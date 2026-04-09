# Notion Tracker Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a first-class `tracker.kind: notion` adapter with read/write support, opt-in filtering, and comment-based run feedback.

**Architecture:** Add a new `NotionTracker` that implements `IssueTracker` and plugs into the existing tracker factory. Extend `TrackerConfig` with Notion fields (hybrid defaults + overrides), keep orchestrator logic unchanged, and verify behavior with focused unit + mock-HTTP tests.

**Tech Stack:** Rust 2021, tokio, async-trait, reqwest, serde/serde_json, thiserror, tempfile.

---

## File Structure

- Create: `crates/ensemble-core/src/tracker/notion.rs` — Notion API DTOs + `NotionTracker` implementation + tests.
- Modify: `crates/ensemble-core/src/tracker/mod.rs` — module export, tracker factory wiring, Notion creation errors, factory tests.
- Modify: `crates/ensemble-core/src/config/ensemble.rs` — `TrackerConfig` Notion fields + defaults + parse tests.
- Modify: `docs/SPEC.md` — add `notion` tracker kind config/behavior requirements.
- Modify: `docs/configuration.md` — user-facing Notion config examples.

---

### Task 1: Extend tracker config model for Notion

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write failing config parse test for Notion defaults and overrides**

```rust
#[test]
fn test_parse_notion_tracker_config_with_defaults_and_overrides() {
    let yaml = r#"
tracker:
  kind: notion
  notion:
    api_key: $NOTION_API_KEY
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
    enabled_property: Ready to Implement
agents:
  build:
    executor: claude-code
    model: claude-opus-4-6
    prompt: "Build the thing"
steps:
  - name: build
    agent: build
on_success: Done
on_failure: Failed
"#;

    let config = parse_config(yaml).unwrap();
    assert_eq!(config.tracker.kind, "notion");
    assert_eq!(config.tracker.notion.as_ref().and_then(|n| n.database_id.as_deref()), Some("deadbeefdeadbeefdeadbeefdeadbeef"));
    assert_eq!(config.tracker.notion.as_ref().map(|n| n.status_property.as_str()), Some("Status"));
    assert_eq!(config.tracker.notion.as_ref().map(|n| n.title_property.as_str()), Some("Name"));
    assert_eq!(config.tracker.notion.as_ref().map(|n| n.enabled_property.as_str()), Some("Ready to Implement"));
    assert_eq!(config.tracker.notion.as_ref().map(|n| n.enabled_value_bool), Some(true));
}
```

- [ ] **Step 2: Run test and verify failure**

Run: `rtk cargo test -p ensemble-core test_parse_notion_tracker_config_with_defaults_and_overrides`
Expected: FAIL because new `TrackerConfig` fields do not exist yet.

- [ ] **Step 3: Add Notion fields + default helpers to `TrackerConfig`**

```rust
#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct TrackerConfig {
    pub kind: String,
    #[serde(default = "default_active_states")]
    pub active_states: Vec<String>,
    #[serde(default = "default_terminal_states")]
    pub terminal_states: Vec<String>,
    pub path: Option<PathBuf>,
    pub endpoint: Option<String>,
    pub gh_hostname: Option<String>,
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    pub repository: Option<String>,
    pub project_number: Option<i64>,
    pub labels_filter: Vec<String>,

    // notion-specific
    #[serde(default)]
    pub notion: Option<NotionTrackerConfig>,
}

#[derive(Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct NotionTrackerConfig {
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    pub database_id: Option<String>,
    #[serde(default = "default_notion_version")]
    pub version: String,
    #[serde(default = "default_notion_title_property")]
    pub title_property: String,
    #[serde(default = "default_notion_status_property")]
    pub status_property: String,
    #[serde(default = "default_notion_enabled_property")]
    pub enabled_property: String,
    #[serde(default = "default_notion_enabled_value_bool")]
    pub enabled_value_bool: bool,
}
```

- [ ] **Step 4: Run focused tests**

Run: `rtk cargo test -p ensemble-core config::ensemble::tests::test_parse_notion_tracker_config_with_defaults_and_overrides`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/config/ensemble.rs
rtk git commit -m "Add Notion tracker config fields and defaults"
```

---

### Task 2: Add tracker-level Notion errors and module wiring

**Files:**
- Modify: `crates/ensemble-core/src/tracker/mod.rs`

- [ ] **Step 1: Write failing factory test for `kind: notion` missing database ID**

```rust
#[test]
fn test_create_notion_tracker_missing_database_id() {
    let config = TrackerConfig {
        kind: "notion".to_string(),
        active_states: vec!["Todo".into()],
        terminal_states: vec!["Done".into()],
        path: None,
        endpoint: None,
        gh_hostname: None,
        repository: None,
        project_number: None,
        labels_filter: vec![],
        api_key: Some("secret".into()),
        notion: Some(NotionTrackerConfig {
            api_key: Some("secret".into()),
            database_id: None,
            version: "2022-06-28".into(),
            title_property: "Name".into(),
            status_property: "Status".into(),
            enabled_property: "Ready to Implement".into(),
            enabled_value_bool: true,
        }),
    };

    let result = create_tracker(&config);
    assert!(matches!(result, Err(TrackerError::MissingDatabaseId)));
}
```

- [ ] **Step 2: Run test and verify failure**

Run: `rtk cargo test -p ensemble-core test_create_notion_tracker_missing_database_id`
Expected: FAIL due to missing `MissingDatabaseId` + missing notion branch.

- [ ] **Step 3: Add error variants + module export + factory branch**

```rust
pub mod notion;

#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error("unsupported tracker kind: {kind}")]
    UnsupportedKind { kind: String },
    #[error("missing tracker API key (set tracker.api_key or env token)")]
    MissingApiKey,
    #[error("missing tracker database_id for notion kind")]
    MissingDatabaseId,
    #[error("missing tracker enabled_property for notion kind")]
    MissingEnabledProperty,
    #[error("Notion API request failed: {reason}")]
    NotionApiRequestFailed { reason: String },
}

"notion" => {
    let token = config.notion_api_key().map(ToOwned::to_owned).ok_or(TrackerError::MissingApiKey)?;
    let database_id = config.notion_database_id().map(ToOwned::to_owned).ok_or(TrackerError::MissingDatabaseId)?;
    let tracker = notion::NotionTracker::new(token, database_id, config)?;
    Ok(Box::new(tracker))
}
```

- [ ] **Step 4: Run focused tracker tests**

Run: `rtk cargo test -p ensemble-core tracker::tests::test_create_notion_tracker_missing_database_id`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/tracker/mod.rs
rtk git commit -m "Wire Notion tracker kind and core tracker errors"
```

---

### Task 3: Implement NotionTracker read path (TDD)

**Files:**
- Create: `crates/ensemble-core/src/tracker/notion.rs`
- Test: `crates/ensemble-core/src/tracker/notion.rs` (inline `#[cfg(test)]` module)

- [ ] **Step 1: Write failing tests for candidate and state-refresh mapping**

```rust
#[tokio::test]
async fn fetch_candidate_issues_filters_active_and_opt_in() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                {"id":"a","properties":{"Name":{"title":[{"plain_text":"A"}]},"Status":{"select":{"name":"Todo"}},"Ready to Implement":{"checkbox":true}}},
                {"id":"b","properties":{"Name":{"title":[{"plain_text":"B"}]},"Status":{"select":{"name":"Done"}},"Ready to Implement":{"checkbox":true}}},
                {"id":"c","properties":{"Name":{"title":[{"plain_text":"C"}]},"Status":{"select":{"name":"Todo"}},"Ready to Implement":{"checkbox":false}}}
            ],
            "has_more": false
        })))
        .mount(&server)
        .await;

    let tracker = test_tracker(server.uri());
    let issues = tracker.fetch_candidate_issues().await.unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].id, "a");
}

#[tokio::test]
async fn fetch_issue_states_by_ids_returns_current_status_for_each_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/pages/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id":"a",
            "properties":{"Name":{"title":[{"plain_text":"A"}]},"Status":{"select":{"name":"In Progress"}}}
        })))
        .mount(&server)
        .await;

    let tracker = test_tracker(server.uri());
    let states = tracker.fetch_issue_states_by_ids(&["a".into()]).await.unwrap();
    assert_eq!(states[0].id, "a");
    assert_eq!(states[0].state, "In Progress");
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk cargo test -p ensemble-core tracker::notion::tests::fetch_candidate_issues_filters_active_and_opt_in`
Expected: FAIL because `NotionTracker` does not exist.

- [ ] **Step 3: Implement minimal `NotionTracker` + read methods**

```rust
pub struct NotionTracker {
    client: reqwest::Client,
    token: String,
    database_id: String,
    active_states: Vec<String>,
    terminal_states: Vec<String>,
    title_property: String,
    status_property: String,
    enabled_property: String,
    enabled_value_bool: bool,
    notion_version: String,
}

#[async_trait]
impl IssueTracker for NotionTracker {
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        // POST /v1/databases/{id}/query with status + enabled filters
    }

    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        // same query builder but state list parameterized
    }

    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        // GET /v1/pages/{id} per id (or batched strategy), map to Issue{ id, identifier, title, state }
    }
}
```

- [ ] **Step 4: Run read-path tests**

Run: `rtk cargo test -p ensemble-core tracker::notion::tests::fetch_candidate_issues_filters_active_and_opt_in tracker::notion::tests::fetch_issue_states_by_ids_returns_current_status_for_each_id`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/tracker/notion.rs
rtk git commit -m "Implement Notion tracker read operations"
```

---

### Task 4: Implement Notion write path (state transition + comments)

**Files:**
- Modify: `crates/ensemble-core/src/tracker/notion.rs`

- [ ] **Step 1: Write failing write-path tests**

```rust
#[tokio::test]
async fn set_issue_state_updates_status_property() {
    let server = MockServer::start().await;
    Mock::given(method("PATCH"))
        .and(path("/v1/pages/a"))
        .and(body_string_contains("\"Status\""))
        .and(body_string_contains("\"In Review\""))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"a"})))
        .mount(&server)
        .await;

    let tracker = test_tracker(server.uri());
    tracker.set_issue_state("a", "In Review").await.unwrap();
}

#[tokio::test]
async fn add_comment_posts_to_page_comments_endpoint() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/comments"))
        .and(body_string_contains("\"page_id\":\"a\""))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"comment_1"})))
        .mount(&server)
        .await;

    let tracker = test_tracker(server.uri());
    tracker.add_comment("a", "hello from ensemble").await.unwrap();
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk cargo test -p ensemble-core tracker::notion::tests::set_issue_state_updates_status_property tracker::notion::tests::add_comment_posts_to_page_comments_endpoint`
Expected: FAIL because write methods are not implemented.

- [ ] **Step 3: Implement `supports_writes`, `set_issue_state`, `add_comment`**

```rust
fn supports_writes(&self) -> bool { true }

async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError> {
    // PATCH page properties with status_property = state
}

async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError> {
    // POST comment with parent.page_id = id
}
```

- [ ] **Step 4: Run write tests**

Run: `rtk cargo test -p ensemble-core tracker::notion::tests::set_issue_state_updates_status_property tracker::notion::tests::add_comment_posts_to_page_comments_endpoint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/tracker/notion.rs
rtk git commit -m "Implement Notion tracker write operations"
```

---

### Task 5: Error classification and resilience tests

**Files:**
- Modify: `crates/ensemble-core/src/tracker/notion.rs`

- [ ] **Step 1: Write failing tests for 401/403/404/429/5xx handling**

```rust
#[tokio::test]
async fn notion_429_maps_to_retryable_api_status_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
        .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
        .mount(&server)
        .await;

    let tracker = test_tracker(server.uri());
    let err = tracker.fetch_candidate_issues().await.unwrap_err();
    assert!(matches!(err, TrackerError::ApiStatus { status: 429, .. }));
}

#[tokio::test]
async fn notion_401_maps_to_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/databases/deadbeefdeadbeefdeadbeefdeadbeef/query"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;

    let tracker = test_tracker(server.uri());
    let err = tracker.fetch_candidate_issues().await.unwrap_err();
    assert!(matches!(err, TrackerError::ApiStatus { status: 401, .. }));
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk cargo test -p ensemble-core tracker::notion::tests::notion_429_maps_to_retryable_api_status_error`
Expected: FAIL until mapping logic is implemented.

- [ ] **Step 3: Implement status-to-error mapping helpers**

```rust
fn map_notion_status(status: u16, body: String) -> TrackerError {
    match status {
        401 | 403 | 404 | 429 | 500..=599 => TrackerError::ApiStatus { status, body },
        _ => TrackerError::NotionApiRequestFailed { reason: body },
    }
}
```

- [ ] **Step 4: Run full Notion test module**

Run: `rtk cargo test -p ensemble-core tracker::notion::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/tracker/notion.rs
rtk git commit -m "Add Notion tracker error mapping and resilience tests"
```

---

### Task 6: Document Notion tracker usage

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Add SPEC section for `tracker.kind == "notion"`**

```md
##### `tracker.kind == "notion"`
A Notion database-backed tracker.
Required: `tracker.notion.database_id`, `tracker.notion.api_key`.
Supports writes: yes (`set_issue_state`, `add_comment`).
Candidate filter: status in `active_states` and opt-in property enabled.
```

- [ ] **Step 2: Add configuration example and property requirements**

```yaml
tracker:
  kind: notion
  notion:
    api_key: $NOTION_API_KEY
    database_id: deadbeefdeadbeefdeadbeefdeadbeef
    status_property: Status
    enabled_property: Ready to Implement
```

- [ ] **Step 3: Run docs sanity checks**

Run: `rtk rg -n "tracker.kind == \"notion\"|tracker.notion.database_id|tracker.notion.enabled_property" docs/SPEC.md docs/configuration.md`
Expected: Matches in both files.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/SPEC.md docs/configuration.md
rtk git commit -m "Document Notion tracker configuration and behavior"
```

---

### Task 7: Workspace verification pass

**Files:**
- Modify: (all files touched above)

- [ ] **Step 1: Run targeted tests first**

Run: `rtk cargo test -p ensemble-core tracker::tests::test_create_notion_tracker_missing_database_id tracker::notion::tests`
Expected: PASS.

- [ ] **Step 2: Run full core crate tests + linting**

Run: `rtk cargo test -p ensemble-core`
Expected: PASS.

Run: `rtk cargo clippy -p ensemble-core -- -D warnings`
Expected: PASS with zero warnings.

Run: `rtk cargo fmt --all -- --check`
Expected: PASS.

- [ ] **Step 3: Final commit for any verification fixes**

```bash
rtk git add -A
rtk git commit -m "Polish Notion tracker integration after verification"
```
