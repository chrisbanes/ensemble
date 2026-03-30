# Plan 4: API, Observability & CLI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the HTTP REST API for runtime observability, structured logging initialization, runtime snapshot generation, the `ensemble-cli` headless binary, and the backend extensions needed by the dashboard (event bus, history log, conversation/stop/retry endpoints, WebSocket streaming, static asset serving).

**Architecture:** The observability layer reads from `Arc<RwLock<OrchestratorState>>` via read locks and produces JSON snapshots consumed by the axum API. The CLI binary is a thin entry point that parses arguments, initializes logging, loads config, creates all subsystems from Plans 1-3, optionally starts the HTTP server, and waits for shutdown. The event bus uses a `tokio::sync::broadcast` channel for pipeline event fan-out to WebSocket subscribers. History is stored as an append-only JSONL file on disk.

**Tech Stack:** Rust (2021 edition), axum (with ws feature), tokio, tracing, tracing-subscriber (json + env-filter), serde/serde_json, chrono, clap, tower-http (ServeDir, method-not-allowed), futures-util, reqwest (test client)

**Design spec (for dashboard backend):** `docs/superpowers/specs/2026-03-30-dashboard-design.md`

---

## File Structure

```
ensemble/
├── Cargo.toml                                  # workspace root (update members + deps)
├── crates/
│   ├── ensemble-core/
│   │   ├── Cargo.toml                          # add: axum (ws), tower-http, futures-util
│   │   └── src/
│   │       ├── lib.rs                          # add api + observability + history modules
│   │       ├── observability/
│   │       │   ├── mod.rs                      # re-exports
│   │       │   ├── snapshot.rs                 # RuntimeSnapshot, build_state_snapshot()
│   │       │   ├── logging.rs                  # init_logging()
│   │       │   └── events.rs                   # EventBus, PipelineEvent types
│   │       ├── history/
│   │       │   ├── mod.rs                      # re-exports
│   │       │   ├── model.rs                    # HistoryRecord struct
│   │       │   ├── writer.rs                   # append-only JSONL writer
│   │       │   └── reader.rs                   # JSONL reader with filtering
│   │       └── api/
│   │           ├── mod.rs                      # re-exports
│   │           ├── router.rs                   # create_api_router() + static serving
│   │           ├── handlers.rs                 # get_state, get_issue_detail, post_refresh
│   │           ├── conversation.rs             # paginated conversation handlers
│   │           ├── controls.rs                 # stop + retry handlers
│   │           ├── history_handler.rs          # history query handler
│   │           └── ws.rs                       # WebSocket upgrade + event fan-out
│   └── ensemble-cli/
│       ├── Cargo.toml                          # binary crate
│       └── src/
│           └── main.rs                         # CLI entry point
```

---

### Task 1: Runtime Snapshot Types

**Files:**
- Create: `crates/ensemble-core/src/observability/mod.rs`
- Create: `crates/ensemble-core/src/observability/snapshot.rs`
- Modify: `crates/ensemble-core/src/lib.rs` (add `pub mod observability;`)

- [ ] **Step 1: Create the observability module file**

Create `crates/ensemble-core/src/observability/mod.rs`:

```rust
pub mod logging;
pub mod snapshot;
```

- [ ] **Step 2: Add the observability module to lib.rs**

Add this line to `crates/ensemble-core/src/lib.rs` alongside the existing module declarations:

```rust
pub mod observability;
```

The full `lib.rs` should now contain:

```rust
pub mod config;
pub mod error;
pub mod pipeline;
pub mod tracker;
pub mod workspace;
pub mod agent;
pub mod orchestrator;
pub mod observability;
```

- [ ] **Step 3: Write snapshot types and build function**

Create `crates/ensemble-core/src/observability/snapshot.rs`:

```rust
use crate::orchestrator::state::OrchestratorState;
use crate::pipeline::engine::{PipelineRun, StepState};
use crate::tracker::model::{RunningEntry, RetryEntry};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;

/// Top-level runtime snapshot matching SPEC.md Section 13.7.2 GET /api/v1/state shape.
#[derive(Debug, Serialize)]
pub struct RuntimeSnapshot {
    pub generated_at: DateTime<Utc>,
    pub counts: SnapshotCounts,
    pub running: Vec<RunningSessionRow>,
    pub retrying: Vec<RetryRow>,
    pub agent_totals: AgentTotalsSnapshot,
    pub rate_limits: Option<serde_json::Value>,
}

/// Summary counts of running and retrying sessions.
#[derive(Debug, Serialize)]
pub struct SnapshotCounts {
    pub running: usize,
    pub retrying: usize,
}

/// A single row in the running sessions list.
#[derive(Debug, Serialize)]
pub struct RunningSessionRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub state: String,
    pub step_name: Option<String>,
    pub session_id: Option<String>,
    pub turn_count: u32,
    pub last_event: Option<String>,
    pub last_message: Option<String>,
    pub started_at: DateTime<Utc>,
    pub last_event_at: Option<DateTime<Utc>>,
    pub tokens: TokenSnapshot,
}

/// Token counts for a single session.
#[derive(Debug, Serialize)]
pub struct TokenSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

/// A single row in the retry queue list.
#[derive(Debug, Serialize)]
pub struct RetryRow {
    pub issue_id: String,
    pub issue_identifier: String,
    pub attempt: u32,
    pub due_at_ms: u64,
    pub error: Option<String>,
}

/// Aggregate token and runtime totals for the snapshot.
#[derive(Debug, Serialize)]
pub struct AgentTotalsSnapshot {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub seconds_running: f64,
}

/// Per-issue detail snapshot for GET /api/v1/{identifier}.
///
/// NOTE: Plan 5 (Dashboard) expects additional fields `logs` and `recent_events`
/// in the API response. When implementing the dashboard integration, extend this
/// struct with:
///   - `logs: IssueLogInfo` (containing `agent_session_logs: Vec<AgentSessionLog>`)
///   - `recent_events: Vec<RecentEvent>`
/// These are omitted here because Plan 4 does not yet have the event/log collection
/// infrastructure, but the JSON shape should be forward-compatible.
#[derive(Debug, Serialize)]
pub struct IssueDetailSnapshot {
    pub issue_identifier: String,
    pub issue_id: String,
    pub status: String,
    pub workspace: WorkspaceInfo,
    pub attempts: AttemptInfo,
    pub running: Option<RunningDetail>,
    pub retry: Option<RetryRow>,
    pub last_error: Option<String>,
}

/// Workspace path info for issue detail.
#[derive(Debug, Serialize)]
pub struct WorkspaceInfo {
    pub path: String,
}

/// Attempt tracking for issue detail.
#[derive(Debug, Serialize)]
pub struct AttemptInfo {
    pub restart_count: u32,
    pub current_retry_attempt: Option<u32>,
}

/// Running session detail for issue detail.
#[derive(Debug, Serialize)]
pub struct RunningDetail {
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

/// Build a RuntimeSnapshot from the current OrchestratorState.
///
/// This computes `seconds_running` as the sum of cumulative ended-session runtime
/// plus elapsed time for all currently active sessions (from their `started_at`).
pub fn build_state_snapshot(state: &OrchestratorState) -> RuntimeSnapshot {
    let now = Utc::now();

    let running_rows: Vec<RunningSessionRow> = state
        .running
        .values()
        .map(|entry| running_entry_to_row(entry, &state.pipeline_runs))
        .collect();

    let retry_rows: Vec<RetryRow> = state
        .retry_attempts
        .values()
        .map(|entry| retry_entry_to_row(entry))
        .collect();

    // Compute live seconds_running: cumulative from ended sessions + active elapsed
    let active_elapsed: f64 = state
        .running
        .values()
        .map(|entry| {
            let elapsed = now.signed_duration_since(entry.started_at);
            elapsed.num_milliseconds().max(0) as f64 / 1000.0
        })
        .sum();

    let total_seconds = state.agent_totals.seconds_running + active_elapsed;

    RuntimeSnapshot {
        generated_at: now,
        counts: SnapshotCounts {
            running: running_rows.len(),
            retrying: retry_rows.len(),
        },
        running: running_rows,
        retrying: retry_rows,
        agent_totals: AgentTotalsSnapshot {
            input_tokens: state.agent_totals.input_tokens,
            output_tokens: state.agent_totals.output_tokens,
            total_tokens: state.agent_totals.total_tokens,
            seconds_running: total_seconds,
        },
        rate_limits: state.agent_rate_limits.clone(),
    }
}

/// Build an IssueDetailSnapshot for a specific issue by identifier.
///
/// Returns None if the identifier is not found in running or retry maps.
pub fn build_issue_snapshot(
    state: &OrchestratorState,
    identifier: &str,
    workspace_root: &str,
) -> Option<IssueDetailSnapshot> {
    // Check running entries first
    let running_entry = state
        .running
        .values()
        .find(|e| e.identifier == identifier);

    // Check retry entries
    let retry_entry = state
        .retry_attempts
        .values()
        .find(|e| e.identifier == identifier);

    if running_entry.is_none() && retry_entry.is_none() {
        return None;
    }

    let (issue_id, issue_identifier) = if let Some(entry) = running_entry {
        (entry.issue_id.clone(), entry.identifier.clone())
    } else if let Some(entry) = retry_entry {
        (entry.issue_id.clone(), entry.identifier.clone())
    } else {
        return None;
    };

    let workspace_key = match crate::tracker::model::sanitize_workspace_key(identifier) {
        Some(key) => key,
        None => return None,  // Can't build detail for unsanitizable identifier
    };
    let workspace_path = format!("{}/{}", workspace_root, workspace_key);

    let status = if running_entry.is_some() {
        "running".to_string()
    } else {
        "retrying".to_string()
    };

    let current_retry_attempt = if let Some(entry) = running_entry {
        entry.retry_attempt
    } else if let Some(entry) = retry_entry {
        Some(entry.attempt)
    } else {
        None
    };

    let restart_count = current_retry_attempt.unwrap_or(0);

    let running_detail = running_entry.map(|entry| {
        let step_name = state.pipeline_runs.get(&entry.issue_id).and_then(|run| {
            run.step_states.iter().find_map(|(name, step_state)| {
                if matches!(step_state, StepState::Running { .. }) {
                    Some(name.clone())
                } else {
                    None
                }
            })
        });
        RunningDetail {
            session_id: entry.session_id.clone(),
            step_name,
            turn_count: entry.turn_count,
            state: entry.issue.state.clone(),
            started_at: entry.started_at,
            last_event: entry.last_agent_event.clone(),
            last_message: entry.last_agent_message.clone(),
            last_event_at: entry.last_agent_timestamp,
            tokens: TokenSnapshot {
                input_tokens: entry.agent_input_tokens,
                output_tokens: entry.agent_output_tokens,
                total_tokens: entry.agent_total_tokens,
            },
        }
    });

    let retry_detail = retry_entry.map(|entry| retry_entry_to_row(entry));

    let last_error = retry_entry.and_then(|e| e.error.clone());

    Some(IssueDetailSnapshot {
        issue_identifier,
        issue_id,
        status,
        workspace: WorkspaceInfo {
            path: workspace_path,
        },
        attempts: AttemptInfo {
            restart_count,
            current_retry_attempt,
        },
        running: running_detail,
        retry: retry_detail,
        last_error,
    })
}

/// Convert a RunningEntry to a RunningSessionRow for the snapshot.
fn running_entry_to_row(entry: &RunningEntry, pipeline_runs: &HashMap<String, PipelineRun>) -> RunningSessionRow {
    let step_name = pipeline_runs.get(&entry.issue_id).and_then(|run| {
        run.step_states.iter().find_map(|(name, state)| {
            if matches!(state, StepState::Running { .. }) {
                Some(name.clone())
            } else {
                None
            }
        })
    });
    RunningSessionRow {
        issue_id: entry.issue_id.clone(),
        issue_identifier: entry.identifier.clone(),
        state: entry.issue.state.clone(),
        step_name,
        session_id: entry.session_id.clone(),
        turn_count: entry.turn_count,
        last_event: entry.last_agent_event.clone(),
        last_message: entry.last_agent_message.clone(),
        started_at: entry.started_at,
        last_event_at: entry.last_agent_timestamp,
        tokens: TokenSnapshot {
            input_tokens: entry.agent_input_tokens,
            output_tokens: entry.agent_output_tokens,
            total_tokens: entry.agent_total_tokens,
        },
    }
}

/// Convert a RetryEntry to a RetryRow for the snapshot.
fn retry_entry_to_row(entry: &RetryEntry) -> RetryRow {
    RetryRow {
        issue_id: entry.issue_id.clone(),
        issue_identifier: entry.identifier.clone(),
        attempt: entry.attempt,
        due_at_ms: entry.due_at_ms,
        error: entry.error.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::state::OrchestratorState;
    use crate::tracker::model::{AgentTotals, Issue, RunningEntry, RetryEntry};
    use chrono::Utc;
    use std::collections::{HashMap, HashSet};

    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It is broken".to_string()),
            priority: Some(2),
            state: "In Progress".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    fn test_running_entry() -> RunningEntry {
        RunningEntry {
            issue_id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            issue: test_issue(),
            session_id: Some("session-abc".to_string()),
            agent_pid: Some("12345".to_string()),
            last_agent_event: Some("turn_completed".to_string()),
            last_agent_timestamp: Some(Utc::now()),
            last_agent_message: Some("Working on tests".to_string()),
            agent_input_tokens: 1200,
            agent_output_tokens: 800,
            agent_total_tokens: 2000,
            last_reported_input_tokens: 1200,
            last_reported_output_tokens: 800,
            last_reported_total_tokens: 2000,
            turn_count: 7,
            retry_attempt: None,
            started_at: Utc::now(),
        }
    }

    fn test_retry_entry() -> RetryEntry {
        RetryEntry {
            issue_id: "NODE_456".to_string(),
            identifier: "my-repo#99".to_string(),
            attempt: 3,
            due_at_ms: 1711641600000, // some future timestamp
            error: Some("no available orchestrator slots".to_string()),
        }
    }

    fn build_test_state() -> OrchestratorState {
        let mut running = HashMap::new();
        running.insert("NODE_123".to_string(), test_running_entry());

        let mut retry_attempts = HashMap::new();
        retry_attempts.insert("NODE_456".to_string(), test_retry_entry());

        let mut claimed = HashSet::new();
        claimed.insert("NODE_123".to_string());
        claimed.insert("NODE_456".to_string());

        OrchestratorState {
            running,
            claimed,
            retry_attempts,
            completed: HashSet::new(),
            agent_totals: AgentTotals {
                input_tokens: 5000,
                output_tokens: 2400,
                total_tokens: 7400,
                seconds_running: 120.5,
            },
            agent_rate_limits: None,
        }
    }

    #[test]
    fn test_build_snapshot_counts() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.counts.running, 1);
        assert_eq!(snapshot.counts.retrying, 1);
    }

    #[test]
    fn test_build_snapshot_running_row() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.running.len(), 1);
        let row = &snapshot.running[0];
        assert_eq!(row.issue_id, "NODE_123");
        assert_eq!(row.issue_identifier, "my-repo#42");
        assert_eq!(row.state, "In Progress");
        assert_eq!(row.session_id, Some("session-abc".to_string()));
        assert_eq!(row.turn_count, 7);
        assert_eq!(row.last_event, Some("turn_completed".to_string()));
        assert_eq!(row.last_message, Some("Working on tests".to_string()));
        assert_eq!(row.tokens.input_tokens, 1200);
        assert_eq!(row.tokens.output_tokens, 800);
        assert_eq!(row.tokens.total_tokens, 2000);
    }

    #[test]
    fn test_build_snapshot_retry_row() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.retrying.len(), 1);
        let row = &snapshot.retrying[0];
        assert_eq!(row.issue_id, "NODE_456");
        assert_eq!(row.issue_identifier, "my-repo#99");
        assert_eq!(row.attempt, 3);
        assert_eq!(row.error, Some("no available orchestrator slots".to_string()));
    }

    #[test]
    fn test_build_snapshot_agent_totals() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);

        assert_eq!(snapshot.agent_totals.input_tokens, 5000);
        assert_eq!(snapshot.agent_totals.output_tokens, 2400);
        assert_eq!(snapshot.agent_totals.total_tokens, 7400);
        // seconds_running should be >= cumulative (120.5) because active sessions add elapsed
        assert!(snapshot.agent_totals.seconds_running >= 120.5);
    }

    #[test]
    fn test_build_snapshot_rate_limits_null() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);
        assert!(snapshot.rate_limits.is_none());
    }

    #[test]
    fn test_build_snapshot_json_shape() {
        let state = build_test_state();
        let snapshot = build_state_snapshot(&state);
        let json = serde_json::to_value(&snapshot).unwrap();

        // Verify top-level keys match SPEC.md Section 13.7.2
        assert!(json.get("generated_at").is_some());
        assert!(json.get("counts").is_some());
        assert!(json.get("running").is_some());
        assert!(json.get("retrying").is_some());
        assert!(json.get("agent_totals").is_some());
        assert!(json.get("rate_limits").is_some());

        // Verify counts sub-keys
        let counts = json.get("counts").unwrap();
        assert!(counts.get("running").is_some());
        assert!(counts.get("retrying").is_some());

        // Verify running row sub-keys
        let running = json.get("running").unwrap().as_array().unwrap();
        assert_eq!(running.len(), 1);
        let row = &running[0];
        assert!(row.get("issue_id").is_some());
        assert!(row.get("issue_identifier").is_some());
        assert!(row.get("state").is_some());
        assert!(row.get("session_id").is_some());
        assert!(row.get("turn_count").is_some());
        assert!(row.get("last_event").is_some());
        assert!(row.get("last_message").is_some());
        assert!(row.get("started_at").is_some());
        assert!(row.get("last_event_at").is_some());
        assert!(row.get("tokens").is_some());

        // Verify tokens sub-keys
        let tokens = row.get("tokens").unwrap();
        assert!(tokens.get("input_tokens").is_some());
        assert!(tokens.get("output_tokens").is_some());
        assert!(tokens.get("total_tokens").is_some());

        // Verify agent_totals sub-keys
        let totals = json.get("agent_totals").unwrap();
        assert!(totals.get("input_tokens").is_some());
        assert!(totals.get("output_tokens").is_some());
        assert!(totals.get("total_tokens").is_some());
        assert!(totals.get("seconds_running").is_some());
    }

    #[test]
    fn test_build_snapshot_empty_state() {
        let state = OrchestratorState {
            running: HashMap::new(),
            claimed: HashSet::new(),
            retry_attempts: HashMap::new(),
            completed: HashSet::new(),
            agent_totals: AgentTotals::default(),
            agent_rate_limits: None,
        };

        let snapshot = build_state_snapshot(&state);
        assert_eq!(snapshot.counts.running, 0);
        assert_eq!(snapshot.counts.retrying, 0);
        assert!(snapshot.running.is_empty());
        assert!(snapshot.retrying.is_empty());
        assert_eq!(snapshot.agent_totals.seconds_running, 0.0);
    }

    #[test]
    fn test_build_issue_snapshot_found_running() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces");

        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.issue_identifier, "my-repo#42");
        assert_eq!(detail.issue_id, "NODE_123");
        assert_eq!(detail.status, "running");
        assert_eq!(detail.workspace.path, "/tmp/workspaces/my-repo_42");
        assert!(detail.running.is_some());
        assert!(detail.retry.is_none());

        let running = detail.running.unwrap();
        assert_eq!(running.turn_count, 7);
        assert_eq!(running.session_id, Some("session-abc".to_string()));
    }

    #[test]
    fn test_build_issue_snapshot_found_retrying() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#99", "/tmp/workspaces");

        assert!(detail.is_some());
        let detail = detail.unwrap();
        assert_eq!(detail.issue_identifier, "my-repo#99");
        assert_eq!(detail.issue_id, "NODE_456");
        assert_eq!(detail.status, "retrying");
        assert!(detail.running.is_none());
        assert!(detail.retry.is_some());
        assert_eq!(detail.last_error, Some("no available orchestrator slots".to_string()));
    }

    #[test]
    fn test_build_issue_snapshot_not_found() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "nonexistent#999", "/tmp/workspaces");
        assert!(detail.is_none());
    }

    #[test]
    fn test_issue_snapshot_json_shape() {
        let state = build_test_state();
        let detail = build_issue_snapshot(&state, "my-repo#42", "/tmp/workspaces").unwrap();
        let json = serde_json::to_value(&detail).unwrap();

        assert!(json.get("issue_identifier").is_some());
        assert!(json.get("issue_id").is_some());
        assert!(json.get("status").is_some());
        assert!(json.get("workspace").is_some());
        assert!(json.get("attempts").is_some());
        assert!(json.get("running").is_some());
        assert!(json.get("retry").is_some());
        assert!(json.get("last_error").is_some());

        let workspace = json.get("workspace").unwrap();
        assert!(workspace.get("path").is_some());

        let attempts = json.get("attempts").unwrap();
        assert!(attempts.get("restart_count").is_some());
        assert!(attempts.get("current_retry_attempt").is_some());
    }

    #[test]
    fn test_retry_row_due_at_ms_passthrough() {
        let entry = RetryEntry {
            issue_id: "NODE_789".to_string(),
            identifier: "test#1".to_string(),
            attempt: 1,
            due_at_ms: 1711641600000, // 2024-03-28T16:00:00Z
            error: None,
        };

        let row = retry_entry_to_row(&entry);
        assert_eq!(row.due_at_ms, 1711641600000);
    }
}
```

- [ ] **Step 4: Create a stub for logging.rs so it compiles**

Create `crates/ensemble-core/src/observability/logging.rs`:

```rust
// Logging setup — will be fleshed out in Task 2
```

- [ ] **Step 5: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core observability::snapshot`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/observability/ crates/ensemble-core/src/lib.rs
git commit -m "feat: runtime snapshot types and build_state_snapshot() for API observability"
```

---

### Task 2: Logging Setup

**Files:**
- Modify: `crates/ensemble-core/src/observability/logging.rs`

- [ ] **Step 1: Write the logging initialization module**

Replace the contents of `crates/ensemble-core/src/observability/logging.rs`:

```rust
use tracing_subscriber::fmt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

/// Initialize structured logging for the Ensemble service.
///
/// Format selection:
/// - JSON when `ENSEMBLE_LOG_FORMAT=json` or stdout is not a terminal
/// - Human-readable (pretty) when stdout is a terminal
///
/// Filter selection (precedence order):
/// 1. `ENSEMBLE_LOG` env var
/// 2. `RUST_LOG` env var
/// 3. Default: `info`
///
/// Key span fields used throughout the codebase:
/// - `issue_id`, `issue_identifier` (per-issue spans)
/// - `session_id` (per-session spans)
/// - `hook` (hook execution spans)
pub fn init_logging() {
    let filter = build_env_filter();
    let use_json = should_use_json();

    if use_json {
        let fmt_layer = fmt::layer()
            .json()
            .with_target(true)
            .with_thread_ids(false)
            .with_span_list(true);

        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    } else {
        let fmt_layer = fmt::layer()
            .with_target(true)
            .with_thread_ids(false)
            .with_ansi(true);

        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    }
}

/// Build an EnvFilter using ENSEMBLE_LOG, RUST_LOG, or the default "info" level.
fn build_env_filter() -> EnvFilter {
    if let Ok(ensemble_log) = std::env::var("ENSEMBLE_LOG") {
        EnvFilter::try_new(&ensemble_log).unwrap_or_else(|_| {
            eprintln!(
                "warning: invalid ENSEMBLE_LOG filter '{}', falling back to 'info'",
                ensemble_log
            );
            EnvFilter::new("info")
        })
    } else if let Ok(rust_log) = std::env::var("RUST_LOG") {
        EnvFilter::try_new(&rust_log).unwrap_or_else(|_| {
            eprintln!(
                "warning: invalid RUST_LOG filter '{}', falling back to 'info'",
                rust_log
            );
            EnvFilter::new("info")
        })
    } else {
        EnvFilter::new("info")
    }
}

/// Determine whether to use JSON output format.
///
/// Returns true if:
/// - `ENSEMBLE_LOG_FORMAT=json` is set, OR
/// - stdout is not a terminal (piped/redirected)
fn should_use_json() -> bool {
    if let Ok(format) = std::env::var("ENSEMBLE_LOG_FORMAT") {
        if format.eq_ignore_ascii_case("json") {
            return true;
        }
    }
    !std::io::IsTerminal::is_terminal(&std::io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_env_filter_default() {
        // When neither ENSEMBLE_LOG nor RUST_LOG is set, default to info
        // (This test must be careful about env var pollution from other tests)
        let saved_ensemble = std::env::var("ENSEMBLE_LOG").ok();
        let saved_rust = std::env::var("RUST_LOG").ok();
        std::env::remove_var("ENSEMBLE_LOG");
        std::env::remove_var("RUST_LOG");

        let filter = build_env_filter();
        // The filter should not panic and should be constructable
        let _ = format!("{:?}", filter);

        // Restore
        if let Some(val) = saved_ensemble {
            std::env::set_var("ENSEMBLE_LOG", val);
        }
        if let Some(val) = saved_rust {
            std::env::set_var("RUST_LOG", val);
        }
    }

    #[test]
    fn test_build_env_filter_from_ensemble_log() {
        let saved = std::env::var("ENSEMBLE_LOG").ok();
        std::env::set_var("ENSEMBLE_LOG", "debug");

        let filter = build_env_filter();
        let _ = format!("{:?}", filter);

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG");
        }
    }

    #[test]
    fn test_build_env_filter_invalid_falls_back() {
        let saved = std::env::var("ENSEMBLE_LOG").ok();
        std::env::set_var("ENSEMBLE_LOG", "not a valid filter {{{}}}");

        let filter = build_env_filter();
        // Should fall back to "info" without panicking
        let _ = format!("{:?}", filter);

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG");
        }
    }

    #[test]
    fn test_should_use_json_with_env_var() {
        let saved = std::env::var("ENSEMBLE_LOG_FORMAT").ok();
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "json");

        assert!(should_use_json());

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG_FORMAT", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG_FORMAT");
        }
    }

    #[test]
    fn test_should_use_json_case_insensitive() {
        let saved = std::env::var("ENSEMBLE_LOG_FORMAT").ok();
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "JSON");

        assert!(should_use_json());

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG_FORMAT", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG_FORMAT");
        }
    }

    #[test]
    fn test_should_not_use_json_with_text_format() {
        let saved = std::env::var("ENSEMBLE_LOG_FORMAT").ok();
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "text");

        // When format is not "json", terminal detection applies.
        // In a test environment this may vary, but at minimum it should not panic.
        let _ = should_use_json();

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG_FORMAT", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG_FORMAT");
        }
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core observability::logging`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/observability/logging.rs
git commit -m "feat: structured logging setup with JSON/human format auto-detection"
```

---

### Task 3: Axum Router

**Files:**
- Create: `crates/ensemble-core/src/api/mod.rs`
- Create: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/lib.rs` (add `pub mod api;`)
- Modify: `crates/ensemble-core/Cargo.toml` (add axum dependency)

- [ ] **Step 1: Add axum to workspace and crate dependencies**

Add to workspace root `Cargo.toml` under `[workspace.dependencies]`:

```toml
axum = "0.8"
tower-http = { version = "0.6", features = ["cors"] }
```

Add to `crates/ensemble-core/Cargo.toml` under `[dependencies]`:

```toml
axum = { workspace = true }
tower-http = { workspace = true }
```

- [ ] **Step 2: Create the api module file**

Create `crates/ensemble-core/src/api/mod.rs`:

```rust
pub mod handlers;
pub mod router;
```

- [ ] **Step 3: Add the api module to lib.rs**

Add this line to `crates/ensemble-core/src/lib.rs`:

```rust
pub mod api;
```

The full `lib.rs` should now contain:

```rust
pub mod config;
pub mod error;
pub mod pipeline;
pub mod tracker;
pub mod workspace;
pub mod agent;
pub mod orchestrator;
pub mod observability;
pub mod api;
```

- [ ] **Step 4: Write the router**

Create `crates/ensemble-core/src/api/router.rs`:

```rust
use crate::api::handlers;
use crate::orchestrator::state::OrchestratorState;
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Shared application state passed to all API handlers.
#[derive(Clone)]
pub struct AppState {
    /// The orchestrator state, shared with the orchestrator task via RwLock.
    pub orchestrator_state: Arc<RwLock<OrchestratorState>>,
    /// Flag that signals the orchestrator to run an immediate tick.
    /// The orchestrator polls this flag; setting it triggers a refresh.
    pub refresh_requested: Arc<tokio::sync::Notify>,
    /// The workspace root path, used for building issue detail paths.
    pub workspace_root: String,
}

/// Create the axum router for the Ensemble HTTP API.
///
/// Endpoints:
/// - `GET /api/v1/state` — runtime snapshot
/// - `POST /api/v1/refresh` — trigger immediate poll+reconcile
/// - `GET /api/v1/{identifier}` — issue-specific detail
///
/// Unsupported methods on these routes return 405.
/// The router does NOT serve static dashboard assets (that is Plan 5).
pub fn create_api_router(state: AppState) -> Router {
    let api_routes = Router::new()
        .route("/state", get(handlers::get_state))
        .route(
            "/refresh",
            post(handlers::post_refresh)
                .get(handlers::method_not_allowed)
                .put(handlers::method_not_allowed)
                .delete(handlers::method_not_allowed)
                .patch(handlers::method_not_allowed),
        )
        .route(
            "/{identifier}",
            get(handlers::get_issue_detail)
                .post(handlers::method_not_allowed)
                .put(handlers::method_not_allowed)
                .delete(handlers::method_not_allowed)
                .patch(handlers::method_not_allowed),
        );

    Router::new()
        .nest("/api/v1", api_routes)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::model::AgentTotals;
    use std::collections::{HashMap, HashSet};

    fn test_app_state() -> AppState {
        let state = OrchestratorState {
            running: HashMap::new(),
            claimed: HashSet::new(),
            retry_attempts: HashMap::new(),
            completed: HashSet::new(),
            agent_totals: AgentTotals::default(),
            agent_rate_limits: None,
        };
        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
        }
    }

    #[test]
    fn test_router_creation_does_not_panic() {
        let state = test_app_state();
        let _router = create_api_router(state);
    }
}
```

- [ ] **Step 5: Create a stub for handlers.rs so it compiles**

Create `crates/ensemble-core/src/api/handlers.rs`:

```rust
// API handlers — will be fleshed out in Task 4
use crate::api::router::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

pub async fn get_state(State(_state): State<AppState>) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

pub async fn get_issue_detail(
    State(_state): State<AppState>,
    Path(_identifier): Path<String>,
) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

pub async fn post_refresh(State(_state): State<AppState>) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

pub async fn method_not_allowed() -> impl IntoResponse {
    StatusCode::METHOD_NOT_ALLOWED
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cargo build -p ensemble-core`
Expected: Compiles with no errors

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/api/ crates/ensemble-core/src/lib.rs Cargo.toml crates/ensemble-core/Cargo.toml
git commit -m "feat: axum API router with route definitions and AppState"
```

---

### Task 4: API Handlers

**Files:**
- Modify: `crates/ensemble-core/src/api/handlers.rs`

- [ ] **Step 1: Write the complete API handlers**

Replace the contents of `crates/ensemble-core/src/api/handlers.rs`:

```rust
use crate::api::router::AppState;
use crate::observability::snapshot::{build_issue_snapshot, build_state_snapshot};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::Utc;
use serde::Serialize;

/// Standard JSON error envelope matching SPEC.md Section 13.7.2 error format.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: ApiErrorDetail,
}

/// Inner detail of the error envelope.
#[derive(Debug, Serialize)]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            error: ApiErrorDetail {
                code: code.to_string(),
                message: message.to_string(),
            },
        }
    }
}

/// GET /api/v1/state
///
/// Acquires a read lock on the orchestrator state, builds a RuntimeSnapshot,
/// and returns it as JSON. Returns 503 if the lock cannot be acquired.
pub async fn get_state(State(state): State<AppState>) -> impl IntoResponse {
    let lock = state.orchestrator_state.read().await;
    let snapshot = build_state_snapshot(&lock);
    drop(lock);

    (StatusCode::OK, Json(snapshot))
}

/// GET /api/v1/{identifier}
///
/// Looks up an issue by its identifier (e.g. "my-repo#42") in running and retry maps.
/// Returns the issue detail or 404 with a JSON error envelope.
pub async fn get_issue_detail(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> impl IntoResponse {
    let lock = state.orchestrator_state.read().await;
    let detail = build_issue_snapshot(&lock, &identifier, &state.workspace_root);
    drop(lock);

    match detail {
        Some(detail) => (StatusCode::OK, Json(serde_json::to_value(detail).unwrap())).into_response(),
        None => {
            let error = ApiError::new(
                "issue_not_found",
                &format!("no running or retrying issue with identifier '{}'", identifier),
            );
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::to_value(error).unwrap()),
            )
                .into_response()
        }
    }
}

/// Response body for POST /api/v1/refresh.
#[derive(Debug, Serialize)]
pub struct RefreshResponse {
    pub queued: bool,
    pub coalesced: bool,
    pub requested_at: String,
    pub operations: Vec<String>,
}

/// POST /api/v1/refresh
///
/// Signals the orchestrator to run an immediate tick (poll + reconcile).
/// Returns 202 Accepted with a confirmation body.
pub async fn post_refresh(State(state): State<AppState>) -> impl IntoResponse {
    state.refresh_requested.notify_one();

    let response = RefreshResponse {
        queued: true,
        coalesced: false,
        requested_at: Utc::now().to_rfc3339(),
        operations: vec!["poll".to_string(), "reconcile".to_string()],
    };

    (StatusCode::ACCEPTED, Json(response))
}

/// Handler for unsupported HTTP methods on defined routes.
/// Returns 405 Method Not Allowed with a JSON error envelope.
pub async fn method_not_allowed() -> impl IntoResponse {
    let error = ApiError::new("method_not_allowed", "this HTTP method is not supported on this endpoint");
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(serde_json::to_value(error).unwrap()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::AppState;
    use crate::orchestrator::state::OrchestratorState;
    use crate::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};
    use chrono::Utc;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It is broken".to_string()),
            priority: Some(2),
            state: "In Progress".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    fn test_running_entry() -> RunningEntry {
        RunningEntry {
            issue_id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            issue: test_issue(),
            session_id: Some("session-abc".to_string()),
            agent_pid: Some("12345".to_string()),
            last_agent_event: Some("turn_completed".to_string()),
            last_agent_timestamp: Some(Utc::now()),
            last_agent_message: Some("Working on tests".to_string()),
            agent_input_tokens: 1200,
            agent_output_tokens: 800,
            agent_total_tokens: 2000,
            last_reported_input_tokens: 1200,
            last_reported_output_tokens: 800,
            last_reported_total_tokens: 2000,
            turn_count: 7,
            retry_attempt: None,
            started_at: Utc::now(),
        }
    }

    fn test_retry_entry() -> RetryEntry {
        RetryEntry {
            issue_id: "NODE_456".to_string(),
            identifier: "my-repo#99".to_string(),
            attempt: 3,
            due_at_ms: 1711641600000,
            error: Some("no available orchestrator slots".to_string()),
        }
    }

    fn build_populated_state() -> AppState {
        let mut running = HashMap::new();
        running.insert("NODE_123".to_string(), test_running_entry());

        let mut retry_attempts = HashMap::new();
        retry_attempts.insert("NODE_456".to_string(), test_retry_entry());

        let mut claimed = HashSet::new();
        claimed.insert("NODE_123".to_string());
        claimed.insert("NODE_456".to_string());

        let state = OrchestratorState {
            running,
            claimed,
            retry_attempts,
            completed: HashSet::new(),
            agent_totals: AgentTotals {
                input_tokens: 5000,
                output_tokens: 2400,
                total_tokens: 7400,
                seconds_running: 120.5,
            },
            agent_rate_limits: None,
        };

        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
        }
    }

    fn build_empty_state() -> AppState {
        let state = OrchestratorState {
            running: HashMap::new(),
            claimed: HashSet::new(),
            retry_attempts: HashMap::new(),
            completed: HashSet::new(),
            agent_totals: AgentTotals::default(),
            agent_rate_limits: None,
        };

        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
        }
    }

    #[tokio::test]
    async fn test_get_state_returns_json() {
        let app_state = build_populated_state();
        let response = get_state(State(app_state)).await;
        let (status, Json(snapshot)) = response;

        assert_eq!(status, StatusCode::OK);

        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["counts"]["running"], 1);
        assert_eq!(json["counts"]["retrying"], 1);
        assert_eq!(json["agent_totals"]["input_tokens"], 5000);
        assert_eq!(json["agent_totals"]["output_tokens"], 2400);
        assert_eq!(json["agent_totals"]["total_tokens"], 7400);
    }

    #[tokio::test]
    async fn test_get_state_empty() {
        let app_state = build_empty_state();
        let response = get_state(State(app_state)).await;
        let (status, Json(snapshot)) = response;

        assert_eq!(status, StatusCode::OK);

        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["counts"]["running"], 0);
        assert_eq!(json["counts"]["retrying"], 0);
    }

    #[tokio::test]
    async fn test_get_issue_detail_found() {
        let app_state = build_populated_state();
        let response = get_issue_detail(
            State(app_state),
            Path("my-repo#42".to_string()),
        )
        .await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_get_issue_detail_not_found() {
        let app_state = build_populated_state();
        let response = get_issue_detail(
            State(app_state),
            Path("nonexistent#999".to_string()),
        )
        .await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_post_refresh_returns_202() {
        let app_state = build_populated_state();
        let response = post_refresh(State(app_state)).await;
        let (status, Json(body)) = response;

        assert_eq!(status, StatusCode::ACCEPTED);
        assert!(body.queued);
        assert!(!body.coalesced);
        assert_eq!(body.operations, vec!["poll", "reconcile"]);
    }

    #[tokio::test]
    async fn test_method_not_allowed_response() {
        let response = method_not_allowed().await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn test_error_envelope_json_shape() {
        let error = ApiError::new("issue_not_found", "no such issue");
        let json = serde_json::to_value(&error).unwrap();

        assert!(json.get("error").is_some());
        let err = json.get("error").unwrap();
        assert_eq!(err.get("code").unwrap().as_str().unwrap(), "issue_not_found");
        assert_eq!(
            err.get("message").unwrap().as_str().unwrap(),
            "no such issue"
        );
    }

    #[tokio::test]
    async fn test_get_issue_detail_retrying_issue() {
        let app_state = build_populated_state();
        let response = get_issue_detail(
            State(app_state),
            Path("my-repo#99".to_string()),
        )
        .await;

        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core api::handlers`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/api/handlers.rs
git commit -m "feat: API handlers — get_state, get_issue_detail, post_refresh with error envelopes"
```

---

### Task 5: CLI Binary

**Files:**
- Create: `crates/ensemble-cli/Cargo.toml`
- Create: `crates/ensemble-cli/src/main.rs`
- Modify: `Cargo.toml` (workspace members already include `crates/*`)

- [ ] **Step 1: Add clap to workspace dependencies**

Add to workspace root `Cargo.toml` under `[workspace.dependencies]`:

```toml
clap = { version = "4", features = ["derive"] }
```

- [ ] **Step 2: Create ensemble-cli Cargo.toml**

Create `crates/ensemble-cli/Cargo.toml`:

```toml
[package]
name = "ensemble-cli"
version = "0.1.0"
edition.workspace = true
license.workspace = true
rust-version.workspace = true

[[bin]]
name = "ensemble"
path = "src/main.rs"

[dependencies]
ensemble-core = { path = "../ensemble-core" }
tokio = { workspace = true }
clap = { workspace = true }
tracing = { workspace = true }
axum = { workspace = true }
```

- [ ] **Step 3: Write the CLI main.rs**

Create `crates/ensemble-cli/src/main.rs`:

```rust
use clap::Parser;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

use ensemble_core::api::router::{AppState, create_api_router};
use ensemble_core::config::ensemble::{load_config, validate_config, EnsembleConfig};
use ensemble_core::observability::logging::init_logging;
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::pipeline::dag::build_dag;

/// Ensemble: orchestrate coding agents to work on project issues.
#[derive(Parser, Debug)]
#[command(name = "ensemble", about = "Orchestrate coding agents")]
struct Cli {
    /// Path to ensemble.yaml
    #[arg(default_value = "ensemble.yaml")]
    config_path: PathBuf,

    /// HTTP server port (enables API + dashboard).
    /// CLI-only flag; not part of ensemble.yaml.
    #[arg(long)]
    port: Option<u16>,
}

#[tokio::main]
async fn main() -> ExitCode {
    // 1. Parse CLI args
    let cli = Cli::parse();

    // 2. Init logging
    init_logging();

    info!(
        config_path = %cli.config_path.display(),
        "starting ensemble"
    );

    // 3. Load and validate ensemble.yaml
    let config = match load_config(&cli.config_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            error!(error = %e, path = %cli.config_path.display(), "failed to load config");
            eprintln!("error: failed to load {}: {}", cli.config_path.display(), e);
            return ExitCode::FAILURE;
        }
    };

    // 4. Validate config and build step DAG
    if let Err(e) = validate_config(&config) {
        error!(error = %e, "config validation failed");
        eprintln!("error: config validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    if let Err(e) = build_dag(&config.steps) {
        error!(error = %e, "step DAG validation failed");
        eprintln!("error: step DAG validation failed: {}", e);
        return ExitCode::FAILURE;
    }

    info!(
        tracker_kind = %config.tracker.kind,
        poll_interval_ms = config.polling.interval_ms,
        max_concurrent = config.concurrency.max_concurrent_agents,
        "config loaded successfully"
    );

    // 5. Create orchestrator state
    let orchestrator_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.polling.interval_ms,
        config.concurrency.max_concurrent_agents,
    )));

    let refresh_notify = Arc::new(tokio::sync::Notify::new());

    // 6. Determine HTTP server port (CLI-only — not part of ensemble.yaml config)
    let effective_port = cli.port;

    // 7. Optionally start HTTP server
    let server_handle = if let Some(port) = effective_port {
        let app_state = AppState {
            orchestrator_state: orchestrator_state.clone(),
            refresh_requested: refresh_notify.clone(),
            workspace_root: config.workspace.root.as_deref()
                .map(|s| s.to_string())
                .unwrap_or_else(|| std::env::temp_dir().join("ensemble_workspaces").display().to_string()),
        };
        let router = create_api_router(app_state);

        let bind_addr = format!("127.0.0.1:{}", port);
        info!(addr = %bind_addr, "starting HTTP server");

        let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
            Ok(l) => l,
            Err(e) => {
                error!(error = %e, addr = %bind_addr, "failed to bind HTTP server");
                eprintln!("error: failed to bind HTTP server on {}: {}", bind_addr, e);
                return ExitCode::FAILURE;
            }
        };

        let actual_addr = listener.local_addr().unwrap();
        info!(addr = %actual_addr, "HTTP server listening");

        Some(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                error!(error = %e, "HTTP server error");
            }
        }))
    } else {
        info!("no HTTP port configured, skipping API server");
        None
    };

    // 8. TODO: Start orchestrator poll loop (Plan 3 wires this up).
    //    For now the CLI starts, optionally serves the API, and waits for shutdown.
    info!("ensemble is running (orchestrator loop placeholder, press Ctrl+C to stop)");

    // 9. Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    // 10. Clean shutdown
    if let Some(handle) = server_handle {
        handle.abort();
        info!("HTTP server stopped");
    }

    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parse_defaults() {
        let cli = Cli::parse_from(["ensemble"]);
        assert_eq!(cli.config_path, PathBuf::from("ensemble.yaml"));
        assert_eq!(cli.port, None);
    }

    #[test]
    fn test_cli_parse_custom_path() {
        let cli = Cli::parse_from(["ensemble", "custom/ensemble.yaml"]);
        assert_eq!(cli.config_path, PathBuf::from("custom/ensemble.yaml"));
        assert_eq!(cli.port, None);
    }

    #[test]
    fn test_cli_parse_with_port() {
        let cli = Cli::parse_from(["ensemble", "--port", "8080"]);
        assert_eq!(cli.config_path, PathBuf::from("ensemble.yaml"));
        assert_eq!(cli.port, Some(8080));
    }

    #[test]
    fn test_cli_parse_all_options() {
        let cli = Cli::parse_from(["ensemble", "--port", "3000", "my/ensemble.yaml"]);
        assert_eq!(cli.config_path, PathBuf::from("my/ensemble.yaml"));
        assert_eq!(cli.port, Some(3000));
    }

    #[test]
    fn test_cli_parse_ephemeral_port() {
        let cli = Cli::parse_from(["ensemble", "--port", "0"]);
        assert_eq!(cli.port, Some(0));
    }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p ensemble-cli`
Expected: Compiles with no errors (may have warnings about unused imports for orchestrator components not yet wired)

- [ ] **Step 5: Verify tests pass**

Run: `cargo test -p ensemble-cli`
Expected: All CLI parsing tests pass

- [ ] **Step 6: Verify the binary runs and exits cleanly on missing ensemble.yaml**

Run from a temp directory where ensemble.yaml does not exist:

```bash
cd /tmp && cargo run -p ensemble-cli 2>&1 || true
```

Expected output should contain: `error: failed to load ensemble.yaml`
Expected exit code: non-zero

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-cli/ Cargo.toml
git commit -m "feat: ensemble-cli binary with arg parsing, logging, ensemble.yaml loading, and optional HTTP server"
```

---

### Task 6: Integration Test -- API Endpoints

**Files:**
- Create: `crates/ensemble-core/tests/api_endpoints.rs`
- Modify: `crates/ensemble-core/Cargo.toml` (add reqwest to dev-dependencies)

- [ ] **Step 1: Add reqwest to workspace and crate dev-dependencies**

Add to workspace root `Cargo.toml` under `[workspace.dependencies]`:

```toml
reqwest = { version = "0.12", features = ["json"] }
```

Add to `crates/ensemble-core/Cargo.toml` under `[dev-dependencies]`:

```toml
reqwest = { workspace = true }
```

- [ ] **Step 2: Write the API integration test**

Create `crates/ensemble-core/tests/api_endpoints.rs`:

```rust
//! Integration test: start an axum server with pre-populated state,
//! hit endpoints with reqwest, verify JSON shapes match SPEC.md Section 13.7.2.

use ensemble_core::api::router::{AppState, create_api_router};
use ensemble_core::orchestrator::state::OrchestratorState;
use ensemble_core::tracker::model::{AgentTotals, Issue, RetryEntry, RunningEntry};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

fn test_issue(id: &str, identifier: &str, state: &str) -> Issue {
    Issue {
        id: id.to_string(),
        identifier: identifier.to_string(),
        title: format!("Issue {}", identifier),
        description: Some(format!("Description for {}", identifier)),
        priority: Some(1),
        state: state.to_string(),
        branch_name: None,
        url: Some(format!("https://github.com/acme/repo/issues/{}", identifier)),
        labels: vec!["bug".to_string()],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

fn build_populated_app_state() -> AppState {
    let issue1 = test_issue("NODE_123", "my-repo#42", "In Progress");
    let running_entry = RunningEntry {
        issue_id: "NODE_123".to_string(),
        identifier: "my-repo#42".to_string(),
        issue: issue1,
        session_id: Some("session-abc".to_string()),
        agent_pid: Some("12345".to_string()),
        last_agent_event: Some("turn_completed".to_string()),
        last_agent_timestamp: Some(Utc::now()),
        last_agent_message: Some("Working on tests".to_string()),
        agent_input_tokens: 1200,
        agent_output_tokens: 800,
        agent_total_tokens: 2000,
        last_reported_input_tokens: 1200,
        last_reported_output_tokens: 800,
        last_reported_total_tokens: 2000,
        turn_count: 7,
        retry_attempt: None,
        started_at: Utc::now(),
    };

    let retry_entry = RetryEntry {
        issue_id: "NODE_456".to_string(),
        identifier: "my-repo#99".to_string(),
        attempt: 3,
        due_at_ms: 1711641600000,
        error: Some("no available orchestrator slots".to_string()),
    };

    let mut running = HashMap::new();
    running.insert("NODE_123".to_string(), running_entry);

    let mut retry_attempts = HashMap::new();
    retry_attempts.insert("NODE_456".to_string(), retry_entry);

    let mut claimed = HashSet::new();
    claimed.insert("NODE_123".to_string());
    claimed.insert("NODE_456".to_string());

    let state = OrchestratorState {
        running,
        claimed,
        retry_attempts,
        completed: HashSet::new(),
        agent_totals: AgentTotals {
            input_tokens: 5000,
            output_tokens: 2400,
            total_tokens: 7400,
            seconds_running: 120.5,
        },
        agent_rate_limits: None,
    };

    AppState {
        orchestrator_state: Arc::new(RwLock::new(state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: "/tmp/ensemble_workspaces".to_string(),
    }
}

/// Start an axum test server and return the base URL.
async fn start_test_server(app_state: AppState) -> String {
    let router = create_api_router(app_state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}", addr);

    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    // Give the server a moment to start
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    base_url
}

#[tokio::test]
async fn test_get_state_endpoint() {
    let app_state = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/state", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();

    // Verify top-level keys from SPEC.md Section 13.7.2
    assert!(json.get("generated_at").is_some(), "missing generated_at");
    assert!(json.get("counts").is_some(), "missing counts");
    assert!(json.get("running").is_some(), "missing running");
    assert!(json.get("retrying").is_some(), "missing retrying");
    assert!(json.get("agent_totals").is_some(), "missing agent_totals");
    assert!(json.get("rate_limits").is_some(), "missing rate_limits");

    // Verify counts
    let counts = json.get("counts").unwrap();
    assert_eq!(counts["running"], 1);
    assert_eq!(counts["retrying"], 1);

    // Verify running array shape
    let running = json.get("running").unwrap().as_array().unwrap();
    assert_eq!(running.len(), 1);
    let row = &running[0];
    assert_eq!(row["issue_id"], "NODE_123");
    assert_eq!(row["issue_identifier"], "my-repo#42");
    assert_eq!(row["state"], "In Progress");
    assert_eq!(row["session_id"], "session-abc");
    assert_eq!(row["turn_count"], 7);
    assert_eq!(row["last_event"], "turn_completed");
    assert_eq!(row["last_message"], "Working on tests");
    assert!(row.get("started_at").is_some());
    assert!(row.get("last_event_at").is_some());

    // Verify tokens sub-object
    let tokens = row.get("tokens").unwrap();
    assert_eq!(tokens["input_tokens"], 1200);
    assert_eq!(tokens["output_tokens"], 800);
    assert_eq!(tokens["total_tokens"], 2000);

    // Verify retrying array shape
    let retrying = json.get("retrying").unwrap().as_array().unwrap();
    assert_eq!(retrying.len(), 1);
    let retry = &retrying[0];
    assert_eq!(retry["issue_id"], "NODE_456");
    assert_eq!(retry["issue_identifier"], "my-repo#99");
    assert_eq!(retry["attempt"], 3);
    assert!(retry.get("due_at_ms").is_some());
    assert_eq!(retry["error"], "no available orchestrator slots");

    // Verify agent_totals shape
    let totals = json.get("agent_totals").unwrap();
    assert_eq!(totals["input_tokens"], 5000);
    assert_eq!(totals["output_tokens"], 2400);
    assert_eq!(totals["total_tokens"], 7400);
    assert!(totals.get("seconds_running").is_some());
    let secs = totals["seconds_running"].as_f64().unwrap();
    assert!(secs >= 120.5, "seconds_running should be >= 120.5, got {}", secs);
}

#[tokio::test]
async fn test_get_issue_detail_running() {
    let app_state = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/my-repo%2342", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["issue_identifier"], "my-repo#42");
    assert_eq!(json["issue_id"], "NODE_123");
    assert_eq!(json["status"], "running");

    // Verify workspace info
    let workspace = json.get("workspace").unwrap();
    assert!(workspace.get("path").is_some());
    assert!(workspace["path"].as_str().unwrap().contains("my-repo_42"));

    // Verify attempts info
    let attempts = json.get("attempts").unwrap();
    assert!(attempts.get("restart_count").is_some());
    assert!(attempts.get("current_retry_attempt").is_some());

    // Verify running detail is present
    assert!(json.get("running").unwrap().is_object());

    // Verify retry is null for a running issue
    assert!(json.get("retry").unwrap().is_null());
}

#[tokio::test]
async fn test_get_issue_detail_retrying() {
    let app_state = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/my-repo%2399", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["issue_identifier"], "my-repo#99");
    assert_eq!(json["status"], "retrying");

    // Verify retry detail is present
    assert!(json.get("retry").unwrap().is_object());

    // Verify running is null for a retrying issue
    assert!(json.get("running").unwrap().is_null());
}

#[tokio::test]
async fn test_get_issue_detail_not_found() {
    let app_state = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/nonexistent%23999", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 404);

    let json: serde_json::Value = response.json().await.unwrap();

    // Verify error envelope
    assert!(json.get("error").is_some(), "missing error envelope");
    let error = json.get("error").unwrap();
    assert_eq!(error["code"], "issue_not_found");
    assert!(error.get("message").is_some());
}

#[tokio::test]
async fn test_post_refresh_endpoint() {
    let app_state = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/api/v1/refresh", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 202);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["queued"], true);
    assert_eq!(json["coalesced"], false);
    assert!(json.get("requested_at").is_some());
    let ops = json["operations"].as_array().unwrap();
    assert!(ops.contains(&serde_json::Value::String("poll".to_string())));
    assert!(ops.contains(&serde_json::Value::String("reconcile".to_string())));
}

#[tokio::test]
async fn test_get_refresh_returns_405() {
    let app_state = build_populated_app_state();
    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/refresh", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 405);

    let json: serde_json::Value = response.json().await.unwrap();
    assert!(json.get("error").is_some());
    assert_eq!(json["error"]["code"], "method_not_allowed");
}

#[tokio::test]
async fn test_get_state_empty_system() {
    let state = OrchestratorState {
        running: HashMap::new(),
        claimed: HashSet::new(),
        retry_attempts: HashMap::new(),
        completed: HashSet::new(),
        agent_totals: AgentTotals::default(),
        agent_rate_limits: None,
    };

    let app_state = AppState {
        orchestrator_state: Arc::new(RwLock::new(state)),
        refresh_requested: Arc::new(tokio::sync::Notify::new()),
        workspace_root: "/tmp/workspaces".to_string(),
    };

    let base_url = start_test_server(app_state).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/api/v1/state", base_url))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);

    let json: serde_json::Value = response.json().await.unwrap();
    assert_eq!(json["counts"]["running"], 0);
    assert_eq!(json["counts"]["retrying"], 0);
    assert!(json["running"].as_array().unwrap().is_empty());
    assert!(json["retrying"].as_array().unwrap().is_empty());
    assert_eq!(json["agent_totals"]["input_tokens"], 0);
    assert_eq!(json["agent_totals"]["output_tokens"], 0);
    assert_eq!(json["agent_totals"]["total_tokens"], 0);
    assert_eq!(json["agent_totals"]["seconds_running"], 0.0);
    assert!(json["rate_limits"].is_null());
}
```

- [ ] **Step 3: Verify all tests pass**

Run: `cargo test -p ensemble-core --test api_endpoints`
Expected: All integration tests pass

- [ ] **Step 4: Verify the entire workspace tests pass**

Run: `cargo test --workspace`
Expected: All tests across all crates pass

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/tests/api_endpoints.rs crates/ensemble-core/Cargo.toml Cargo.toml
git commit -m "test: API endpoint integration tests verifying SPEC.md 13.7.2 JSON shapes"
```

---

## Phase 2: Dashboard Backend Extensions

The following tasks extend the API with event streaming, history, conversation, operator controls, and static asset serving — as defined in the dashboard design spec (`docs/superpowers/specs/2026-03-30-dashboard-design.md`).

---

### Task 7: Event Bus Types and Broadcast Channel

**Files:**
- Create: `crates/ensemble-core/src/observability/events.rs`
- Modify: `crates/ensemble-core/src/observability/mod.rs`

- [ ] **Step 1: Define PipelineEvent enum**

`crates/ensemble-core/src/observability/events.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::Serialize;

/// A lightweight event emitted by the orchestrator at pipeline boundaries.
/// These are broadcast to WebSocket subscribers and used for the event timeline.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum PipelineEvent {
    SessionStarted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        detail: String,
    },
    StepStarted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        step_name: String,
        agent_name: String,
        detail: String,
    },
    StepCompleted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        step_name: String,
        verdict: Option<String>,
        detail: String,
    },
    TurnCompleted {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        turn: u32,
        detail: String,
        conversation_index: Option<u64>,
        tokens_delta: TokensDelta,
    },
    ToolCall {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        tool_name: String,
        detail: String,
    },
    Error {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        detail: String,
    },
    RetryScheduled {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        attempt: u32,
        detail: String,
    },
    Complete {
        issue_identifier: String,
        timestamp: DateTime<Utc>,
        outcome: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct TokensDelta {
    pub input: u64,
    pub output: u64,
}

impl PipelineEvent {
    pub fn issue_identifier(&self) -> &str {
        match self {
            Self::SessionStarted { issue_identifier, .. }
            | Self::StepStarted { issue_identifier, .. }
            | Self::StepCompleted { issue_identifier, .. }
            | Self::TurnCompleted { issue_identifier, .. }
            | Self::ToolCall { issue_identifier, .. }
            | Self::Error { issue_identifier, .. }
            | Self::RetryScheduled { issue_identifier, .. }
            | Self::Complete { issue_identifier, .. } => issue_identifier,
        }
    }

    pub fn timestamp(&self) -> DateTime<Utc> {
        match self {
            Self::SessionStarted { timestamp, .. }
            | Self::StepStarted { timestamp, .. }
            | Self::StepCompleted { timestamp, .. }
            | Self::TurnCompleted { timestamp, .. }
            | Self::ToolCall { timestamp, .. }
            | Self::Error { timestamp, .. }
            | Self::RetryScheduled { timestamp, .. }
            | Self::Complete { timestamp, .. } => *timestamp,
        }
    }
}
```

- [ ] **Step 2: Define EventBus wrapper**

Append to `crates/ensemble-core/src/observability/events.rs`:
```rust
use tokio::sync::broadcast;

const EVENT_BUS_CAPACITY: usize = 1024;

#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<PipelineEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        Self { sender }
    }

    pub fn publish(&self, event: PipelineEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PipelineEvent> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 3: Add module declaration**

Update `crates/ensemble-core/src/observability/mod.rs` — add:
```rust
pub mod events;
```

- [ ] **Step 4: Write tests**

Append to `crates/ensemble-core/src/observability/events.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_and_receive() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(PipelineEvent::SessionStarted {
            issue_identifier: "MT-1".into(),
            timestamp: Utc::now(),
            detail: "test".into(),
        });
        let event = rx.recv().await.unwrap();
        assert_eq!(event.issue_identifier(), "MT-1");
    }

    #[tokio::test]
    async fn publish_with_no_subscribers_does_not_panic() {
        let bus = EventBus::new();
        bus.publish(PipelineEvent::Complete {
            issue_identifier: "MT-2".into(),
            timestamp: Utc::now(),
            outcome: "succeeded".into(),
        });
    }

    #[test]
    fn issue_identifier_extraction() {
        let event = PipelineEvent::ToolCall {
            issue_identifier: "MT-99".into(),
            timestamp: Utc::now(),
            tool_name: "bash".into(),
            detail: "ls".into(),
        };
        assert_eq!(event.issue_identifier(), "MT-99");
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p ensemble-core -- observability::events`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/observability/events.rs crates/ensemble-core/src/observability/mod.rs
git commit -m "feat: event bus with broadcast channel for pipeline event streaming"
```

---

### Task 8: History Log Model and Writer

**Files:**
- Create: `crates/ensemble-core/src/history/mod.rs`
- Create: `crates/ensemble-core/src/history/model.rs`
- Create: `crates/ensemble-core/src/history/writer.rs`
- Modify: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Create history module with model types**

`crates/ensemble-core/src/history/mod.rs`:
```rust
pub mod model;
pub mod reader;
pub mod writer;
```

`crates/ensemble-core/src/history/model.rs`:
```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryRecord {
    pub issue_identifier: String,
    pub issue_id: String,
    pub outcome: String,
    pub steps_traversed: Vec<String>,
    pub attempts: u32,
    pub tokens: TokenTotals,
    pub duration_seconds: u64,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub last_error: Option<String>,
    pub verdict: Option<String>,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}
```

- [ ] **Step 2: Write the HistoryWriter**

`crates/ensemble-core/src/history/writer.rs`:
```rust
use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;

use super::model::HistoryRecord;

#[derive(Debug, Clone)]
pub struct HistoryWriter {
    path: PathBuf,
}

impl HistoryWriter {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn append(&self, record: &HistoryRecord) -> Result<(), std::io::Error> {
        let mut line = serde_json::to_string(record)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        line.push('\n');

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await?;

        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::TokenTotals;
    use chrono::Utc;
    use tempfile::NamedTempFile;

    fn sample_record() -> HistoryRecord {
        HistoryRecord {
            issue_identifier: "MT-648".into(),
            issue_id: "abc123".into(),
            outcome: "succeeded".into(),
            steps_traversed: vec!["build".into(), "review".into()],
            attempts: 1,
            tokens: TokenTotals { input_tokens: 180_000, output_tokens: 104_000, total_tokens: 284_000 },
            duration_seconds: 765,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: Some("approved".into()),
            workspace_path: "/tmp/ensemble_workspaces/MT-648".into(),
        }
    }

    #[tokio::test]
    async fn append_creates_file_and_writes_line() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        let writer = HistoryWriter::new(path.clone());
        writer.append(&sample_record()).await.unwrap();
        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 1);
        let parsed: HistoryRecord = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(parsed.issue_identifier, "MT-648");
    }

    #[tokio::test]
    async fn append_multiple_records() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        let writer = HistoryWriter::new(path.clone());
        writer.append(&sample_record()).await.unwrap();
        let mut r2 = sample_record();
        r2.issue_identifier = "MT-649".into();
        writer.append(&r2).await.unwrap();
        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(contents.lines().count(), 2);
    }
}
```

- [ ] **Step 3: Add module declaration to lib.rs**

Add to `crates/ensemble-core/src/lib.rs`:
```rust
pub mod history;
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p ensemble-core -- history::writer`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/history/ crates/ensemble-core/src/lib.rs
git commit -m "feat: history log model and append-only JSONL writer"
```

---

### Task 9: History Log Reader with Filtering

**Files:**
- Create: `crates/ensemble-core/src/history/reader.rs`

See Plan 5 (2026-03-30) Task 3 for the complete implementation including `HistoryQuery`, `HistoryResponse`, `read_history()`, and 5 tests (read_all, filter_by_outcome, filter_by_step, pagination, missing_file_returns_empty).

- [ ] **Step 1: Implement reader with filtering and pagination** — See design spec for response shapes.
- [ ] **Step 2: Write tests**
- [ ] **Step 3: Run tests** — `cargo test -p ensemble-core -- history::reader` — Expected: 5 tests pass.
- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/history/reader.rs
git commit -m "feat: history log reader with filtering and cursor-based pagination"
```

---

### Task 10: History, Conversation, Stop, and Retry API Handlers

**Files:**
- Create: `crates/ensemble-core/src/api/history_handler.rs`
- Create: `crates/ensemble-core/src/api/conversation.rs`
- Create: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`

See Plan 5 (2026-03-30) Tasks 4, 5, and 7 for the complete handler implementations. Key points:

- `history_handler.rs`: Delegates to `history::reader::read_history()`.
- `conversation.rs`: Reads `{workspace}/.ensemble/conversation.jsonl`, cursor-based pagination, plus a single-message endpoint for full tool output.
- `controls.rs`: `post_stop` sends SIGTERM to agent process and removes from running state. `post_retry` removes from retry queue for immediate re-dispatch. Both return 404/409 for invalid states.
- `ApiState` needs `history_path: PathBuf`, `workspace_root: PathBuf`, and `event_bus: EventBus` fields added.

- [ ] **Step 1: Create history_handler.rs**
- [ ] **Step 2: Create conversation.rs with paginated + single-message handlers**
- [ ] **Step 3: Create controls.rs with stop + retry handlers**
- [ ] **Step 4: Add module declarations to api/mod.rs**
- [ ] **Step 5: Mount all new routes in router.rs**

```rust
.route("/api/v1/history", get(history_handler::get_history))
.route("/api/v1/:identifier/conversation", get(conversation::get_conversation))
.route("/api/v1/:identifier/conversation/:index", get(conversation::get_conversation_message))
.route("/api/v1/:identifier/stop", post(controls::post_stop))
.route("/api/v1/:identifier/retry", post(controls::post_retry))
```

- [ ] **Step 6: Run clippy and tests** — `cargo clippy -p ensemble-core -- -D warnings && cargo test -p ensemble-core`
- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/api/
git commit -m "feat: history, conversation, stop, and retry API endpoints"
```

---

### Task 11: WebSocket Event Handler

**Files:**
- Create: `crates/ensemble-core/src/api/ws.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/Cargo.toml`

See Plan 5 (2026-03-30) Task 6 for the complete WebSocket handler implementation. Key points:

- Uses axum's built-in WebSocket support (`axum::extract::ws`). Enable `ws` feature on axum.
- Add `futures-util` to workspace dependencies.
- On connect: build snapshot from `OrchestratorState`, send to client.
- Subscribe to `EventBus`, filter by `issue_identifier`, forward matching events.
- On `PipelineEvent::Complete`: send complete message and close connection.
- Handle client disconnect and broadcast lag gracefully.

- [ ] **Step 1: Add axum ws feature and futures-util dependency**
- [ ] **Step 2: Create ws.rs with WebSocket handler**
- [ ] **Step 3: Add module declaration and route** — `.route("/ws/events/:identifier", get(ws::ws_events))`
- [ ] **Step 4: Run clippy and tests**
- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml crates/ensemble-core/src/api/ws.rs crates/ensemble-core/src/api/mod.rs crates/ensemble-core/src/api/router.rs
git commit -m "feat: WebSocket handler for live event streaming per issue"
```

---

### Task 12: Static Asset Serving

**Files:**
- Modify: `crates/ensemble-core/Cargo.toml`
- Modify: `crates/ensemble-core/src/api/router.rs`

- [ ] **Step 1: Add tower-http with fs feature**

Workspace `Cargo.toml`:
```toml
tower-http = { version = "0.6", features = ["fs"] }
```

- [ ] **Step 2: Update create_api_router to accept optional static_dir**

```rust
use tower_http::services::{ServeDir, ServeFile};

pub fn create_api_router(state: Arc<ApiState>, static_dir: Option<PathBuf>) -> Router {
    let mut router = Router::new()
        // ... existing routes ...
        .with_state(state);

    if let Some(dir) = static_dir {
        let serve = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
        router = router.fallback_service(serve);
    }

    router
}
```

- [ ] **Step 3: Run clippy** — `cargo clippy -p ensemble-core -- -D warnings`
- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml crates/ensemble-core/src/api/router.rs
git commit -m "feat: static asset serving for dashboard SPA via tower-http ServeDir"
```

---

## Summary

After completing all 12 tasks, you will have:

**Phase 1 (Tasks 1-6):**
- **Runtime snapshot types** (`observability/snapshot.rs`) — JSON snapshots matching SPEC.md Section 13.7.2
- **Structured logging** (`observability/logging.rs`) — `init_logging()` with JSON/human format
- **Axum HTTP router** (`api/router.rs`) — `create_api_router()` with shared state
- **API handlers** (`api/handlers.rs`) — `get_state`, `get_issue_detail`, `post_refresh`, `method_not_allowed`
- **CLI binary** (`ensemble-cli/`) — headless binary with arg parsing, config loading, optional HTTP server
- **Integration tests** verifying API endpoint JSON shapes

**Phase 2 (Tasks 7-12):**
- **Event bus** (`observability/events.rs`) — `PipelineEvent` enum + `EventBus` broadcast channel
- **History log** (`history/`) — `HistoryRecord` model, append-only JSONL writer, reader with filtering + pagination
- **New API endpoints** — `GET /history`, `GET /{id}/conversation`, `GET /{id}/conversation/{index}`, `POST /{id}/stop`, `POST /{id}/retry`
- **WebSocket handler** (`api/ws.rs`) — `/ws/events/{id}` with snapshot-on-connect, typed event streaming, auto-close on completion
- **Static asset serving** — `tower-http::ServeDir` fallback for dashboard SPA

**Next:** Plan 5 adds the React dashboard frontend. Plan 6 adds the Tauri desktop wrapper.
