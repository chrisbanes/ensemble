# Step-level retry and agent results

**Date:** 2026-06-11
**Issue:** [#175](https://github.com/chrisbanes/ensemble/issues/175)
**Status:** Design

## Context

Ensemble pipelines run a DAG of steps. Today, when any step fails, the entire pipeline re-runs from scratch. In a 5-step pipeline where step 4 fails, steps 1–3 are wasted. This is especially expensive when steps involve long-running agent calls.

The verdict model (`Approve`/`Reject`) is binary and judgmental. A review agent has no way to flag concerns without halting the pipeline. The pipeline engine owns the decision-making, but the current contract forces agents to gate.

## Problem

1. **No step-level retry.** The whole pipeline restarts on any failure. `PipelineRun::new()` resets all steps to `Pending`, and `OrchestratorState::remove_pipeline_run()` destroys step state completely.

2. **No middle-ground verdict.** `Reject` kills the pipeline; `Approve` continues. A review that finds minor issues must either block everything or stay silent. The synthesis step never sees the data.

3. **No per-step failure policy.** All steps share one retry strategy. A flaky agent timeout should retry the step; a meaningful rejection should halt for user review.

## Goal

- Rename the verdict model to results: `Succeeded`, `Failed`, `Concern`
- Add step-level retry that preserves passed step state and only re-dispatches the failed step + downstream dependents
- Allow each step to configure its failure behavior (`on_failure`)
- Optionally inject a fixup agent before retrying a failed step

## Non-Goals

- Per-step cycle counters or per-step retry limits (whole-issue `max_cycles` still applies)
- Workspace state reset on retry (continue from current workspace state)
- Removing whole-issue retry (coexists alongside step-level)
- Changing the verdict resolution pipeline (ACP → file → default still applies, with renamed values)

---

## Design

### 1. Rename Verdict → Result

| Current | Proposed | Behavior |
|---------|----------|----------|
| `Approve` | `Succeeded` | Step passed. Pipeline continues. |
| `Reject { summary }` | `Failed { summary }` | Step failed. Pipeline halts. Triggers `on_failure`. |
| — | `Concern { summary }` | Issues found but not blocking. Pipeline continues. Downstream steps see the flagged output. |

**`Concern`** is the key addition. A review agent that finds naming issues or minor style problems reports `Concern` with details in `summary` and structured `output`. The pipeline does not halt — downstream steps (especially `kind: synthesis`) receive the concern in their `dependency_outputs` and decide what is actionable. `Failed` remains for truly blocking problems (broken build, wrong approach, unsafe code).

**Result resolution** follows the same priority chain:
1. ACP runtime result (the `result` field in the final session/update event)
2. `.ensemble/verdict-{step_name}.json` (or legacy `verdict.json`)
3. Default to `Succeeded`

**Value mapping:** the existing `"approve"` / `"reject"` strings in ACP payloads and verdict files are mapped to `Succeeded` / `Failed`. The new `"concern"` value is also recognized. Old configs continue working.

### 2. Step-level retry

When a step fails and `on_failure` permits it, the orchestrator resets the failed step and all transitive downstream dependents to `Pending`, clears their outputs, and re-dispatches. Passed steps are preserved.

**Downstream computation** (`StepDag::downstream_steps(step_name)`): a BFS from the named step through the dependency graph collects all transitive dependents (including the step itself).

**Retry from a Passed step:** the user can manually retry from any step, including passed ones. This is useful when a downstream failure's root cause is upstream. The passed step, its outputs, and all downstream are reset as if it had failed.

**Example** — `synthesize` fails because `review-b`'s output was poor:

```
implement → review-a ──→ synthesize
          → review-b ──→
```

| Step | Before retry | After `retry_from_step("review-b")` |
|---|---|---|
| implement | Passed | **Passed** |
| review-a | Passed | **Passed** |
| review-b | Passed | **Pending** (reset + output cleared) |
| synthesize | Failed | **Pending** (reset + output cleared) |

On re-dispatch, `review-b` runs first (implement still Passed), then `synthesize`. Two steps re-run instead of four.

**Edge case: no downstream.** If the failed step is a leaf, only it resets. One step re-runs instead of the whole pipeline.

### 3. `on_failure` per step

A new field on `StepConfig` controls retry behavior when a step fails:

```yaml
steps:
  - name: implement
    agent: builder
    on_failure: halt          # stop and wait for manual intervention

  - name: review-a
    agent: reviewer
    on_failure: retry_step    # retry just this step (auto)

  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [review-a, review-b]
    on_failure: fixup         # inject fixup agent, then retry
    fixup_agent: fixer
```

| Value | Behavior |
|-------|----------|
| `retry_issue` | Whole-issue retry (existing behavior, the default). Destroys PipelineRun, restarts from scratch. |
| `retry_step` | Step-level retry. Resets failed step + downstream, preserves passed steps. |
| `fixup` | Step-level retry with an injected fixup agent. The fixup step runs before the retried step. |
| `halt` | Stop the pipeline. Do not retry. Wait for manual intervention via API/UI. |

`halt` stops the pipeline entirely — no retry is scheduled. The issue remains claimed and the PipelineRun stays in memory. The user must explicitly retry (via API) or stop the issue.

### 4. Fixup retry

When `on_failure: fixup`, a designated fixup agent is injected into the runtime DAG as a synthetic step between the failed step's dependencies and the failed step itself. The fixup agent receives:

- All dependency outputs from the failed step's dependencies
- The failure reason (`Failed { summary }` text)
- Full workspace access

The fixup step runs as a standard agent step. If it fails, the pipeline halts (no recursive fixup). If it succeeds, the original failed step retries against the patched workspace.

```
implement (Passed) ─────┐
review-a  (Passed) ─────┼── deps ───→ [fixup] → synthesize (retry)
review-b  (Passed) ─────┘
```

The fixup step is runtime-only — it does not appear in `config.yaml` and is not persisted. It uses the agent named in `fixup_agent` on the failed step's config.

### 5. PipelineRun changes

Two new methods on `PipelineRun`:

```rust
/// Reset `step_name` and all transitive downstream dependents to Pending.
/// Clears their outputs from `step_outputs`. Returns the set of reset names.
pub fn retry_from_step(&mut self, step_name: &str) -> HashSet<String>;

/// Same as retry_from_step, plus injects a synthetic fixup step between the
/// reset step's dependencies and the reset step itself. The failed step's
/// `depends` are rewired to `[fixup_step]`.
pub fn retry_from_step_with_fixup(
    &mut self,
    step_name: &str,
    fixup_agent: &str,
) -> HashSet<String>;
```

`retry_from_step` for a step with no downstream resets only that step. For a root step, it resets everything (functionally a whole-issue retry, but without destroying the PipelineRun).

### 6. Orchestrator changes

**In `handle_worker_exit` — Failed path:**

Today:
```rust
state.remove_pipeline_run(issue_id);  // destroys PipelineRun
schedule_failure_retry(...);          // always whole-issue
```

With step-level retry:
```rust
let on_failure = step_on_failure(step_name);
match on_failure {
    OnFailure::RetryStep => {
        run.retry_from_step(step_name);
        // do NOT remove_pipeline_run
        schedule_failure_retry(..., retry_from_step: Some(step_name));
    }
    OnFailure::Fixup => {
        run.retry_from_step_with_fixup(step_name, fixup_agent);
        schedule_failure_retry(..., retry_from_step: Some(step_name), with_fixup: true);
    }
    OnFailure::Halt => {
        // do NOT remove_pipeline_run, do NOT schedule retry
        // issue stays claimed, PipelineRun stays in memory
    }
    OnFailure::RetryIssue => {
        state.remove_pipeline_run(issue_id);
        schedule_failure_retry(...);
    }
}
```

**In `dispatch_issue` — re-dispatch path:**

When retry fires for an issue that still has a PipelineRun (step-level retry didn't remove it), reuse the existing run instead of calling `PipelineRun::new()`:

```rust
if let Some(run) = state.get_pipeline_run(&issue.id) {
    // Reuse existing run (already has retry_from_step applied)
    let action = run.start(); // finds dispatchable steps among the reset states
} else {
    // Fresh dispatch
    let pipeline_run = PipelineRun::new(issue.id.clone(), cycle, dag);
}
```

**`RetryEntry` gains:**

```rust
pub struct RetryEntry {
    // ... existing fields
    pub retry_from_step: Option<String>,  // None = whole-issue
    pub with_fixup: bool,
}
```

**API:** `POST /api/v1/issues/:identifier/retry?step=review-b` for manual step-level retry. Without `?step=`, whole-issue retry (existing behavior).

### 7. Step-level retry + `Concern`

`Concern` does not trigger retry — it is not a failure. The pipeline continues to downstream steps. The `on_failure` config only applies to `Failed` results. If a synthesis step receives `Concern` results from its dependencies and then itself returns `Failed`, the step-level retry logic applies normally.

### 8. `max_cycles` interaction

`max_cycles` still applies to the whole issue. A step-level retry counts as one cycle — the same as a whole-issue retry today. The cycle counter on `PipelineRun` increments on retry regardless of retry type.

---

## Files changed

| File | Change |
|---|---|
| `crates/ensemble-core/src/pipeline/verdict.rs` | Rename Verdict → Result (`Approve` → `Succeeded`, `Reject` → `Failed`, add `Concern`). Update parsers and resolvers. |
| `crates/ensemble-core/src/pipeline/engine.rs` | Add `retry_from_step()`, `retry_from_step_with_fixup()`. Update `step_completed()` to handle `Concern` (continue, not fail). |
| `crates/ensemble-core/src/pipeline/dag.rs` | Add `StepDag::downstream_steps()`. |
| `crates/ensemble-core/src/config/ensemble.rs` | Add `OnFailure` enum and `on_failure` + `fixup_agent` fields to `StepConfig`. |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Route step failures through `on_failure`. Preserve PipelineRun on step-level/halt retries. Handle fixup injection in dispatch. Reuse PipelineRun on re-dispatch. |
| `crates/ensemble-core/src/orchestrator/retry.rs` | Add `retry_from_step` and `with_fixup` to `RetryEntry`. |
| `crates/ensemble-core/src/orchestrator/state.rs` | Update `remove_pipeline_run` call sites. |
| `crates/ensemble-core/src/api/controls.rs` | Add `?step=` parameter to retry endpoint. |
| `crates/ensemble-core/src/agent/` | Propagate `Concern` result type to agent runner and worker result types. |
| `docs/pipelines.md` | Document results, `on_failure`, step-level retry, fixup. |

## Testing

- **Unit:** `PipelineRun::retry_from_step` for leaf, mid-dag, root, and no-downstream cases
- **Unit:** `StepDag::downstream_steps` for linear, parallel, and diamond DAGs
- **Unit:** Verdict parsing of `"concern"` string in ACP payloads and file fallback
- **Unit:** `on_failure` routing in orchestrator (retry_step, fixup, halt, retry_issue)
- **Integration:** End-to-end pipeline with step failure, verifying passed steps preserved on re-dispatch
- **Integration:** Fixup step injection and re-wiring
- **Integration:** `Concern` result flowing through to synthesis step without halting

## Compatibility

- Existing `"approve"` and `"reject"` values in ACP payloads and verdict files continue to parse (mapped to `Succeeded`/`Failed`)
- `on_failure` defaults to `retry_issue` (existing behavior)
- Existing prompt templates continue working (template variables unchanged)
- `max_cycles` behavior unchanged
