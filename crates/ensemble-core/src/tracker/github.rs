use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use tracing::{debug, info, warn};

use crate::observability::events_contract::{
    TRACKER_TRANSITION_FAILED, TRACKER_TRANSITION_REQUESTED, TRACKER_TRANSITION_SUCCEEDED,
};
use super::model::Issue;
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
            if let Some(issue) = self.normalize_state_node(node) {
                issues.push(issue);
            }
        }

        Ok(issues)
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
    fn normalize_state_node(&self, node: &Value) -> Option<Issue> {
        let id = node.get("id")?.as_str()?;
        let number = node.get("number")?.as_u64()?;
        let title = node.get("title")?.as_str().unwrap_or("").to_string();

        let labels = extract_labels(node);

        // Try to get state from project items first
        let project_state = node
            .pointer("/projectItems/nodes")
            .and_then(|v| v.as_array())
            .and_then(|items| {
                for item in items {
                    let field_values = item
                        .pointer("/fieldValues/nodes")
                        .and_then(|v| v.as_array());
                    if let Some(fvs) = field_values {
                        for fv in fvs {
                            let field_name = fv.pointer("/field/name").and_then(|v| v.as_str());
                            if field_name == Some("Status") {
                                return fv
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                            }
                        }
                    }
                }
                None
            });

        let state = project_state.unwrap_or_else(|| {
            let raw_state = node
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open")
                .to_lowercase();

            // In repo-mode, derive canonical state from labels to stay consistent
            // with normalize_repo_issue.
            self.canonical_state_from_labels(&labels, raw_state)
        });

        let url = node
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let identifier = format!("{}#{}", self.repo, number);

        Some(Issue {
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
        })
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
        // Repo mode doesn't support state writes yet (label-based transitions not implemented).
        self.project_number.is_some()
    }

    async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
        let variables = json!({
            "subjectId": id,
            "body": body,
        });
        self.graphql(ADD_COMMENT_MUTATION, variables).await?;
        Ok(())
    }

    async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
        info!(
            event = TRACKER_TRANSITION_REQUESTED,
            issue_id = id,
            tracker_state_to = state,
            "github tracker state transition requested"
        );

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
            if let Err(error) = self.graphql(UPDATE_PROJECT_ITEM_FIELD_MUTATION, variables).await {
                warn!(
                    event = TRACKER_TRANSITION_FAILED,
                    issue_id = id,
                    tracker_state_to = state,
                    error = %error,
                    "github tracker state transition failed"
                );
                return Err(error);
            }
            info!(
                event = TRACKER_TRANSITION_SUCCEEDED,
                issue_id = id,
                tracker_state_to = state,
                "github tracker state transition succeeded"
            );
            Ok(())
        } else {
            tracing::warn!(
                event = TRACKER_TRANSITION_FAILED,
                issue_id = id,
                target_state = state,
                "set_issue_state in repo mode: label-based state transitions not yet implemented"
            );
            Err(TrackerError::WritesNotSupported)
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
                    "projectItems": { "nodes": [] }
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

        // Third issue has no project status, falls back to GitHub state
        assert_eq!(issues[1].id, "I_node3");
        assert_eq!(issues[1].state, "closed");
        assert_eq!(issues[1].identifier, "my-repo#99");
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
}
