# Pipeline run transition journal

**Date:** 2026-06-11
**Issue:** [#195](https://github.com/chrisbanes/ensemble/issues/195)
**Status:** Design

## Context

`PipelineRun` is the per-issue runtime state for step DAG execution. It tracks the current cycle,
step states, step outputs, the resolved runtime DAG, and synthetic fixup steps introduced by
step-level retry. Today that state lives only in `OrchestratorState`.

If Ensemble restarts while a pipeline is halted, awaiting approval, blocked on human input, or
queued for step-level retry, the in-memory `PipelineRun` is lost. The next poll can treat the issue
as fresh work and re-dispatch it from the beginning, wasting completed steps and hiding the actual
reason the pipeline stopped.

The interaction store partially reconstructs `BlockedOnHuman` and `AwaitingApproval`, but it only
stores coarse fields such as `completed_steps`. It cannot restore step outputs, failed-step
summaries, non-passed step states, or runtime DAG mutations such as synthetic fixup steps.

## Goal

- Persist every meaningful pipeline transition as append-only JSONL.
- Include recovery snapshots in transition records so startup does not need fragile event replay.
- Restore paused or retryable pipeline state after orchestrator restart.
- Keep the journal useful for debugging by recording what transition happened and why.
- Release persisted pipeline state when the issue completes, is stopped, or is intentionally
  restarted from scratch.

## Non-goals

- Pure event sourcing where restore depends on replaying every historical delta.
- Persisting process-local worker state such as agent PIDs, live runtime sessions, turn counters, or
  last agent messages.
- Recovering an in-flight agent process after the orchestrator process exits.
- Replacing the interaction store, timeline events, or history store.
- Adding UI log browsing in this change.

## Design

### 1. Storage layout

Add a per-issue JSONL journal under the config state directory:

```text
<config_dir>/state/pipeline-runs/<safe_issue_id>.jsonl
```

`<safe_issue_id>` should be a reversible percent-encoding of the issue ID bytes, leaving only
ASCII letters, digits, `.`, `_`, and `-` unescaped. This avoids collisions without adding a new
dependency and keeps common tracker IDs readable.

Each line is one `PipelineTransitionRecord`. The file is append-only during normal operation. The
implementation may add compaction later, but compaction is not required for issue #195.

### 2. Record format

Each record captures both a transition and, when the pipeline is still recoverable, the full
post-transition snapshot.

```json
{
  "schema_version": 1,
  "seq": 17,
  "kind": "step_completed",
  "issue_id": "NODE_123",
  "identifier": "ENS-42",
  "run_id": "run-1781190000000-1",
  "cycle": 2,
  "step": "review",
  "reason": "review raised concern",
  "snapshot": {
    "issue_id": "NODE_123",
    "cycle": 2,
    "step_states": {},
    "step_outputs": {},
    "dag_steps": [],
    "synthetic_fixup_steps": []
  },
  "written_at": "2026-06-11T12:00:00Z"
}
```

Fields:

- `schema_version`: starts at `1`.
- `seq`: monotonically increasing per journal file. The store reads the last valid record's `seq`
  before append and writes `seq + 1`; if no valid record exists, it writes `1`.
- `kind`: transition kind.
- `issue_id`: tracker issue ID used by `OrchestratorState`.
- `identifier`: human-readable issue identifier used for workspaces and API display.
- `run_id`: optional orchestrator run ID for cross-referencing timeline/history.
- `cycle`: pipeline cycle at the time of the transition.
- `step`: optional step name for step-scoped transitions.
- `reason`: optional human-readable reason for failures, halts, retries, or releases.
- `snapshot`: optional `PipelineRunSnapshot`. Present for recoverable transitions; absent for
  `released`.
- `written_at`: UTC timestamp.

The record is intentionally self-describing. Developers can inspect the JSONL file directly to see
how the pipeline moved through states.

### 3. Transition kinds

Initial transition kinds:

| Kind | Snapshot | Meaning |
|------|----------|---------|
| `run_started` | yes | New `PipelineRun` created. |
| `step_running` | yes | Step marked running and worker dispatch started. |
| `step_completed` | yes | Step returned a successful, failed, or concern result. |
| `step_failed` | yes | Step errored due to worker/runtime failure. |
| `step_blocked_on_human` | yes | Step emitted a blocking human interaction request. |
| `step_awaiting_approval` | yes | Step completed and is waiting at an approval gate. |
| `approval_resolved` | yes | Approval gate was approved or rejected. |
| `step_retry_scheduled` | yes | Failed step and downstream steps were reset for step-level retry. |
| `fixup_retry_scheduled` | yes | Runtime DAG was mutated to insert a synthetic fixup step. |
| `pipeline_halted` | yes | `on_failure: halt` stopped the pipeline for manual intervention. |
| `pipeline_succeeded` | yes | All pipeline steps passed before final release/cleanup. |
| `pipeline_failed` | yes | Pipeline reached final failure before final release/cleanup. |
| `released` | no | This issue must not be restored from earlier snapshots. |

The implementation must cover every listed transition kind that has a corresponding code path in
the current orchestrator. It should not persist high-volume agent telemetry such as output chunks or
token updates.

### 4. Snapshot format

`PipelineRunSnapshot` is the durable form of `PipelineRun`:

```rust
pub struct PipelineRunSnapshot {
    pub issue_id: String,
    pub cycle: u32,
    pub step_states: HashMap<String, StepState>,
    pub step_outputs: HashMap<String, StepOutput>,
    pub dag_steps: Vec<DagStep>,
    pub synthetic_fixup_steps: HashSet<String>,
}
```

The following types need serde support, either directly or through separate persisted DTOs:

- `StepState`
- `StepResult`
- `StepOutput`
- `DagStep`
- `StepDag`

Persisting `dag_steps` matters. Step-level `fixup` mutates the runtime DAG by inserting a synthetic
step and rewiring the failed step to depend on it. Rebuilding only from `config.steps` would lose
that mutation and could dispatch the wrong next step after restart.

`PipelineRun` should expose explicit conversion methods instead of making all internals public:

```rust
impl PipelineRun {
    pub fn to_snapshot(&self) -> PipelineRunSnapshot;
    pub fn from_snapshot(snapshot: PipelineRunSnapshot) -> Result<Self, PipelineError>;
}
```

### 5. Restore behavior

Startup restore happens after config-derived orchestrator state is initialized and before the first
poll tick. It should run before interaction hydration so persisted pipeline state can be the richer
source of truth.

Restore algorithm:

1. Scan `<config_dir>/state/pipeline-runs/*.jsonl`.
2. For each file, read records in order and keep the latest valid record.
3. If the latest valid record is `released`, restore nothing for that issue.
4. If the latest valid record has a snapshot, rebuild `PipelineRun` from that snapshot.
5. Normalize stale `StepState::Running { .. }` values to `StepState::Pending`.
6. Validate the snapshot enough to avoid unsafe restoration:
   - all `step_states` keys exist in the persisted runtime DAG,
   - all `step_outputs` keys exist in the persisted runtime DAG,
   - every dependency in `dag_steps` references another persisted step,
   - configured non-synthetic steps still exist in the current config,
   - configured non-synthetic step agent/kind/dependencies match the current config unless the
     dependency difference is caused by a persisted synthetic fixup rewrite.
7. Insert the run into `state.pipeline_runs` and insert the current config snapshot into
   `state.pipeline_configs`.
8. Ensure the issue remains claimed if the restored state is waiting, halted, or retryable.

Malformed trailing lines are ignored with a warning. Unknown future schema versions are skipped.
If no valid live snapshot remains for a file, the issue is not restored.

### 6. Running step recovery policy

The orchestrator does not try to recover old worker processes. Any `Running` step in a restored
snapshot came from a previous process and is stale.

Normalize stale `Running` steps to `Pending`. This preserves completed upstream work and allows the
same step to be dispatched again when the issue becomes eligible. It is safer than pretending the
old session is still active, and less punitive than marking the step errored solely because the
orchestrator restarted.

### 7. Write points

Append transition records immediately after durable pipeline mutations:

- new pipeline run inserted,
- step marked running,
- step completed and `PipelineRun::step_completed` mutates state,
- step failed via `PipelineRun::step_failed`,
- blocked-on-human state recorded,
- approval interaction bound,
- approval accepted/rejected,
- step-level retry reset applied,
- fixup retry mutation applied,
- halt waiting entry recorded,
- pipeline success/failure decided.

Append `released` records when persisted state must no longer restore:

- successful completion after finalization succeeds or is not required,
- final failure after retries are exhausted,
- terminal tracker reconciliation releases the issue,
- API stop releases the issue,
- manual whole-issue retry intentionally discards the existing pipeline run,
- workspace cleanup/release paths that call `release_claim` for an active issue.

The cleanest implementation is to funnel release writes through orchestrator methods near
`remove_pipeline_run` / `release_claim` call sites rather than hiding async filesystem writes inside
`OrchestratorState`.

### 8. Interaction store integration

The interaction store remains responsible for interaction request/response lifecycle. The pipeline
journal becomes the richer source for `PipelineRun` recovery.

On startup:

- Restore live pipeline runs from the journal first.
- Hydrate waiting interactions second.
- If a waiting interaction exists for an issue with a restored pipeline run, attach/update the
  `WaitingOnHumanEntry` without reconstructing `PipelineRun` from `completed_steps`.
- If no journal snapshot exists, keep the existing coarse reconstruction path as a fallback for
  older state files.

This preserves backward compatibility while fixing the incomplete restore path for new runs.

### 9. Error handling

Journal append failures should be logged as warnings and should not crash the orchestrator. Runtime
work should continue even if persistence is temporarily unavailable.

Restore failures for one issue should not block restoring other issues. The failed issue should be
left un-restored and a warning should include the issue ID, file path, and reason.

The implementation should prefer append-open-write-flush for each record. A partially written final
line after a crash is acceptable because restore skips malformed trailing lines.

### 10. Tests

Unit tests:

- `PipelineRunSnapshot` round-trips `StepState`, `StepOutput`, runtime DAG steps, and synthetic
  fixup steps.
- Stale `Running` steps normalize to `Pending` on restore.
- A `released` record suppresses restoration of earlier snapshots.
- A malformed trailing JSONL line is ignored when an earlier valid record exists.
- Unknown schema versions are skipped.
- Config validation rejects snapshots whose configured steps no longer match the current config.

Orchestrator tests:

- A halted pipeline is restored after creating a fresh orchestrator state.
- An awaiting-approval pipeline restores step output and approval state.
- A blocked-on-human issue with a journal snapshot does not fall back to lossy `completed_steps`
  reconstruction.
- A fixup retry restores the synthetic fixup step and dependency rewrite.
- Whole-issue retry appends `released` and does not restore the old run.
- Successful completion appends `released` and does not restore the old run.

## Deferred work

- Compact long journal files by rewriting the latest live record, if the files become large in
  practice.
- Expose the journal through an API endpoint or UI panel for debugging. This design only writes the
  file.
