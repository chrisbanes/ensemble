# Agent Timeline Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-run timeline events and render a merged historical+live timeline in the web UI with retries shown inline and visually distinct.

**Architecture:** Add a timeline persistence/read layer in `ensemble-core`, wire persistence into event publication, expose a new timeline API endpoint, and update the Issue Detail timeline to merge paged history with WebSocket events by `(run_id, sequence)`. Keep writes best-effort so runtime behavior is unaffected by log IO failures.

**Tech Stack:** Rust (`tokio`, `serde`, `axum`, `utoipa`), TypeScript/React (`tanstack-query`, existing WS helpers), JSONL storage.

---

## File Structure

- Create: `crates/ensemble-core/src/timeline/model.rs` — normalized persisted timeline event types.
- Create: `crates/ensemble-core/src/timeline/writer.rs` — append-only JSONL writer for per-run event logs.
- Create: `crates/ensemble-core/src/timeline/reader.rs` — paginated read API for timeline JSONL.
- Create: `crates/ensemble-core/src/api/timeline_handler.rs` — HTTP endpoint for timeline history.
- Modify: `crates/ensemble-core/src/timeline/mod.rs` (new module export from `lib.rs` if missing).
- Modify: `crates/ensemble-core/src/lib.rs` — export `timeline` module.
- Modify: `crates/ensemble-core/src/observability/events.rs` — add persisted timeline envelope helpers (run_id, sequence mapping).
- Modify: `crates/ensemble-core/src/api/router.rs` — register `/api/v1/{identifier}/timeline` route.
- Modify: `crates/ensemble-core/src/api/openapi.rs` — add timeline handler and schemas.
- Modify: `crates/ensemble-core/src/observability/snapshot.rs` — include `run_id` in issue running detail (for UI API query).
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs` — route event emission through shared publish+persist path.
- Modify: `crates/ensemble-core/src/orchestrator/state.rs` — store per-run sequence counters in orchestrator state.
- Modify: `crates/ensemble-ui/src-ui/src/generated/api/issues/issues.ts` (via orval) — issue detail type includes `run_id`.
- Modify: `crates/ensemble-ui/src-ui/src/generated/api/timeline/timeline.ts` (via orval) — timeline endpoint hooks.
- Modify: `crates/ensemble-ui/src-ui/src/generated/models` (via orval) — timeline models.
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts` — expose `useTimelineQuery`.
- Modify: `crates/ensemble-ui/src-ui/src/ws-types.ts` and `src/ws-events.ts` — include `run_id` + `sequence` normalization.
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx` — show retry badge/accent and attempt metadata.
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` — load persisted timeline first, merge/de-dupe with WS stream.
- Tests:
  - `crates/ensemble-core/src/timeline/writer.rs` (unit tests)
  - `crates/ensemble-core/src/timeline/reader.rs` (unit tests)
  - `crates/ensemble-core/src/api/timeline_handler.rs` (API tests)
  - `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx` (or closest existing page test)
  - `crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx` (if missing, create)

---

### Task 1: Add timeline domain model + storage primitives

**Files:**
- Create: `crates/ensemble-core/src/timeline/model.rs`
- Create: `crates/ensemble-core/src/timeline/writer.rs`
- Create: `crates/ensemble-core/src/timeline/reader.rs`
- Create: `crates/ensemble-core/src/timeline/mod.rs`
- Modify: `crates/ensemble-core/src/lib.rs`
- Test: `crates/ensemble-core/src/timeline/writer.rs`, `crates/ensemble-core/src/timeline/reader.rs`

- [ ] **Step 1: Write failing unit tests for writer + reader**
```rust
#[tokio::test]
async fn append_creates_run_events_file_and_writes_jsonl_line() {
    let writer = TimelineWriter::new(tempdir.path().to_path_buf());
    writer.append(&sample_event("run-1", 1)).await.unwrap();
    let contents = tokio::fs::read_to_string(events_path(tempdir.path(), "run-1")).await.unwrap();
    assert_eq!(contents.lines().count(), 1);
}

#[tokio::test]
async fn read_timeline_returns_paginated_events_in_sequence_order() {
    write_events(vec![sample_event("run-1", 2), sample_event("run-1", 1)]).await;
    let response = read_timeline(&path, &TimelineQuery { run_id: "run-1".into(), cursor: Some(0), limit: Some(1) }).await.unwrap();
    assert_eq!(response.events[0].sequence, 1);
    assert_eq!(response.next_cursor, Some(1));
}

#[tokio::test]
async fn read_timeline_skips_malformed_lines() {
    tokio::fs::write(&path, "{\"bad\":\n{\"run_id\":\"run-1\",\"issue_identifier\":\"repo#1\",\"sequence\":1,\"timestamp\":\"2026-04-08T10:00:00Z\",\"event_type\":\"step_started\",\"step_name\":\"build\",\"attempt\":1,\"detail\":\"start\"}\n").await.unwrap();
    let response = read_timeline(&path, &query).await.unwrap();
    assert_eq!(response.events.len(), 1);
}
```

- [ ] **Step 2: Run tests to verify failure**
Run: `cargo test -p ensemble-core timeline::writer timeline::reader`
Expected: FAIL (missing module/types/functions)

- [ ] **Step 3: Implement `TimelineEventRecord`, writer, and reader**
```rust
pub struct TimelineEventRecord {
    pub run_id: String,
    pub issue_identifier: String,
    pub sequence: u64,
    pub timestamp: DateTime<Utc>,
    pub event_type: String,
    pub step_name: Option<String>,
    pub attempt: u32,
    pub detail: String,
    pub verdict: Option<String>,
    pub tool_name: Option<String>,
}
```

- [ ] **Step 4: Run tests to verify pass**
Run: `cargo test -p ensemble-core timeline::writer timeline::reader`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add crates/ensemble-core/src/timeline crates/ensemble-core/src/lib.rs
git commit -m "Add timeline JSONL model, writer, and reader"
```

### Task 2: Expose timeline history API

**Files:**
- Create: `crates/ensemble-core/src/api/timeline_handler.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Test: `crates/ensemble-core/src/api/timeline_handler.rs`

- [ ] **Step 1: Write failing API handler tests**
```rust
#[tokio::test]
async fn get_timeline_returns_empty_when_file_missing() {
    let (status, Json(body)) = get_timeline(State(state), Path("repo#1".into()), Query(query)).await.into_parts();
    assert_eq!(status, StatusCode::OK);
    assert!(body.events.is_empty());
}

#[tokio::test]
async fn get_timeline_returns_paginated_events_for_run_id() {
    write_timeline_lines(&state, "run-abc", vec![1, 2, 3]).await;
    let response = get_timeline(State(state), Path("repo#1".into()), Query(query_with_limit_2)).await.into_response();
    assert_eq!(response.status(), StatusCode::OK);
}
```

- [ ] **Step 2: Run tests to verify failure**
Run: `cargo test -p ensemble-core timeline_handler`
Expected: FAIL (missing route/handler)

- [ ] **Step 3: Implement endpoint + routing + schema registration**
```rust
// GET /api/v1/{identifier}/timeline?run_id=run-abc&cursor=0&limit=50
pub async fn get_timeline(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Query(query): Query<TimelineQuery>,
) -> impl IntoResponse {
    match read_timeline(&timeline_path(&state.workspace_root, &identifier, &query.run_id), &query).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, api_error("timeline_read_error", format!("failed to read timeline: {error}"))).into_response(),
    }
}
```

- [ ] **Step 4: Run tests to verify pass**
Run: `cargo test -p ensemble-core timeline_handler`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add crates/ensemble-core/src/api/timeline_handler.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/openapi.rs
git commit -m "Add timeline history API endpoint"
```

### Task 3: Persist pipeline events with run_id + sequence

**Files:**
- Modify: `crates/ensemble-core/src/observability/events.rs`
- Modify: orchestrator event emission callsites in `crates/ensemble-core/src/orchestrator/` (where pipeline events are produced)
- Modify: `crates/ensemble-core/src/observability/snapshot.rs` (include `run_id` in `RunningDetail`)
- Test: `crates/ensemble-core/src/orchestrator/mod.rs` tests and `crates/ensemble-core/src/observability/events.rs` tests

- [ ] **Step 1: Add failing test for event-to-timeline mapping**
```rust
#[test]
fn pipeline_event_maps_to_timeline_record_with_run_and_sequence() {
    let event = PipelineEvent::RetryScheduled { issue_identifier: "repo#1".into(), timestamp: Utc::now(), attempt: 2, detail: "retry".into() };
    let record = TimelineEventRecord::from_pipeline_event("run-1", 7, &event).unwrap();
    assert_eq!(record.run_id, "run-1");
    assert_eq!(record.sequence, 7);
    assert_eq!(record.attempt, 2);
}
```

- [ ] **Step 2: Run tests to verify failure**
Run: `cargo test -p ensemble-core observability::events`
Expected: FAIL (missing mapping/run_id/sequence fields)

- [ ] **Step 3: Implement mapping + persistence hook (best effort)**
```rust
if let Some(record) = TimelineEventRecord::from_pipeline_event(event, run_id, sequence) {
    if let Err(err) = timeline_writer.append(&record).await {
        warn!(event = "timeline_persist_failed", %run_id, error = %err);
    }
}
event_bus.publish(event);
```

- [ ] **Step 4: Expose run_id in issue detail snapshot for UI query**
```rust
pub struct RunningDetail {
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub step_name: Option<String>,
    pub turn_count: u32,
    pub state: String,
    pub started_at: DateTime<Utc>,
    pub last_event: Option<String>,
    pub last_message: Option<String>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub tokens: TokenSnapshot,
}
```

- [ ] **Step 5: Run focused tests**
Run: `cargo test -p ensemble-core observability::events orchestrator`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add crates/ensemble-core/src/observability/events.rs crates/ensemble-core/src/observability/snapshot.rs crates/ensemble-core/src/orchestrator
git commit -m "Persist pipeline events to per-run timeline logs"
```

### Task 4: Integrate timeline history in web UI and merge with WS

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/ws-types.ts`
- Modify: `crates/ensemble-ui/src-ui/src/ws-events.ts`
- Regenerate: `crates/ensemble-ui/src-ui/src/generated/api/timeline/timeline.ts`, `crates/ensemble-ui/src-ui/src/generated/api/issues/issues.ts`, `crates/ensemble-ui/src-ui/src/generated/models/index.ts` (orval)
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Add failing UI test for merged timeline**
```tsx
it("merges persisted timeline with live ws and dedupes by run_id+sequence", async () => {
  // assert single list in execution order
});
```

- [ ] **Step 2: Run test to verify failure**
Run: `cd crates/ensemble-ui/src-ui && pnpm test IssueDetail`
Expected: FAIL (no history hook/merge logic)

- [ ] **Step 3: Add timeline query + merge/de-dupe logic in IssueDetail**
```ts
const key = `${event.run_id}:${event.sequence}`;
const merged = [...history, ...live].filter(uniqueKey).sort(bySequenceThenTimestamp);
```

- [ ] **Step 4: Run UI tests**
Run: `cd crates/ensemble-ui/src-ui && pnpm test IssueDetail`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add crates/ensemble-ui/src-ui/src/hooks.ts crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx crates/ensemble-ui/src-ui/src/ws-types.ts crates/ensemble-ui/src-ui/src/ws-events.ts crates/ensemble-ui/src-ui/src/generated
git commit -m "Merge persisted and live timeline events in issue detail"
```

### Task 5: Distinct retry visuals and final verification

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
- Create/Modify: `crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx`

- [ ] **Step 1: Add failing visual behavior test**
```tsx
it("renders retry events with a distinct retry badge and accent styling", () => {
  // expects "Retry" and "Attempt 2" badge class
});
```

- [ ] **Step 2: Run test to verify failure**
Run: `cd crates/ensemble-ui/src-ui && pnpm test EventTimeline`
Expected: FAIL (badge/accent missing)

- [ ] **Step 3: Implement retry-specific badge + accent styling**
```tsx
{event.attempt > 1 && <Badge variant="secondary">Retry • Attempt {event.attempt}</Badge>}
```

- [ ] **Step 4: Run frontend verification**
Run: `cd crates/ensemble-ui/src-ui && pnpm test && pnpm run build`
Expected: PASS

- [ ] **Step 5: Run backend verification**
Run: `cargo test --workspace --exclude ensemble-desktop`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx crates/ensemble-ui/src-ui/src/components/EventTimeline.test.tsx
git commit -m "Render retries as distinct timeline badges"
```

## Final Validation Checklist

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --exclude ensemble-desktop -- -D warnings`
- [ ] `cargo test --workspace --exclude ensemble-desktop`
- [ ] `cd crates/ensemble-ui/src-ui && pnpm test && pnpm run build`
