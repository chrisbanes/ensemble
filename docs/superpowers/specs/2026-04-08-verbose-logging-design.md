# Verbose Logging Design for Ensemble

Date: 2026-04-08
Status: Proposed
Owner: Ensemble core

## Goal

Improve Ensemble debugging by making logs easier to correlate end-to-end while allowing operators to opt into deeper verbosity (`debug`/`trace`) without overwhelming normal `info` runs.

## Scope

In scope:
- Logging taxonomy (stable event names)
- Correlation field contract
- Span strategy across orchestrator/pipeline/agent/workspace
- Level-based verbosity strategy (`info` vs `debug` vs `trace`)
- Redaction/truncation rules for sensitive/high-volume payloads
- Validation approach (tests + runbook checks)

Out of scope:
- Metrics backend changes
- New log shipping infrastructure
- UI log viewer changes

## Problem Statement

Ensemble already emits many `tracing` logs, but debugging complex failures is still costly because:
- Event naming is not fully standardized
- Correlation fields are inconsistent between modules
- High-signal lifecycle events are mixed with ad-hoc detail
- Deep internals are available in some places but not with consistent guardrails

## Design Summary

Use a combined strategy:
1. **Correlation-first logging contract**: every lifecycle event uses stable `event` names and consistent context fields.
2. **Tiered verbosity**: keep `info` concise for normal operations; add decision-level `debug`; reserve protocol/command internals for `trace` with redaction.

This yields predictable, query-friendly logs for routine debugging and deeper diagnostics when needed.

## Logging Contract

### 1) Event taxonomy

Define stable `event` names for key flows.

Orchestrator:
- `orchestrator.tick_started`
- `orchestrator.tick_finished`
- `issue.dispatch_started`
- `issue.dispatch_skipped`
- `issue.dispatch_completed`
- `issue.retry_scheduled`
- `issue.retry_cancelled`

Pipeline:
- `step.started`
- `step.waiting`
- `step.finished`

Tracker:
- `tracker.transition_requested`
- `tracker.transition_succeeded`
- `tracker.transition_failed`

Workspace:
- `workspace.prepare_started`
- `workspace.prepare_finished`
- `workspace.prepare_failed`
- `workspace.hook_started`
- `workspace.hook_finished`
- `workspace.hook_failed`

Agent:
- `agent.session_started`
- `agent.session_finished`
- `agent.session_failed`
- `agent.message` (debug/trace only)

### 2) Required structured fields

Required on all lifecycle logs where applicable:
- `event`
- `run_id`
- `issue_id`
- `issue_identifier`
- `cycle` (or attempt index)
- `step`
- `agent`
- `duration_ms` (for start/finish pairs)
- `reason` (for skip/failure decisions)

Optional contextual fields:
- `workspace_path`
- `branch`
- `tracker_state_from`, `tracker_state_to`
- `command` (workspace/git/acpx boundary logs)
- `exit_code`

## Span Architecture

Use nested spans to avoid repeated field wiring and improve automatic context propagation:

1. **Run root span**
   - Fields: `run_id`, `mode` (`run`/`web`/`desktop`)
2. **Issue span**
   - Fields: `issue_id`, `issue_identifier`, `cycle`
3. **Step span**
   - Fields: `step`, `agent`
4. **Workspace span** (optional)
   - Fields: `workspace_path`, `branch`

All logs emitted inside a span inherit parent context, keeping events compact and queryable.

## Verbosity Levels

### `info` (default operator mode)
Log only lifecycle milestones and major outcomes:
- Dispatch start/skip/complete
- Step start/finish
- Tracker transition request/result
- Workspace prepare/hook failures and key milestones
- Agent session start/finish/failure

### `debug`
Add decision traces and richer context:
- Why an issue was skipped/dispatched/retried
- DAG readiness checks (`waiting` causes)
- Retry backoff calculations
- Tracker adapter request intent metadata (not full payloads)

### `trace`
Add deep protocol/process internals:
- ACP boundary envelope metadata (type/count/size)
- Git/worktree command boundaries and summarized stderr
- Hook command timing and exit details

## Redaction and Data Hygiene

Never log by default:
- Prompt bodies
- Secrets/tokens
- Raw credentials
- Full ACP payload content containing user/code content

Allowed in debug/trace:
- Metadata only (message type, byte length, counts)
- Truncated stderr/stdout summaries when needed

Redaction rules should be centralized and reused to prevent drift.

## Implementation Phases

### Phase 1: Foundation
- Document taxonomy + required fields in core observability module docs.
- Add helper functions/macros for standard events and start/finish timing.
- Generate and attach `run_id` at orchestrator startup.

### Phase 2: High-value instrumentation
- Instrument orchestrator dispatch/retry/skip reasoning.
- Instrument pipeline transitions with durations.
- Instrument tracker transition request/result pairs.
- Instrument workspace prepare + hooks with durations and outcomes.

### Phase 3: Deep-debug expansion
- Add trace-level ACP boundary metadata logs.
- Add trace-level git/worktree/hook command boundary logs with truncation.

## Error Handling Considerations

- Logging helper failures must never fail runtime behavior.
- If helper formatting fails, fallback logs should preserve core fields (`event`, `run_id`, `issue_id`).
- Invalid log env configuration continues current behavior (warn and fallback to default filter).

## Testing Strategy

1. Unit tests for helper functions/macros:
   - Correct event names
   - Required field presence
   - Duration emission for start/finish pairs
2. Integration-level smoke checks:
   - `ENSEMBLE_LOG=info` produces concise lifecycle logs
   - `ENSEMBLE_LOG=debug` adds decision detail without secrets
3. Manual runbook verification:
   - Trace a single issue end-to-end by `run_id + issue_id`
   - Confirm predictable searchability by `event`

## Rollout / Compatibility

- Backward-compatible with existing `ENSEMBLE_LOG` and `RUST_LOG` usage.
- Incremental migration: legacy logs can coexist until modules are converted.
- No tracker contract changes required.

## Open Questions

- Should `trace` ACP metadata be gated behind a dedicated opt-in env var in addition to level?
- Should we emit a canonical `correlation_id` alias in addition to `run_id` for external log pipelines?

## Recommendation

Adopt this design as the logging baseline, then execute Phase 1 and Phase 2 first for immediate debugging gains. Phase 3 follows once redaction helpers are finalized.
