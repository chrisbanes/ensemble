# GitHub Project Status Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure GitHub status reconciliation and state writes use only the issue item belonging to the configured Project v2 board, with deterministic diagnostics for missing or ambiguous project-item data.

**Architecture:** Extend the reconciliation GraphQL query to retain each project item's ID and project ID. Introduce one selector that validates every returned item's identity and requires exactly one match for the configured project; use it from both status normalization and write-item lookup so reads and writes enforce the same invariant. Repository-label mode remains independent of project items.

**Tech Stack:** Rust 2021, `serde_json`, `reqwest`, GitHub GraphQL, Tokio, `wiremock`

---

## File Structure

- Modify: `crates/ensemble-core/src/tracker/github.rs` - add project identity to the state query, centralize configured-project item selection, scope reconciliation reads, scope writes, and add unit/GraphQL regression tests.
- Create: `docs/superpowers/plans/2026-07-10-github-project-status-scoping.md` - record the implementation and verification sequence for issue #320.

No user-facing configuration or tracker contract changes are required. `docs/SPEC.md`, `docs/configuration.md`, and `docs/pipelines.md` therefore do not need behavioral edits; this is a correctness fix within the existing configured-project semantics.

### Task 1: Retain Project Identity in Reconciliation Responses

**Files:**
- Modify: `crates/ensemble-core/src/tracker/github.rs:110-144`
- Test: `crates/ensemble-core/src/tracker/github.rs` (`tests` module)

- [ ] **Step 1: Write a failing query-contract test**

Add this test near the other query/parser unit tests:

```rust
#[test]
fn issue_states_query_requests_project_item_identity() {
    let compact_query = ISSUE_STATES_QUERY
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    assert!(compact_query.contains(
        "projectItems(first: 100) { nodes { id project { id } fieldValues"
    ));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cargo test -p ensemble-core issue_states_query_requests_project_item_identity -- --nocapture
```

Expected: FAIL because `ISSUE_STATES_QUERY` currently jumps directly from `nodes` to `fieldValues` and does not request either item ID or project ID.

- [ ] **Step 3: Request item and project identity**

Update the `projectItems` selection in `ISSUE_STATES_QUERY`:

```graphql
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cargo test -p ensemble-core issue_states_query_requests_project_item_identity -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit the query contract**

```bash
git add crates/ensemble-core/src/tracker/github.rs docs/superpowers/plans/2026-07-10-github-project-status-scoping.md
git commit -m "fix: retain project identity in GitHub state query"
```

### Task 2: Scope Reconciliation Reads to the Configured Project

**Files:**
- Modify: `crates/ensemble-core/src/tracker/github.rs:383-490,813-843,972-1037,1312-1850`
- Test: `crates/ensemble-core/src/tracker/github.rs` (`tests` module)

- [ ] **Step 1: Add shared GraphQL test setup**

Add this helper below `graphql_response` in the tests module. It gives project-mode reconciliation and write tests the metadata discovery response required to identify the configured project:

```rust
async fn mount_project_discovery(server: &MockServer, project_id: &str) {
    let response = graphql_response(json!({
        "repository": {
            "projectV2": {
                "id": project_id,
                "fields": {
                    "nodes": [{
                        "id": "F_status",
                        "name": "Status",
                        "options": [
                            { "id": "O_todo", "name": "Todo" },
                            { "id": "O_progress", "name": "In Progress" },
                            { "id": "O_done", "name": "Done" }
                        ]
                    }]
                }
            }
        }
    }));

    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("projectNumber"))
        .respond_with(ResponseTemplate::new(200).set_body_json(response))
        .expect(1)
        .mount(server)
        .await;
}
```

- [ ] **Step 2: Write the failing multi-project reconciliation test**

Add a GraphQL regression test where the unrelated project's terminal status appears first:

```rust
#[tokio::test]
async fn project_mode_reconciliation_reads_configured_project_status() {
    let server = MockServer::start().await;
    mount_project_discovery(&server, "P_configured").await;

    let response = graphql_response(json!({
        "nodes": [{
            "id": "I_node1",
            "number": 42,
            "title": "Issue 42",
            "state": "OPEN",
            "url": "https://github.com/acme/my-repo/issues/42",
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
        .respond_with(ResponseTemplate::new(200).set_body_json(response))
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
```

- [ ] **Step 3: Write failing deterministic-diagnostic tests**

Add focused unit tests for unprovable, missing, and ambiguous project matches, plus a normalization test for a configured item with no Status. Sorting duplicate IDs in the expected diagnostic prevents response ordering from changing the message:

```rust
#[test]
fn configured_project_item_rejects_missing_project_identity() {
    let items = json!([{
        "id": "PVTI_unknown",
        "fieldValues": { "nodes": [] }
    }]);

    let error = select_configured_project_item(
        "I_node1",
        "P_configured",
        items.as_array().unwrap(),
    )
    .unwrap_err();

    match error {
        TrackerError::UnexpectedPayload { reason } => assert_eq!(
            reason,
            "issue I_node1 project item PVTI_unknown is missing project ID"
        ),
        other => panic!("expected UnexpectedPayload, got: {other:?}"),
    }
}

#[test]
fn configured_project_item_rejects_missing_configured_project() {
    let items = json!([{
        "id": "PVTI_other",
        "project": { "id": "P_other" },
        "fieldValues": { "nodes": [] }
    }]);

    let error = select_configured_project_item(
        "I_node1",
        "P_configured",
        items.as_array().unwrap(),
    )
    .unwrap_err();

    match error {
        TrackerError::UnexpectedPayload { reason } => assert_eq!(
            reason,
            "issue I_node1 has no item in configured project P_configured"
        ),
        other => panic!("expected UnexpectedPayload, got: {other:?}"),
    }
}

#[test]
fn configured_project_item_rejects_multiple_configured_items() {
    let items = json!([
        { "id": "PVTI_b", "project": { "id": "P_configured" } },
        { "id": "PVTI_a", "project": { "id": "P_configured" } }
    ]);

    let error = select_configured_project_item(
        "I_node1",
        "P_configured",
        items.as_array().unwrap(),
    )
    .unwrap_err();

    match error {
        TrackerError::UnexpectedPayload { reason } => assert_eq!(
            reason,
            "issue I_node1 has multiple items in configured project P_configured: PVTI_a, PVTI_b"
        ),
        other => panic!("expected UnexpectedPayload, got: {other:?}"),
    }
}

#[test]
fn project_mode_reconciliation_rejects_missing_status() {
    let tracker = create_test_tracker("http://unused", Some(1));
    let node = json!({
        "id": "I_node1",
        "number": 42,
        "title": "Issue 42",
        "state": "OPEN",
        "labels": { "nodes": [] },
        "projectItems": {
            "nodes": [{
                "id": "PVTI_configured",
                "project": { "id": "P_configured" },
                "fieldValues": { "nodes": [] }
            }]
        }
    });

    let error = tracker
        .normalize_state_node(&node, Some("P_configured"))
        .unwrap_err();

    match error {
        TrackerError::UnexpectedPayload { reason } => assert_eq!(
            reason,
            "issue I_node1 project item PVTI_configured in configured project P_configured is missing Status"
        ),
        other => panic!("expected UnexpectedPayload, got: {other:?}"),
    }
}
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core project_mode_reconciliation_reads_configured_project_status -- --nocapture
cargo test -p ensemble-core configured_project_item_rejects -- --nocapture
cargo test -p ensemble-core project_mode_reconciliation_rejects_missing_status -- --nocapture
```

Expected: FAIL. The end-to-end test either reads `Done` from the first item or fails its unmet discovery expectation, while the diagnostic tests do not compile because `select_configured_project_item` and the fallible `normalize_state_node` signature do not exist.

- [ ] **Step 5: Add the single configured-project item selector**

Add this free function near the other JSON extraction helpers, before `extract_labels`:

```rust
fn select_configured_project_item<'a>(
    issue_node_id: &str,
    configured_project_id: &str,
    items: &'a [Value],
) -> Result<(&'a str, &'a Value), TrackerError> {
    let mut matches = Vec::new();

    for (index, item) in items.iter().enumerate() {
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "issue {issue_node_id} project item at index {index} is missing item ID"
                ),
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
            matches.push((item_id, item));
        }
    }

    if matches.is_empty() {
        return Err(TrackerError::UnexpectedPayload {
            reason: format!(
                "issue {issue_node_id} has no item in configured project {configured_project_id}"
            ),
        });
    }

    if matches.len() > 1 {
        let mut item_ids: Vec<&str> = matches.iter().map(|(item_id, _)| *item_id).collect();
        item_ids.sort_unstable();
        return Err(TrackerError::UnexpectedPayload {
            reason: format!(
                "issue {issue_node_id} has multiple items in configured project {configured_project_id}: {}",
                item_ids.join(", ")
            ),
        });
    }

    Ok(matches[0])
}
```

- [ ] **Step 6: Make state normalization project-aware and fallible**

Change `normalize_state_node` to accept the discovered project ID and return `Result<Option<Issue>, TrackerError>`. Preserve the existing behavior of skipping malformed non-issue nodes, but do not fall back to repository state when project mode cannot prove one configured item and one configured Status value:

```rust
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
    let title = node
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let labels = extract_labels(node);

    let state = if let Some(project_id) = configured_project_id {
        let items = node
            .pointer("/projectItems/nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!("issue {id} is missing projectItems nodes"),
            })?;
        let (item_id, item) = select_configured_project_item(id, project_id, items)?;
        self.extract_status_from_field_values(item)
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: format!(
                    "issue {id} project item {item_id} in configured project {project_id} is missing Status"
                ),
            })?
    } else {
        let raw_state = node
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("open")
            .to_lowercase();
        self.canonical_state_from_labels(&labels, raw_state)
    };

    let url = node
        .get("url")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    Ok(Some(Issue {
        id: id.to_string(),
        identifier: format!("{}#{}", self.repo, number),
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
```

Then discover metadata once before the batch state query in project mode and propagate normalization errors:

```rust
async fn fetch_states_by_node_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }

    let configured_project_id = if self.project_number.is_some() {
        Some(self.ensure_project_metadata().await?.0)
    } else {
        None
    };

    let data = self
        .graphql(ISSUE_STATES_QUERY, json!({ "ids": ids }))
        .await?;
    let nodes = data
        .get("nodes")
        .and_then(Value::as_array)
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
```

- [ ] **Step 7: Run the missing-Status regression test**

Run:

```bash
cargo test -p ensemble-core project_mode_reconciliation_rejects_missing_status -- --nocapture
```

Expected: PASS with the exact `UnexpectedPayload` reason asserted in Step 3.

- [ ] **Step 8: Update the existing project-mode reconciliation fixture**

`test_fetch_states_by_ids` currently creates a project-mode tracker without a discovery response, returns one project item without identity, and expects a second issue with no project item to fall back to raw GitHub state. In project mode both issues must instead resolve through the configured project. Mount discovery for `P_configured`, then add identity to the first item:

```rust
mount_project_discovery(&server, "P_configured").await;

// Inside the existing projectItems.nodes entry:
"id": "PVTI_configured",
"project": { "id": "P_configured" },
```

Replace the closed issue's empty `projectItems` with a configured-project item:

```rust
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
```

Change the second issue assertion from `assert_eq!(issues[1].state, "closed")` to `assert_eq!(issues[1].state, "Done")`, and update its comment to say that project mode uses the configured project's Status. Keep the null-node behavior unchanged. Repository-mode tests require no discovery fixture and must continue deriving state only from labels/raw issue state.

- [ ] **Step 9: Run reconciliation tests**

Run:

```bash
cargo test -p ensemble-core project_mode_reconciliation -- --nocapture
cargo test -p ensemble-core configured_project_item_rejects -- --nocapture
cargo test -p ensemble-core test_fetch_states_by_ids -- --nocapture
```

Expected: PASS. The multi-project issue reports `In Progress`, all malformed/ambiguous cases return the exact diagnostics, and repo-mode state derivation remains unchanged.

- [ ] **Step 10: Commit scoped reads and diagnostics**

```bash
git add crates/ensemble-core/src/tracker/github.rs
git commit -m "fix: scope GitHub reconciliation to configured project"
```

### Task 3: Apply the Same Invariant to Project Status Writes

**Files:**
- Modify: `crates/ensemble-core/src/tracker/github.rs:937-970,1266-1305`
- Test: `crates/ensemble-core/src/tracker/github.rs` (`tests` module)

- [ ] **Step 1: Write a failing multi-project write test**

Add an end-to-end wiremock test proving the mutation receives the configured project's item ID even when another project item appears first:

```rust
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
        .respond_with(ResponseTemplate::new(200).set_body_json(find_response))
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
        .respond_with(ResponseTemplate::new(200).set_body_json(mutation_response))
        .expect(1)
        .mount(&server)
        .await;

    let tracker = create_test_tracker(&server.uri(), Some(1));
    tracker.set_issue_state("I_node1", "Done").await.unwrap();
}
```

- [ ] **Step 2: Write a failing ambiguous-write diagnostic test**

```rust
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
        .respond_with(ResponseTemplate::new(200).set_body_json(find_response))
        .expect(1)
        .mount(&server)
        .await;

    let tracker = create_test_tracker(&server.uri(), Some(1));
    let error = tracker
        .set_issue_state("I_node1", "Done")
        .await
        .unwrap_err();

    match error {
        TrackerError::UnexpectedPayload { reason } => assert_eq!(
            reason,
            "issue I_node1 has multiple items in configured project P_configured: PVTI_a, PVTI_b"
        ),
        other => panic!("expected UnexpectedPayload, got: {other:?}"),
    }
}
```

- [ ] **Step 3: Run write tests to establish the baseline**

Run:

```bash
cargo test -p ensemble-core project_mode_write -- --nocapture
```

Expected: `project_mode_write_targets_configured_project_item` may already pass because the old write loop compares project IDs, while `project_mode_write_rejects_multiple_configured_items` FAILS because the old loop silently returns the first duplicate. This is the expected baseline: targeting is partly correct, ambiguity handling is not.

- [ ] **Step 4: Reuse the selector in `find_project_item_id`**

Replace the loop in `find_project_item_id` with the shared selector:

```rust
let items = data
    .pointer("/node/projectItems/nodes")
    .and_then(Value::as_array)
    .ok_or_else(|| TrackerError::UnexpectedPayload {
        reason: format!("issue {issue_node_id} is missing projectItems nodes"),
    })?;

let (item_id, _) =
    select_configured_project_item(issue_node_id, &project_id, items)?;
Ok(item_id.to_string())
```

Delete the old first-match loop and its generic `issue ... not found in project` error. `set_issue_state` continues to use the configured `project_id`, configured Status `field_id`, and configured option ID in `UPDATE_PROJECT_ITEM_FIELD_MUTATION`; only item selection changes.

- [ ] **Step 5: Run all project write tests**

Run:

```bash
cargo test -p ensemble-core project_mode_write -- --nocapture
```

Expected: PASS. The mutation targets `PVTI_configured`, and duplicate configured-project items fail before a mutation is sent.

- [ ] **Step 6: Commit scoped write selection**

```bash
git add crates/ensemble-core/src/tracker/github.rs
git commit -m "fix: validate configured project item for GitHub writes"
```

### Task 4: Verify the Complete Tracker Fix

**Files:**
- Modify: `crates/ensemble-core/src/tracker/github.rs` only if formatting or Clippy requires it
- Verify: `docs/superpowers/plans/2026-07-10-github-project-status-scoping.md`

- [ ] **Step 1: Format the workspace**

Run:

```bash
cargo fmt --all
```

Expected: command exits successfully.

- [ ] **Step 2: Run the full core test suite**

Run:

```bash
cargo test -p ensemble-core
```

Expected: PASS, including existing repo-label mode, project fetch, reconciliation, and write tests.

- [ ] **Step 3: Run Clippy with warnings denied**

Run:

```bash
cargo clippy -p ensemble-core -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 4: Verify formatting is clean**

Run:

```bash
cargo fmt --all -- --check
```

Expected: PASS with no diff.

- [ ] **Step 5: Review the final diff against issue #320**

Run:

```bash
git diff --check
git diff -- crates/ensemble-core/src/tracker/github.rs docs/superpowers/plans/2026-07-10-github-project-status-scoping.md
```

Expected: no whitespace errors. Confirm the diff demonstrates all four acceptance criteria: query identity, configured-project-only reads, configured-project-only writes with deterministic missing/duplicate diagnostics, and multi-project GraphQL tests.

- [ ] **Step 6: Commit any verification-only formatting changes**

If `cargo fmt --all` changed the tracker after Task 3:

```bash
git add crates/ensemble-core/src/tracker/github.rs
git commit -m "style: format GitHub tracker project scoping"
```

If formatting made no changes, skip this commit rather than creating an empty commit.
