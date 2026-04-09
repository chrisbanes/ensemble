use super::{IssueTracker, TrackerError};
use crate::config::ensemble::TrackerConfig;
use crate::tracker::model::Issue;
use async_trait::async_trait;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

/// Notion issue tracker adapter.
pub struct NotionTracker {
    client: reqwest::Client,
    token: String,
    base_url: String,
    database_id: String,
    active_states: Vec<String>,
    _terminal_states: Vec<String>,
    status_property: String,
    title_property: String,
    enabled_property: String,
    enabled_value_bool: bool,
    notion_version: String,
}

impl NotionTracker {
    pub fn new(token: String, database_id: String, config: &TrackerConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            token,
            base_url: config
                .endpoint
                .clone()
                .unwrap_or_else(|| "https://api.notion.com".to_string()),
            database_id,
            active_states: config.active_states.clone(),
            _terminal_states: config.terminal_states.clone(),
            status_property: config.status_property.clone(),
            title_property: config.title_property.clone(),
            enabled_property: config.enabled_property.clone(),
            enabled_value_bool: config.enabled_value_bool,
            notion_version: config.notion_version.clone(),
        }
    }

    fn notion_request(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header("Notion-Version", self.notion_version.clone())
            .header(CONTENT_TYPE, "application/json")
    }

    async fn query_database(&self) -> Result<Vec<Value>, TrackerError> {
        let url = format!("{}/v1/databases/{}/query", self.base_url, self.database_id);
        let resp = self
            .notion_request(self.client.post(url))
            .json(&json!({}))
            .send()
            .await
            .map_err(|error| TrackerError::ApiRequestFailed {
                reason: error.to_string(),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "failed to read response body".to_string());
            return Err(TrackerError::ApiStatus {
                status: status.as_u16(),
                body,
            });
        }

        let payload: Value = resp.json().await.map_err(|error| TrackerError::UnexpectedPayload {
            reason: error.to_string(),
        })?;

        let results = payload
            .get("results")
            .and_then(Value::as_array)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "missing results array".to_string(),
            })?;

        Ok(results.clone())
    }

    async fn fetch_page(&self, id: &str) -> Result<Value, TrackerError> {
        let url = format!("{}/v1/pages/{id}", self.base_url);
        let resp = self
            .notion_request(self.client.get(url))
            .send()
            .await
            .map_err(|error| TrackerError::ApiRequestFailed {
                reason: error.to_string(),
            })?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "failed to read response body".to_string());
            return Err(TrackerError::ApiStatus {
                status: status.as_u16(),
                body,
            });
        }

        resp.json()
            .await
            .map_err(|error| TrackerError::UnexpectedPayload {
                reason: error.to_string(),
            })
    }

    fn page_to_issue(&self, page: &Value) -> Result<Issue, TrackerError> {
        let id = page
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "page.id missing".to_string(),
            })?;

        let title = self.extract_title(page).unwrap_or_else(|| id.to_string());
        let state = self
            .extract_state(page)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!("status property '{}' missing", self.status_property),
            })?;

        Ok(Issue {
            id: id.to_string(),
            identifier: id.to_string(),
            title,
            description: None,
            priority: None,
            state,
            branch_name: None,
            url: None,
            labels: vec![],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        })
    }

    fn extract_title(&self, page: &Value) -> Option<String> {
        page.get("properties")
            .and_then(|properties| properties.get(&self.title_property))
            .and_then(|value| value.get("title"))
            .and_then(Value::as_array)
            .and_then(|title_entries| title_entries.first())
            .and_then(|first| first.get("plain_text"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    }

    fn extract_state(&self, page: &Value) -> Option<String> {
        page.get("properties")
            .and_then(|properties| properties.get(&self.status_property))
            .and_then(|value| value.get("select"))
            .and_then(|select| select.get("name"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    }

    fn extract_enabled(&self, page: &Value) -> Option<bool> {
        page.get("properties")
            .and_then(|properties| properties.get(&self.enabled_property))
            .and_then(|value| value.get("checkbox"))
            .and_then(Value::as_bool)
    }
}

#[async_trait]
impl IssueTracker for NotionTracker {
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        let pages = self.query_database().await?;
        let mut issues = Vec::new();

        for page in &pages {
            let Some(state) = self.extract_state(page) else {
                continue;
            };
            let Some(enabled) = self.extract_enabled(page) else {
                continue;
            };

            if self.active_states.contains(&state) && enabled == self.enabled_value_bool {
                issues.push(self.page_to_issue(page)?);
            }
        }

        Ok(issues)
    }

    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        let pages = self.query_database().await?;
        let mut issues = Vec::new();

        for page in &pages {
            let Some(state) = self.extract_state(page) else {
                continue;
            };

            if states.contains(&state) {
                issues.push(self.page_to_issue(page)?);
            }
        }

        Ok(issues)
    }

    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        let mut issues = Vec::with_capacity(ids.len());
        for id in ids {
            let page = self.fetch_page(id).await?;
            issues.push(self.page_to_issue(&page)?);
        }
        Ok(issues)
    }

    fn supports_writes(&self) -> bool {
        true
    }

    async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
        let url = format!("{}/v1/pages/{id}", self.base_url);
        let resp = self
            .notion_request(self.client.patch(url))
            .json(&json!({
                "properties": {
                    self.status_property.clone(): {
                        "select": { "name": state }
                    }
                }
            }))
            .send()
            .await
            .map_err(|error| TrackerError::ApiRequestFailed {
                reason: error.to_string(),
            })?;

        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status().as_u16();
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "failed to read response body".to_string());
            Err(TrackerError::ApiStatus { status, body })
        }
    }

    async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
        let url = format!("{}/v1/comments", self.base_url);
        let resp = self
            .notion_request(self.client.post(url))
            .json(&json!({
                "parent": { "page_id": id },
                "rich_text": [{
                    "type": "text",
                    "text": { "content": body }
                }]
            }))
            .send()
            .await
            .map_err(|error| TrackerError::ApiRequestFailed {
                reason: error.to_string(),
            })?;

        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status().as_u16();
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "failed to read response body".to_string());
            Err(TrackerError::ApiStatus { status, body })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::IssueTracker;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_tracker(server_uri: &str) -> NotionTracker {
        let config = TrackerConfig {
            kind: "notion".to_string(),
            active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            terminal_states: vec!["Done".to_string(), "Closed".to_string()],
            path: None,
            endpoint: Some(server_uri.to_string()),
            gh_hostname: None,
            api_key: Some("token".to_string()),
            repository: None,
            project_number: None,
            labels_filter: vec![],
            database_id: Some("deadbeefdeadbeefdeadbeefdeadbeef".to_string()),
            notion_version: "2022-06-28".to_string(),
            title_property: "Name".to_string(),
            status_property: "Status".to_string(),
            enabled_property: "Ready to Implement".to_string(),
            enabled_value_bool: true,
        };
        NotionTracker::new(
            "token".to_string(),
            "deadbeefdeadbeefdeadbeefdeadbeef".to_string(),
            &config,
        )
    }

    #[tokio::test]
    async fn fetch_candidate_issues_filters_active_and_opt_in() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [
                    {
                        "id": "page-a",
                        "properties": {
                            "Name": { "title": [ { "plain_text": "A task" } ] },
                            "Status": { "select": { "name": "Todo" } },
                            "Ready to Implement": { "checkbox": true }
                        }
                    },
                    {
                        "id": "page-b",
                        "properties": {
                            "Name": { "title": [ { "plain_text": "Done task" } ] },
                            "Status": { "select": { "name": "Done" } },
                            "Ready to Implement": { "checkbox": true }
                        }
                    },
                    {
                        "id": "page-c",
                        "properties": {
                            "Name": { "title": [ { "plain_text": "Not enabled" } ] },
                            "Status": { "select": { "name": "Todo" } },
                            "Ready to Implement": { "checkbox": false }
                        }
                    }
                ],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "page-a");
        assert_eq!(issues[0].title, "A task");
        assert_eq!(issues[0].state, "Todo");
    }

    #[tokio::test]
    async fn fetch_issue_states_by_ids_returns_current_status_for_each_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/pages/page-a"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "page-a",
                "properties": {
                    "Name": { "title": [ { "plain_text": "A task" } ] },
                    "Status": { "select": { "name": "In Progress" } }
                }
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let issues = tracker
            .fetch_issue_states_by_ids(&["page-a".to_string()])
            .await
            .unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "page-a");
        assert_eq!(issues[0].state, "In Progress");
        assert_eq!(issues[0].title, "A task");
    }

    #[tokio::test]
    async fn set_issue_state_updates_status_property() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path("/v1/pages/page-a"))
            .and(body_string_contains("\"Status\""))
            .and(body_string_contains("\"In Review\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "page-a"})))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        tracker.set_issue_state("page-a", "In Review").await.unwrap();
    }

    #[tokio::test]
    async fn add_comment_posts_to_page_comments_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/comments"))
            .and(body_string_contains("\"page_id\":\"page-a\""))
            .and(body_string_contains("hello from ensemble"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "comment-1"})))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        tracker
            .add_comment("page-a", "hello from ensemble")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn notion_429_maps_to_api_status_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let err = tracker.fetch_candidate_issues().await.unwrap_err();
        assert!(matches!(err, TrackerError::ApiStatus { status: 429, .. }));
    }

    #[tokio::test]
    async fn notion_401_maps_to_api_status_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let err = tracker.fetch_candidate_issues().await.unwrap_err();
        assert!(matches!(err, TrackerError::ApiStatus { status: 401, .. }));
    }
}
