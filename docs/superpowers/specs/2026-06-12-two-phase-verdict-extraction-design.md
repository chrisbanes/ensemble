# Two-phase verdict extraction

**Date:** 2026-06-12
**Issue:** [#184](https://github.com/chrisbanes/ensemble/issues/184)
**Status:** Design

## Context

Ensemble currently lets agent runtimes return an optional structured result. If the runtime result
is missing or unparsable, the orchestrator falls back to `.ensemble/verdict-{step}.json`, then
defaults the step to success. This made early integrations forgiving, but it also allows malformed
or absent verdicts to silently pass.

Agents also have to reason about the task and format the final result in the same turn. That is a
poor fit for review and synthesis steps: schema pressure can reduce reasoning quality, and one bad
JSON shape can turn a useful answer into an unreliable pipeline signal.

Both supported runtime paths can continue a session for another prompt. The direct ACP path already
accepts a vector of prompts. The `acpx` runtime creates a named session, runs one prompt, then closes
it; it can keep that session open for a hidden extraction prompt before closing.

## Problem

1. **Reasoning and formatting are coupled.** Agents must solve the task and produce structured JSON
   in one response.
2. **Bad runtime results are not strict failures.** Invalid runtime payloads can fall through to file
   fallback or default success.
3. **File fallback and default success hide contract bugs.** A missing result should be a runtime
   problem, not an approved step.
4. **Extraction visibility needs a clear boundary.** The second turn is an implementation detail and
   should not appear as agent work in the operator timeline.

## Goal

- Make every successful agent step produce exactly one validated runtime `StepOutput`.
- Split agent execution into a visible working turn and a hidden extraction turn.
- Validate extracted results in Ensemble before the pipeline state machine sees them.
- Retry extraction once with a corrective hidden prompt when validation fails.
- Remove normal runtime dependence on verdict files and default-success resolution.

## Non-Goals

- Preserving legacy `verdict: approve/reject` payloads.
- Preserving `.ensemble/verdict.json` or `.ensemble/verdict-{step}.json` as a normal result path.
- Adding per-agent opt-in controls for two-phase extraction.
- Introducing a separate external extractor service.
- Surfacing extraction messages, chunks, or repair prompts in the user-facing timeline.

---

## Design

### 1. Strict Result Contract

The runtime contract becomes:

```rust
pub struct StepOutput {
    pub result: StepResult,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}
```

Allowed `result` values:

| Value | Meaning |
|-------|---------|
| `succeeded` | Step passed. Pipeline continues. |
| `failed` | Step failed. `summary` is required. |
| `concern` | Step raised a non-blocking concern. `summary` is required. |

`output` remains optional arbitrary JSON for downstream prompts. `summary` is optional only for
`succeeded`.

Legacy `verdict` keys and `approve`/`reject` values are rejected. A successful worker exit without a
valid `StepOutput` is impossible by contract; the worker returns `WorkerResult::Failed` instead.

### 2. Runtime Flow

Each agent-backed step runs these phases in the same runtime session:

1. **Working turn**: the configured prompt is rendered and sent normally. The agent has the same tool
   access, permissions, hooks, and event visibility it has today.
2. **Extraction turn**: Ensemble sends a hidden prompt that includes the working answer and the
   required result schema. Tool use is disabled or denied. Events from this turn are not published to
   the timeline or normal agent state.
3. **Repair turn**: if validation fails, Ensemble sends one hidden corrective prompt containing the
   validation error and the required schema. A second failure makes the worker fail.

The working turn should not be asked to format JSON. Its prompt should make clear that it can answer
freely and that Ensemble will extract the final result separately.

Extraction uses the same session and configured model as the working turn. A future dedicated
extractor model can be added later, but the first implementation keeps extraction in-session so it
has the same conversation context across ACP backends.

### 3. Capturing the Working Answer

Extraction needs the visible answer, not only the original prompt. Runtime adapters should collect
the text emitted by the working turn into an internal buffer while still streaming it to the
timeline.

The extraction prompt receives:

- The step name and issue identifier.
- The original rendered step prompt.
- The visible working answer captured from the first turn.
- The strict `StepOutput` schema and semantic rules.
- A clear instruction to return only the structured result.

If the working answer is empty but the runtime completed successfully, extraction still runs. The
extractor may return `succeeded` only if the answer gives enough evidence; otherwise it should return
`failed` with a summary explaining the missing usable answer.

### 4. Direct ACP Runtime

The direct ACP implementation should replace the plain `Vec<String>` prompt list with turn metadata:

```rust
pub enum TurnVisibility {
    Visible,
    Hidden,
}

pub struct SessionTurn {
    pub prompt: String,
    pub visibility: TurnVisibility,
    pub purpose: TurnPurpose,
}
```

`run_acp_session` keeps the existing session open across all turns. Visible turns emit `AgentEvent`s
as they do today. Hidden turns still update internal usage and diagnostics, but do not send timeline
events or mutate the operator-visible `last_agent_event`.

The final return type should carry a validated `StepOutput`, not an optional raw verdict value.

### 5. `acpx` Runtime

`AcpxRuntime::run_step` should keep the named session open until extraction is complete:

1. `sessions ensure`
2. visible `prompt --session <name>` for the working turn
3. hidden `prompt --session <name>` for extraction
4. optional hidden repair prompt
5. `sessions close`

`AcpxCli::run_prompt` should accept an event visibility setting. For hidden prompts it parses stdout
for runtime verdicts and usage, but suppresses `AgentEvent` emission.

Cancellation still cancels the active `acpx` prompt and closes the session best-effort.

### 6. Validation

Add a dedicated validator in `pipeline/verdict.rs` or a new `pipeline/result_contract.rs` module.
The validator should return either a typed `StepOutput` or a diagnostic suitable for the repair
prompt and worker error.

Validation rules:

- Payload must be a JSON object.
- `result` must be one of `succeeded`, `failed`, or `concern`.
- `failed` and `concern` require a non-empty `summary`.
- `succeeded` may include `summary`, but it is not required.
- `output`, when present, may be any JSON value.
- Unknown top-level keys are errors.
- Legacy `verdict` keys are errors.

The orchestrator should no longer call a resolver that can default to success for normal worker
success. It should receive the validated `StepOutput` directly and pass it to `PipelineRun`.

### 7. Worker and Orchestrator Contract

Change worker success from:

```rust
WorkerResult::Success {
    runtime_verdict: Option<serde_json::Value>,
    approval_request: Option<StepApprovalRequestDraft>,
}
```

to:

```rust
WorkerResult::Success {
    output: StepOutput,
    approval_request: Option<StepApprovalRequestDraft>,
}
```

`approval_request` remains mutually exclusive with human interaction requests. A step that blocks on
human input does not run extraction yet; after the user response resumes the step, the normal visible
turn and extraction contract apply to the resumed run.

The pipeline state machine receives validated data only. Missing or invalid extraction output becomes
`WorkerResult::Failed`, which follows existing agent error retry behavior.

### 8. Removing Fallbacks

Remove prompt injection that tells agents to write `.ensemble/verdict-{step}.json`. Remove normal
runtime reads of verdict files and the default-success path.

Tests may still create `StepOutput` values directly. If a local fixture helper for verdict files
remains useful during transition, keep it test-only and outside the production resolution path.

### 9. Observability

Extraction is hidden from the timeline but should remain debuggable through structured logs:

- `verdict_extraction_started`
- `verdict_extraction_completed`
- `verdict_extraction_repair_started`
- `verdict_extraction_failed`

Include issue id, step name, runtime, validation diagnostics, and token usage when available. Do not
log full hidden prompts by default.

Timeline records should continue to show the visible working answer and the final step result. They
should not show extraction prompt text, extraction output chunks, or repair details.

Hidden-turn token usage counts toward the step and aggregate runtime totals because it is real agent
work. It is not shown as a separate timeline turn.

## Testing Strategy

Unit tests:

- Strict validator accepts valid `succeeded`, `failed`, and `concern` payloads.
- Validator rejects legacy `verdict`, unknown keys, invalid result strings, and missing summaries.
- Extraction prompt builder includes the working answer and schema.
- Hidden turns suppress `AgentEvent` emission while preserving internal verdict capture.

Runtime tests:

- Direct ACP returns `WorkerResult::Success { output }` from the hidden extraction turn.
- Direct ACP runs one repair turn after invalid extraction and succeeds when repair is valid.
- Direct ACP fails the worker after two invalid extraction payloads.
- `acpx` runs visible prompt, hidden extraction prompt, optional repair prompt, then closes the
  session.
- `acpx` hidden prompt output is not emitted to the timeline.

Orchestrator tests:

- Worker success passes validated `StepOutput` directly to `PipelineRun`.
- Worker extraction failure follows existing agent error retry behavior.
- No-runtime-result no longer defaults to success.
- Verdict file artifacts do not affect step outcomes.

Docs tests/checks:

- Update `docs/SPEC.md`, `docs/configuration.md`, and `docs/pipelines.md` to remove fallback/default
  result behavior and document mandatory two-phase extraction.

## Rollout

This is a breaking contract cleanup. No compatibility migration is required.

Implementation should land in small pieces:

1. Add strict validation and extraction prompt construction.
2. Change `WorkerResult::Success` to carry `StepOutput`.
3. Update direct ACP for visible/hidden turn metadata.
4. Update `acpx` to run hidden extraction before closing the session.
5. Remove production verdict-file/default-success resolution.
6. Update docs and tests.

## Risks and Mitigations

Risk: Hidden extraction increases token usage and latency.
- Mitigation: Keep extraction prompt compact and schema-only. Do not include full session logs beyond
  the original prompt and visible working answer.

Risk: Some runtimes cannot truly disable tools for a hidden turn.
- Mitigation: Deny permission callbacks during hidden turns and instruct no tool use. Treat tool
  requests as extraction failure.

Risk: Suppressing hidden events makes failures harder to debug.
- Mitigation: Add structured logs with validation diagnostics and runtime metadata, while keeping
  hidden prompt contents out of normal timeline views.

Risk: Removing default success can reveal existing prompts that never produced real results.
- Mitigation: This is intentional. Failed extraction should retry or fail loudly instead of silently
  approving work.
