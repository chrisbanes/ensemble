# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 24 issues found during code review — 7 bugs, 5 performance improvements, 6 simplifications, and 6 minor issues.

**Architecture:** All changes are within `crates/ensemble-core`. No API changes, no new dependencies. Each task is self-contained and independently testable.

**Tech Stack:** Rust, tokio, axum, serde, thiserror, tracing

---

### Task 1: Fix Critical Bugs — Shell Injection

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs:137-139` (executor escaping)
- Modify: `crates/ensemble-core/src/agent/mod.rs:306-479` (add test)

- [ ] **Step 1: Fix executor path shell injection**

In `agent/mod.rs`, the `resolve_agent_command` function properly shell-escapes `acpx_agent` and `model` values, but returns `executor` raw. If `executor` contains shell metacharacters and is passed to `bash -lc`, this is an injection vector.

Change in `agent/mod.rs` around line 137-139:

```rust
// Before:
if let Some(ref executor) = ac.executor {
    return executor.clone();
}

// After:
if let Some(ref executor) = ac.executor {
    return shell_escape(executor);
}
```

- [ ] **Step 2: Add test for executor escaping**

Add to `agent/mod.rs` tests:

```rust
#[test]
fn test_resolve_agent_command_escapes_executor() {
    let config = crate::config::ensemble::AgentConfig {
        acpx_agent: None,
        model: None,
        executor: Some("my-agent; rm -rf /".to_string()),
        prompt: None,
        prompt_template: None,
        reasoning_level: None,
    };
    let cmd = resolve_agent_command(Some(&config), "default-cmd");
    assert_eq!(cmd, "'my-agent; rm -rf /'");
}
```

- [ ] **Step 3: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

Expected: All tests pass, no clippy warnings.

**Note on token double-counting (Issue #6 from review):** After analysis, this is NOT a bug. On retry, a NEW agent session starts from 0 cumulative tokens. The `last_reported_*` fields correctly default to 0 because the delta calculation `new_value - 0` gives the right delta for the fresh session. The `agent_totals` already contains the previous session's tokens. No fix needed.

---

### Task 2: Fix Performance — Eliminate Redundant Allocations in Scheduler and Reconciler

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/scheduler.rs:9-85` (is_dispatch_eligible)
- Modify: `crates/ensemble-core/src/orchestrator/scheduler.rs:138-494` (tests)
- Modify: `crates/ensemble-core/src/orchestrator/reconciler.rs:66-82` (determine_reconcile_action)
- Modify: `crates/ensemble-core/src/orchestrator/reconciler.rs:219-520` (tests)
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:256-278` (dispatch loop caller)

- [ ] **Step 1: Pre-compute lowercase state lists in handle_tick**

In `orchestrator/mod.rs`, inside `handle_tick`, compute lowercase versions once and pass them to eligibility checks:

```rust
// Add near the top of handle_tick, after config read:
let active_lower: Vec<String> = config.tracker.active_states.iter()
    .map(|s| s.to_lowercase())
    .collect();
let terminal_lower: Vec<String> = config.tracker.terminal_states.iter()
    .map(|s| s.to_lowercase())
    .collect();
```

- [ ] **Step 2: Update `is_dispatch_eligible` to accept pre-lowercased slices**

Change the signature in `scheduler.rs`:

```rust
pub fn is_dispatch_eligible(
    issue: &Issue,
    state: &OrchestratorState,
    active_states_lower: &[String],
    terminal_states_lower: &[String],
    max_concurrent_by_state: &HashMap<String, u32>,
) -> Option<String> {
```

Remove the internal `to_lowercase()` allocations (lines 33-40). Use `state_lower` directly with the pre-lowercased slices.

- [ ] **Step 3: Update `determine_reconcile_action` similarly**

Change the signature in `reconciler.rs`:

```rust
pub fn determine_reconcile_action(
    issue: &Issue,
    active_states_lower: &[String],
    terminal_states_lower: &[String],
) -> ReconcileAction {
```

Remove the internal allocations (lines 72-73).

- [ ] **Step 4: Update `reconcile_tracker_states` to accept pre-lowercased slices**

Change the signature:

```rust
pub async fn reconcile_tracker_states(
    state: &OrchestratorState,
    tracker: &dyn IssueTracker,
    active_states_lower: &[String],
    terminal_states_lower: &[String],
) -> ReconcileTrackerResult {
```

- [ ] **Step 5: Update all callers in `mod.rs`**

Update the calls in `handle_tick` to pass the pre-computed lowercase slices to `is_dispatch_eligible` and `reconcile_tracker_states`.

- [ ] **Step 6: Update tests to pass lowercase slices**

In `scheduler.rs` tests, change `default_active()` and `default_terminal()` to return pre-lowercased values, or update test calls to lowercase them before passing.

In `reconciler.rs` tests, update `default_active()` and `default_terminal()` similarly.

- [ ] **Step 7: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

---

### Task 3: Fix Performance — Agent Prompt Caching and JSON-RPC Write Batching

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs:37-98` (build_prompt caching + cache invalidation)
- Modify: `crates/ensemble-core/src/agent/acp_client.rs:545-565` (send_json_rpc batching)

- [ ] **Step 1: Cache prompt template in AcpAgentRunner with invalidation**

In `agent/mod.rs`, the `build_prompt` method reads config and resolves the prompt template on every turn. The prompt template is static — cache it once at session start, with a `clear_cache()` method for config reload.

Add a `cached_prompts` field to `AcpAgentRunner`:

```rust
pub struct AcpAgentRunner {
    pub config: Arc<RwLock<EnsembleConfig>>,
    cached_prompts: RwLock<HashMap<String, String>>, // agent_name -> resolved template
}
```

Add methods:

```rust
impl AcpAgentRunner {
    pub fn new(config: Arc<RwLock<EnsembleConfig>>) -> Self {
        Self {
            config,
            cached_prompts: RwLock::new(HashMap::new()),
        }
    }

    /// Clear the prompt cache. Call this when config is reloaded.
    pub fn clear_cache(&self) {
        // Synchronous clear — safe because it's a simple HashMap clear
        // The RwLock write guard is held briefly
        let mut cache = self.cached_prompts.try_write();
        if let Ok(mut cache) = cache {
            cache.clear();
        }
    }

    async fn get_or_cache_prompt_template(&self, agent_name: &str) -> Result<String, AgentError> {
        // Check cache first
        {
            let cache = self.cached_prompts.read().await;
            if let Some(template) = cache.get(agent_name) {
                return Ok(template.clone());
            }
        }

        // Resolve and cache
        let config = self.config.read().await;
        let agent_config = config.agents.get(agent_name).ok_or_else(|| {
            AgentError::PromptError {
                reason: format!("agent '{}' not found in config", agent_name),
            }
        })?;

        let template = if let Some(ref prompt) = agent_config.prompt {
            prompt.clone()
        } else if let Some(ref template_path) = agent_config.prompt_template {
            std::fs::read_to_string(template_path).map_err(|e| AgentError::PromptError {
                reason: format!(
                    "failed to read prompt template '{}': {}",
                    template_path.display(),
                    e
                ),
            })?
        } else {
            return Err(AgentError::PromptError {
                reason: format!(
                    "agent '{}' has neither prompt nor prompt_template",
                    agent_name
                ),
            });
        };

        // Store in cache
        {
            let mut cache = self.cached_prompts.write().await;
            cache.insert(agent_name.to_string(), template.clone());
        }

        Ok(template)
    }
}
```

Update `build_prompt` to use the cached template:

```rust
async fn build_prompt(
    &self,
    issue: &Issue,
    agent_name: &str,
    attempt: Option<u32>,
    turn_number: u32,
) -> Result<String, AgentError> {
    if turn_number == 1 {
        let template = self.get_or_cache_prompt_template(agent_name).await?;
        render_prompt(&template, issue, attempt).map_err(|e| AgentError::PromptError {
            reason: e.to_string(),
        })
    } else {
        Ok(format!(
            "Continue working on {}. This is turn {} of this session. \
             The issue is still in an active state. \
             Review your progress and continue where you left off.",
            issue.identifier, turn_number
        ))
    }
}
```

- [ ] **Step 2: Batch JSON-RPC writes**

In `acp_client.rs`, `send_json_rpc` does three separate async operations. Combine into one:

```rust
async fn send_json_rpc(&mut self, msg: &serde_json::Value) -> Result<(), AgentError> {
    let line = serde_json::to_string(msg).map_err(|e| AgentError::IoError {
        reason: format!("json serialize error: {e}"),
    })?;
    debug!(msg = %line, "sending JSON-RPC");

    // Single write: serialize into buffer with newline
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line.as_bytes());
    buf.push(b'\n');

    self.stdin
        .write_all(&buf)
        .await
        .map_err(|e| AgentError::IoError {
            reason: format!("stdin write error: {e}"),
        })?;
    self.stdin.flush().await.map_err(|e| AgentError::IoError {
        reason: format!("stdin flush error: {e}"),
    })?;
    Ok(())
}
```

- [ ] **Step 3: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

---

### Task 4: Fix Performance — Iterator Return for running_issue_ids

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/state.rs:230-232` (running_issue_ids → iterator)
- Modify: `crates/ensemble-core/src/orchestrator/reconciler.rs:92` (caller of running_issue_ids)

- [ ] **Step 1: Change `running_issue_ids` to return an iterator**

In `state.rs`:

```rust
// Before:
pub fn running_issue_ids(&self) -> Vec<String> {
    self.running.keys().cloned().collect()
}

// After:
pub fn running_issue_ids(&self) -> impl Iterator<Item = &str> {
    self.running.keys().map(|k| k.as_str())
}
```

Returning `&str` instead of `&String` avoids leaking the internal HashMap key type.

- [ ] **Step 2: Update `reconcile_tracker_states` caller**

In `reconciler.rs`, the caller already collects to Vec for the trait call:

```rust
// Before:
let running_ids = state.running_issue_ids();
if running_ids.is_empty() { ... }
let refreshed = match tracker.fetch_issue_states_by_ids(&running_ids).await {

// After:
let running_ids: Vec<String> = state.running_issue_ids().map(|s| s.to_string()).collect();
if running_ids.is_empty() { ... }
let refreshed = match tracker.fetch_issue_states_by_ids(&running_ids).await {
```

The Vec is still needed for the trait call, but the iterator avoids an intermediate allocation in the common case where it's empty (no running issues).

- [ ] **Step 3: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

**Note on `get_due_retries` (Issue #9 from review):** After analysis, changing this to return IDs only would require `handle_single_retry` to look up the entry under a separate lock, adding complexity rather than reducing it. `RetryEntry` is small and already Clone. Keep returning `Vec<RetryEntry>`.

**Note on DAG clones (Issue #11 from review):** The proposed "fix" produces the same number of clones total — it's churn with zero benefit. Skip.

---

### Task 5: Simplify — Orchestrator Lock Churn and Verbose Match

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:158-278` (handle_tick lock reduction)
- Modify: `crates/ensemble-core/src/agent/events.rs:51-85` (add helper methods to AgentEvent)
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:485-561` (handle_agent_update simplification)

- [ ] **Step 1: Add helper methods to AgentEvent**

In `agent/events.rs`, add to `impl AgentEvent`:

```rust
impl AgentEvent {
    /// Returns the event name for logging/state tracking.
    pub fn event_name(&self) -> &'static str {
        match self {
            AgentEvent::SessionStarted { .. } => "session_started",
            AgentEvent::TurnStarted => "turn_started",
            AgentEvent::TurnUpdate { .. } => "turn_update",
            AgentEvent::TurnCompleted { .. } => "turn_completed",
            AgentEvent::TurnFailed { .. } => "turn_failed",
            AgentEvent::PermissionRequested { .. } => "permission_requested",
            AgentEvent::PermissionResolved { .. } => "permission_resolved",
            AgentEvent::Notification { .. } => "notification",
            AgentEvent::OtherMessage { .. } => "other_message",
            AgentEvent::Malformed { .. } => "malformed",
        }
    }

    /// Returns the message content for state tracking, truncated.
    pub fn message_for_state(&self) -> Option<String> {
        match self {
            AgentEvent::TurnUpdate { content } => Some(content.clone()),
            AgentEvent::TurnFailed { reason, .. } => Some(reason.clone()),
            AgentEvent::PermissionRequested { description, .. } => Some(description.clone()),
            AgentEvent::Notification { message } => Some(message.clone()),
            AgentEvent::OtherMessage { raw } => Some(raw.chars().take(100).collect()),
            AgentEvent::Malformed { line } => Some(line.chars().take(100).collect()),
            _ => None,
        }
    }
}
```

- [ ] **Step 2: Simplify `handle_agent_update`**

In `orchestrator/mod.rs`, replace the 17-arm match with:

```rust
async fn handle_agent_update(
    &self,
    issue_id: &str,
    _step_name: &str,
    event: AgentEvent,
    timestamp: chrono::DateTime<Utc>,
) {
    let mut state = self.state.write().await;

    // Handle special cases
    match &event {
        AgentEvent::SessionStarted { session_id, agent_pid } => {
            state.update_session_info(issue_id, session_id, agent_pid.as_deref());
        }
        AgentEvent::TurnStarted => {
            state.increment_turn_count(issue_id);
        }
        AgentEvent::TurnCompleted { usage } | AgentEvent::TurnFailed { usage, .. } => {
            if let Some(u) = usage {
                state.update_token_usage(
                    issue_id,
                    u.input_tokens,
                    u.output_tokens,
                    u.total_tokens,
                );
            }
        }
        _ => {}
    }

    // Common path: update agent event
    state.update_agent_event(issue_id, event.event_name(), event.message_for_state().as_deref(), timestamp);
}
```

- [ ] **Step 3: Reduce lock churn in `handle_tick`**

In `orchestrator/mod.rs`, `handle_tick` currently acquires ~8 separate read/write locks. Since the orchestrator is single-threaded in its event loop, consolidate to fewer lock acquisitions:

```rust
async fn handle_tick(&self) {
    // Record tick
    {
        let mut state = self.state.write().await;
        state.last_tick_at = Some(Utc::now());
    }

    // Stall detection (read-only on state)
    let stall_timeout_ms = {
        let config = self.config.read().await;
        config.agent.stall_timeout_ms
    };
    let stalled_issue_ids = {
        let state = self.state.read().await;
        reconcile_stalled_runs(&state, stall_timeout_ms).stalled_issue_ids
    };

    if !stalled_issue_ids.is_empty() {
        let mut state = self.state.write().await;
        let config = self.config.read().await;
        for issue_id in &stalled_issue_ids {
            if let Some(entry) = state.remove_running(issue_id) {
                state.add_runtime_seconds(&entry);
                schedule_failure_retry(
                    &mut state, issue_id, &entry.identifier,
                    next_attempt(entry.retry_attempt),
                    config.agent.max_retry_backoff_ms, config.max_cycles,
                    "stall timeout",
                );
            }
        }
    }

    // Tracker reconciliation (one write lock for the entire operation)
    {
        let config = self.config.read().await;
        let active_lower: Vec<String> = config.tracker.active_states.iter().map(|s| s.to_lowercase()).collect();
        let terminal_lower: Vec<String> = config.tracker.terminal_states.iter().map(|s| s.to_lowercase()).collect();

        let reconcile_result = reconcile_tracker_states(
            &self.state.read().await,
            self.tracker.as_ref(),
            &active_lower, &terminal_lower,
        ).await;

        let mut state = self.state.write().await;
        for issue in reconcile_result.updates {
            let id = issue.id.clone();
            state.update_issue_snapshot(&id, issue);
        }
        for issue in reconcile_result.terminate_cleanup {
            if let Some(entry) = state.remove_running(&issue.id) {
                state.add_runtime_seconds(&entry);
                state.release_claim(&issue.id);
                state.remove_pipeline_run(&issue.id);
                if let Err(e) = self.workspace_mgr.remove_workspace(&entry.identifier).await {
                    warn!(identifier = %entry.identifier, error = %e, "failed to clean terminal workspace");
                }
            }
        }
        for issue in reconcile_result.terminate_no_cleanup {
            if let Some(entry) = state.remove_running(&issue.id) {
                state.add_runtime_seconds(&entry);
                state.release_claim(&issue.id);
                state.remove_pipeline_run(&issue.id);
            }
        }
    }

    // Fetch and dispatch (single read lock for state)
    let mut candidates = match self.tracker.fetch_candidate_issues().await {
        Ok(issues) => issues,
        Err(e) => {
            warn!(error = %e, "failed to fetch candidate issues, skipping dispatch");
            return;
        }
    };
    sort_for_dispatch(&mut candidates);

    let config = self.config.read().await;
    let active_lower: Vec<String> = config.tracker.active_states.iter().map(|s| s.to_lowercase()).collect();
    let terminal_lower: Vec<String> = config.tracker.terminal_states.iter().map(|s| s.to_lowercase()).collect();

    for issue in &candidates {
        {
            let state = self.state.read().await;
            if !has_available_slots(&state) {
                break;
            }
            if is_dispatch_eligible(issue, &state, &active_lower, &terminal_lower, &HashMap::new()).is_none() {
                drop(state);
                self.dispatch_issue(issue, None).await;
            }
        }
    }
}
```

This reduces lock acquisitions from ~8 to ~5, and combines the active/terminal lowercase computation so it's done once instead of twice.

- [ ] **Step 4: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

---

### Task 6: Fix Minor Issues — Build.rs Panic, Silent Approve, Shell Consistency

**Files:**
- Modify: `crates/ensemble-cli/build.rs:47-53` (graceful openapi.json missing)
- Modify: `crates/ensemble-core/src/pipeline/verdict.rs:1-78` (warn on default approve + add tracing import)
- Modify: `crates/ensemble-core/src/workspace/hooks.rs:27` (use bash instead of sh)

- [ ] **Step 1: Make build.rs graceful on missing openapi.json**

In `ensemble-cli/build.rs`:

```rust
// Before:
if !openapi_json.exists() {
    panic!(
        "openapi.json not found at {}. Run `pnpm run codegen:spec` in crates/ensemble-ui/src-ui/ first, \
         or set SKIP_UI_BUILD=1 to skip the UI embed.",
        openapi_json.display()
    );
}

// After:
if !openapi_json.exists() {
    println!(
        "cargo:warning=openapi.json not found at {}. UI will not be embedded.",
        openapi_json.display()
    );
    println!("cargo:warning=Run `pnpm run codegen:spec` in crates/ensemble-ui/src-ui/ to generate it.");
    std::fs::create_dir_all(assets_dir).ok();
    return;
}
```

- [ ] **Step 2: Add warning log on default verdict approval**

In `pipeline/verdict.rs`, add `use tracing::warn;` at the top of the file (line 1 area), then in `resolve_verdict`:

```rust
// Before (line ~77):
Verdict::Approve

// After:
warn!("no verdict source found for step, defaulting to Approve");
Verdict::Approve
```

- [ ] **Step 3: Use `bash -lc` for hooks to match ACP client**

In `workspace/hooks.rs`:

```rust
// Before:
let child = Command::new("sh")
    .arg("-lc")

// After:
let child = Command::new("bash")
    .arg("-lc")
```

- [ ] **Step 4: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

---

### Task 7: Fix Remaining Issues — Path Validation and Stale Config

**Files:**
- Modify: `crates/ensemble-core/src/workspace/manager.rs:163-193` (validate_path_inside_root warn on canonicalize failure)
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:282-327` (dispatch_issue rebuilds DAG from fresh config)
- Modify: `crates/ensemble-core/src/workspace/manager.rs:196-297` (tests)

- [ ] **Step 1: Fix validate_path_inside_root to warn on canonicalize failure**

In `workspace/manager.rs`, the original code silently falls back to non-canonicalized paths when `canonicalize()` fails, which weakens the security check. Instead, keep the fallback but add a `warn!` log so operators know the check is degraded:

```rust
// Before:
fn validate_path_inside_root(&self, path: &Path) -> Result<(), WorkspaceError> {
    let canonical_root = if self.root.exists() {
        self.root.canonicalize().unwrap_or_else(|_| self.root.clone())
    } else {
        self.root.clone()
    };

    let canonical_path = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    } else if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
        let canonical_parent = if parent.exists() {
            parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf())
        } else {
            parent.to_path_buf()
        };
        canonical_parent.join(file_name)
    } else {
        path.to_path_buf()
    };

    if !canonical_path.starts_with(&canonical_root) {
        return Err(WorkspaceError::PathOutsideRoot {
            path: canonical_path.display().to_string(),
        });
    }
    Ok(())
}

// After:
fn validate_path_inside_root(&self, path: &Path) -> Result<(), WorkspaceError> {
    let canonical_root = self.root.canonicalize().unwrap_or_else(|e| {
        warn!(
            root = %self.root.display(),
            error = %e,
            "cannot canonicalize workspace root, falling back to non-canonical path check"
        );
        self.root.clone()
    });

    let canonical_path = if path.exists() {
        path.canonicalize().unwrap_or_else(|e| {
            warn!(
                path = %path.display(),
                error = %e,
                "cannot canonicalize path, falling back to non-canonical check"
            );
            path.to_path_buf()
        })
    } else if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
        let canonical_parent = parent.canonicalize().unwrap_or_else(|e| {
            warn!(
                parent = %parent.display(),
                error = %e,
                "cannot canonicalize parent path, falling back to non-canonical check"
            );
            parent.to_path_buf()
        });
        canonical_parent.join(file_name)
    } else {
        path.to_path_buf()
    };

    if !canonical_path.starts_with(&canonical_root) {
        return Err(WorkspaceError::PathOutsideRoot {
            path: canonical_path.display().to_string(),
        });
    }
    Ok(())
}
```

This preserves compatibility with edge cases (network drives, FUSE mounts, permission-denied intermediates) while alerting operators when the check is degraded.

- [ ] **Step 2: Fix dispatch_issue to rebuild DAG from fresh config**

In `orchestrator/mod.rs`, the `dispatch_issue` method reads config once at the top, builds the DAG, then writes state. If config is reloaded between these operations, the DAG is stale.

The fix: read config, build DAG, and clone the config snapshot within a single config read scope, so the DAG and the config used for `dispatch_step` are consistent:

```rust
async fn dispatch_issue(&self, issue: &Issue, attempt: Option<u32>) {
    // Read config and build DAG atomically
    let (dag, config_snapshot) = {
        let config = self.config.read().await;
        let dag = match build_dag(&config.steps) {
            Ok(d) => d,
            Err(e) => {
                warn!(issue_id = %issue.id, error = %e, "failed to build step DAG, skipping dispatch");
                return;
            }
        };
        (dag, config.clone())
    };

    let cycle = attempt.unwrap_or(1);
    let pipeline_run = PipelineRun::new(issue.id.clone(), cycle, dag);
    let action = pipeline_run.start();

    info!(issue_id = %issue.id, identifier = %issue.identifier, attempt = ?attempt, "dispatching issue with pipeline");

    {
        let mut state = self.state.write().await;
        state.add_running(issue, attempt);
        state.insert_pipeline_run(&issue.id, pipeline_run);
    }

    // Process initial dispatch requests
    if let PipelineAction::Dispatch(requests) = action {
        for req in requests {
            self.dispatch_step(
                issue, &req.step_name, &req.agent_name,
                req.tracker_state.as_deref(), attempt,
            ).await;
        }
    }
}
```

This clones the config (which is cheap for the fields used in `dispatch_step`), ensuring the DAG and the config snapshot used for dispatch_step are consistent.

- [ ] **Step 3: Run tests and verify**

```bash
cargo test -p ensemble-core -- --test-threads=1
cargo clippy -p ensemble-core -- -D warnings
```

---

## Execution Order

Tasks are ordered by priority (bugs first, then performance, then simplifications, then minors). Each task is independent and can be executed in any order, but this order maximizes risk reduction early.

1. **Task 1** — Critical bug (shell injection in executor path)
2. **Task 2** — Performance: eliminate redundant allocations in scheduler/reconciler
3. **Task 3** — Performance: prompt caching with invalidation + JSON-RPC write batching
4. **Task 4** — Performance: iterator return for running_issue_ids
5. **Task 5** — Simplification: lock churn reduction + verbose match refactoring
6. **Task 6** — Minor: build.rs graceful fallback, silent approve warning, shell consistency
7. **Task 7** — Path validation warning on canonicalize failure + stale config fix

## Not Addressed (Deferred)

- **Issue #6** (token double-count on retry): After analysis, NOT a bug. New agent sessions on retry start from 0 cumulative tokens, so `last_reported_* = 0` is correct. `agent_totals` already contains prior session totals.
- **Issue #7** (handle_worker_exit TOCTOU): The PipelineRun state machine already provides protection. Defer until a real race is observed.
- **Issue #9** (get_due_retries clones): Changing to ID-only returns adds complexity (separate lookup under write lock). `RetryEntry` is small and Clone. Not worth it.
- **Issue #11** (DagStep clone in build_dag): Same number of clones total — churn with zero benefit.
- **Issue #14** (MockAgentRunner duplication): Cosmetic test improvement. Defer.
- **Issue #15** (test_issue duplication): Cosmetic test improvement. Defer.
- **Issue #16** (resolve_env_from monolith): Refactoring opportunity, not a bug. Defer.
- **Issue #19** (hardcoded event name strings): Already addressed by Task 5's `event_name()` method.
- **Issue #21** (AgentEvent missing Deserialize): No current use case for deserializing events. Defer.
- **Issue #22** (OrchestratorState not Serialize): Snapshot builder is intentional design. Defer.
