use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::{debug, info, warn};

use super::model::{InteractionThreadRoot, Issue, TrackerComment};
use super::{IssueTracker, TrackerError};

// --- GraphQL query constants ---

/// Discovery query: resolve Project v2 node ID and Status field ID.
const PROJECT_DISCOVERY_QUERY: &str = r#"
query($owner: String!, $repo: String!, $projectNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $projectNumber) {
      id
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  }
}
"#;

/// Fetch project items with pagination.
const PROJECT_ITEMS_QUERY: &str = r#"
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              body
              createdAt
              updatedAt
              url
              labels(first: 20) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

/// Fetch repository issues (no project board).
const REPO_ISSUES_QUERY: &str = r#"
query($owner: String!, $repo: String!, $cursor: String, $labels: [String!]) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $cursor, states: [OPEN, CLOSED], labels: $labels, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        body
        createdAt
        updatedAt
        url
        state
        labels(first: 20) {
          nodes {
            name
          }
        }
      }
    }
  }
}
"#;

/// Batch query for issue states by node IDs.
const ISSUE_STATES_QUERY: &str = r#"
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      number
      title
      state
      url
      labels(first: 20) {
        nodes {
          name
        }
      }
      projectItems(first: 100) {
        nodes {
          id
          project {
            id
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

const ADD_COMMENT_MUTATION: &str = r#"
mutation($subjectId: ID!, $body: String!) {
  addComment(input: {subjectId: $subjectId, body: $body}) {
    commentEdge {
      node {
        id
        url
      }
    }
  }
}
"#;

const ISSUE_COMMENTS_QUERY: &str = r#"
query($issueId: ID!, $cursor: String) {
  node(id: $issueId) {
    ... on Issue {
      comments(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          body
          createdAt
          updatedAt
          author {
            login
          }
        }
      }
    }
  }
}
"#;

const UPDATE_PROJECT_ITEM_FIELD_MUTATION: &str = r#"
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item {
      id
    }
  }
}
"#;

const REPOSITORY_LABEL_QUERY: &str = r#"
query($owner: String!, $repo: String!, $name: String!) {
  repository(owner: $owner, name: $repo) {
    label(name: $name) {
      id
      name
    }
  }
}
"#;

const ADD_LABELS_MUTATION: &str = r#"
mutation($labelableId: ID!, $labelIds: [ID!]!) {
  addLabelsToLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) {
    labelable {
      ... on Issue {
        id
      }
    }
  }
}
"#;

const REMOVE_LABELS_MUTATION: &str = r#"
mutation($labelableId: ID!, $labelIds: [ID!]!) {
  removeLabelsFromLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) {
    labelable {
      ... on Issue {
        id
      }
    }
  }
}
"#;

const FIND_PROJECT_ITEM_QUERY: &str = r#"
query($nodeId: ID!) {
  node(id: $nodeId) {
    ... on Issue {
      projectItems(first: 100) {
        nodes {
          id
          project {
            id
          }
        }
      }
    }
  }
}
"#;

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
    /// Cached project node ID (resolved at first use when project_number is set).
    project_node_id: tokio::sync::RwLock<Option<String>>,
    /// Cached Status field ID.
    status_field_id: tokio::sync::RwLock<Option<String>>,
    /// Cached Status option name -> option ID map.
    status_option_ids: tokio::sync::RwLock<HashMap<String, String>>,
}

impl GithubTracker {
    /// Create a new GithubTracker.
    ///
    /// Parses `owner/repo` from the repository string.
    /// The reqwest client is created with a 30-second timeout.
    pub fn new(
        endpoint: String,
        token: String,
        repository: String,
        project_number: Option<i64>,
        active_states: Vec<String>,
        terminal_states: Vec<String>,
        labels_filter: Vec<String>,
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
            project_number,
            active_states,
            terminal_states,
            labels_filter,
            client,
            project_node_id: tokio::sync::RwLock::new(None),
            status_field_id: tokio::sync::RwLock::new(None),
            status_option_ids: tokio::sync::RwLock::new(HashMap::new()),
        })
    }

    /// Execute a GraphQL query against the configured endpoint.
    async fn graphql(&self, query: &str, variables: Value) -> Result<Value, TrackerError> {
        let body = json!({
            "query": query,
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
                body: body_text,
            });
        }

        let json_body: Value =
            response
                .json()
                .await
                .map_err(|e| TrackerError::UnexpectedPayload {
                    reason: format!("failed to parse response JSON: {e}"),
                })?;

        // Check for GraphQL errors
        if let Some(errors) = json_body.get("errors") {
            if let Some(arr) = errors.as_array() {
                if !arr.is_empty() {
                    let messages: Vec<String> = arr
                        .iter()
                        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                        .map(|s| s.to_string())
                        .collect();
                    return Err(TrackerError::GraphqlErrors {
                        errors: messages.join("; "),
                    });
                }
            }
        }

        json_body
            .get("data")
            .cloned()
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "response missing 'data' field".to_string(),
            })
    }

    /// Discover the project node ID and status field ID via GraphQL.
    /// Caches results for subsequent calls.
    async fn ensure_project_metadata(&self) -> Result<(String, String), TrackerError> {
        // Check cache first
        {
            let node_id = self.project_node_id.read().await;
            let field_id = self.status_field_id.read().await;
            if let (Some(nid), Some(fid)) = (node_id.as_ref(), field_id.as_ref()) {
                return Ok((nid.clone(), fid.clone()));
            }
        }

        let project_number =
            self.project_number
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "project_number is required for project board mode".to_string(),
                })?;

        info!(
            owner = %self.owner,
            repo = %self.repo,
            project_number,
            "discovering project metadata"
        );

        let variables = json!({
            "owner": self.owner,
            "repo": self.repo,
            "projectNumber": project_number,
        });

        let data = self.graphql(PROJECT_DISCOVERY_QUERY, variables).await?;

        let project = data.pointer("/repository/projectV2").ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "project not found in discovery response".to_string(),
            }
        })?;

        let project_id = project
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "project ID not found".to_string(),
            })?
            .to_string();

        // Find the Status field
        let fields = project
            .pointer("/fields/nodes")
            .and_then(|v| v.as_array())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "project fields not found".to_string(),
            })?;

        let status_field = fields
            .iter()
            .find(|f| f.get("name").and_then(|n| n.as_str()) == Some("Status"))
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "Status field not found in project".to_string(),
            })?;

        let status_field_id = status_field
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "Status field ID not found".to_string(),
            })?
            .to_string();

        // Extract status option name -> ID map
        let option_ids: HashMap<String, String> = status_field
            .pointer("/options")
            .and_then(|v| v.as_array())
            .map(|opts| {
                opts.iter()
                    .filter_map(|opt| {
                        let name = opt.get("name")?.as_str()?.to_string();
                        let id = opt.get("id")?.as_str()?.to_string();
                        Some((name, id))
                    })
                    .collect()
            })
            .unwrap_or_default();

        info!(
            project_id = %project_id,
            status_field_id = %status_field_id,
            option_count = option_ids.len(),
            "project metadata discovered"
        );

        // Cache results
        {
            let mut node_id_lock = self.project_node_id.write().await;
            *node_id_lock = Some(project_id.clone());
        }
        {
            let mut field_id_lock = self.status_field_id.write().await;
            *field_id_lock = Some(status_field_id.clone());
        }
        {
            let mut option_ids_lock = self.status_option_ids.write().await;
            *option_ids_lock = option_ids;
        }

        Ok((project_id, status_field_id))
    }

    /// Fetch all project items with pagination, filtering by active states.
    async fn fetch_project_items(
        &self,
        filter_states: &[String],
    ) -> Result<Vec<Issue>, TrackerError> {
        let (project_id, _status_field_id) = self.ensure_project_metadata().await?;

        let mut all_issues = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let variables = json!({
                "projectId": project_id,
                "cursor": cursor,
            });

            let data = self.graphql(PROJECT_ITEMS_QUERY, variables).await?;

            let items_data =
                data.pointer("/node/items")
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "items not found in project response".to_string(),
                    })?;

            let page_info =
                items_data
                    .get("pageInfo")
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "pageInfo not found".to_string(),
                    })?;

            let has_next = page_info
                .get("hasNextPage")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let nodes = items_data
                .pointer("/nodes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "items nodes not found".to_string(),
                })?;

            for node in nodes {
                if let Some(issue) = self.normalize_project_item(node, filter_states) {
                    all_issues.push(issue);
                }
            }

            if has_next {
                cursor = page_info
                    .get("endCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    return Err(TrackerError::MissingEndCursor);
                }
            } else {
                break;
            }
        }

        Ok(all_issues)
    }

    /// Normalize a single ProjectV2 item node into an Issue.
    /// Returns None if the item's status doesn't match the filter states
    /// or if the content is not an Issue.
    fn normalize_project_item(&self, node: &Value, filter_states: &[String]) -> Option<Issue> {
        let content = node.get("content")?;

        // Must be an Issue (not Draft or PR)
        let id = content.get("id")?.as_str()?;
        let number = content.get("number")?.as_u64()?;
        let title = content.get("title")?.as_str()?;

        // Extract status from field values
        let status = self.extract_status_from_field_values(node);

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

        let body = content
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let url = content
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

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

        let priority = extract_priority_from_field_values(node);

        let created_at = content
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let updated_at = content
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let identifier = format!("{}#{}", self.repo, number);

        Some(Issue {
            id: id.to_string(),
            identifier,
            title: title.to_string(),
            description: body,
            priority,
            state: status.unwrap_or_else(|| "unknown".to_string()),
            branch_name: None,
            url,
            labels,
            blocked_by: vec![],
            created_at,
            updated_at,
        })
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

    /// Extract the Status field value from a project item's fieldValues.
    fn extract_status_from_field_values(&self, node: &Value) -> Option<String> {
        let field_values = node
            .pointer("/fieldValues/nodes")
            .and_then(|v| v.as_array())?;

        for fv in field_values {
            let field_name = fv.pointer("/field/name").and_then(|v| v.as_str());
            if field_name == Some("Status") {
                return fv
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
        None
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

            let data = self.graphql(REPO_ISSUES_QUERY, variables).await?;

            let issues_data = data.pointer("/repository/issues").ok_or_else(|| {
                TrackerError::UnexpectedPayload {
                    reason: "issues not found in repo response".to_string(),
                }
            })?;

            let page_info =
                issues_data
                    .get("pageInfo")
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "pageInfo not found".to_string(),
                    })?;

            let has_next = page_info
                .get("hasNextPage")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let nodes = issues_data
                .get("nodes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "issue nodes not found".to_string(),
                })?;

            for node in nodes {
                if let Some(issue) = self.normalize_repo_issue(node, filter_states) {
                    all_issues.push(issue);
                }
            }

            if has_next {
                cursor = page_info
                    .get("endCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    return Err(TrackerError::MissingEndCursor);
                }
            } else {
                break;
            }
        }

        Ok(all_issues)
    }

    /// Normalize a single repository issue node into an Issue.
    fn normalize_repo_issue(&self, node: &Value, filter_states: &[String]) -> Option<Issue> {
        let id = node.get("id")?.as_str()?;
        let number = node.get("number")?.as_u64()?;
        let title = node.get("title")?.as_str()?;

        let labels = extract_labels(node);

        // Determine state: match labels to canonical configured names,
        // falling back to raw GitHub open/closed.
        let raw_state = node
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("open")
            .to_lowercase();

        let state = self.canonical_state_from_labels(&labels, raw_state);

        // Filter by state
        if !filter_states.is_empty()
            && !filter_states.iter().any(|s| s.eq_ignore_ascii_case(&state))
        {
            return None;
        }

        let body = node
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let url = node
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let created_at = node
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let updated_at = node
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let identifier = format!("{}#{}", self.repo, number);

        Some(Issue {
            id: id.to_string(),
            identifier,
            title: title.to_string(),
            description: body,
            priority: None,
            state,
            branch_name: None,
            url,
            labels,
            blocked_by: vec![],
            created_at,
            updated_at,
        })
    }

    /// Batch fetch issue states by node IDs.
    async fn fetch_states_by_node_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let configured_project_id = if self.project_number.is_some() {
            Some(self.ensure_project_metadata().await?.0)
        } else {
            None
        };

        let variables = json!({
            "ids": ids,
        });

        let data = self.graphql(ISSUE_STATES_QUERY, variables).await?;

        let nodes = data
            .get("nodes")
            .and_then(|v| v.as_array())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "nodes not found in state refresh response".to_string(),
            })?;

        let mut issues = Vec::new();
        for node in nodes {
            if node.is_null() {
                continue;
            }
            if let Some(issue) =
                self.normalize_state_node(node, configured_project_id.as_deref())?
            {
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
        let data = self.graphql(REPOSITORY_LABEL_QUERY, variables).await?;
        Ok(data
            .pointer("/repository/label/id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned))
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
            self.graphql(
                REMOVE_LABELS_MUTATION,
                json!({
                    "labelableId": id,
                    "labelIds": remove_label_ids,
                }),
            )
            .await?;
        }

        let already_has_target = current
            .labels
            .iter()
            .any(|label| label.eq_ignore_ascii_case(state));
        if !already_has_target {
            self.graphql(
                ADD_LABELS_MUTATION,
                json!({
                    "labelableId": id,
                    "labelIds": [target_label_id],
                }),
            )
            .await?;
        }

        Ok(())
    }

    /// Find the project item ID for an issue node within the configured project.
    async fn find_project_item_id(&self, issue_node_id: &str) -> Result<String, TrackerError> {
        let variables = json!({ "nodeId": issue_node_id });
        let data = self.graphql(FIND_PROJECT_ITEM_QUERY, variables).await?;

        let project_id = {
            let lock = self.project_node_id.read().await;
            lock.clone()
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "project node ID not set".to_string(),
                })?
        };

        let items = data
            .pointer("/node/projectItems/nodes")
            .and_then(|v| v.as_array())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "missing projectItems in response".to_string(),
            })?;

        for item in items {
            if let Some(proj_id) = item.pointer("/project/id").and_then(|v| v.as_str()) {
                if proj_id == project_id {
                    if let Some(item_id) = item.get("id").and_then(|v| v.as_str()) {
                        return Ok(item_id.to_string());
                    }
                }
            }
        }

        Err(TrackerError::UnexpectedPayload {
            reason: format!("issue {} not found in project", issue_node_id),
        })
    }

    /// Normalize a node from the state refresh query.
    fn normalize_state_node(
        &self,
        node: &Value,
        configured_project_id: Option<&str>,
    ) -> Result<Option<Issue>, TrackerError> {
        let Some(id) = node.get("id").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some(number) = node.get("number").and_then(Value::as_u64) else {
            return Ok(None);
        };
        let Some(title) = node.get("title") else {
            return Ok(None);
        };
        let title = title.as_str().unwrap_or("").to_string();

        let labels = extract_labels(node);

        let state = if let Some(configured_project_id) = configured_project_id {
            let items = node
                .pointer("/projectItems/nodes")
                .and_then(Value::as_array)
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: format!("issue {id} is missing projectItems nodes"),
                })?;
            let (item_id, item) = select_configured_project_item(id, configured_project_id, items)?;
            self.extract_status_from_field_values(item).ok_or_else(|| {
                TrackerError::UnexpectedPayload {
                    reason: format!(
                        "issue {id} project item {item_id} in configured project {configured_project_id} is missing Status"
                    ),
                }
            })?
        } else {
            let raw_state = node
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("open")
                .to_lowercase();

            // In repo-mode, derive canonical state from labels to stay consistent
            // with normalize_repo_issue.
            self.canonical_state_from_labels(&labels, raw_state)
        };

        let url = node
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let identifier = format!("{}#{}", self.repo, number);

        Ok(Some(Issue {
            id: id.to_string(),
            identifier,
            title,
            description: None,
            priority: None,
            state,
            branch_name: None,
            url,
            labels,
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }))
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
fn extract_labels(node: &Value) -> Vec<String> {
    node.pointer("/labels/nodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                .map(|s| s.to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// Select the one ProjectV2 item for an issue in the configured project.
fn select_configured_project_item<'a>(
    issue_node_id: &str,
    configured_project_id: &str,
    items: &'a [Value],
) -> Result<(&'a str, &'a Value), TrackerError> {
    let mut configured_items = Vec::new();

    for (index, item) in items.iter().enumerate() {
        let item_id = item.get("id").and_then(Value::as_str).ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: format!(
                    "issue {issue_node_id} project item at index {index} is missing item ID"
                ),
            }
        })?;
        let project_id = item
            .pointer("/project/id")
            .and_then(Value::as_str)
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

/// Extract priority from project item field values.
///
/// Looks for a "Priority" single-select field and maps known values:
/// Urgent=1, High=2, Medium=3, Low=4.
fn extract_priority_from_field_values(node: &Value) -> Option<i32> {
    let field_values = node
        .pointer("/fieldValues/nodes")
        .and_then(|v| v.as_array())?;

    for fv in field_values {
        let field_name = fv.pointer("/field/name").and_then(|v| v.as_str());
        if field_name == Some("Priority") {
            if let Some(value) = fv.get("name").and_then(|v| v.as_str()) {
                return match value.to_lowercase().as_str() {
                    "urgent" => Some(1),
                    "high" => Some(2),
                    "medium" => Some(3),
                    "low" => Some(4),
                    _ => None,
                };
            }
        }
    }
    None
}

#[async_trait]
impl IssueTracker for GithubTracker {
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
        self.graphql(ADD_COMMENT_MUTATION, variables).await?;
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
        let data = self.graphql(ADD_COMMENT_MUTATION, variables).await?;
        let node = data
            .pointer("/addComment/commentEdge/node")
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "missing addComment.commentEdge.node payload".to_string(),
            })?;
        let comment_id = node.get("id").and_then(Value::as_str).ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "missing comment id in addComment payload".to_string(),
            }
        })?;
        let comment_url = node
            .get("url")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        Ok(InteractionThreadRoot {
            comment_id: comment_id.to_string(),
            comment_url,
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
            let data = self.graphql(ISSUE_COMMENTS_QUERY, variables).await?;
            let comments_node =
                data.pointer("/node/comments")
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "missing issue comments payload".to_string(),
                    })?;
            let nodes = comments_node
                .get("nodes")
                .and_then(Value::as_array)
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "missing issue comments nodes".to_string(),
                })?;

            for node in nodes {
                let comment_id = node.get("id").and_then(Value::as_str).ok_or_else(|| {
                    TrackerError::UnexpectedPayload {
                        reason: "missing issue comment id".to_string(),
                    }
                })?;
                let body = node.get("body").and_then(Value::as_str).ok_or_else(|| {
                    TrackerError::UnexpectedPayload {
                        reason: "missing issue comment body".to_string(),
                    }
                })?;
                comments.push(TrackerComment {
                    comment_id: comment_id.to_string(),
                    body: body.to_string(),
                    author: node
                        .pointer("/author/login")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    created_at: node
                        .get("createdAt")
                        .and_then(Value::as_str)
                        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.with_timezone(&Utc)),
                    updated_at: node
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                        .map(|value| value.with_timezone(&Utc)),
                });
            }

            let page_info =
                comments_node
                    .get("pageInfo")
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "missing issue comments pageInfo".to_string(),
                    })?;
            let has_next = page_info
                .get("hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !has_next {
                break;
            }
            cursor = page_info
                .get("endCursor")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if cursor.is_none() {
                return Err(TrackerError::MissingEndCursor);
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
            // Ensure project metadata is discovered (populates project_node_id,
            // status_field_id, and status_option_ids).
            self.ensure_project_metadata().await?;

            let project_id = {
                let lock = self.project_node_id.read().await;
                lock.clone()
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "project node ID not discovered".to_string(),
                    })?
            };
            let field_id = {
                let lock = self.status_field_id.read().await;
                lock.clone()
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: "status field ID not discovered".to_string(),
                    })?
            };
            let option_id = {
                let lock = self.status_option_ids.read().await;
                lock.get(state)
                    .cloned()
                    .ok_or_else(|| TrackerError::UnexpectedPayload {
                        reason: format!("unknown status option: {}", state),
                    })?
            };

            let item_id = self.find_project_item_id(id).await?;

            let variables = json!({
                "projectId": project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "optionId": option_id,
            });
            self.graphql(UPDATE_PROJECT_ITEM_FIELD_MUTATION, variables)
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
            project_number,
            vec!["Todo".to_string(), "In Progress".to_string()],
            vec!["Done".to_string(), "Closed".to_string()],
            vec![],
        )
        .unwrap()
    }

    /// Build a GraphQL response body wrapping the given data.
    fn graphql_response(data: Value) -> Value {
        json!({ "data": data })
    }

    async fn mount_project_discovery(server: &MockServer, project_id: &str) {
        let response = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": project_id,
                    "fields": {
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
        let node = json!({
            "labels": {
                "nodes": [
                    { "name": "Bug" },
                    { "name": "ENHANCEMENT" },
                    { "name": "p1" }
                ]
            }
        });
        let labels = extract_labels(&node);
        assert_eq!(labels, vec!["bug", "enhancement", "p1"]);
    }

    #[test]
    fn test_extract_labels_empty() {
        let node = json!({});
        let labels = extract_labels(&node);
        assert!(labels.is_empty());
    }

    // --- extract_priority tests ---

    #[test]
    fn test_extract_priority_urgent() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Urgent",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(1));
    }

    #[test]
    fn test_extract_priority_high() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "High",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(2));
    }

    #[test]
    fn test_extract_priority_medium() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Medium",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(3));
    }

    #[test]
    fn test_extract_priority_low() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Low",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(4));
    }

    #[test]
    fn test_extract_priority_none() {
        let node = json!({
            "fieldValues": {
                "nodes": []
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), None);
    }

    #[test]
    fn test_extract_priority_skips_non_priority_fields() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Todo",
                        "field": { "name": "Status" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), None);
    }

    // --- project-mode state reconciliation tests ---

    #[test]
    fn configured_project_item_rejects_missing_project_identity() {
        let items = json!([{ "id": "PVTI_unknown" }]);

        let result =
            select_configured_project_item("I_node1", "P_configured", items.as_array().unwrap());

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
        let items = json!([{ "id": "PVTI_other", "project": { "id": "P_other" } }]);

        let result =
            select_configured_project_item("I_node1", "P_configured", items.as_array().unwrap());

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
        let items = json!([
            { "id": "PVTI_b", "project": { "id": "P_configured" } },
            { "id": "PVTI_a", "project": { "id": "P_configured" } }
        ]);

        let result =
            select_configured_project_item("I_node1", "P_configured", items.as_array().unwrap());

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
        let node = json!({
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
        });

        let result = tracker.normalize_state_node(&node, Some("P_configured"));

        match result {
            Err(TrackerError::UnexpectedPayload { reason }) => assert_eq!(
                reason,
                "issue I_node1 project item PVTI_configured in configured project P_configured is missing Status"
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
                        "nodes": [
                            {
                                "id": "FIELD_status_1",
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
            None,
            vec![],
            vec![],
            vec![],
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
    async fn test_normalization_priority_mapping_from_project() {
        let server = MockServer::start().await;

        // Discovery
        let discovery = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_1",
                    "fields": {
                        "nodes": [
                            {
                                "id": "F_status",
                                "name": "Status",
                                "options": []
                            }
                        ]
                    }
                }
            }
        }));

        // Items with priority field
        let items = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Todo",
                                        "field": { "name": "Status" }
                                    },
                                    {
                                        "name": "High",
                                        "field": { "name": "Priority" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_1",
                                "number": 1,
                                "title": "High priority",
                                "body": "",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-01T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/1",
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

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].priority, Some(2)); // High = 2
    }

    #[tokio::test]
    async fn test_project_board_label_filtering() {
        let server = MockServer::start().await;

        let discovery = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_1",
                    "fields": {
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
            Some(1),
            vec!["Todo".to_string()],
            vec!["Done".to_string()],
            vec!["bug".to_string()],
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

    #[test]
    fn issue_states_query_requests_project_item_identity() {
        let compact_query = ISSUE_STATES_QUERY
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(compact_query
            .contains("projectItems(first: 100) { nodes { id project { id } fieldValues"));
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
        assert!(err.to_string().contains("missing issue comment body"));
    }
}
