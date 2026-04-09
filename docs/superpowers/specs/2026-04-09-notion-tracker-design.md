# Notion Tracker Backend Design

## Goal
Add a first-class Notion tracker backend to Ensemble so orchestrator pipelines can read candidate work items from Notion, drive state transitions, and publish run feedback via comments.

## Scope
- Add `tracker.kind: notion` as a pluggable `IssueTracker` implementation.
- Support one Notion database per Ensemble config.
- Filter candidates by both active state and explicit opt-in property.
- Write pipeline state transitions to a single status/select property.
- Write verdict/run feedback to Notion page comments.

Out of scope (v1):
- Multi-database fan-in.
- Bidirectional schema migration.
- Advanced per-page mapping logic.

## Decisions Captured
1. Notion is a full read+write tracker backend (not read-only).
2. v1 supports a single Notion database per project.
3. Workflow state is mapped to one `Status`-style property.
4. Pipeline notes/verdicts are written as page comments.
5. Candidate selection requires an explicit opt-in property (e.g. `Ready to Implement`).
6. Use a hybrid schema model: default property names with optional config overrides.

## Architecture

### Adapter placement
- Create `crates/ensemble-core/src/tracker/notion.rs` implementing `IssueTracker`.
- Wire adapter construction into `crates/ensemble-core/src/tracker/mod.rs` factory.
- Keep orchestrator and pipeline engine unchanged; they depend only on `IssueTracker` semantics.

### Interfaces
The adapter must implement:
- `fetch_candidate_issues`
- `fetch_terminal_issues`
- `fetch_issue_states_by_ids`
- `supports_writes` (true)
- `set_issue_state`
- `add_comment`

## Configuration Model

Add `notion` fields to tracker config:

```yaml
tracker:
  kind: notion
  notion:
    api_key: $NOTION_API_KEY
    version: "2022-06-28"  # optional, default pinned in code
    database_id: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" # required

  active_states: ["Todo", "In Progress"]
  terminal_states: ["Done", "Canceled"]

  # Hybrid defaults (all optional overrides)
    title_property: "Name"
    status_property: "Status"
    enabled_property: "Ready to Implement"
    enabled_value_bool: true
```

### Validation rules
- `tracker.notion.api_key` and `tracker.notion.database_id` are required for `tracker.kind: notion`.
- `tracker.notion.status_property` must exist and be a status/select-compatible property.
- `tracker.notion.title_property` must exist and be readable as title text.
- `tracker.notion.enabled_property` must exist and support configured `enabled_value_bool` type.
- If pipeline uses `tracker_state` / `on_success` / `on_failure`, each configured state must map to a valid Notion status option.

## Data Mapping

### Ensemble issue model
- `Issue.id` = Notion page ID (canonical).
- `Issue.key` = stable display key (default: shortened page ID for now).
- `Issue.title` = `title_property`.
- `Issue.state` = selected value from `status_property`.

### Candidate selection
Database query filter is:
1. `status_property` in `active_states`, and
2. `enabled_property == enabled_value_bool`.

### Terminal fetch
`fetch_terminal_issues` filters by `terminal_states` (same opt-in filter preserved for consistency).

## Runtime Behavior

### State refresh
`fetch_issue_states_by_ids` reads current status for running issue IDs so reconciliation can terminate or continue runs as it already does for other trackers.

### Writes
- `set_issue_state(issue_id, state)` updates `status_property` on the Notion page.
- `add_comment(issue_id, body)` creates a Notion comment on that page.

### Error handling
- 401/403: authentication/authorization misconfiguration (non-retryable until config/auth fixed).
- 404 for database/page: missing resource or stale config (non-retryable).
- 429/5xx/network timeout: transient/retryable tracker errors.
- Missing configured state option: typed mismatch/config error with clear field + state name.

## Testing Strategy

### Unit tests
- Property extraction/mapping from Notion payloads to `Issue`.
- Filter/query construction for candidate and terminal selection.
- Error classification and message rendering.

### Adapter integration tests (mock HTTP)
- Candidate fetch success path.
- State refresh by ID list.
- Status transition write success/failure.
- Comment creation success/failure.
- Rate-limit and transient failure handling.

### Config/factory tests
- `tracker.kind: notion` constructs adapter when required fields are present.
- Missing required fields fail with specific tracker/config errors.
- Override and default property name behavior.

### Regression tests
- Ensure orchestrator pipeline behavior remains tracker-agnostic with the new adapter.

## Rollout Notes
- Keep Notion API version pinned by default to reduce schema drift.
- Surface startup validation errors early in `ensemble init` and startup config validation.
- Document required Notion database property setup in docs after implementation.
