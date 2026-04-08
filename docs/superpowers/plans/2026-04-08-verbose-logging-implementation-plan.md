# Verbose Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement correlation-first, level-aware logging in Ensemble so operators can trace issue execution end-to-end and selectively enable deep debug output.

**Architecture:** Add a small observability contract layer in `ensemble-core` (event names + helper emitters + redaction utilities), propagate `run_id` through orchestrator spans, then migrate high-value orchestration/workspace/tracker/agent callsites to standardized events. Keep `info` concise, add reasoning at `debug`, and gate protocol/process internals to `trace`.

**Tech Stack:** Rust 2021, `tracing`, `tracing-subscriber`, `tokio`, existing `ensemble-core` orchestrator/pipeline/workspace/agent modules.

---

## File Structure (planned)

- Create: `crates/ensemble-core/src/observability/events_contract.rs`
  - Stable event name constants + helper functions for required fields.
- Create: `crates/ensemble-core/src/observability/redaction.rs`
  - Truncation/redaction helpers for trace logging.
- Modify: `crates/ensemble-core/src/observability/mod.rs`
  - Export new observability modules.
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
  - Root run span, `run_id`, standardized lifecycle events.
- Modify: `crates/ensemble-core/src/orchestrator/retry.rs`
  - Standard retry schedule/cancel event fields.
- Modify: `crates/ensemble-core/src/workspace/manager.rs`
  - Workspace prepare events and durations.
- Modify: `crates/ensemble-core/src/workspace/hooks.rs`
  - Hook start/finish/failure with duration + redacted command context.
- Modify: `crates/ensemble-core/src/tracker/github.rs`
  - Transition requested/succeeded/failed events.
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
  - Trace-level ACP metadata logging with redaction.
- Modify: `crates/ensemble-core/src/observability/logging.rs`
  - Add module-level docs referencing event contract and levels.
- Test: `crates/ensemble-core/src/observability/events_contract.rs` (unit tests inline)
- Test: `crates/ensemble-core/src/observability/redaction.rs` (unit tests inline)

---

### Task 1: Add observability contract module (event names + helper emitters)

**Files:**
- Create: `crates/ensemble-core/src/observability/events_contract.rs`
- Modify: `crates/ensemble-core/src/observability/mod.rs`
- Test: `crates/ensemble-core/src/observability/events_contract.rs`

- [ ] **Step 1: Write failing tests for event constants and helper field formatting**

```rust
#[test]
fn event_names_are_stable() {
    assert_eq!(ORCH_TICK_STARTED, "orchestrator.tick_started");
    assert_eq!(ISSUE_DISPATCH_STARTED, "issue.dispatch_started");
    assert_eq!(TRACKER_TRANSITION_FAILED, "tracker.transition_failed");
}

#[test]
fn duration_helper_is_millis() {
    let start = std::time::Instant::now();
    let elapsed = elapsed_ms(start);
    assert!(elapsed <= 5_000);
}
```

- [ ] **Step 2: Run test to verify it fails (module missing)**

Run: `rtk cargo test -p ensemble-core observability::events_contract::tests::event_names_are_stable`
Expected: FAIL with unresolved module/path errors.

- [ ] **Step 3: Add minimal implementation module and exports**

```rust
// crates/ensemble-core/src/observability/events_contract.rs
pub const ORCH_TICK_STARTED: &str = "orchestrator.tick_started";
pub const ORCH_TICK_FINISHED: &str = "orchestrator.tick_finished";
pub const ISSUE_DISPATCH_STARTED: &str = "issue.dispatch_started";
pub const ISSUE_DISPATCH_SKIPPED: &str = "issue.dispatch_skipped";
pub const ISSUE_DISPATCH_COMPLETED: &str = "issue.dispatch_completed";
pub const STEP_STARTED: &str = "step.started";
pub const STEP_WAITING: &str = "step.waiting";
pub const STEP_FINISHED: &str = "step.finished";
pub const TRACKER_TRANSITION_REQUESTED: &str = "tracker.transition_requested";
pub const TRACKER_TRANSITION_SUCCEEDED: &str = "tracker.transition_succeeded";
pub const TRACKER_TRANSITION_FAILED: &str = "tracker.transition_failed";

pub fn elapsed_ms(start: std::time::Instant) -> u128 {
    start.elapsed().as_millis()
}
```

```rust
// crates/ensemble-core/src/observability/mod.rs
pub mod events_contract;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `rtk cargo test -p ensemble-core observability::events_contract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/observability/events_contract.rs crates/ensemble-core/src/observability/mod.rs
rtk git commit -m "Add observability event contract module"
```

---

### Task 2: Add `run_id` generation and root orchestrator span

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs` (inline tests if applicable)

- [ ] **Step 1: Write failing test for run_id format helper**

```rust
#[test]
fn run_id_has_expected_prefix() {
    let run_id = new_run_id();
    assert!(run_id.starts_with("run-"));
    assert!(run_id.len() > 8);
}
```

- [ ] **Step 2: Run test to confirm fail**

Run: `rtk cargo test -p ensemble-core orchestrator::tests::run_id_has_expected_prefix`
Expected: FAIL (helper not found).

- [ ] **Step 3: Implement helper and root span in `run()`**

```rust
fn new_run_id() -> String {
    format!("run-{}", uuid::Uuid::new_v4())
}

pub async fn run(&mut self) {
    let run_id = new_run_id();
    let run_span = tracing::info_span!("ensemble_run", run_id = %run_id, mode = "run");
    let _guard = run_span.enter();

    tracing::info!(event = crate::observability::events_contract::ORCH_TICK_STARTED, "orchestrator starting");
    // existing run body continues...
}
```

- [ ] **Step 4: Run targeted tests**

Run: `rtk cargo test -p ensemble-core orchestrator::tests::run_id_has_expected_prefix`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/orchestrator/mod.rs
rtk git commit -m "Add run_id and root run span for orchestrator"
```

---

### Task 3: Standardize orchestrator lifecycle events (dispatch/tick/retry)

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/retry.rs`
- Test: `crates/ensemble-core/src/orchestrator/retry.rs` (existing tests + new asserts)

- [ ] **Step 1: Write failing test for retry event reason normalization**

```rust
#[test]
fn retry_reason_is_non_empty() {
    let reason = normalize_reason("");
    assert_eq!(reason, "unknown");
}
```

- [ ] **Step 2: Run test to verify fail**

Run: `rtk cargo test -p ensemble-core orchestrator::retry::tests::retry_reason_is_non_empty`
Expected: FAIL.

- [ ] **Step 3: Add standardized event logs around ticks/dispatch/retry**

```rust
let tick_started = std::time::Instant::now();
tracing::info!(event = ORCH_TICK_STARTED, "tick started");

// existing handle_tick body

tracing::info!(
    event = ORCH_TICK_FINISHED,
    duration_ms = crate::observability::events_contract::elapsed_ms(tick_started),
    "tick finished"
);
```

```rust
tracing::info!(
    event = ISSUE_DISPATCH_STARTED,
    issue_id = %issue.id,
    issue_identifier = %issue.identifier,
    cycle = cycle,
    "dispatching issue"
);
```

```rust
tracing::debug!(
    event = "issue.retry_scheduled",
    issue_id = %issue_id,
    reason = %normalize_reason(reason),
    backoff_ms = delay_ms,
    "retry scheduled"
);
```

- [ ] **Step 4: Run orchestrator-focused tests**

Run: `rtk cargo test -p ensemble-core orchestrator::retry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/orchestrator/retry.rs
rtk git commit -m "Standardize orchestrator tick dispatch and retry events"
```

---

### Task 4: Instrument pipeline/workspace/tracker transitions with required fields

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/workspace/manager.rs`
- Modify: `crates/ensemble-core/src/workspace/hooks.rs`
- Modify: `crates/ensemble-core/src/tracker/github.rs`

- [ ] **Step 1: Add failing tests for redaction-safe hook/tracker logging metadata**

```rust
#[test]
fn hook_log_includes_duration_and_outcome() {
    let line = format_hook_log("after_run", 42, "ok");
    assert!(line.contains("duration_ms=42"));
    assert!(line.contains("outcome=ok"));
}
```

- [ ] **Step 2: Run targeted test to verify fail**

Run: `rtk cargo test -p ensemble-core workspace::hooks::tests::hook_log_includes_duration_and_outcome`
Expected: FAIL.

- [ ] **Step 3: Implement lifecycle events for step/workspace/tracker**

```rust
tracing::info!(
    event = STEP_STARTED,
    issue_id = %issue.id,
    issue_identifier = %issue.identifier,
    step = %ctx.step_name,
    agent = %ctx.agent_name,
    "step started"
);
```

```rust
let started = std::time::Instant::now();
tracing::info!(event = "workspace.prepare_started", issue_identifier = %identifier, "workspace prepare started");
// existing prepare logic
tracing::info!(event = "workspace.prepare_finished", duration_ms = elapsed_ms(started), issue_identifier = %identifier, "workspace prepare finished");
```

```rust
tracing::info!(
    event = TRACKER_TRANSITION_REQUESTED,
    issue_id = %issue.id,
    tracker_state_from = %from,
    tracker_state_to = %to,
    "tracker transition requested"
);
```

- [ ] **Step 4: Run focused module tests**

Run: `rtk cargo test -p ensemble-core workspace::hooks tracker::github`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/workspace/manager.rs crates/ensemble-core/src/workspace/hooks.rs crates/ensemble-core/src/tracker/github.rs
rtk git commit -m "Add standardized step workspace and tracker transition events"
```

---

### Task 5: Add redaction helpers + trace-level ACP/generic command metadata logging

**Files:**
- Create: `crates/ensemble-core/src/observability/redaction.rs`
- Modify: `crates/ensemble-core/src/observability/mod.rs`
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/workspace/worktree.rs`
- Test: `crates/ensemble-core/src/observability/redaction.rs`

- [ ] **Step 1: Write failing tests for truncation and secret masking helpers**

```rust
#[test]
fn truncate_preserves_prefix_and_marks_ellipsis() {
    let out = truncate_for_log("abcdefghijklmnopqrstuvwxyz", 8);
    assert_eq!(out, "abcdefgh…");
}

#[test]
fn redact_token_masks_known_keys() {
    let out = redact_kv("api_token=abc123");
    assert_eq!(out, "api_token=[REDACTED]");
}
```

- [ ] **Step 2: Run tests to verify fail**

Run: `rtk cargo test -p ensemble-core observability::redaction`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement helpers and integrate in trace callsites**

```rust
pub fn truncate_for_log(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let prefix: String = input.chars().take(max).collect();
    format!("{}…", prefix)
}

pub fn redact_kv(input: &str) -> String {
    input
        .replace("api_token=", "api_token=[REDACTED]")
        .replace("authorization=", "authorization=[REDACTED]")
}
```

```rust
tracing::trace!(
    event = "agent.message",
    direction = "outbound",
    bytes = payload.len(),
    preview = %crate::observability::redaction::truncate_for_log(&payload, 120),
    "acp outbound metadata"
);
```

- [ ] **Step 4: Run tests**

Run: `rtk cargo test -p ensemble-core observability::redaction agent::acp_client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/observability/redaction.rs crates/ensemble-core/src/observability/mod.rs crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/workspace/worktree.rs
rtk git commit -m "Add redaction helpers and trace-level ACP command metadata logs"
```

---

### Task 6: Documentation and verification pass

**Files:**
- Modify: `crates/ensemble-core/src/observability/logging.rs`
- Modify: `docs/SPEC.md` (observability section only, if needed)

- [ ] **Step 1: Add docs describing event contract and level semantics**

```rust
/// Logging levels:
/// - info: lifecycle milestones
/// - debug: decision reasons
/// - trace: protocol/process metadata with redaction
///
/// Contract fields: event, run_id, issue_id/issue_identifier, cycle, step, agent, duration_ms.
```

- [ ] **Step 2: Run full Rust validation suite**

Run: `rtk cargo test --workspace --exclude ensemble-desktop`
Expected: PASS.

Run: `rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings`
Expected: PASS.

Run: `rtk cargo fmt --all -- --check`
Expected: PASS.

- [ ] **Step 3: Manual behavior check commands**

Run:
```bash
ENSEMBLE_LOG=info rtk cargo run -p ensemble-cli -- run --config-dir <path>
```
Expected: concise lifecycle events with `event` names.

Run:
```bash
ENSEMBLE_LOG=debug rtk cargo run -p ensemble-cli -- run --config-dir <path>
```
Expected: includes skip/retry/DAG decision reasons.

- [ ] **Step 4: Commit**

```bash
rtk git add crates/ensemble-core/src/observability/logging.rs docs/SPEC.md
rtk git commit -m "Document structured verbose logging contract and verification runbook"
```

---

## Spec Coverage Check

- Correlation-first contract: Covered by Task 1, Task 2, Task 3.
- Required event naming taxonomy: Covered by Task 1 and adopted across Tasks 3–5.
- Level strategy (`info`/`debug`/`trace`): Covered by Tasks 3, 5, and 6 docs.
- Redaction/truncation guardrails: Covered by Task 5.
- Validation and operator runbook checks: Covered by Task 6.

No uncovered spec requirements remain.

## Placeholder Scan

- No TODO/TBD placeholders remain.
- Every task includes concrete file paths, commands, expected outcomes, and commit steps.

## Type/Name Consistency Check

- Event constants referenced from a single module: `observability::events_contract`.
- Redaction helper names are consistent (`truncate_for_log`, `redact_kv`).
- `run_id` terminology is consistent across all tasks.
