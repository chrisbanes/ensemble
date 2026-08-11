use super::{IssueTracker, TrackerError};
use crate::config::ensemble::TrackerConfig;
use crate::tracker::model::{InteractionThreadRoot, Issue, TrackerComment};
use async_trait::async_trait;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::sleep;

/// Notion issue tracker adapter.
pub struct NotionTracker {
    client: reqwest::Client,
    token: String,
    base_url: String,
    database_id: String,
    active_states: Vec<String>,
    status_property: String,
    title_property: String,
    enabled_property: String,
    enabled_value_bool: bool,
    notion_version: String,
    max_retries: u32,
    initial_retry_delay: Duration,
}

impl NotionTracker {
    pub fn new(token: String, database_id: String, config: &TrackerConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            token,
            base_url: config
                .endpoint
                .clone()
                .unwrap_or_else(|| "https://api.notion.com".to_string()),
            database_id,
            active_states: config.active_states.clone(),
            status_property: config.notion_status_property().to_string(),
            title_property: config.notion_title_property().to_string(),
            enabled_property: config.notion_enabled_property().to_string(),
            enabled_value_bool: config.notion_enabled_value_bool(),
            notion_version: config.notion_version().to_string(),
            max_retries: 3,
            initial_retry_delay: Duration::from_millis(250),
        }
    }

    fn notion_request(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header(AUTHORIZATION, format!("Bearer {}", self.token))
            .header("Notion-Version", self.notion_version.clone())
            .header(CONTENT_TYPE, "application/json")
    }

    fn is_retryable_status(status: u16) -> bool {
        status == 429 || (500..=599).contains(&status)
    }

    fn database_query_url(&self) -> Result<String, TrackerError> {
        let mut base =
            Url::parse(&self.base_url).map_err(|error| TrackerError::UnexpectedPayload {
                reason: format!("invalid base URL '{}': {error}", self.base_url),
            })?;
        {
            let mut segments =
                base.path_segments_mut()
                    .map_err(|_| TrackerError::UnexpectedPayload {
                        reason: "invalid URL path segments".to_string(),
                    })?;
            segments.clear();
            segments.push("v1");
            segments.push("databases");
            segments.push(&self.database_id);
            segments.push("query");
        }
        Ok(base.to_string())
    }

    fn page_url(&self, id: &str) -> Result<Url, TrackerError> {
        let mut base =
            Url::parse(&self.base_url).map_err(|error| TrackerError::UnexpectedPayload {
                reason: format!("invalid base URL '{}': {error}", self.base_url),
            })?;
        {
            let mut segments =
                base.path_segments_mut()
                    .map_err(|_| TrackerError::UnexpectedPayload {
                        reason: "invalid URL path segments".to_string(),
                    })?;
            segments.clear();
            segments.push("v1");
            segments.push("pages");
            segments.push(id);
        }
        Ok(base)
    }

    async fn send_json_with_retry<F>(&self, mut build_request: F) -> Result<Value, TrackerError>
    where
        F: FnMut() -> reqwest::RequestBuilder,
    {
        let mut delay = self.initial_retry_delay;
        for attempt in 0..=self.max_retries {
            let response =
                build_request()
                    .send()
                    .await
                    .map_err(|error| TrackerError::ApiRequestFailed {
                        reason: error.to_string(),
                    });

            match response {
                Ok(resp) if resp.status().is_success() => {
                    return resp
                        .json()
                        .await
                        .map_err(|error| TrackerError::UnexpectedPayload {
                            reason: error.to_string(),
                        });
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp
                        .text()
                        .await
                        .unwrap_or_else(|_| "failed to read response body".to_string());

                    if attempt < self.max_retries && Self::is_retryable_status(status) {
                        sleep(delay).await;
                        delay *= 2;
                        continue;
                    }

                    return Err(TrackerError::ApiStatus { status, body });
                }
                Err(err) => {
                    if attempt < self.max_retries {
                        sleep(delay).await;
                        delay *= 2;
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        Err(TrackerError::ApiRequestFailed {
            reason: "retry loop exhausted unexpectedly".to_string(),
        })
    }

    async fn send_unit_with_retry<F>(&self, mut build_request: F) -> Result<(), TrackerError>
    where
        F: FnMut() -> reqwest::RequestBuilder,
    {
        let mut delay = self.initial_retry_delay;
        for attempt in 0..=self.max_retries {
            let response =
                build_request()
                    .send()
                    .await
                    .map_err(|error| TrackerError::ApiRequestFailed {
                        reason: error.to_string(),
                    });

            match response {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp
                        .text()
                        .await
                        .unwrap_or_else(|_| "failed to read response body".to_string());

                    if attempt < self.max_retries && Self::is_retryable_status(status) {
                        sleep(delay).await;
                        delay *= 2;
                        continue;
                    }

                    return Err(TrackerError::ApiStatus { status, body });
                }
                Err(err) => {
                    if attempt < self.max_retries {
                        sleep(delay).await;
                        delay *= 2;
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        Err(TrackerError::ApiRequestFailed {
            reason: "retry loop exhausted unexpectedly".to_string(),
        })
    }

    fn require_state(&self, page: &Value) -> Result<String, TrackerError> {
        self.extract_state(page)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "status property '{}' missing or invalid on page {}",
                    self.status_property,
                    page.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("<unknown>")
                ),
            })
    }

    fn require_enabled(&self, page: &Value) -> Result<bool, TrackerError> {
        self.extract_enabled(page)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "enabled property '{}' missing or invalid on page {}",
                    self.enabled_property,
                    page.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("<unknown>")
                ),
            })
    }

    fn state_filter(&self, states: &[String], field: &str) -> Value {
        let terms: Vec<Value> = states
            .iter()
            .map(|state| {
                json!({
                    "property": self.status_property,
                    field: {
                        "equals": state
                    }
                })
            })
            .collect();

        match terms.len() {
            0 => json!({}),
            1 => terms[0].clone(),
            _ => json!({ "or": terms }),
        }
    }

    fn candidate_filter(&self, states: &[String], field: &str) -> Value {
        json!({
            "and": [
                self.state_filter(states, field),
                {
                    "property": self.enabled_property,
                    "checkbox": {
                        "equals": self.enabled_value_bool
                    }
                }
            ]
        })
    }

    async fn query_database_for_states(
        &self,
        states: &[String],
        include_enabled_filter: bool,
    ) -> Result<Vec<Value>, TrackerError> {
        let mut last_error = None;

        for status_field in ["status", "select"] {
            let filter = if include_enabled_filter {
                self.candidate_filter(states, status_field)
            } else {
                self.state_filter(states, status_field)
            };

            match self.query_database(Some(filter)).await {
                Ok(results) => return Ok(results),
                Err(err @ TrackerError::ApiStatus { status: 400, .. }) => {
                    last_error = Some(err);
                }
                Err(err) => return Err(err),
            }
        }

        Err(
            last_error.unwrap_or_else(|| TrackerError::UnexpectedPayload {
                reason: "failed to query Notion with either status/select filters".to_string(),
            }),
        )
    }

    async fn query_database(&self, filter: Option<Value>) -> Result<Vec<Value>, TrackerError> {
        let mut all_results = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let mut body = serde_json::Map::new();
            if let Some(cursor) = &cursor {
                body.insert("start_cursor".to_string(), json!(cursor));
            }
            if let Some(filter) = &filter {
                body.insert("filter".to_string(), filter.clone());
            }
            let query_url = self.database_query_url()?;
            let payload = self
                .send_json_with_retry(|| {
                    self.notion_request(self.client.post(query_url.clone()))
                        .json(&Value::Object(body.clone()))
                })
                .await?;

            let results = payload
                .get("results")
                .and_then(Value::as_array)
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "missing results array".to_string(),
                })?;
            all_results.extend(results.iter().cloned());

            let has_more = payload
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if !has_more {
                break;
            }

            let next_cursor = payload
                .get("next_cursor")
                .and_then(Value::as_str)
                .ok_or(TrackerError::MissingEndCursor)?;
            cursor = Some(next_cursor.to_string());
        }

        Ok(all_results)
    }

    async fn fetch_page(&self, id: &str) -> Result<Value, TrackerError> {
        let page_url = self.page_url(id)?;
        self.send_json_with_retry(|| self.notion_request(self.client.get(page_url.clone())))
            .await
    }

    fn page_to_issue(&self, page: &Value) -> Result<Issue, TrackerError> {
        let id = page.get("id").and_then(Value::as_str).ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "page.id missing".to_string(),
            }
        })?;

        let title = self.extract_title(page).unwrap_or_else(|| id.to_string());
        let state = self.require_state(page)?;

        Ok(Issue {
            id: id.to_string(),
            identifier: id.to_string(),
            title,
            description: None,
            priority: None,
            tracker_position: None,
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
        let property = page
            .get("properties")
            .and_then(|properties| properties.get(&self.status_property))?;

        property
            .get("select")
            .and_then(|select| select.get("name"))
            .and_then(Value::as_str)
            .or_else(|| {
                property
                    .get("status")
                    .and_then(|status| status.get("name"))
                    .and_then(Value::as_str)
            })
            .map(ToString::to_string)
    }

    fn extract_enabled(&self, page: &Value) -> Option<bool> {
        page.get("properties")
            .and_then(|properties| properties.get(&self.enabled_property))
            .and_then(|value| value.get("checkbox"))
            .and_then(Value::as_bool)
    }

    fn state_property_update(&self, page: &Value, state: &str) -> Result<Value, TrackerError> {
        let property = page
            .get("properties")
            .and_then(|properties| properties.get(&self.status_property))
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "missing status property '{}' in page payload",
                    self.status_property
                ),
            })?;

        let property_type = property.get("type").and_then(Value::as_str).or_else(|| {
            if property.get("status").is_some() {
                Some("status")
            } else if property.get("select").is_some() {
                Some("select")
            } else {
                None
            }
        });

        match property_type {
            Some("status") => Ok(json!({
                self.status_property.clone(): {
                    "status": { "name": state }
                }
            })),
            Some("select") => Ok(json!({
                self.status_property.clone(): {
                    "select": { "name": state }
                }
            })),
            Some(other) => Err(TrackerError::UnexpectedPayload {
                reason: format!(
                    "status property '{}' has unsupported type '{}'",
                    self.status_property, other
                ),
            }),
            None => Err(TrackerError::UnexpectedPayload {
                reason: format!(
                    "status property '{}' missing Notion type metadata",
                    self.status_property
                ),
            }),
        }
    }
}

#[async_trait]
impl IssueTracker for NotionTracker {
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        let pages = self
            .query_database_for_states(&self.active_states, true)
            .await?;
        let mut issues = Vec::new();

        for page in &pages {
            let state = self.require_state(page)?;
            let enabled = self.require_enabled(page)?;

            if self.active_states.contains(&state) && enabled == self.enabled_value_bool {
                issues.push(self.page_to_issue(page)?);
            }
        }

        Ok(issues)
    }

    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        let pages = self.query_database_for_states(states, false).await?;
        let mut issues = Vec::new();

        for page in &pages {
            let state = self.require_state(page)?;

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
        let page = self.fetch_page(id).await?;
        let properties = self.state_property_update(&page, state)?;
        let page_url = self.page_url(id)?;
        self.send_unit_with_retry(|| {
            self.notion_request(self.client.patch(page_url.clone()))
                .json(&json!({
                    "properties": properties
                }))
        })
        .await
    }

    async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
        let mut url =
            Url::parse(&self.base_url).map_err(|error| TrackerError::UnexpectedPayload {
                reason: format!("invalid base URL '{}': {error}", self.base_url),
            })?;
        {
            let mut segments =
                url.path_segments_mut()
                    .map_err(|_| TrackerError::UnexpectedPayload {
                        reason: "invalid URL path segments".to_string(),
                    })?;
            segments.clear();
            segments.push("v1");
            segments.push("comments");
        }
        self.send_unit_with_retry(|| {
            self.notion_request(self.client.post(url.clone()))
                .json(&json!({
                    "parent": { "page_id": id },
                    "rich_text": [{
                        "type": "text",
                        "text": { "content": body }
                    }]
                }))
        })
        .await
    }

    async fn create_interaction_thread_root(
        &self,
        _id: &str,
        _body: &str,
    ) -> Result<InteractionThreadRoot, TrackerError> {
        Err(TrackerError::WritesNotSupported)
    }

    async fn list_comments_after(
        &self,
        _id: &str,
        _after_comment_id: &str,
    ) -> Result<Vec<TrackerComment>, TrackerError> {
        Err(TrackerError::WritesNotSupported)
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
            notion: Some(crate::config::ensemble::NotionTrackerConfig {
                api_key: Some("token".to_string()),
                database_id: Some("deadbeefdeadbeefdeadbeefdeadbeef".to_string()),
                version: "2022-06-28".to_string(),
                title_property: "Name".to_string(),
                status_property: "Status".to_string(),
                enabled_property: "Ready to Implement".to_string(),
                enabled_value_bool: true,
            }),
            github: None,
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
    async fn fetch_issue_states_by_ids_supports_status_property_type() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/pages/page-a"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "page-a",
                "properties": {
                    "Name": { "title": [ { "plain_text": "A task" } ] },
                    "Status": { "status": { "name": "In Progress" } }
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
        assert_eq!(issues[0].state, "In Progress");
    }

    #[tokio::test]
    async fn fetch_issues_by_states_filters_requested_states() {
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
                            "Name": { "title": [ { "plain_text": "B task" } ] },
                            "Status": { "select": { "name": "Done" } },
                            "Ready to Implement": { "checkbox": true }
                        }
                    }
                ],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let issues = tracker
            .fetch_issues_by_states(&["Done".to_string()])
            .await
            .unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "page-b");
        assert_eq!(issues[0].state, "Done");
    }

    #[tokio::test]
    async fn set_issue_state_updates_status_property() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/pages/page-a"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "page-a",
                "properties": {
                    "Status": {
                        "type": "select",
                        "select": { "name": "Todo" }
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/v1/pages/page-a"))
            .and(body_string_contains("\"Status\""))
            .and(body_string_contains("\"select\":{\"name\":\"In Review\"}"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "page-a"})))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        tracker
            .set_issue_state("page-a", "In Review")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn set_issue_state_uses_status_payload_when_status_property_type_is_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/pages/page-a"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "page-a",
                "properties": {
                    "Status": {
                        "type": "status",
                        "status": { "name": "Todo" }
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/v1/pages/page-a"))
            .and(body_string_contains("\"status\":{\"name\":\"In Review\"}"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "page-a"})))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        tracker
            .set_issue_state("page-a", "In Review")
            .await
            .unwrap();
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
    async fn retries_on_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "id": "page-a",
                    "properties": {
                        "Name": { "title": [ { "plain_text": "A task" } ] },
                        "Status": { "select": { "name": "Todo" } },
                        "Ready to Implement": { "checkbox": true }
                    }
                }],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 1);
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

    #[tokio::test]
    async fn query_database_paginates_until_complete() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "id": "page-a",
                    "properties": {
                        "Name": { "title": [ { "plain_text": "A task" } ] },
                        "Status": { "select": { "name": "Todo" } },
                        "Ready to Implement": { "checkbox": true }
                    }
                }],
                "has_more": true,
                "next_cursor": "next-cursor"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "id": "page-b",
                    "properties": {
                        "Name": { "title": [ { "plain_text": "B task" } ] },
                        "Status": { "select": { "name": "Todo" } },
                        "Ready to Implement": { "checkbox": true }
                    }
                }],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].id, "page-a");
        assert_eq!(issues[1].id, "page-b");
    }

    #[tokio::test]
    async fn fetch_candidate_issues_query_uses_server_side_filters() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .and(body_string_contains("\"filter\""))
            .and(body_string_contains("\"Status\""))
            .and(body_string_contains("\"Ready to Implement\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert!(issues.is_empty());
    }

    #[tokio::test]
    async fn missing_enabled_property_returns_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "id": "page-a",
                    "properties": {
                        "Name": { "title": [ { "plain_text": "A task" } ] },
                        "Status": { "select": { "name": "Todo" } }
                    }
                }],
                "has_more": false
            })))
            .mount(&server)
            .await;

        let tracker = make_tracker(&server.uri());
        let err = tracker.fetch_candidate_issues().await.unwrap_err();
        assert!(matches!(err, TrackerError::UnexpectedPayload { .. }));
    }

    #[test]
    fn page_url_encodes_path_segment() {
        let tracker = make_tracker("http://example.com");
        let url = tracker.page_url("page/with/slash").unwrap();
        assert!(url.as_str().contains("page%2Fwith%2Fslash"));
    }
}
