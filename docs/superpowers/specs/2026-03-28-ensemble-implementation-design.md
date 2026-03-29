# Ensemble Implementation Design

## Overview

Ensemble is a Rust implementation of the Ensemble Service Specification (SPEC.md). It orchestrates multi-agent pipelines against issue trackers: polling for work, creating isolated workspaces per issue, running named agents through a step DAG (build, review, etc.), collecting verdicts, and driving tracker state transitions. It provides a web dashboard for observability.

The system ships as two binaries built from a shared core library:
- **ensemble-desktop**: Tauri app with embedded orchestrator and React dashboard
- **ensemble-cli**: Headless daemon for server deployments

Target audience: personal/small team use, with an OSS-friendly design.

## Architecture: Cargo Workspace

```
ensemble/
├── Cargo.toml                    # workspace root
├── SPEC.md
├── README.md
├── crates/
│   ├── ensemble-core/            # library: all orchestration logic
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── config/           # ensemble.yaml loader, typed config, validation
│   │       ├── tracker/          # pluggable issue trackers (todo_file, github) with read + write
│   │       ├── pipeline/         # step DAG, per-issue execution engine, verdict collection
│   │       ├── orchestrator/     # state machine, polling, dispatch, retry, reconciliation
│   │       ├── workspace/        # workspace manager, hooks, safety invariants
│   │       ├── agent/            # ACP client (stdio JSON-RPC 2.0)
│   │       ├── api/              # HTTP REST API (axum)
│   │       └── observability/    # structured logging, metrics, snapshots
│   ├── ensemble-cli/             # headless binary
│   │   ├── Cargo.toml
│   │   └── src/main.rs           # CLI entry: parse args, start core, optionally serve API
│   └── ensemble-desktop/         # Tauri binary
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── src/main.rs           # Tauri entry: start core, serve dashboard
│       └── src-ui/               # React app (Vite)
│           ├── package.json
│           ├── src/
│           └── ...
```

The separation ensures the core orchestration logic is testable without Tauri/WebView dependencies, and headless users don't need to install GUI toolkits.

## Core Library Modules (`ensemble-core`)

### `config/`

- **`ensemble.rs`**: Loads `ensemble.yaml`, parses into typed `EnsembleConfig` (tracker, agents, steps, concurrency, pipeline config). Watches for file changes via the `notify` crate and triggers reload callbacks. Handles `$VAR` env resolution, `~` path expansion, integer coercion from string values. Validated at startup and before each dispatch tick. Dispatch validation is tracker-kind-aware: `todo_file` only needs a valid path, `github` needs api_key + repository. Also validates DAG structure (no cycles, all agent/step references resolve) and write support requirements.
- **`template.rs`**: Liquid-compatible prompt rendering (via `liquid` crate) with strict variable/filter checking. Takes an `Issue` + `Option<u32>` attempt and produces the rendered prompt string. Unknown variables fail rendering. Used by each agent's prompt (inline or file-referenced).

### `tracker/`

The tracker subsystem is pluggable. All tracker implementations share the `IssueTracker` trait and normalize to the same `Issue` model. The orchestrator is tracker-agnostic. The trait includes both read operations (fetch candidates, fetch states) and write operations (set state, add comment) with default no-op implementations.

- **`mod.rs`**: `IssueTracker` trait (read + write methods with default no-ops), `TrackerError` (including `WritesNotSupported`), and a factory function that returns the appropriate implementation based on `tracker.kind`.
- **`todo_file.rs`**: File-based tracker that reads issues from a local Markdown file (default `TODO.md`). Issues are list items under `## <State>` headings. No API credentials needed — ideal for personal use and getting started quickly.
  - Parses `[IDENTIFIER]` from the start of list items, or generates a stable slug from the title.
  - Re-reads the file on each poll tick.
  - Priority derived from document order.
  - Write support: `set_issue_state` rewrites the file, moving the issue line between `## Section` headings. `add_comment` returns `WritesNotSupported`.
- **`github.rs`**: GitHub Projects v2 GraphQL client using `reqwest`. Implements three operations:
  - `fetch_candidate_issues()` — Paginates ProjectV2 items filtered by Status field matching `active_states`, or repo issues filtered by open state + optional labels. Page size 50, cursor-based.
  - `fetch_issues_by_states(states)` — For startup terminal cleanup.
  - `fetch_issue_states_by_ids(ids)` — Lightweight batch query for reconciliation (just id + state).
  - At startup (when `project_number` is set), performs a discovery query to resolve the Project v2 node ID, Status field ID, and option name-to-ID mapping. Cached in memory, refreshed on config reload.
  - Write support: `set_issue_state` uses GraphQL mutation to update the Status field (project board mode) or labels (repo mode). `add_comment` uses the `addComment` GraphQL mutation.
- **`model.rs`**: The normalized `Issue` struct and related types (shared by all tracker backends):

```rust
pub struct Issue {
    pub id: String,                         // GitHub node ID
    pub identifier: String,                 // "my-repo#42"
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i32>,              // from Priority field if present
    pub state: String,                      // Status field value or "open"/"closed"
    pub branch_name: Option<String>,
    pub url: Option<String>,
    pub labels: Vec<String>,                // lowercased
    pub blocked_by: Vec<BlockerRef>,        // empty unless impl parses body refs
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

pub struct BlockerRef {
    pub id: Option<String>,
    pub identifier: Option<String>,
    pub state: Option<String>,
}
```

Rate limiting: tracks `X-RateLimit-Remaining` header and logs warnings. The 30s poll interval is naturally conservative against GitHub's 5,000 points/hour budget.

### `orchestrator/`

- **`state.rs`**: `OrchestratorState` — the single authoritative in-memory state:
  - `running: HashMap<String, RunningEntry>` — issue_id to running session metadata
  - `claimed: HashSet<String>` — issue IDs reserved/running/retrying
  - `retry_attempts: HashMap<String, RetryEntry>` — pending retries with timers
  - `completed: HashSet<String>` — bookkeeping only
  - `agent_totals: AgentTotals` — aggregate token counts + runtime seconds
  - `agent_rate_limits: Option<RateLimitSnapshot>`
- **`scheduler.rs`**: Poll loop implementation. Each tick: reconcile → validate config → fetch candidates → sort by priority (ascending, then oldest `created_at`, then identifier) → dispatch while slots available. Concurrency control: global cap from `agent.max_concurrent_agents`, per-state caps from `agent.max_concurrent_agents_by_state`.
- **`reconciler.rs`**: Two-part reconciliation per tick:
  - Part A: Stall detection — compare `last_agent_timestamp` or `started_at` against `agent.stall_timeout_ms`. Kill stalled workers.
  - Part B: Tracker state refresh — fetch current states for running issue IDs. Terminal → kill + cleanup workspace. Active → update snapshot. Non-active → kill without cleanup.
- **`retry.rs`**: Retry queue management. Normal exit → 1s continuation retry. Failure → `min(10s * 2^(attempt-1), max_retry_backoff_ms)`. Retries stored with attempt count, due time, error context.

### `pipeline/`

- **`dag.rs`**: Builds a directed acyclic graph from `steps` config. Validates: all agent references exist, all dependency references resolve, no cycles (topological sort), at least one root step. Implicit sequential rule: the first step is a root; subsequent steps without `depends` implicitly depend on their predecessor.
- **`engine.rs`**: Per-issue pipeline execution engine. Manages `PipelineRun` state: dispatches root steps, collects verdicts as agents complete, unblocks downstream steps, enforces `max_step_parallelism`. Writes `tracker_state` on step entry, `on_success`/`on_failure` on pipeline completion. Tracks `cycle` count per issue for `max_cycles` enforcement.
- **`verdict.rs`**: Verdict collection from two sources (priority order): ACP protocol `verdict` field in final status event, or `.ensemble/verdict.json` file in workspace. Parses `approve`/`reject` + optional `summary`. Missing verdict = approve.

### `workspace/`

- **`manager.rs`**: Deterministic path: `<workspace.root>/<sanitized_identifier>`. Sanitization replaces non-`[A-Za-z0-9._-]` chars with `_`. Validates workspace path stays inside workspace root (absolute path prefix check). Creates directory if missing, reuses if present.
- **`hooks.rs`**: Runs shell scripts via `tokio::process::Command` with `sh -lc <script>`, cwd set to workspace path. Timeout enforcement via `tokio::time::timeout(hooks.timeout_ms)`. Failure semantics per spec: `after_create`/`before_run` fatal, `after_run`/`before_remove` logged and ignored.

### `agent/`

- **`acp_client.rs`**: Spawns agent subprocess via `bash -lc <agent.command>` with cwd = workspace path. Manages stdio:
  - Stdout: `tokio::io::BufReader::read_line()`, max 10MB per line, JSON-RPC 2.0 parsing
  - Stdin: write JSON-RPC messages + newline via `tokio::io::AsyncWriteExt`
  - Stderr: logged as diagnostics, not parsed

  ACP handshake sequence:
  1. `initialize` → wait for response (`read_timeout_ms`)
  2. `session/new { cwd, mcpServers }` → extract `sessionId`
  3. `session/set_mode` (optional, if `agent.session_mode` configured)
  4. `session/prompt { sessionId, content }` → stream `session/update` notifications

  Turn loop: read `session/update` messages until `stopReason` appears. Map `end_turn` → success, `cancelled`/`refusal`/`max_turn_requests` → failure. Enforce `agent.turn_timeout_ms`.

  Permission handling: on `session/request_permission`, respond per `agent.permission_policy`: `auto_approve_all` → `allow_always`, etc.

  Verdict extraction: on agent exit, check the final `session/update` for a `verdict` field. If absent, check `.ensemble/verdict.json` in workspace. No verdict = approve. Pass verdict back to pipeline engine.

  Process cleanup: `session/cancel` → SIGTERM → grace period → SIGKILL.

- **`events.rs`**: Maps ACP messages to internal event enum:
  - `SessionStarted`, `TurnStarted`, `TurnUpdate`, `TurnCompleted`, `TurnFailed`
  - `PermissionRequested`, `PermissionResolved`
  - `Notification`, `OtherMessage`, `Malformed`

  Each event carries timestamp, agent_pid, optional usage data.

### `api/`

- **`router.rs`**: axum router with endpoints:
  - `GET /` — serves static dashboard assets (React build output)
  - `GET /api/v1/state` — runtime snapshot (running sessions, retry queue, token totals, rate limits)
  - `GET /api/v1/:identifier` — issue-specific debug details
  - `POST /api/v1/refresh` — trigger immediate poll + reconciliation (202 Accepted)
  - Unsupported methods → 405. Errors → `{"error":{"code":"...","message":"..."}}`.
- **`handlers.rs`**: Read from `Arc<RwLock<OrchestratorState>>`. Snapshot computation happens on read — no background ticker needed.

### `observability/`

- **`logging.rs`**: `tracing` + `tracing-subscriber`. JSON output for machine consumption, human-readable for terminal (auto-detected). Key spans: `orchestrator`, `issue{id, identifier}`, `session{session_id}`, `hook{name, workspace}`.
- **`snapshot.rs`**: Produces `RuntimeSnapshot` struct consumed by the API:
  - Running rows with turn_count, last event, tokens
  - Retry rows with attempt, due time, error
  - Aggregate totals (tokens + live runtime seconds computed from `started_at`)

## Orchestrator Runtime Model

### Event loop

The orchestrator runs as a single tokio task that selects on multiple event sources:

```
select! {
    _ = poll_timer.tick()     => handle_tick()
    event = worker_rx.recv()  => handle_worker_event(event)
    _ = retry_timers.next()   => handle_retry_fire()
    _ = config_change_rx      => handle_workflow_reload()
}
```

All state mutations are serialized through this single task — no concurrent writes, no lock contention on the hot path.

### Worker communication

Workers (one spawned tokio task per dispatched issue) communicate back via `tokio::sync::mpsc`:

```rust
enum WorkerEvent {
    AgentUpdate { issue_id: String, event: AgentEvent },
    WorkerExited { issue_id: String, result: WorkerResult },
}
```

Workers never touch `OrchestratorState` directly. The orchestrator applies all state transitions.

### Shared state access

`OrchestratorState` lives behind `Arc<tokio::sync::RwLock<OrchestratorState>>`:
- The orchestrator task holds the write lock during mutations (brief, serialized)
- API handlers acquire read locks for snapshots
- Workers don't access it at all (communicate via channel)

### Retry timers

Stored as `tokio::time::Sleep` futures in a `FuturesUnordered`. When a retry fires, it sends an event into the main select loop, which re-fetches candidates and re-dispatches or re-queues.

## Web Dashboard (React)

### Shared frontend

The same React app serves both Tauri desktop and headless browser access. No Tauri-specific APIs — it's a pure HTTP client consuming `/api/v1/*`.

### Tech stack

- Vite (build tooling, Tauri default)
- React 19 with TypeScript
- Tailwind CSS
- TanStack Query for data fetching, caching, and auto-refresh (2-3s polling interval)

### Pages

- **Dashboard (home)**: Running agents table (issue, session, turn count, last event, tokens), retry queue with countdowns, aggregate totals, rate limit status
- **Issue detail**: Workspace path, attempt history, recent events, session logs, token breakdown. Linked from dashboard rows.
- **Config status**: Current effective config, validation state, last reload timestamp

### Tauri integration

`ensemble-desktop/src/main.rs`:
1. Starts the `ensemble-core` orchestrator (config → poll loop → workers)
2. Starts the axum HTTP server on `127.0.0.1:<port>`
3. Opens the Tauri window pointed at `http://127.0.0.1:<port>/`

The window closing stops the orchestrator. Single process, single binary.

### HTTP server port selection

Both binaries use the same logic for port selection (precedence order):
1. CLI `--port` argument (if provided)
2. `server.port` from ensemble.yaml (if present)
3. No HTTP server started (for `ensemble-cli` when no port is configured)

`ensemble-desktop` always starts the HTTP server (needed for the WebView). If no port is configured, it binds to an ephemeral port on `127.0.0.1`.

## Error Handling

### Top-level error type

```rust
#[derive(Debug, thiserror::Error)]
enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Tracker(#[from] TrackerError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Agent(#[from] AgentError),
    #[error(transparent)]
    Pipeline(#[from] PipelineError),
}
```

### Recovery behavior by layer

| Layer | Failure | Recovery |
|-------|---------|----------|
| Config (startup) | Missing ensemble.yaml, bad YAML, invalid DAG | Fail fast with clear error |
| Config (reload) | Invalid new config | Keep last good config, log error |
| Pipeline | Step failure, rejection, max cycles | Write on_failure to tracker, halt pipeline |
| Tracker (candidates) | API/network error | Skip dispatch this tick, retry next tick |
| Tracker (reconciliation) | State refresh failed | Keep workers running, retry next tick |
| Tracker (startup cleanup) | Terminal fetch failed | Log warning, continue startup |
| Workspace | Creation failed, hook failed | Abort attempt, orchestrator retries |
| Agent | Handshake/turn/timeout/exit | Worker fails, exponential backoff retry |
| API | Snapshot timeout | 503 response, orchestrator unaffected |
| Logging | Sink failure | Continue running, warn via remaining sinks |

The orchestrator never crashes due to downstream failures.

## Testing Strategy

### Trait boundaries for testability

```rust
#[async_trait]
pub trait IssueTracker: Send + Sync {
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError>;
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError>;
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError>;
    fn supports_writes(&self) -> bool { false }
    async fn set_issue_state(&self, id: &str, state: &str) -> Result<(), TrackerError>;
    async fn add_comment(&self, id: &str, body: &str) -> Result<(), TrackerError>;
}

#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        issue: &Issue,
        attempt: Option<u32>,
        workspace: &Path,
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), AgentError>;
}
```

### Unit tests

- **`config/`**: Parse valid/invalid ensemble.yaml, defaults, `$VAR` resolution, `~` expansion, reload, DAG validation (cycles, missing refs, agent prompt validation)
- **`tracker/`**: Mock HTTP responses (`wiremock`). Pagination, normalization, error handling, write operations (set_issue_state, add_comment)
- **`pipeline/`**: DAG construction, topological sort, cycle detection, per-issue execution (step dispatch, verdict collection, step transitions, concurrency enforcement, max_cycles)
- **`orchestrator/`**: Mock tracker + agent traits. Test state transitions: dispatch eligibility, blocker rules, concurrency limits, backoff calculations, reconciliation paths
- **`workspace/`**: Real filesystem in temp dirs. Sanitization, containment, hook execution with mock scripts
- **`agent/`**: Mock ACP agent (script that speaks JSON-RPC on stdio). Handshake, turn flow, permission handling, timeouts

### Integration tests

- **End-to-end**: Full orchestrator with wiremock GitHub API + mock ACP agent script. Verify poll → dispatch → agent run → turn complete → retry → reconciliation.
- **API tests**: Pre-populated state, verify REST endpoint JSON shapes match spec Section 13.7.2.

### No frontend tests initially

Dashboard is a thin API consumer. Rely on API contract correctness. Add Playwright/Vitest later if complexity grows.

## Key Dependencies

| Crate | Purpose |
|-------|---------|
| `tokio` | Async runtime (full features) |
| `axum` | HTTP server |
| `reqwest` | HTTP client (GitHub API) |
| `serde`, `serde_json`, `serde_yaml` | Serialization |
| `liquid` | Prompt template rendering |
| `notify` | Filesystem watching (ensemble.yaml) |
| `tracing`, `tracing-subscriber` | Structured logging |
| `thiserror` | Error types |
| `chrono` | Timestamps |
| `clap` | CLI argument parsing |
| `tauri` | Desktop app shell (ensemble-desktop only) |
| `wiremock` | HTTP mocking (tests) |

## Out of Scope

- Persistent database for orchestrator state (in-memory only, per spec)
- Multi-tenant / multi-user access control
- Frontend tests (deferred)
- SSH worker extension (Appendix A of spec — can be added later)
- `github_graphql` MCP tool extension (optional per spec — can be added later)
- Linear tracker adapter (post-MVP — the `IssueTracker` trait makes this straightforward to add)

## Multi-Agent Pipeline Architecture

The pipeline architecture is documented inline in the module descriptions above (`config/`, `pipeline/`, `tracker/`) and specified in SPEC.md Sections 4-5 and 11.5. Key design points:

- **`ensemble.yaml` config format** — replaces `WORKFLOW.md` with named agents, step DAG, and pipeline config
- **Pipeline engine** — DAG construction, per-issue execution, verdict collection, tracker state writes
- **Tracker write methods** — `set_issue_state` and `add_comment` with default no-ops on `IssueTracker` trait
- **Verdict contract** — ACP protocol field (preferred) and `.ensemble/verdict.json` file (fallback)
- **Two-level concurrency** — global `max_concurrent_agents` + per-issue `max_step_parallelism`
