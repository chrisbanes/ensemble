# Per-step timeout configuration

**Date:** 2026-06-14
**Issue:** [#176](https://github.com/chrisbanes/ensemble/issues/176)
**Status:** Design

## Context

Ensemble currently has global runtime timeout settings under `agent.*`:

- `agent.turn_timeout_ms`
- `agent.read_timeout_ms`
- `agent.stall_timeout_ms`

These settings apply broadly across the agent runtime. They do not let operators express that one
pipeline step should have a tighter execution bound than another. A build step may reasonably take
10 minutes, while a review or synthesis step may be expected to finish in 2 minutes.

The current runtime paths also differ:

- The direct ACP path passes `agent.turn_timeout_ms` into `AcpSessionConfig`.
- The `acpx` path already supports cooperative cancellation through `acpx cancel --session`, but
  does not have a per-step timeout value flowing through `AgentRunRequest`.

## Problem

1. **No per-step turn bound.** Operators must choose one global turn timeout that fits the
   slowest step.
2. **Stall detection is too blunt.** `agent.stall_timeout_ms` detects inactivity, not a configured
   maximum for each runtime prompt in a step.
3. **Timeout failures should respect step policy.** A timed-out step should enter the same pipeline
   failure flow as other step runtime errors, including `on_failure: retry_step`, `fixup`, `halt`, or
   `retry_issue`.
4. **Cancellation behavior must stay runtime-aware.** The pipeline layer should not hard-kill agent
   processes when runtimes already have graceful session cancellation mechanisms.

## Goal

- Add optional `timeout_ms` to each `StepConfig`.
- Default missing `timeout_ms` to `agent.turn_timeout_ms`.
- Enforce the effective timeout in both supported runtime paths for each prompt or turn associated
  with that step.
- On timeout, gracefully cancel the active session where supported and return
  `AgentError::TurnTimeout`.
- Route timeout errors through the normal per-step failure path.
- Document the config field and update generated API schema coverage.

## Non-Goals

- Adding separate timeout fields for working, extraction, and repair turns.
- Adding per-agent timeout overrides.
- Adding a hard process-kill policy as user-facing config.
- Changing `agent.read_timeout_ms` or `agent.stall_timeout_ms` semantics.
- Adding a special timeout retry counter independent of `max_cycles`.

---

## Design

### 1. Step Config

Add `timeout_ms` to `StepConfig`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct StepConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "StepKind::is_agent")]
    pub kind: StepKind,
    pub agent: String,
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<StepApprovalConfig>,
    #[serde(default, skip_serializing_if = "OnFailure::is_default")]
    pub on_failure: OnFailure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixup_agent: Option<String>,
}
```

Example YAML:

```yaml
steps:
  - name: build
    agent: builder
    timeout_ms: 600000

  - name: review
    agent: reviewer
    timeout_ms: 120000
```

`timeout_ms` must be a positive integer when present. `0` is invalid because it would create an
immediate timeout and is more likely to be a configuration mistake than useful behavior.

### 2. Effective Timeout

The effective timeout for a dispatched step is:

```rust
step.timeout_ms.unwrap_or(config.agent.turn_timeout_ms)
```

This value should be resolved when the pipeline produces dispatch requests, not by looking up the
step again inside each runtime. That keeps the runtime contract explicit and works for synthetic
runtime DAG steps. Synthetic fixup steps should inherit the timeout from the step that caused the
fixup retry.

Propagation:

1. Add `timeout_ms: Option<u64>` to `DagStep`.
2. Copy `StepConfig.timeout_ms` into `DagStep` in `build_dag`.
3. Add `timeout_ms: Option<u64>` to `DispatchRequest`.
4. Add `timeout_ms: u64` to `StepDispatchContext`.
5. Add `turn_timeout_ms: u64` or `timeout_ms: u64` to `AgentRunRequest`.

The dispatch layer computes the default from the config snapshot and passes a concrete value to the
agent runner. Agent runners should not inspect `StepConfig` directly.

`timeout_ms` intentionally matches the existing `agent.turn_timeout_ms` semantics: it bounds each
runtime prompt or turn for the configured step. It does not cover workspace preparation, hooks, or
the sum of working plus hidden extraction and repair turns.

### 3. Runtime Enforcement

#### Direct ACP runtime

Pass the per-step effective timeout into `AcpSessionConfig.turn_timeout_ms` instead of always using
`config.agent.turn_timeout_ms`.

The existing direct ACP flow already maps timeout text to `AgentError::TurnTimeout`, and should keep
using that normalized error type.

#### `acpx` runtime

Wrap each `run_prompt_with_cancellation` prompt with `tokio::time::timeout` using the effective
per-step timeout. This applies independently to visible working prompts and hidden extraction or
repair prompts.

On timeout:

1. Call `acpx cancel --session <session>`.
2. Emit a visible cancellation or failure event only for visible prompts.
3. Wait briefly for the prompt future to exit, reusing the existing bounded wait.
4. Return `AgentError::TurnTimeout { timeout_ms }`.
5. Always attempt to close the session before returning from `run_step`.

The runtime should continue to use cooperative cancellation as the primary behavior. Hard process
termination remains an internal fallback in process cleanup paths, not a configurable step policy.

### 4. Pipeline Failure Handling

Timeouts should behave like step runtime errors, not like a generic worker crash.

When a worker exits with `AgentError::TurnTimeout`, the orchestrator should call
`PipelineRun::step_failed(step_name, error.to_string())` and handle the returned
`PipelineAction::Failed` through the existing per-step failure policy branch.

This ensures:

- `on_failure: retry_issue` preserves current default behavior.
- `on_failure: retry_step` retries only the timed-out step and downstream dependents.
- `on_failure: fixup` can run the configured fixup agent before retrying.
- `on_failure: halt` moves the issue into the manual intervention path.

The timeout reason stored in retry entries, history, and pipeline transitions should remain the
normalized error string, for example `turn timeout after 120000ms`.

### 5. Validation And API Surfaces

Validation should reject `timeout_ms: 0` with `PipelineError::InvalidStepConfig`.

Surfaces to update:

- `crates/ensemble-core/src/config/ensemble.rs`
- `crates/ensemble-core/src/pipeline/dag.rs`
- `crates/ensemble-core/src/pipeline/engine.rs`
- `crates/ensemble-core/src/orchestrator/mod.rs`
- `crates/ensemble-core/src/agent/mod.rs`
- `crates/ensemble-core/src/agent/acp_client.rs`
- `crates/ensemble-core/src/agent/acpx_runtime.rs`
- `docs/SPEC.md`
- `docs/configuration.md`
- OpenAPI schema tests or snapshots, if affected by `StepConfig`

If guided config editing exposes step fields, it should preserve unknown keys automatically today,
but it may need a typed field later if the UI adds explicit timeout controls. This issue does not
require a UI control.

### 6. Testing

Add focused tests for:

1. Parsing `steps[].timeout_ms`.
2. Rejecting `timeout_ms: 0`.
3. DAG propagation from `StepConfig` to `DagStep` and `DispatchRequest`.
4. Direct ACP session config receives the step timeout.
5. `acpx` runtime cancels a prompt and returns `AgentError::TurnTimeout` when the step timeout
   elapses.
6. Worker timeout routes through per-step `on_failure`, especially `retry_step`, instead of always
   scheduling whole-issue retry.
7. Existing configs without `timeout_ms` continue to inherit `agent.turn_timeout_ms`.

## Open Decisions

None. The initial behavior is runtime-enforced graceful cancellation with inherited defaults and
normal step failure policy handling.
