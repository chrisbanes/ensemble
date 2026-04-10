# Hybrid Interactive Orchestration Design

Date: 2026-04-10  
Status: Draft for review

## Goal

Pivot Ensemble from async-only unattended execution to a hybrid model that supports first-class human-in-the-loop interactions, with brainstorming as the primary use case.

## Scope

In scope:
- Issue-scoped interactive pauses for running pipelines
- UI-first response flow (Web UI and Tauri)
- Explicit pause types and resume semantics
- Internal audit trail for prompts and responses

Out of scope:
- Multi-user routing/ownership workflows
- Automatic tracker comments for human responses
- CLI-first response workflow (may be added later)

## Requirements (Validated)

1. Human interaction is required for both approvals/checkpoints and mid-step question answering.
2. Brainstorming pauses are the highest-priority interactive path.
3. Ensemble is primarily single-user.
4. Interactive waiting must be issue-scoped (other issues continue running).
5. Waiting can be indefinite at Ensemble level.
6. Web UI/Tauri app are the primary interaction surfaces.
7. Human responses remain internal to Ensemble by default.

## Architecture

### 1) Runtime State Model

Add explicit per-issue interactive state:
- `WaitingForInput { kind, prompt, requested_at, session_ref, context }`

Pause kinds:
- `BrainstormPrompt`
- `ApprovalGate`
- `ManualDecision`

Behavior:
- Waiting is issue-scoped and does not block orchestrator-wide progress.
- Ensemble does not impose a separate human-input timeout.
- Existing ACP/agent runtime timeouts still apply while a worker call is active.
- Responses are persisted in internal timeline/event history.

### 2) API and Event Contracts

Issue snapshot payload gains `pending_input`:
- `kind`: `brainstorm_prompt | approval_gate | manual_decision`
- `prompt`: string (markdown/plain text)
- `requested_at`: timestamp
- `context`: optional structured fields (step, attempt, agent, etc.)

Submit response endpoint:
- `POST /api/issues/:id/input`
- Body: `{ response: string }`

Validation:
- Accept only when issue is in `WaitingForInput`
- Otherwise return conflict and do not mutate state

Events:
- `input_requested`
- `input_submitted`
- `input_resumed`

Orchestrator boundary:
- API submit only records input + signals resume
- Orchestrator tick performs authoritative transition back to execution

### 3) Web/Tauri UX

Add a dedicated `Needs Input` inbox:
- Shows all issues waiting for input
- Sorted by newest `requested_at`

Issue detail panel includes:
- Prompt body
- Pause kind badge
- Context (step/attempt/agent)
- Response editor and submit action

Actions:
- `Submit` (primary)
- `Defer` (leave waiting)
- `Cancel run` (terminal for this issue)

Flow:
- Submit may show optimistic state
- Issue leaves inbox after orchestrator emits resume confirmation

No automatic tracker writes are performed for prompt/response data.

## Failure Handling and Safety

1. **Late/invalid submit**: conflict response if issue is no longer waiting.
2. **Duplicate submits**: support idempotency (request key or unresolved-prompt guard).
3. **Restart recovery**: pending-input state must survive process restarts via persisted runtime state/timeline.
4. **Cancel while waiting**: transition cleanly to terminal state and clear pending input.
5. **Untrusted content**: treat prompt and response text as untrusted; sanitize rendering and enforce payload size limits.

## Testing Strategy

1. Unit tests for waiting/resume/cancel transitions.
2. API tests:
   - waiting + valid submit success
   - conflict on non-waiting issue
   - duplicate submit safety
3. Integration test:
   - issue A pauses for brainstorm input
   - issue B continues processing
   - submit resumes only issue A
4. UI tests:
   - `Needs Input` inbox visibility and ordering
   - submit/defer/cancel behavior
   - timeline event rendering for input lifecycle

## Rollout Plan

Phase 1:
- Implement core waiting state + submit/resume + inbox for `BrainstormPrompt`

Phase 2:
- Add `ApprovalGate` and `ManualDecision` semantics
- Expand timeline and recovery hardening

Phase 3:
- Optional advanced controls (filters, keyboard flow, optional CLI helper)

## Open Questions

None currently blocking this design.

## Success Criteria

- A running issue can pause for brainstorming input and resume from Web/Tauri.
- Other issues continue unaffected while one issue waits.
- Prompt/response interactions are visible in internal timeline logs.
- Invalid or duplicate submits do not corrupt issue state.
