# Agent Timeline Web UI Design

Date: 2026-04-08
Status: Proposed
Owner: Ensemble core + UI

## Goal

Make the Issue Detail timeline work for both live and historical runs by persisting pipeline events and rendering a single execution-ordered event stream in the web UI.

## Scope

In scope:
- Persist timeline events per run
- Read API for historical timeline events
- UI merge of persisted history + live WebSocket events
- Execution-order timeline rendering where retries appear inline
- Tests for writer/reader/API/UI merge behavior

Out of scope:
- Raw stdout/stderr log viewing
- SSE streaming support
- Database-backed event storage
- Advanced filtering/search UX

## Problem Statement

Today timeline events are emitted on the in-memory event bus and streamed over WebSocket, but not persisted. This means:
- active runs can be viewed live
- completed runs lose timeline detail
- retries/step history cannot be replayed reliably in the UI

## Design Summary

Use per-run append-only JSONL event persistence, then combine:
1. persisted timeline events from a REST endpoint
2. live WebSocket events for the active run

Render one chronological timeline in execution order. Retries are normal timeline rows (not grouped behind selectors).

## Persistence Model

### Storage path

Store timeline events under:
- `<workspace_root>/.ensemble/runs/<run_id>/events.jsonl`

This keeps events scoped to a single run, avoids global-file growth concerns, and supports parallel/multi-step execution.

### Event envelope

Persist a normalized timeline event record with:
- `run_id: String`
- `issue_identifier: String`
- `sequence: u64` (monotonic per run)
- `timestamp: DateTime<Utc>`
- `event_type: String` (or enum serialization)
- `step_name: Option<String>`
- `attempt: u32` (default 1)
- `detail: String`
- optional event-specific fields (e.g. `verdict`, `tool_name`, token deltas)

### Ordering contract

Primary ordering key: `sequence`.
Fallback ordering key: `timestamp`.

Retries are represented by later events with higher `sequence` and incremented `attempt`.

## Backend Write Path

- Add a timeline writer module in `ensemble-core` for JSONL append.
- Hook persistence into the existing pipeline event publication path.
- For each emitted pipeline event:
  - map to normalized timeline event
  - append to per-run `events.jsonl`
  - publish live event as today

### Failure behavior

Persistence failures are non-fatal:
- log warning/error with run + issue context
- continue orchestrator execution

## Read API

Add timeline history endpoint:
- `GET /api/v1/{identifier}/timeline?run_id=<id>&cursor=<n>&limit=<n>`

Response:
- `events: TimelineEvent[]`
- `total: usize`
- `next_cursor: Option<usize>`

Reader behavior:
- missing file => empty list
- malformed lines => skip line (best-effort)
- stable pagination semantics aligned with existing history/conversation patterns

## UI Behavior (Issue Detail)

### Data flow

1. Load persisted events for current run via timeline endpoint
2. Open WebSocket stream for live events
3. Normalize to shared UI event type
4. De-duplicate by `(run_id, sequence)`
5. Render one combined ordered list

### Rendering

Each row shows:
- event type/status style
- timestamp
- step name when present
- attempt badge (e.g. `Attempt 2`)
- detail text

Retries are inline events in the same list.

### Empty/error states

- No events yet: show empty state message
- Timeline history read failure: show non-blocking error banner and continue live stream where possible

## Why Not SSE

SSE is not required for this design:
- live updates already use WebSocket
- historical replay comes from REST timeline endpoint

Adding SSE now would duplicate transport complexity without solving a current gap.

## Testing Strategy

### Core tests

- Writer appends valid JSONL records and creates parent directories
- Reader returns ordered pages with cursor/limit behavior
- Reader skips malformed lines without failing whole request

### API tests

- Missing timeline file returns empty response
- Valid timeline file returns ordered events
- Pagination and cursor behavior

### UI tests

- Merges persisted + live events
- De-duplicates by `(run_id, sequence)`
- Renders retries inline in execution order

## Rollout Plan

1. Implement core timeline event model + writer
2. Wire persistence into event emission path
3. Add timeline reader + API endpoint
4. Update UI timeline data flow and rendering
5. Add/adjust tests for core/API/UI

## Recommendation

Adopt per-run JSONL timeline persistence now. It is the smallest change that enables reliable historical timeline replay while preserving existing live WebSocket behavior.
