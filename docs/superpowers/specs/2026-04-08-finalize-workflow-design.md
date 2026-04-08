# Finalize Workflow as a First-Class Concept

Date: 2026-04-08  
Status: Draft for review

## Goal

Make issue finalization a first-class lifecycle phase after pipeline step success, replacing `push_strategy` with explicit per-repo `finalize` rules that support push/push+PR and optional human approval (UI-only).

## Why

Current behavior conflates pipeline success with workflow completion and only has a generic `push_strategy` knob. We need:

1. A clear post-pipeline "finalize" phase.
2. Per-repo behavior for multi-repo work.
3. Optional human approval that only works in web/desktop UI contexts.
4. Safe headless behavior with explicit startup warnings.

## Scope

In scope:

- Config model changes (`push_strategy` removal, `repos[].finalize` addition)
- Orchestrator/runtime finalization phase and states
- Headless startup warnings for approval-required configs
- Retry behavior for failed finalize operations
- API/UI state contract for finalize status and approval

Out of scope:

- Rich PR templating
- Auto-detection of changed repos beyond current workspace/repo config model
- New tracker integrations specifically for finalize metadata

## Configuration Design

`push_strategy` is removed.

Per-repo config adds a `finalize` block:

```yaml
repos:
  - path: /path/to/repo
    branch: main
    finalize:
      enabled: true                # default true
      mode: push                   # none | push | push_and_pr
      approval_required: false     # default false
```

### Defaults

- `enabled: true`
- `mode: none`
- `approval_required: false`

### Semantics

- `enabled: false` => no finalize action for that repo.
- `mode: none` => no publish/finalize action.
- `mode: push` => push the issue branch.
- `mode: push_and_pr` => push branch, then create/open PR.
- `approval_required: true` => action only executes after explicit UI/app approval.

## Runtime Lifecycle Design

Issue lifecycle is split into two phases:

1. **Pipeline phase**: DAG step execution and verdict collection.
2. **Finalize phase**: per-repo publication actions.

Pipeline success no longer means fully finalized.

### Finalize execution sequence

On pipeline success:

1. Build list of repos requiring finalize (`enabled && mode != none`).
2. For each repo:
   - if `approval_required=true` and UI context exists, mark pending approval.
   - if `approval_required=true` and headless mode, mark skipped headless.
   - otherwise enqueue finalize execution.
3. Execute finalize operations and persist per-repo outcomes.
4. Only mark issue fully completed when all required finalize actions reach successful terminal status.

### Failure semantics

- Finalize failure does **not** rerun pipeline DAG.
- Finalize failure keeps workspace and metadata for retry/recovery.
- Issue remains in a non-complete state until finalize is resolved.

## State Model

Track finalize independently from pipeline:

- `pipeline_status`: `running | succeeded | failed`
- `finalize_status`: `not_required | pending_approval | in_progress | succeeded | failed | skipped_headless`

Per-repo finalize entries include:

- repo identifier/name
- configured mode
- approval required flag
- current status
- last error (if any)
- timestamps

## Headless Approval Policy

If any repo has `approval_required: true` and runtime is headless (`ensemble run` without web/app approval path):

- Emit startup warning naming affected repos.
- Document that finalize actions for those repos will be skipped (`skipped_headless`).
- Continue orchestrator startup (non-fatal), preserving pipeline operation.

This matches the explicit user decision: warn on startup and do not auto-approve.

## API/UI Contract

UI/API should expose finalize as first-class:

- issue-level finalize summary status
- per-repo finalize status rows
- action endpoint for "approve finalize" (UI/app only)
- action endpoint for "retry finalize"

UI behavior:

- Show a Finalize panel when pipeline is succeeded but finalize is pending/failed.
- Show skipped-headless status with explanation when applicable.
- Distinguish "pipeline succeeded" from "workflow finalized".

## Completion Semantics

Issue considered fully complete only when:

- pipeline succeeded, and
- all required finalize actions are in terminal success state
  (`succeeded`, or effectively not required via disabled/none).

If finalize required and unresolved (pending, failed, skipped_headless), issue is not fully complete.

## Migration and Compatibility

- `push_strategy` removed from config schema.
- Old configs containing `push_strategy` fail validation with a direct migration message:
  - explain removal
  - point to `repos[].finalize`
  - include a short mapping table in error/help docs

Suggested mapping guidance:

- `manual` -> `mode: none`
- `auto_push` -> `mode: push`
- `pr_only` -> `mode: push_and_pr`
- `ask` -> `approval_required: true` + mode chosen explicitly

## Testing Strategy

1. Config parse tests for new finalize block defaults and explicit values.
2. Validation tests for removed `push_strategy` and migration guidance text.
3. Orchestrator tests:
   - pipeline success + no finalize required -> complete
   - finalize pending approval -> not complete
   - headless + approval required -> startup warning + skipped status
   - finalize failure -> retryable, no DAG rerun
   - multi-repo mixed outcomes
4. API tests for finalize status/approve/retry endpoints.
5. Integration tests covering push and push+PR paths (mocked where needed).

## Risks and Mitigations

- **User confusion around success state split**  
  Mitigation: explicit pipeline vs finalize status in API/UI.

- **Breaking config change friction**  
  Mitigation: strong validation message and migration mapping.

- **Headless silent non-publication**  
  Mitigation: startup warning plus observable `skipped_headless` state.

## Rollout Notes

- Update docs (`SPEC.md`, configuration docs, examples, init output if needed).
- Add release note callout: breaking config change (`push_strategy` removed).

