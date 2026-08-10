use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::{debug, info, warn};

use super::model::{InteractionThreadRoot, Issue, TrackerComment};
use super::{IssueTracker, TrackerError};
use crate::config::ensemble::GithubTrackerConfig;

mod graphql;

/// GitHub Projects v2 issue tracker using GraphQL.
pub struct GithubTracker {
    endpoint: String,
    token: String,
    owner: String,
    repo: String,
    project_number: Option<i64>,
    active_states: Vec<String>,
    terminal_states: Vec<String>,
    labels_filter: Vec<String>,
    client: reqwest::Client,
    project_fields: Option<GithubTrackerConfig>,
    project_metadata: tokio::sync::RwLock<Option<ProjectMetadata>>,
}

#[derive(Clone)]
struct ProjectMetadata {
    project_id: String,
    status: ResolvedProjectField,
    priority: Option<ResolvedProjectField>,
}

#[derive(Clone)]
struct ResolvedProjectField {
    id: String,
    option_ids: HashMap<String, String>,
    option_ranks: HashMap<String, i32>,
}

pub(crate) struct GithubTrackerSettings {
    pub project_number: Option<i64>,
    pub project_fields: Option<GithubTrackerConfig>,
    pub active_states: Vec<String>,
    pub terminal_states: Vec<String>,
    pub labels_filter: Vec<String>,
}

impl GithubTracker {
    /// Create a new GithubTracker.
    ///
    /// Parses `owner/repo` from the repository string.
    /// The reqwest client is created with a 30-second timeout.
    pub(crate) fn new(
        endpoint: String,
        token: String,
        repository: String,
        settings: GithubTrackerSettings,
    ) -> Result<Self, TrackerError> {
        let (owner, repo) = parse_owner_repo(&repository)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| TrackerError::ApiRequestFailed {
                reason: format!("failed to build HTTP client: {e}"),
            })?;

        Ok(Self {
            endpoint,
            token,
            owner,
            repo,
            project_number: settings.project_number,
            project_fields: settings.project_fields,
            active_states: settings.active_states,
            terminal_states: settings.terminal_states,
            labels_filter: settings.labels_filter,
            client,
            project_metadata: tokio::sync::RwLock::new(None),
        })
    }

    /// Execute a GraphQL query against the configured endpoint.
    async fn graphql<O: graphql::Operation>(
        &self,
        variables: Value,
    ) -> Result<O::Response, TrackerError> {
        let body = json!({
            "query": O::QUERY,
            "variables": variables,
        });

        debug!(endpoint = %self.endpoint, "sending GraphQL request");

        let response = self
            .client
            .post(&self.endpoint)
            .header("Authorization", format!("bearer {}", self.token))
            .header("User-Agent", "ensemble-core")
            .json(&body)
            .send()
            .await
            .map_err(|e| TrackerError::ApiRequestFailed {
                reason: e.to_string(),
            })?;

        // Track rate limit
        if let Some(remaining) = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
        {
            if remaining < 500 {
                warn!(remaining, "GitHub API rate limit running low");
            } else {
                debug!(remaining, "GitHub API rate limit remaining");
            }
        }

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(TrackerError::ApiStatus {
                status: status.as_u16(),
                body: graphql::redact_token(
                    &format!("{} response: {body_text}", O::NAME),
                    &self.token,
                ),
            });
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|error| TrackerError::ApiRequestFailed {
                reason: error.to_string(),
            })?;
        graphql::decode_response::<O>(&bytes, &self.token)
    }

    async fn ensure_project_metadata(&self) -> Result<ProjectMetadata, TrackerError> {
        if let Some(metadata) = self.project_metadata.read().await.clone() {
            return Ok(metadata);
        }
        self.refresh_project_metadata().await
    }

    /// Resolve the configured readable Project field identities to stable IDs.
    async fn refresh_project_metadata(&self) -> Result<ProjectMetadata, TrackerError> {
        let project_number =
            self.project_number
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "project_number is required for project board mode".to_string(),
                })?;
        let configured_fields =
            self.project_fields
                .as_ref()
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "GitHub Project field configuration is required in project board mode"
                        .to_string(),
                })?;

        info!(
            owner = %self.owner,
            repo = %self.repo,
            project_number,
            "discovering project metadata"
        );

        let mut cursor: Option<String> = None;
        let mut project_id = None;
        let mut fields = Vec::new();
        loop {
            let variables = json!({
                "owner": self.owner,
                "repo": self.repo,
                "projectNumber": project_number,
                "cursor": cursor,
            });
            let data = self.graphql::<graphql::ProjectDiscovery>(variables).await?;
            let project = data
                .repository
                .and_then(|repository| repository.project)
                .ok_or_else(|| {
                    graphql::unexpected_payload::<graphql::ProjectDiscovery>("project not found")
                })?;
            project_id.get_or_insert_with(|| project.id.clone());

            fields.extend(project.fields.nodes.into_iter().flatten());
            match project.fields.page_info.next_cursor()? {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }
        let project_id = project_id.ok_or_else(|| {
            graphql::unexpected_payload::<graphql::ProjectDiscovery>("project ID not found")
        })?;
        let status = resolve_project_field(&fields, &configured_fields.status_field)?;
        let mut priority = configured_fields
            .priority
            .as_ref()
            .map(|priority| resolve_project_field(&fields, &priority.field))
            .transpose()?;

        if let (Some(priority), Some(resolved_priority)) =
            (configured_fields.priority.as_ref(), priority.as_mut())
        {
            for (index, option_name) in priority.options.iter().enumerate() {
                let option_id = resolved_priority
                    .option_ids
                    .get(option_name)
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: format!(
                            "configured GitHub Project priority option '{option_name}' in field '{}' matched 0 live options",
                            priority.field
                        ),
                    })?;
                if resolved_priority
                    .option_ranks
                    .insert(option_id.clone(), index as i32 + 1)
                    .is_some()
                {
                    return Err(TrackerError::UnexpectedPayload {
                        reason: format!(
                            "configured GitHub Project priority option '{option_name}' in field '{}' is listed more than once",
                            priority.field
                        ),
                    });
                }
            }
        }

        let metadata = ProjectMetadata {
            project_id,
            status,
            priority,
        };

        info!(
            project_id = %metadata.project_id,
            status_field_id = %metadata.status.id,
            option_count = metadata.status.option_ids.len(),
            "project metadata discovered"
        );
        *self.project_metadata.write().await = Some(metadata.clone());
        Ok(metadata)
    }

    /// Fetch all project items with pagination, filtering by active states.
    async fn fetch_project_items(
        &self,
        filter_states: &[String],
    ) -> Result<Vec<Issue>, TrackerError> {
        let metadata = self.ensure_project_metadata().await?;

        let mut all_issues = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let variables = json!({
                "projectId": metadata.project_id,
                "cursor": cursor,
            });

            let data = self.graphql::<graphql::ProjectItems>(variables).await?;
            let items = data
                .node
                .ok_or_else(|| {
                    graphql::unexpected_payload::<graphql::ProjectItems>("project items not found")
                })?
                .items;

            for node in items.nodes.iter().flatten() {
                if let Some(issue) = self.normalize_project_item(node, filter_states, &metadata) {
                    all_issues.push(issue);
                }
            }

            match items.page_info.next_cursor()? {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }

        Ok(all_issues)
    }

    /// Normalize a single ProjectV2 item node into an Issue.
    /// Returns None if the item's status doesn't match the filter states
    /// or if the content is not an Issue.
    fn normalize_project_item(
        &self,
        node: &graphql::ProjectItem,
        filter_states: &[String],
        metadata: &ProjectMetadata,
    ) -> Option<Issue> {
        let content = node.content.as_ref()?;
        let status = extract_field_value(node, &metadata.status);

        // Filter by status if filter_states is provided
        if !filter_states.is_empty() {
            let status_ref = status.as_deref().unwrap_or("");
            if !filter_states
                .iter()
                .any(|s| s.eq_ignore_ascii_case(status_ref))
            {
                return None;
            }
        }

        let labels = extract_labels(content);

        // Client-side label filtering for project-board mode (repo-mode uses
        // the GraphQL `labels` argument, but project-board queries don't support it).
        if !self.labels_filter.is_empty()
            && !labels
                .iter()
                .any(|l| self.labels_filter.iter().any(|f| f.eq_ignore_ascii_case(l)))
        {
            return None;
        }

        self.normalize_issue_node(
            content,
            status.unwrap_or_else(|| "unknown".to_string()),
            priority_rank(node, metadata),
            node.position.clone(),
        )
    }

    /// Map a set of lowercased labels to the canonical configured state name.
    ///
    /// Finds the first label that case-insensitively matches an active or terminal
    /// state, then returns the *configured* name (preserving casing) instead of
    /// the lowercased label value.  Falls back to `fallback` if no label matches.
    fn canonical_state_from_labels(&self, labels: &[String], fallback: String) -> String {
        for label in labels {
            if let Some(s) = self
                .active_states
                .iter()
                .find(|s| s.eq_ignore_ascii_case(label))
            {
                return s.clone();
            }
            if let Some(s) = self
                .terminal_states
                .iter()
                .find(|s| s.eq_ignore_ascii_case(label))
            {
                return s.clone();
            }
        }
        fallback
    }

    /// Fetch repository issues without a project board.
    async fn fetch_repo_issues(
        &self,
        filter_states: &[String],
    ) -> Result<Vec<Issue>, TrackerError> {
        let mut all_issues = Vec::new();
        let mut cursor: Option<String> = None;

        let labels_param: Option<Vec<String>> = if !self.labels_filter.is_empty() {
            Some(self.labels_filter.clone())
        } else {
            None
        };

        loop {
            let variables = json!({
                "owner": self.owner,
                "repo": self.repo,
                "cursor": cursor,
                "labels": labels_param,
            });

            let data = self.graphql::<graphql::RepositoryIssues>(variables).await?;
            let issues = data
                .repository
                .ok_or_else(|| {
                    graphql::unexpected_payload::<graphql::RepositoryIssues>("repository not found")
                })?
                .issues;

            for node in issues.nodes.iter().flatten() {
                if let Some(issue) = self.normalize_repo_issue(node, filter_states) {
                    all_issues.push(issue);
                }
            }

            match issues.page_info.next_cursor()? {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }

        Ok(all_issues)
    }

    /// Normalize a single repository issue node into an Issue.
    fn normalize_repo_issue(
        &self,
        node: &graphql::IssueNode,
        filter_states: &[String],
    ) -> Option<Issue> {
        let labels = extract_labels(node);

        // Determine state: match labels to canonical configured names,
        // falling back to raw GitHub open/closed.
        let raw_state = node.state.as_deref().unwrap_or("open").to_lowercase();

        let state = self.canonical_state_from_labels(&labels, raw_state);

        // Filter by state
        if !filter_states.is_empty()
            && !filter_states.iter().any(|s| s.eq_ignore_ascii_case(&state))
        {
            return None;
        }

        self.normalize_issue_node(node, state, None, None)
    }

    fn normalize_issue_node(
        &self,
        node: &graphql::IssueNode,
        state: String,
        priority: Option<i32>,
        tracker_position: Option<String>,
    ) -> Option<Issue> {
        let id = node.id.clone()?;
        let number = node.number?;
        let title = node.title.clone()?;
        Some(Issue {
            id,
            identifier: format!("{}#{}", self.repo, number),
            title,
            description: node.body.clone().filter(|body| !body.is_empty()),
            priority,
            tracker_position,
            state,
            branch_name: None,
            url: node.url.clone(),
            labels: extract_labels(node),
            blocked_by: vec![],
            created_at: node
                .created_at
                .as_deref()
                .and_then(|value| value.parse::<DateTime<Utc>>().ok()),
            updated_at: node
                .updated_at
                .as_deref()
                .and_then(|value| value.parse::<DateTime<Utc>>().ok()),
        })
    }

    /// Batch fetch issue states by node IDs.
    async fn fetch_states_by_node_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let project_metadata = if self.project_number.is_some() {
            Some(self.ensure_project_metadata().await?)
        } else {
            None
        };

        let variables = json!({
            "ids": ids,
        });

        let data = self.graphql::<graphql::IssueStates>(variables).await?;

        let mut issues = Vec::new();
        for node in data.nodes.iter().flatten() {
            if let Some(issue) = self.normalize_state_node(node, project_metadata.as_ref())? {
                issues.push(issue);
            }
        }

        Ok(issues)
    }

    async fn repository_label_id(&self, name: &str) -> Result<Option<String>, TrackerError> {
        let variables = json!({
            "owner": self.owner,
            "repo": self.repo,
            "name": name,
        });
        let data = self.graphql::<graphql::RepositoryLabel>(variables).await?;
        Ok(data
            .repository
            .and_then(|repository| repository.label)
            .map(|label| label.id))
    }

    async fn configured_state_label_ids(
        &self,
        target_state: &str,
    ) -> Result<HashMap<String, String>, TrackerError> {
        let mut labels = HashMap::new();
        for state in self.active_states.iter().chain(self.terminal_states.iter()) {
            let key = state.to_lowercase();
            if labels.contains_key(&key) {
                continue;
            }
            if let Some(label_id) = self.repository_label_id(state).await? {
                labels.insert(key, label_id);
            }
        }
        let target_key = target_state.to_lowercase();
        if let std::collections::hash_map::Entry::Vacant(entry) = labels.entry(target_key) {
            if let Some(label_id) = self.repository_label_id(target_state).await? {
                entry.insert(label_id);
            }
        }
        Ok(labels)
    }

    async fn set_repo_label_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
        let current = self
            .fetch_states_by_node_ids(&[id.to_string()])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!("issue not found for node ID: {id}"),
            })?;

        let state_label_ids = self.configured_state_label_ids(state).await?;
        let target_label_id = state_label_ids
            .get(&state.to_lowercase())
            .cloned()
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "repository label for configured tracker state '{state}' was not found"
                ),
            })?;

        let remove_label_ids: Vec<String> = current
            .labels
            .iter()
            .filter_map(|label| state_label_ids.get(&label.to_lowercase()).cloned())
            .filter(|label_id| label_id != &target_label_id)
            .collect();

        if !remove_label_ids.is_empty() {
            self.graphql::<graphql::RemoveLabels>(json!({
                "labelableId": id,
                "labelIds": remove_label_ids,
            }))
            .await?;
        }

        let already_has_target = current
            .labels
            .iter()
            .any(|label| label.eq_ignore_ascii_case(state));
        if !already_has_target {
            self.graphql::<graphql::AddLabels>(json!({
                "labelableId": id,
                "labelIds": [target_label_id],
            }))
            .await?;
        }

        Ok(())
    }

    /// Find the project item ID for an issue node within the configured project.
    async fn find_project_item_id(&self, issue_node_id: &str) -> Result<String, TrackerError> {
        let variables = json!({ "nodeId": issue_node_id });
        let data = self.graphql::<graphql::FindProjectItem>(variables).await?;

        let project_id = self.ensure_project_metadata().await?.project_id;

        let items = data
            .node
            .and_then(|node| node.project_items)
            .ok_or_else(|| {
                graphql::unexpected_payload::<graphql::FindProjectItem>(format_args!(
                    "issue {issue_node_id} is missing projectItems nodes"
                ))
            })?
            .nodes;

        let (item_id, _) = select_configured_project_item(issue_node_id, &project_id, &items)?;
        Ok(item_id.to_string())
    }

    /// Normalize a node from the state refresh query.
    fn normalize_state_node(
        &self,
        node: &graphql::IssueNode,
        project_metadata: Option<&ProjectMetadata>,
    ) -> Result<Option<Issue>, TrackerError> {
        let Some(id) = node.id.as_deref() else {
            return Ok(None);
        };
        if node.number.is_none() || node.title.is_none() {
            return Ok(None);
        }

        let labels = extract_labels(node);

        let (state, priority, tracker_position) = if let Some(metadata) = project_metadata {
            let items = node
                .project_items
                .as_ref()
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: format!("issue {id} is missing projectItems nodes"),
                })?
                .nodes
                .as_slice();
            let (item_id, item) = select_configured_project_item(id, &metadata.project_id, items)?;
            let state = extract_field_value(item, &metadata.status).ok_or_else(|| {
                TrackerError::UnexpectedPayload {
                    reason: format!(
                        "issue {id} project item {item_id} in configured project {} is missing configured status",
                        metadata.project_id
                    ),
                }
            })?;
            (state, priority_rank(item, metadata), item.position.clone())
        } else {
            let raw_state = node.state.as_deref().unwrap_or("open").to_lowercase();

            // In repo-mode, derive canonical state from labels to stay consistent
            // with normalize_repo_issue.
            (
                self.canonical_state_from_labels(&labels, raw_state),
                None,
                None,
            )
        };

        Ok(self.normalize_issue_node(node, state, priority, tracker_position))
    }
}

/// Parse "owner/repo" into (owner, repo).
fn parse_owner_repo(repository: &str) -> Result<(String, String), TrackerError> {
    let (owner, repo) =
        repository
            .split_once('/')
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "invalid repository format '{}', expected 'owner/repo'",
                    repository
                ),
            })?;
    if owner.is_empty() || repo.is_empty() {
        return Err(TrackerError::UnexpectedPayload {
            reason: format!(
                "invalid repository format '{}', expected 'owner/repo'",
                repository
            ),
        });
    }
    Ok((owner.to_string(), repo.to_string()))
}

/// Extract lowercased labels from a GitHub issue node.
fn extract_labels(node: &graphql::IssueNode) -> Vec<String> {
    node.labels
        .as_ref()
        .map(|labels| {
            labels
                .nodes
                .iter()
                .flatten()
                .filter_map(|label| label.name.as_deref())
                .map(str::to_lowercase)
                .collect()
        })
        .unwrap_or_default()
}

/// Select the one ProjectV2 item for an issue in the configured project.
fn select_configured_project_item<'a>(
    issue_node_id: &str,
    configured_project_id: &str,
    items: &'a [Option<graphql::ProjectItem>],
) -> Result<(&'a str, &'a graphql::ProjectItem), TrackerError> {
    let mut configured_items = Vec::new();

    for (index, item) in items.iter().enumerate() {
        let Some(item) = item.as_ref() else {
            continue;
        };
        let item_id = item
            .id
            .as_deref()
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "issue {issue_node_id} project item at index {index} is missing item ID"
                ),
            })?;
        let project_id = item
            .project
            .as_ref()
            .map(|project| project.id.as_str())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "issue {issue_node_id} project item {item_id} is missing project ID"
                ),
            })?;

        if project_id == configured_project_id {
            configured_items.push((item_id, item));
        }
    }

    match configured_items.as_slice() {
        [] => Err(TrackerError::UnexpectedPayload {
            reason: format!(
                "issue {issue_node_id} has no item in configured project {configured_project_id}"
            ),
        }),
        [(item_id, item)] => Ok((*item_id, *item)),
        _ => {
            let mut item_ids: Vec<&str> = configured_items
                .iter()
                .map(|(item_id, _)| *item_id)
                .collect();
            item_ids.sort_unstable();
            Err(TrackerError::UnexpectedPayload {
                reason: format!(
                    "issue {issue_node_id} has multiple items in configured project {configured_project_id}: {}",
                    item_ids.join(", ")
                ),
            })
        }
    }
}

fn resolve_project_field(
    fields: &[graphql::ProjectField],
    name: &str,
) -> Result<ResolvedProjectField, TrackerError> {
    let matches: Vec<&graphql::ProjectField> = fields
        .iter()
        .filter(|field| field.name.as_deref() == Some(name))
        .collect();
    let [field] = matches.as_slice() else {
        return Err(TrackerError::UnexpectedPayload {
            reason: format!(
                "configured GitHub Project field '{name}' matched {} live single-select fields",
                matches.len()
            ),
        });
    };
    let id = field
        .id
        .clone()
        .ok_or_else(|| TrackerError::UnexpectedPayload {
            reason: format!("configured GitHub Project field '{name}' has no ID"),
        })?;
    let mut option_ids = HashMap::new();
    for option in field.options.as_deref().unwrap_or_default() {
        let option_name = option
            .name
            .clone()
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!("configured GitHub Project field '{name}' has an unnamed option"),
            })?;
        let option_id = option
            .id
            .clone()
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "configured GitHub Project field '{name}' has an option without an ID"
                ),
            })?;
        if option_ids.insert(option_name.clone(), option_id).is_some() {
            return Err(TrackerError::UnexpectedPayload {
                reason: format!(
                    "configured GitHub Project field '{name}' has duplicate readable option name '{option_name}'"
                ),
            });
        }
    }
    Ok(ResolvedProjectField {
        id,
        option_ids,
        option_ranks: HashMap::new(),
    })
}

fn extract_field_value(
    node: &graphql::ProjectItem,
    field: &ResolvedProjectField,
) -> Option<String> {
    node.field_values
        .as_ref()?
        .nodes
        .iter()
        .flatten()
        .find(|value| value.field.as_ref().and_then(|value| value.id.as_deref()) == Some(&field.id))
        .and_then(|value| value.name.clone())
}

fn priority_rank(node: &graphql::ProjectItem, metadata: &ProjectMetadata) -> Option<i32> {
    let priority = metadata.priority.as_ref()?;
    let option_id = node
        .field_values
        .as_ref()?
        .nodes
        .iter()
        .flatten()
        .find(|value| {
            value.field.as_ref().and_then(|field| field.id.as_deref()) == Some(&priority.id)
        })?
        .option_id
        .as_deref()?;
    priority.option_ranks.get(option_id).copied()
}

#[async_trait]
impl IssueTracker for GithubTracker {
    async fn validate_configuration(&self) -> Result<(), TrackerError> {
        if self.project_number.is_some() {
            self.refresh_project_metadata().await?;
        }
        Ok(())
    }

    /// Fetch candidate issues in active states for dispatch.
    ///
    /// When project_number is set: queries project board items.
    /// When not set: queries repository issues.
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        if self.project_number.is_some() {
            self.fetch_project_items(&self.active_states).await
        } else {
            self.fetch_repo_issues(&self.active_states).await
        }
    }

    /// Fetch issues in the given states (used for startup terminal cleanup).
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        if self.project_number.is_some() {
            self.fetch_project_items(states).await
        } else {
            self.fetch_repo_issues(states).await
        }
    }

    /// Fetch current states for specific issue IDs (used for reconciliation).
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        self.fetch_states_by_node_ids(ids).await
    }

    fn supports_writes(&self) -> bool {
        true
    }

    async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
        let variables = json!({
            "subjectId": id,
            "body": body,
        });
        self.graphql::<graphql::AddComment>(variables).await?;
        Ok(())
    }

    async fn create_interaction_thread_root(
        &self,
        id: &str,
        body: &str,
    ) -> Result<InteractionThreadRoot, TrackerError> {
        let variables = json!({
            "subjectId": id,
            "body": body,
        });
        let data = self.graphql::<graphql::AddComment>(variables).await?;
        let node = data
            .add_comment
            .and_then(|payload| payload.comment_edge)
            .and_then(|edge| edge.node)
            .ok_or_else(|| {
                graphql::unexpected_payload::<graphql::AddComment>(
                    "missing addComment.commentEdge.node payload",
                )
            })?;
        Ok(InteractionThreadRoot {
            comment_id: node.id,
            comment_url: node.url,
        })
    }

    async fn list_comments_after(
        &self,
        id: &str,
        after_comment_id: &str,
    ) -> Result<Vec<TrackerComment>, TrackerError> {
        let mut cursor: Option<String> = None;
        let mut comments = Vec::new();
        loop {
            let variables = json!({
                "issueId": id,
                "cursor": cursor,
            });
            let data = self.graphql::<graphql::IssueComments>(variables).await?;
            let connection = data
                .node
                .ok_or_else(|| {
                    graphql::unexpected_payload::<graphql::IssueComments>(
                        "missing issue comments payload",
                    )
                })?
                .comments;

            for node in connection.nodes.iter().flatten() {
                comments.push(TrackerComment {
                    comment_id: node.id.clone(),
                    body: node.body.clone(),
                    author: node
                        .author
                        .as_ref()
                        .and_then(|author| author.login.clone())
                        .unwrap_or_else(|| "unknown".to_string()),
                    created_at: node
                        .created_at
                        .as_deref()
                        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.with_timezone(&Utc)),
                    updated_at: node
                        .updated_at
                        .as_deref()
                        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.with_timezone(&Utc)),
                });
            }

            match connection.page_info.next_cursor()? {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }

        comments.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.comment_id.cmp(&right.comment_id))
        });
        if let Some(anchor_index) = comments
            .iter()
            .position(|comment| comment.comment_id == after_comment_id)
        {
            Ok(comments.into_iter().skip(anchor_index + 1).collect())
        } else {
            Ok(Vec::new())
        }
    }

    async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
        if self.project_number.is_some() {
            let metadata = self.ensure_project_metadata().await?;
            let project_id = metadata.project_id;
            let field_id = metadata.status.id;
            let option_id = metadata
                .status
                .option_ids
                .get(state)
                .cloned()
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: format!("unknown configured status option: {state}"),
                })?;

            let item_id = self.find_project_item_id(id).await?;

            let variables = json!({
                "projectId": project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "optionId": option_id,
            });
            self.graphql::<graphql::UpdateProjectItemField>(variables)
                .await?;
            Ok(())
        } else {
            self.set_repo_label_state(id, state).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Helper to create a GithubTracker pointed at a wiremock server.
    fn create_test_tracker(server_url: &str, project_number: Option<i64>) -> GithubTracker {
        GithubTracker::new(
            format!("{}/graphql", server_url),
            "ghp_test_token".to_string(),
            "acme/my-repo".to_string(),
            GithubTrackerSettings {
                project_number,
                project_fields: project_number.map(|_| GithubTrackerConfig {
                    status_field: "Status".to_string(),
                    priority: None,
                }),
                active_states: vec!["Todo".to_string(), "In Progress".to_string()],
                terminal_states: vec!["Done".to_string(), "Closed".to_string()],
                labels_filter: vec![],
            },
        )
        .unwrap()
    }

    /// Build a GraphQL response body wrapping the given data.
    fn graphql_response(mut data: Value) -> Value {
        add_project_field_ids(&mut data);
        json!({ "data": data })
    }

    fn add_project_field_ids(value: &mut Value) {
        match value {
            Value::Array(values) => values.iter_mut().for_each(add_project_field_ids),
            Value::Object(values) => {
                if let Some(Value::Object(field)) = values.get_mut("field") {
                    if let Some(name) = field
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    {
                        field.entry("id").or_insert_with(|| {
                            Value::String(format!("F_{}", name.to_lowercase().replace(' ', "_")))
                        });
                    }
                }
                values.values_mut().for_each(add_project_field_ids);
            }
            _ => {}
        }
    }

    fn issue_node(mut value: Value) -> graphql::IssueNode {
        add_project_field_ids(&mut value);
        serde_json::from_value(value).unwrap()
    }

    fn project_item(value: Value) -> graphql::ProjectItem {
        serde_json::from_value(value).unwrap()
    }

    fn project_items(value: Value) -> Vec<Option<graphql::ProjectItem>> {
        serde_json::from_value(value).unwrap()
    }

    async fn mount_project_discovery(server: &MockServer, project_id: &str) {
        let response = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": project_id,
                    "fields": {
                        "pageInfo": { "hasNextPage": false, "endCursor": null },
                        "nodes": [
                            {
                                "id": "F_status",
                                "name": "Status",
                                "options": [
                                    { "id": "O_todo", "name": "Todo" },
                                    { "id": "O_progress", "name": "In Progress" },
                                    { "id": "O_done", "name": "Done" }
                                ]
                            }
                        ]
                    }
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectNumber"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn project_discovery_finds_status_on_later_page() {
        let server = MockServer::start().await;

        let first_page = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_test123",
                    "fields": {
                        "pageInfo": {
                            "hasNextPage": true,
                            "endCursor": "fields_page_2"
                        },
                        "nodes": [
                            { "id": "F_priority", "name": "Priority", "options": [] }
                        ]
                    }
                }
            }
        }));
        let second_page = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_test123",
                    "fields": {
                        "pageInfo": {
                            "hasNextPage": false,
                            "endCursor": null
                        },
                        "nodes": [{
                            "id": "F_status",
                            "name": "Status",
                            "options": [{ "id": "O_todo", "name": "Todo" }]
                        }]
                    }
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"cursor\":null"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&first_page))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("fields_page_2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&second_page))
            .expect(1)
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let metadata = tracker.ensure_project_metadata().await.unwrap();

        assert_eq!(metadata.project_id, "PVT_test123");
        assert_eq!(metadata.status.id, "F_status");
        assert_eq!(
            metadata.status.option_ids.get("Todo"),
            Some(&"O_todo".to_string())
        );
    }

    // --- parse_owner_repo tests ---

    #[test]
    fn test_parse_owner_repo_valid() {
        let (owner, repo) = parse_owner_repo("acme/my-repo").unwrap();
        assert_eq!(owner, "acme");
        assert_eq!(repo, "my-repo");
    }

    #[test]
    fn test_parse_owner_repo_with_org_slash() {
        let (owner, repo) = parse_owner_repo("my-org/my-repo").unwrap();
        assert_eq!(owner, "my-org");
        assert_eq!(repo, "my-repo");
    }

    #[test]
    fn test_parse_owner_repo_no_slash() {
        let result = parse_owner_repo("justarepo");
        assert!(matches!(
            result,
            Err(TrackerError::UnexpectedPayload { .. })
        ));
    }

    #[test]
    fn test_parse_owner_repo_empty_parts() {
        assert!(parse_owner_repo("/repo").is_err());
        assert!(parse_owner_repo("owner/").is_err());
        assert!(parse_owner_repo("/").is_err());
    }

    // --- extract_labels tests ---

    #[test]
    fn test_extract_labels_lowercased() {
        let node = issue_node(json!({
            "labels": {
                "nodes": [
                    { "name": "Bug" },
                    { "name": "ENHANCEMENT" },
                    { "name": "p1" }
                ]
            }
        }));
        let labels = extract_labels(&node);
        assert_eq!(labels, vec!["bug", "enhancement", "p1"]);
    }

    #[test]
    fn test_extract_labels_empty() {
        let node = issue_node(json!({}));
        let labels = extract_labels(&node);
        assert!(labels.is_empty());
    }

    #[test]
    fn priority_rank_uses_resolved_option_ids() {
        let metadata = ProjectMetadata {
            project_id: "P_1".to_string(),
            status: ResolvedProjectField {
                id: "F_status".to_string(),
                option_ids: HashMap::new(),
                option_ranks: HashMap::new(),
            },
            priority: Some(ResolvedProjectField {
                id: "F_impact".to_string(),
                option_ids: HashMap::new(),
                option_ranks: HashMap::from([
                    ("O_critical".to_string(), 1),
                    ("O_normal".to_string(), 2),
                ]),
            }),
        };
        let ranked = project_item(json!({
            "fieldValues": {
                "nodes": [{
                    "name": "Normal",
                    "optionId": "O_normal",
                    "field": { "id": "F_impact", "name": "Customer impact" }
                }]
            }
        }));
        let unranked = project_item(json!({
            "fieldValues": {
                "nodes": [{
                    "name": "Deferred",
                    "optionId": "O_deferred",
                    "field": { "id": "F_impact", "name": "Customer impact" }
                }]
            }
        }));

        assert_eq!(priority_rank(&ranked, &metadata), Some(2));
        assert_eq!(priority_rank(&unranked, &metadata), None);
    }

    // --- project-mode state reconciliation tests ---

    #[test]
    fn configured_project_item_rejects_missing_project_identity() {
        let items = project_items(json!([{ "id": "PVTI_unknown" }]));

        let result = select_configured_project_item("I_node1", "P_configured", &items);

        match result {
            Err(TrackerError::UnexpectedPayload { reason }) => assert_eq!(
                reason,
                "issue I_node1 project item PVTI_unknown is missing project ID"
            ),
            other => panic!("expected UnexpectedPayload error, got: {other:?}"),
        }
    }

    #[test]
    fn configured_project_item_rejects_missing_configured_project() {
        let items = project_items(json!([{ "id": "PVTI_other", "project": { "id": "P_other" } }]));

        let result = select_configured_project_item("I_node1", "P_configured", &items);

        match result {
            Err(TrackerError::UnexpectedPayload { reason }) => assert_eq!(
                reason,
                "issue I_node1 has no item in configured project P_configured"
            ),
            other => panic!("expected UnexpectedPayload error, got: {other:?}"),
        }
    }

    #[test]
    fn configured_project_item_rejects_multiple_configured_items() {
        let items = project_items(json!([
            { "id": "PVTI_b", "project": { "id": "P_configured" } },
            { "id": "PVTI_a", "project": { "id": "P_configured" } }
        ]));

        let result = select_configured_project_item("I_node1", "P_configured", &items);

        match result {
            Err(TrackerError::UnexpectedPayload { reason }) => assert_eq!(
                reason,
                "issue I_node1 has multiple items in configured project P_configured: PVTI_a, PVTI_b"
            ),
            other => panic!("expected UnexpectedPayload error, got: {other:?}"),
        }
    }

    #[test]
    fn project_mode_reconciliation_rejects_missing_status() {
        let tracker = create_test_tracker("https://example.invalid", Some(1));
        let node = issue_node(json!({
            "id": "I_node1",
            "number": 1,
            "title": "Issue 1",
            "state": "OPEN",
            "projectItems": {
                "nodes": [{
                    "id": "PVTI_configured",
                    "project": { "id": "P_configured" },
                    "fieldValues": { "nodes": [] }
                }]
            }
        }));

        let metadata = ProjectMetadata {
            project_id: "P_configured".to_string(),
            status: ResolvedProjectField {
                id: "F_status".to_string(),
                option_ids: HashMap::new(),
                option_ranks: HashMap::new(),
            },
            priority: None,
        };
        let result = tracker.normalize_state_node(&node, Some(&metadata));

        match result {
            Err(TrackerError::UnexpectedPayload { reason }) => assert_eq!(
                reason,
                "issue I_node1 project item PVTI_configured in configured project P_configured is missing configured status"
            ),
            other => panic!("expected UnexpectedPayload error, got: {other:?}"),
        }
    }

    // --- wiremock integration tests ---

    #[tokio::test]
    async fn test_fetch_candidates_with_project_board() {
        let server = MockServer::start().await;

        // Mock discovery query
        let discovery_response = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_test123",
                    "fields": {
                        "pageInfo": { "hasNextPage": false, "endCursor": null },
                        "nodes": [
                            {
                                "id": "F_status",
                                "name": "Status",
                                "options": [
                                    { "id": "OPT_1", "name": "Todo" },
                                    { "id": "OPT_2", "name": "In Progress" },
                                    { "id": "OPT_3", "name": "Done" }
                                ]
                            }
                        ]
                    }
                }
            }
        }));

        // Mock items query
        let items_response = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": {
                        "hasNextPage": false,
                        "endCursor": null
                    },
                    "nodes": [
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Todo",
                                        "field": { "name": "Status" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_issue1",
                                "number": 1,
                                "title": "First issue",
                                "body": "Issue body",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-02T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/1",
                                "labels": {
                                    "nodes": [
                                        { "name": "Bug" }
                                    ]
                                }
                            }
                        },
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Done",
                                        "field": { "name": "Status" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_issue2",
                                "number": 2,
                                "title": "Done issue",
                                "body": "",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-02T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/2",
                                "labels": { "nodes": [] }
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectNumber"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&discovery_response))
            .named("discovery")
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectId"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&items_response))
            .named("items")
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        // Only the Todo issue should be returned (Done is filtered out)
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "I_issue1");
        assert_eq!(issues[0].identifier, "my-repo#1");
        assert_eq!(issues[0].title, "First issue");
        assert_eq!(issues[0].description.as_deref(), Some("Issue body"));
        assert_eq!(issues[0].state, "Todo");
        assert_eq!(issues[0].labels, vec!["bug"]);
        assert!(issues[0].url.is_some());
        assert!(issues[0].created_at.is_some());
        assert!(issues[0].updated_at.is_some());
    }

    #[tokio::test]
    async fn test_fetch_candidates_without_project_board() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": {
                        "hasNextPage": false,
                        "endCursor": null
                    },
                    "nodes": [
                        {
                            "id": "I_node1",
                            "number": 10,
                            "title": "Open issue",
                            "body": "Some body",
                            "createdAt": "2025-03-01T12:00:00Z",
                            "updatedAt": "2025-03-02T12:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/10",
                            "state": "OPEN",
                            "labels": {
                                "nodes": [
                                    { "name": "todo" }
                                ]
                            }
                        },
                        {
                            "id": "I_node2",
                            "number": 11,
                            "title": "Another issue",
                            "body": "",
                            "createdAt": "2025-03-01T13:00:00Z",
                            "updatedAt": "2025-03-02T13:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/11",
                            "state": "OPEN",
                            "labels": {
                                "nodes": [
                                    { "name": "done" }
                                ]
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        // "todo" label matches active state "Todo" (case-insensitive), so it passes.
        // "done" label matches terminal state "Done", so it does NOT match active states.
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].identifier, "my-repo#10");
        assert_eq!(issues[0].labels, vec!["todo"]);
    }

    #[tokio::test]
    async fn test_pagination_two_pages() {
        let server = MockServer::start().await;

        let page1_response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": {
                        "hasNextPage": true,
                        "endCursor": "cursor_page2"
                    },
                    "nodes": [
                        {
                            "id": "I_p1",
                            "number": 1,
                            "title": "Page 1 issue",
                            "body": "",
                            "createdAt": "2025-01-01T00:00:00Z",
                            "updatedAt": "2025-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/1",
                            "state": "OPEN",
                            "labels": { "nodes": [{ "name": "todo" }] }
                        }
                    ]
                }
            }
        }));

        let page2_response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": {
                        "hasNextPage": false,
                        "endCursor": null
                    },
                    "nodes": [
                        {
                            "id": "I_p2",
                            "number": 2,
                            "title": "Page 2 issue",
                            "body": "",
                            "createdAt": "2025-01-02T00:00:00Z",
                            "updatedAt": "2025-01-02T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/2",
                            "state": "OPEN",
                            "labels": { "nodes": [{ "name": "in progress" }] }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"cursor\":null"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&page1_response))
            .named("page1")
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("cursor_page2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&page2_response))
            .named("page2")
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].identifier, "my-repo#1");
        assert_eq!(issues[1].identifier, "my-repo#2");
    }

    #[tokio::test]
    async fn project_items_paginates_across_empty_and_populated_pages() {
        let server = MockServer::start().await;
        mount_project_discovery(&server, "P_configured").await;

        let first_page = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": { "hasNextPage": true, "endCursor": "items_page_2" },
                    "nodes": []
                }
            }
        }));
        let second_page = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [{
                        "fieldValues": {
                            "nodes": [
                                { "name": "Todo", "field": { "name": "Status" } },
                                { "name": "Urgent", "field": { "name": "Priority" } }
                            ]
                        },
                        "content": {
                            "id": "I_page_2",
                            "number": 2,
                            "title": "Second page",
                            "body": "body",
                            "createdAt": "2026-01-01T00:00:00Z",
                            "updatedAt": "2026-01-02T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/2",
                            "labels": { "nodes": [{ "name": "Bug" }] }
                        }
                    }]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"projectId\":\"P_configured\""))
            .and(body_string_contains("\"cursor\":null"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&first_page))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("items_page_2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&second_page))
            .expect(1)
            .mount(&server)
            .await;

        let issues = create_test_tracker(&server.uri(), Some(1))
            .fetch_candidate_issues()
            .await
            .unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].identifier, "my-repo#2");
        assert_eq!(issues[0].priority, None);
        assert_eq!(issues[0].labels, vec!["bug"]);
        assert!(issues[0].created_at.is_some());
        assert!(issues[0].updated_at.is_some());
    }

    #[tokio::test]
    async fn pagination_rejects_missing_end_cursor() {
        let server = MockServer::start().await;
        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": true, "endCursor": null },
                    "nodes": []
                }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .expect(1)
            .mount(&server)
            .await;

        let error = create_test_tracker(&server.uri(), None)
            .fetch_candidate_issues()
            .await
            .unwrap_err();

        assert!(matches!(error, TrackerError::MissingEndCursor));
    }

    #[tokio::test]
    async fn nullable_graphql_nodes_are_skipped() {
        let server = MockServer::start().await;
        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        null,
                        {
                            "id": "I_present",
                            "number": 7,
                            "title": "Present issue",
                            "body": "",
                            "createdAt": "2026-01-01T00:00:00Z",
                            "updatedAt": "2026-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/7",
                            "state": "OPEN",
                            "labels": { "nodes": [null, { "name": "Todo" }] }
                        }
                    ]
                }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let issues = create_test_tracker(&server.uri(), None)
            .fetch_candidate_issues()
            .await
            .unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "I_present");
        assert_eq!(issues[0].labels, vec!["todo"]);
    }

    #[tokio::test]
    async fn missing_required_connection_is_contextual() {
        let server = MockServer::start().await;
        let response = graphql_response(json!({ "repository": {} }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let error = create_test_tracker(&server.uri(), None)
            .fetch_candidate_issues()
            .await
            .unwrap_err();

        assert!(matches!(error, TrackerError::UnexpectedPayload { .. }));
        assert!(error.to_string().contains("RepositoryIssues"));
        assert!(error.to_string().contains("missing field `issues`"));
    }

    #[tokio::test]
    async fn test_fetch_states_by_ids() {
        let server = MockServer::start().await;

        mount_project_discovery(&server, "P_configured").await;

        let response = graphql_response(json!({
            "nodes": [
                {
                    "id": "I_node1",
                    "number": 42,
                    "title": "Issue 42",
                    "state": "OPEN",
                    "url": "https://github.com/acme/my-repo/issues/42",
                    "labels": { "nodes": [{ "name": "bug" }] },
                    "projectItems": {
                        "nodes": [
                            {
                                "id": "PVTI_configured",
                                "project": { "id": "P_configured" },
                                "fieldValues": {
                                    "nodes": [
                                        {
                                            "name": "In Progress",
                                            "field": { "name": "Status" }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                },
                null,
                {
                    "id": "I_node3",
                    "number": 99,
                    "title": "Issue 99",
                    "state": "CLOSED",
                    "url": "https://github.com/acme/my-repo/issues/99",
                    "labels": { "nodes": [] },
                    "projectItems": {
                        "nodes": [{
                            "id": "PVTI_configured_node3",
                            "project": { "id": "P_configured" },
                            "fieldValues": {
                                "nodes": [{
                                    "name": "Done",
                                    "field": { "name": "Status" }
                                }]
                            }
                        }]
                    }
                }
            ]
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker
            .fetch_issue_states_by_ids(&[
                "I_node1".to_string(),
                "I_node_missing".to_string(),
                "I_node3".to_string(),
            ])
            .await
            .unwrap();

        assert_eq!(issues.len(), 2);

        // First issue has project Status = "In Progress"
        assert_eq!(issues[0].id, "I_node1");
        assert_eq!(issues[0].state, "In Progress");
        assert_eq!(issues[0].identifier, "my-repo#42");
        assert_eq!(issues[0].labels, vec!["bug"]);

        // Third issue derives its state from the configured project's Status.
        assert_eq!(issues[1].id, "I_node3");
        assert_eq!(issues[1].state, "Done");
        assert_eq!(issues[1].identifier, "my-repo#99");
    }

    #[tokio::test]
    async fn project_mode_reconciliation_reads_configured_project_status() {
        let server = MockServer::start().await;
        mount_project_discovery(&server, "P_configured").await;

        let response = graphql_response(json!({
            "nodes": [{
                "id": "I_node1",
                "number": 1,
                "title": "Issue 1",
                "state": "OPEN",
                "url": "https://github.com/acme/my-repo/issues/1",
                "labels": { "nodes": [] },
                "projectItems": {
                    "nodes": [
                        {
                            "id": "PVTI_other",
                            "project": { "id": "P_other" },
                            "fieldValues": {
                                "nodes": [{
                                    "name": "Done",
                                    "field": { "name": "Status" }
                                }]
                            }
                        },
                        {
                            "id": "PVTI_configured",
                            "project": { "id": "P_configured" },
                            "fieldValues": {
                                "nodes": [{
                                    "name": "In Progress",
                                    "field": { "name": "Status" }
                                }]
                            }
                        }
                    ]
                }
            }]
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("nodes(ids"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .expect(1)
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker
            .fetch_issue_states_by_ids(&["I_node1".to_string()])
            .await
            .unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].state, "In Progress");
    }

    #[tokio::test]
    async fn project_mode_write_targets_configured_project_item() {
        let server = MockServer::start().await;
        mount_project_discovery(&server, "P_configured").await;

        let find_response = graphql_response(json!({
            "node": {
                "projectItems": {
                    "nodes": [
                        { "id": "PVTI_other", "project": { "id": "P_other" } },
                        { "id": "PVTI_configured", "project": { "id": "P_configured" } }
                    ]
                }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"nodeId\":\"I_node1\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(&find_response))
            .expect(1)
            .mount(&server)
            .await;

        let mutation_response = graphql_response(json!({
            "updateProjectV2ItemFieldValue": {
                "projectV2Item": { "id": "PVTI_configured" }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("updateProjectV2ItemFieldValue"))
            .and(body_string_contains("\"projectId\":\"P_configured\""))
            .and(body_string_contains("\"itemId\":\"PVTI_configured\""))
            .and(body_string_contains("\"fieldId\":\"F_status\""))
            .and(body_string_contains("\"optionId\":\"O_done\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(&mutation_response))
            .expect(1)
            .mount(&server)
            .await;

        create_test_tracker(&server.uri(), Some(1))
            .set_issue_state("I_node1", "Done")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn project_mode_write_rejects_multiple_configured_items() {
        let server = MockServer::start().await;
        mount_project_discovery(&server, "P_configured").await;

        let find_response = graphql_response(json!({
            "node": {
                "projectItems": {
                    "nodes": [
                        { "id": "PVTI_b", "project": { "id": "P_configured" } },
                        { "id": "PVTI_a", "project": { "id": "P_configured" } }
                    ]
                }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"nodeId\":\"I_node1\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(&find_response))
            .expect(1)
            .mount(&server)
            .await;

        let error = create_test_tracker(&server.uri(), Some(1))
            .set_issue_state("I_node1", "Done")
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            TrackerError::UnexpectedPayload { reason }
                if reason == "issue I_node1 has multiple items in configured project P_configured: PVTI_a, PVTI_b"
        ));
    }

    #[tokio::test]
    async fn test_fetch_states_by_ids_derives_state_from_labels() {
        // Regression: repo-mode reconciliation must re-derive state from labels,
        // not just fall back to raw open/closed.
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "nodes": [
                {
                    "id": "I_label_issue",
                    "number": 55,
                    "title": "Label-derived state",
                    "state": "OPEN",
                    "url": "https://github.com/acme/my-repo/issues/55",
                    "labels": { "nodes": [{ "name": "todo" }] },
                    "projectItems": { "nodes": [] }
                }
            ]
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker
            .fetch_issue_states_by_ids(&["I_label_issue".to_string()])
            .await
            .unwrap();

        assert_eq!(issues.len(), 1);
        // Should derive canonical "Todo" from labels, not fall back to "open"
        assert_eq!(issues[0].state, "Todo");
    }

    #[tokio::test]
    async fn test_fetch_states_empty_ids() {
        let tracker = GithubTracker::new(
            "https://api.github.com/graphql".to_string(),
            "token".to_string(),
            "acme/repo".to_string(),
            GithubTrackerSettings {
                project_number: None,
                project_fields: None,
                active_states: vec![],
                terminal_states: vec![],
                labels_filter: vec![],
            },
        )
        .unwrap();

        // Empty IDs should return empty without making a request
        let issues = tracker.fetch_issue_states_by_ids(&[]).await.unwrap();
        assert!(issues.is_empty());
    }

    #[tokio::test]
    async fn test_error_non_200_status() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(401).set_body_string("Unauthorized"))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let result = tracker.fetch_candidate_issues().await;

        match result {
            Err(TrackerError::ApiStatus { status, body }) => {
                assert_eq!(status, 401);
                assert!(body.contains("Unauthorized"));
            }
            other => panic!("expected ApiStatus error, got: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_error_graphql_errors() {
        let server = MockServer::start().await;

        let response = json!({
            "data": null,
            "errors": [
                { "message": "Field 'repository' not found" },
                { "message": "Another error" }
            ]
        });

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let result = tracker.fetch_candidate_issues().await;

        match result {
            Err(TrackerError::GraphqlErrors { errors }) => {
                assert!(errors.contains("Field 'repository' not found"));
                assert!(errors.contains("Another error"));
            }
            other => panic!("expected GraphqlErrors, got: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_error_malformed_payload() {
        let server = MockServer::start().await;

        // Valid JSON but no "data" field
        let response = json!({ "something": "else" });

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let result = tracker.fetch_candidate_issues().await;

        assert!(matches!(
            result,
            Err(TrackerError::UnexpectedPayload { .. })
        ));
    }

    #[tokio::test]
    async fn test_normalization_labels_lowercased() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "id": "I_1",
                            "number": 1,
                            "title": "Test",
                            "body": "",
                            "createdAt": "2025-01-01T00:00:00Z",
                            "updatedAt": "2025-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/1",
                            "state": "OPEN",
                            "labels": {
                                "nodes": [
                                    { "name": "BUG" },
                                    { "name": "TODO" },
                                    { "name": "P1" }
                                ]
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].labels, vec!["bug", "todo", "p1"]);
    }

    #[tokio::test]
    async fn test_normalization_identifier_format() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "id": "I_abc",
                            "number": 42,
                            "title": "Test",
                            "body": "",
                            "createdAt": "2025-01-01T00:00:00Z",
                            "updatedAt": "2025-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/42",
                            "state": "OPEN",
                            "labels": { "nodes": [{ "name": "todo" }] }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        // Identifier uses repo name (not owner/repo)
        assert_eq!(issues[0].identifier, "my-repo#42");
    }

    #[tokio::test]
    async fn configured_priority_options_normalize_by_resolved_ids() {
        let server = MockServer::start().await;

        let discovery = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_1",
                    "fields": {
                        "pageInfo": { "hasNextPage": false, "endCursor": null },
                        "nodes": [
                            {
                                "id": "F_delivery",
                                "name": "Delivery state",
                                "options": [{ "id": "O_queued", "name": "Queued" }]
                            },
                            {
                                "id": "F_impact",
                                "name": "Customer impact",
                                "options": [
                                    { "id": "O_critical", "name": "Critical" },
                                    { "id": "O_normal", "name": "Normal" },
                                    { "id": "O_deferred", "name": "Deferred" }
                                ]
                            }
                        ]
                    }
                }
            }
        }));

        let items = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Queued",
                                        "optionId": "O_queued",
                                        "field": { "id": "F_delivery", "name": "Delivery state" }
                                    },
                                    {
                                        "name": "Normal",
                                        "optionId": "O_normal",
                                        "field": { "id": "F_impact", "name": "Customer impact" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_1",
                                "number": 1,
                                "title": "Configured priority",
                                "body": "",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-01T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/1",
                                "labels": { "nodes": [] }
                            }
                        },
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Queued",
                                        "optionId": "O_queued",
                                        "field": { "id": "F_delivery", "name": "Delivery state" }
                                    },
                                    {
                                        "name": "Deferred",
                                        "optionId": "O_deferred",
                                        "field": { "id": "F_impact", "name": "Customer impact" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_2",
                                "number": 2,
                                "title": "Unlisted priority",
                                "body": "",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-01T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/2",
                                "labels": { "nodes": [] }
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectNumber"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&discovery))
            .named("discovery")
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectId"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&items))
            .named("items")
            .mount(&server)
            .await;

        let tracker = GithubTracker::new(
            format!("{}/graphql", server.uri()),
            "ghp_test_token".to_string(),
            "acme/my-repo".to_string(),
            GithubTrackerSettings {
                project_number: Some(1),
                project_fields: Some(GithubTrackerConfig {
                    status_field: "Delivery state".to_string(),
                    priority: Some(crate::config::ensemble::GithubPriorityConfig {
                        field: "Customer impact".to_string(),
                        options: vec!["Critical".to_string(), "Normal".to_string()],
                    }),
                }),
                active_states: vec!["Queued".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec![],
            },
        )
        .unwrap();
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].priority, Some(2));
        assert_eq!(issues[1].priority, None);
    }

    #[tokio::test]
    async fn test_project_board_label_filtering() {
        let server = MockServer::start().await;

        let discovery = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_1",
                    "fields": {
                        "pageInfo": { "hasNextPage": false, "endCursor": null },
                        "nodes": [{
                            "id": "F_status",
                            "name": "Status",
                            "options": []
                        }]
                    }
                }
            }
        }));

        let items = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "fieldValues": { "nodes": [{ "name": "Todo", "field": { "name": "Status" } }] },
                            "content": {
                                "id": "I_match", "number": 1, "title": "Has matching label",
                                "body": "", "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/1",
                                "labels": { "nodes": [{ "name": "Bug" }] }
                            }
                        },
                        {
                            "fieldValues": { "nodes": [{ "name": "Todo", "field": { "name": "Status" } }] },
                            "content": {
                                "id": "I_no_match", "number": 2, "title": "No matching label",
                                "body": "", "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/2",
                                "labels": { "nodes": [{ "name": "Feature" }] }
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectNumber"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&discovery))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("projectId"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&items))
            .mount(&server)
            .await;

        // Tracker with labels_filter = ["bug"]
        let tracker = GithubTracker::new(
            format!("{}/graphql", server.uri()),
            "ghp_test_token".to_string(),
            "acme/my-repo".to_string(),
            GithubTrackerSettings {
                project_number: Some(1),
                project_fields: Some(GithubTrackerConfig {
                    status_field: "Status".to_string(),
                    priority: None,
                }),
                active_states: vec!["Todo".to_string()],
                terminal_states: vec!["Done".to_string()],
                labels_filter: vec!["bug".to_string()],
            },
        )
        .unwrap();

        let issues = tracker.fetch_candidate_issues().await.unwrap();

        // Only the issue with "Bug" label should pass the filter
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "I_match");
    }

    #[tokio::test]
    async fn test_repo_mode_canonical_state_casing() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [{
                        "id": "I_1", "number": 1, "title": "Test",
                        "body": "", "createdAt": "2025-01-01T00:00:00Z", "updatedAt": "2025-01-01T00:00:00Z",
                        "url": "https://github.com/acme/my-repo/issues/1",
                        "state": "OPEN",
                        "labels": { "nodes": [{ "name": "TODO" }] }
                    }]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        // Label "TODO" (lowercased to "todo") should map to canonical "Todo"
        assert_eq!(issues[0].state, "Todo");
    }

    #[tokio::test]
    async fn repo_mode_set_issue_state_replaces_configured_state_labels() {
        let server = MockServer::start().await;

        let state_response = graphql_response(json!({
            "nodes": [
                {
                    "id": "I_issue1",
                    "number": 1,
                    "title": "Move me",
                    "state": "OPEN",
                    "url": "https://github.com/acme/my-repo/issues/1",
                    "labels": {
                        "nodes": [
                            { "name": "Todo" },
                            { "name": "bug" }
                        ]
                    },
                    "projectItems": { "nodes": [] }
                }
            ]
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("nodes(ids"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&state_response))
            .expect(1)
            .mount(&server)
            .await;

        for (name, id) in [
            ("Todo", Some("L_todo")),
            ("In Progress", Some("L_progress")),
            ("Done", Some("L_done")),
            ("Closed", None),
        ] {
            let label_response = graphql_response(json!({
                "repository": {
                    "label": id.map(|id| json!({ "id": id, "name": name }))
                }
            }));
            Mock::given(method("POST"))
                .and(path("/graphql"))
                .and(body_string_contains(&format!("\"name\":\"{name}\"")))
                .respond_with(ResponseTemplate::new(200).set_body_json(&label_response))
                .expect(1)
                .mount(&server)
                .await;
        }

        let remove_response = graphql_response(json!({
            "removeLabelsFromLabelable": {
                "labelable": { "id": "I_issue1" }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("removeLabelsFromLabelable"))
            .and(body_string_contains("L_todo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&remove_response))
            .expect(1)
            .mount(&server)
            .await;

        let add_response = graphql_response(json!({
            "addLabelsToLabelable": {
                "labelable": { "id": "I_issue1" }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("addLabelsToLabelable"))
            .and(body_string_contains("L_done"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&add_response))
            .expect(1)
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        tracker.set_issue_state("I_issue1", "Done").await.unwrap();
    }

    #[tokio::test]
    async fn repo_mode_set_issue_state_resolves_target_label_outside_configured_states() {
        let server = MockServer::start().await;

        let state_response = graphql_response(json!({
            "nodes": [
                {
                    "id": "I_issue1",
                    "number": 1,
                    "title": "Move me",
                    "state": "OPEN",
                    "url": "https://github.com/acme/my-repo/issues/1",
                    "labels": {
                        "nodes": [
                            { "name": "In Progress" },
                            { "name": "bug" }
                        ]
                    },
                    "projectItems": { "nodes": [] }
                }
            ]
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("nodes(ids"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&state_response))
            .expect(1)
            .mount(&server)
            .await;

        for (name, id) in [
            ("Todo", Some("L_todo")),
            ("In Progress", Some("L_progress")),
            ("Done", Some("L_done")),
            ("Closed", None),
            ("Failed", Some("L_failed")),
        ] {
            let label_response = graphql_response(json!({
                "repository": {
                    "label": id.map(|id| json!({ "id": id, "name": name }))
                }
            }));
            Mock::given(method("POST"))
                .and(path("/graphql"))
                .and(body_string_contains(&format!("\"name\":\"{name}\"")))
                .respond_with(ResponseTemplate::new(200).set_body_json(&label_response))
                .expect(1)
                .mount(&server)
                .await;
        }

        let remove_response = graphql_response(json!({
            "removeLabelsFromLabelable": {
                "labelable": { "id": "I_issue1" }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("removeLabelsFromLabelable"))
            .and(body_string_contains("L_progress"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&remove_response))
            .expect(1)
            .mount(&server)
            .await;

        let add_response = graphql_response(json!({
            "addLabelsToLabelable": {
                "labelable": { "id": "I_issue1" }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("addLabelsToLabelable"))
            .and(body_string_contains("L_failed"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&add_response))
            .expect(1)
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        tracker.set_issue_state("I_issue1", "Failed").await.unwrap();
    }

    #[tokio::test]
    async fn repository_label_lookup_preserves_absent_repository_as_missing_label() {
        let server = MockServer::start().await;
        let response = graphql_response(json!({ "repository": null }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("label(name:"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let label_id = create_test_tracker(&server.uri(), None)
            .repository_label_id("Todo")
            .await
            .unwrap();

        assert_eq!(label_id, None);
    }

    #[tokio::test]
    async fn add_comment_accepts_missing_mutation_payload() {
        let server = MockServer::start().await;
        let response = graphql_response(json!({}));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("addComment"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        create_test_tracker(&server.uri(), None)
            .add_comment("ISSUE_NODE_1", "Hello")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn create_interaction_thread_root_returns_comment_metadata() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "addComment": {
                "commentEdge": {
                    "node": {
                        "id": "C_123",
                        "url": "https://github.com/acme/my-repo/issues/1#issuecomment-123"
                    }
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("addComment"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let root = tracker
            .create_interaction_thread_root("ISSUE_NODE_1", "Need input")
            .await
            .unwrap();

        assert_eq!(root.comment_id, "C_123");
        assert_eq!(
            root.comment_url.as_deref(),
            Some("https://github.com/acme/my-repo/issues/1#issuecomment-123")
        );
    }

    #[tokio::test]
    async fn interaction_root_rejects_missing_typed_comment_metadata() {
        let server = MockServer::start().await;
        let response = graphql_response(json!({ "addComment": { "commentEdge": null } }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("addComment"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let error = create_test_tracker(&server.uri(), None)
            .create_interaction_thread_root("ISSUE_NODE_1", "Need input")
            .await
            .unwrap_err();

        assert!(matches!(error, TrackerError::UnexpectedPayload { .. }));
        assert!(error.to_string().contains("AddComment"));
        assert!(error
            .to_string()
            .contains("missing addComment.commentEdge.node payload"));
    }

    #[tokio::test]
    async fn list_comments_after_returns_comments_after_anchor() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "node": {
                "comments": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "id": "C_1",
                            "body": "root",
                            "createdAt": "2026-01-01T00:00:00Z",
                            "updatedAt": "2026-01-01T00:00:00Z",
                            "author": { "login": "bot" }
                        },
                        {
                            "id": "C_2",
                            "body": "/approve",
                            "createdAt": "2026-01-01T00:01:00Z",
                            "updatedAt": "2026-01-01T00:01:00Z",
                            "author": { "login": "alice" }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("comments(first: 100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let comments = tracker
            .list_comments_after("ISSUE_NODE_1", "C_1")
            .await
            .unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].comment_id, "C_2");
        assert_eq!(comments[0].author, "alice");
    }

    #[tokio::test]
    async fn list_comments_after_paginates_with_shared_cursor_rules() {
        let server = MockServer::start().await;
        let first_page = graphql_response(json!({
            "node": {
                "comments": {
                    "pageInfo": { "hasNextPage": true, "endCursor": "comments_page_2" },
                    "nodes": [{
                        "id": "C_1",
                        "body": "root",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                        "author": { "login": "bot" }
                    }]
                }
            }
        }));
        let second_page = graphql_response(json!({
            "node": {
                "comments": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [{
                        "id": "C_2",
                        "body": "/approve",
                        "createdAt": "2026-01-01T00:01:00Z",
                        "updatedAt": "2026-01-01T00:01:00Z",
                        "author": { "login": "alice" }
                    }]
                }
            }
        }));
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("\"cursor\":null"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&first_page))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("comments_page_2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&second_page))
            .expect(1)
            .mount(&server)
            .await;

        let comments = create_test_tracker(&server.uri(), None)
            .list_comments_after("ISSUE_NODE_1", "C_1")
            .await
            .unwrap();

        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].comment_id, "C_2");
    }

    #[test]
    fn issue_states_query_requests_project_item_identity() {
        let compact_query = graphql::ISSUE_STATES_QUERY
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(compact_query
            .contains("projectItems(first: 100) { nodes { id position project { id } fieldValues"));
        assert!(compact_query.contains("fieldValues(first: 100)"));
        assert!(compact_query.contains("name optionId"));
    }

    #[test]
    fn project_items_query_requests_all_configured_field_values() {
        let compact_query = graphql::PROJECT_ITEMS_QUERY
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(compact_query.contains("fieldValues(first: 100)"));
    }

    #[tokio::test]
    async fn list_comments_after_rejects_missing_required_comment_fields() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "node": {
                "comments": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "id": "C_1",
                            "body": "root",
                            "createdAt": "2026-01-01T00:00:00Z",
                            "updatedAt": "2026-01-01T00:00:00Z",
                            "author": { "login": "bot" }
                        },
                        {
                            "id": "C_2",
                            "createdAt": "2026-01-01T00:01:00Z",
                            "updatedAt": "2026-01-01T00:01:00Z",
                            "author": { "login": "alice" }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let err = tracker
            .list_comments_after("ISSUE_NODE_1", "C_1")
            .await
            .unwrap_err();

        assert!(matches!(err, TrackerError::UnexpectedPayload { .. }));
        assert!(err.to_string().contains("IssueComments"));
        assert!(err.to_string().contains("missing field `body`"));
    }
}
