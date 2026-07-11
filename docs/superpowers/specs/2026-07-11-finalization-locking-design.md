# Finalization Locking Design

## Goal

Prevent enabled finalization from deadlocking the orchestrator while preserving the existing pipeline, tracker, artifact, approval, and retry semantics described in the finalization workflow design.

This design addresses GitHub issue #324.

## Root Cause

`Orchestrator::handle_worker_exit` holds the orchestrator state write guard while handling `PipelineAction::Succeeded`. It then awaits `run_finalize_phase`, which performs workspace and git operations and calls artifact update helpers that acquire the same state write guard. Tokio's `RwLock` is not reentrant, so enabled finalization can wait forever for a guard held by its own task.

The same success branch currently awaits tracker writes while retaining the state guard. Even when those calls do not reenter orchestrator state, they unnecessarily block every other state reader and writer for the duration of external I/O.

Restored-pipeline completion, approval resume, and finalize retry already demonstrate the intended pattern: perform external work without a state guard, acquire the guard briefly to commit outcomes, then release it before tracker and persistence I/O.

## Scope

The change covers initial finalization after a successful pipeline, including successful finalization, finalization failure, pending approval, and skipped-headless outcomes. It also verifies that approval and retry processing terminate without lock inversion.

The change does not redesign the finalization state model, alter completion semantics, or refactor unrelated worker-failure handling.

## Design

### Two-phase successful-exit handling

The `PipelineAction::Succeeded` branch will use two distinct phases.

1. External finalization phase:
   - Copy the issue identifier and any configuration values needed after the current state calculation.
   - Release the existing orchestrator state write guard.
   - Run `run_finalize_phase`.
   - Allow workspace preparation, git/GitHub commands, and the artifact helpers' own short state mutations to finish without an outer state guard.

2. State commit phase:
   - Reacquire the orchestrator state write guard after finalization returns.
   - Build the history record after artifact results have been applied so the record includes finalization output.
   - For `succeeded` or `not_required`, mark the issue completed, release its claim, remove running and pipeline state, and clear transient finalize state.
   - For unresolved or failed finalization, persist the returned finalize state and remove the completed pipeline run while retaining the claim and workspace for approval or retry.
   - Collect tracker, journal, release, and history operations as owned values.
   - Release the state guard before awaiting any of those operations.

The existing `run_finalize_phase` interface and artifact update helpers remain unchanged. Their state guards are limited to synchronous in-memory mutation and no longer nest inside another state guard.

### Tracker updates

The success branch will decide the required tracker transition while committing state:

- `on_success` when finalization succeeded or was not required.
- `on_failure` when finalization failed or was skipped in headless mode.
- No tracker transition while finalization is pending approval.

The tracker write will occur only after the state guard is released. Tracker errors remain best-effort warnings and do not roll back the already-committed orchestrator state, matching the restored-pipeline and finalize-retry paths.

### Approval and retry

Approval and retry API handlers only mutate in-memory state and notify the orchestrator. They do not perform finalization I/O while holding the state guard.

`retry_finalize_for_issue` already follows the required three-step sequence: snapshot retry work under a read guard, perform workspace and git/GitHub I/O without a guard, then commit finalize and artifact outcomes under a short write guard. Tracker writes happen afterward. This path should remain structurally unchanged unless regression testing exposes a separate defect.

## Error Handling

Workspace preparation and git/GitHub failures continue to produce `FinalizeStatus::Failed` with per-repository error details. The state commit phase persists that result and leaves the issue recoverable through the existing retry flow.

Failure to update the tracker remains non-fatal and is logged. The orchestrator must always release its state guard and return from worker-exit handling regardless of finalization or tracker outcome.

## Testing

Add a timeout-based orchestrator regression test that configures at least one enabled repository finalization rule, seeds a successful pipeline and matching artifact state, and invokes `handle_worker_exit` for the final step.

The test must:

- wrap worker-exit handling in `tokio::time::timeout`,
- exercise an enabled finalization path that reaches an artifact update helper,
- fail on the current implementation because the nested state write cannot complete,
- pass after the fix because worker-exit handling returns,
- assert the resulting issue-level and repository-level finalize state or completed state,
- assert the artifact finalization status was updated.

Use a local temporary git repository and workspace fixture so the test does not depend on network access. An approval-required rule is acceptable for the primary deadlock reproduction because it reaches the artifact status helper without requiring a remote push. Existing approval/retry API tests remain in place; add a focused timeout assertion for retry processing only if it can reuse the same fixture without introducing substantial test-only infrastructure.

Run the focused regression test, the `ensemble-core` test suite, formatting, and clippy before completion.

## Documentation Impact

No user-facing documentation changes are required. The finalization workflow documentation already requires finalization to complete or enter a recoverable approval/failure state. This change restores that contract without changing configuration or API behavior.
