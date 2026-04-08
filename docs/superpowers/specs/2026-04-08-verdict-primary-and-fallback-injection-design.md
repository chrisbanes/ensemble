# Runtime-First Verdict Resolution + Automatic Fallback Injection Design

Date: 2026-04-08  
Status: Proposed  
Owner: Ensemble core

## Goal

Ensure verdict handling matches intended architecture (runtime verdict as primary, file fallback second) while removing prompt authoring burden from users.

## Scope

In scope:
- Restore runtime verdict as first-class input to pipeline verdict resolution
- Keep `.ensemble/verdict.json` fallback behavior
- Preserve existing default behavior when no verdict exists (approve)
- Add automatic fallback instruction injection into rendered prompts
- Add observability for verdict source selection

Out of scope:
- Changing verdict semantics (no-verdict remains approve)
- Breaking runtime/file compatibility
- Major protocol redesign beyond current runtime contracts

## Problem Statement

Current behavior is intended to be:
1. Runtime/structured verdict
2. `.ensemble/verdict.json` fallback
3. Default approve

However, the current orchestrator success path resolves verdicts with no runtime verdict payload passed through, which can cause effective reliance on file/default behavior in practice. This also forces users to include verdict-file instructions in prompts manually.

## Design Summary

Implement a two-part fix:

1. **Runtime-first plumbing**: propagate runtime verdict payload from worker completion to orchestrator verdict resolution.
2. **Automatic fallback instruction injection**: append a standard Ensemble-owned verdict-file instruction block during prompt assembly so users do not need to write verdict boilerplate.

Behavioral contract remains:
- runtime verdict (if present and valid) wins
- else file verdict (if present and valid)
- else approve (unchanged)

## Detailed Design

### 1) Verdict Resolution Architecture

- Keep `resolve_verdict(acp_verdict, workspace)` priority unchanged.
- Update worker success data model so completion can carry an optional runtime verdict JSON value.
- Pass that runtime verdict value into `resolve_verdict(Some(...), workspace)` from orchestrator worker-exit handling.
- Maintain compatibility with existing file-based and no-verdict flows.

### 2) Automatic Fallback Instruction Injection

- Inject a standard fallback verdict instruction block at prompt assembly time (after template render, before runtime dispatch).
- This instruction block is owned by Ensemble, not user prompt templates.
- Default config: injection enabled.
- Add advanced escape hatch:
  - `agent.inject_verdict_fallback_instructions: true` (default)

Implementation constraints:
- Idempotent append (avoid duplicate injection)
- Shared across runtime paths so behavior is uniform
- Keep instruction concise and deterministic

### 3) Observability and Safety Rails

Add structured fields on step completion logs:
- `verdict_source`: `runtime | file | default`
- `verdict_value`: `approve | reject`

Additional diagnostics:
- Warn log when runtime verdict is absent and fallback injection is enabled, but no file verdict exists (still resolves to approve).
- Counter/metric by source to validate real-world usage of runtime-first path.

## Data Flow (Post-change)

1. Agent runtime completes turn/step.
2. Worker extracts optional runtime verdict payload (if present).
3. Worker exit event carries `result=Success { runtime_verdict: Option<Value> }`.
4. Orchestrator resolves verdict with:
   - runtime payload first
   - file fallback second
   - default approve last
5. Pipeline engine receives resolved `Verdict` and advances state as today.

## Testing Strategy

1. Runtime verdict beats conflicting file verdict.
2. Missing runtime verdict falls back to file verdict.
3. Missing runtime and file verdict defaults to approve.
4. Prompt injection appends expected fallback block when enabled.
5. Prompt injection does not append block when disabled.
6. Verdict source fields/metrics reflect actual source used.

## Rollout Plan

- Ship with default-on injection and runtime-first wiring.
- No migration required.
- Monitor verdict source counters/logs to confirm runtime verdict path adoption.
- Keep fallback and default behavior for safe backward compatibility.

## Risks and Mitigations

Risk: Runtime verdict extraction varies across runtimes.
- Mitigation: Use optional payload + existing fallback chain.

Risk: Injection text conflicts with highly customized agent prompts.
- Mitigation: Provide opt-out config flag.

Risk: Silent default-approve remains easy to miss.
- Mitigation: add explicit `verdict_source=default` logging and warn path.

## Alternatives Considered

1. **Prompt-only solution** (fallback instructions only): low effort but does not restore intended runtime-primary architecture.
2. **Runtime-only strict verdict** (no fallback): cleaner contract but breaks compatibility and increases operational risk.

Chosen approach keeps intended architecture while minimizing disruption.

## Acceptance Criteria

- Runtime verdict is propagated into orchestrator verdict resolution path.
- Users are not required to include verdict-file instructions in prompt templates.
- No-verdict behavior remains approve.
- Logs/metrics show verdict source per completed step.
- Existing file fallback workflows continue to work unchanged.
