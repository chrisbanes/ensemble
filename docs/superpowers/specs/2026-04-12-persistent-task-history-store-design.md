# Persistent Task History Store Design

## Goal
Replace JSONL-based task history/timeline persistence with a single global SQLite backing store that provides durable local writes (zero acknowledged data loss on crash/restart), while keeping existing history/timeline API response shapes unchanged.

## Scope
- In scope:
  - New global SQLite storage layer for run history + timeline events
  - Orchestrator write-path integration
  - API query-path swap from JSONL readers to SQL queries
  - Durable SQLite settings and crash-safety semantics
- Out of scope:
  - Backfill/migration of existing JSONL data
  - Remote DB support
  - API contract changes

## Constraints and Decisions
- Primary driver: durability and recovery guarantees
- Deployment model: local embedded store
- Storage topology: **single global DB** (not per-workspace DB)
- Legacy storage strategy: **replace** JSONL rather than dual-write
- Migration requirement: **none** (new store starts empty)

## Storage Architecture

### Database location
- Global DB file under Ensemble runtime state root:
  - `<workspace_root>/.ensemble/history.db`

### SQLite durability configuration
On connection initialization:
- `PRAGMA journal_mode = WAL;`
- `PRAGMA synchronous = FULL;`
- `PRAGMA busy_timeout = <configured>;`
- optional tuning: `wal_autocheckpoint`

### Logical model
Use one DB as source of truth for both summary history and event timeline.

#### Tables
1. `runs`
   - `run_id` (PK)
   - `issue_id`
   - `issue_identifier`
   - `started_at`
   - `completed_at` (nullable until terminal)
   - `outcome`
   - `attempts`
   - summary fields currently surfaced by history API (duration, token totals, last_error, verdict, workspace_path, etc.)

2. `run_events`
   - `run_id`
   - `sequence`
   - `timestamp`
   - `issue_identifier`
   - `event_type`
   - `step_name` (nullable)
   - `attempt`
   - `detail`
   - `verdict` (nullable)
   - `tool_name` (nullable)
   - Unique key: `(run_id, sequence)`

#### Indexes
- `run_events(run_id, sequence)`
- `runs(issue_identifier, completed_at)`
- `runs(outcome, completed_at)`

## Write Path Design

### Orchestrator integration
At existing persistence points (current history/timeline append sites), call a storage interface instead of file writers.

### Transaction boundary
Each acknowledged persistence operation uses a transaction:
1. `BEGIN IMMEDIATE`
2. upsert/update `runs` row as needed
3. insert `run_events` row (if event persistence point)
4. update summary columns in `runs` when applicable
5. `COMMIT`

### Acknowledgement semantics
- Success is reported only after `COMMIT` succeeds.
- Therefore, acknowledged writes are durable across process restart under configured SQLite durability mode.

### Idempotency / duplicate protection
- Enforce uniqueness on `(run_id, sequence)`.
- If replay occurs after partial failure/retry, duplicate inserts are no-op or explicitly handled as idempotent conflict.

## Recovery Semantics
- Crash before `COMMIT`: write is not visible and not acknowledged.
- Crash after `COMMIT`: write is durable and queryable on restart.
- Startup behavior:
  - open DB
  - apply schema bootstrap if missing
  - no JSONL import/backfill
  - optional warning if legacy JSONL files are detected

## Read Path / API Compatibility

### Unchanged API contracts
- `GET /api/v1/history` response shape unchanged
- `GET /api/v1/{identifier}/timeline?run_id=...` response shape unchanged

### Implementation swap
- Replace JSONL `read_history(...)` with SQL query + pagination/filtering mapping.
- Replace JSONL timeline reader with SQL query over `run_events` filtered by `run_id` (+ identifier path scope).
- Preserve current pagination semantics (`cursor`, `limit`) at API boundary.

## Error Handling
- DB initialization failure: startup error with actionable message.
- Write failure in orchestrator path:
  - log structured error
  - keep existing event-bus behavior where possible
  - fail persistence operation explicitly (no silent success).
- Busy/lock contention: bounded retry behavior via busy timeout; emit warnings on repeated contention.

## Testing Strategy

### Unit tests
- Schema bootstrap creates required tables/indexes.
- Insert/read mapping parity with current model structs.
- Duplicate `(run_id, sequence)` handling is idempotent.

### Integration tests
- Orchestrator writes history/timeline records to SQLite at existing lifecycle points.
- History endpoint returns equivalent shape/content for new writes.
- Timeline endpoint returns ordered events with filters and pagination.

### Durability-focused tests
- Simulated restart test: write, drop runtime, reopen, verify committed data present.
- Transaction atomicity test: induce failure mid-operation, assert no partial visible write.

## Rollout Notes
- Cutover is immediate to SQLite-backed persistence for new runs.
- No migration/backfill from JSONL.
- Legacy JSONL files are ignored by read path.

## Open Questions
- None for initial implementation scope.
