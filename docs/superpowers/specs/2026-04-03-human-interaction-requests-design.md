# Human Interaction Requests Design

## Summary

This design adds first-class, tracker-agnostic human-in-the-loop support to Ensemble so autonomous runs can stop for a real human boundary, persist the request, and resume predictably later.

The core idea is that Ensemble should own a durable `InteractionRequest` model rather than relying on ad hoc tracker comments, tracker-specific states, or long-lived agent sessions.

## Problem

Ensemble can already orchestrate around human input by reading tracker changes between runs, but it does not currently own the workflow that:

- records why a run is blocked on a human
- presents the pending request to an operator
- captures the human response in a structured way
- resumes the correct issue and step after the response arrives

That gap makes interactive or review-heavy spec-driven workflows awkward. Today, a team can approximate `Needs Input` or `In Review` through tracker states and issue comments, but those are conventions rather than first-class runtime concepts.

## Goals

- Support human questions, approvals, and handoffs as first-class workflow events.
- Keep the core model tracker-agnostic.
- Preserve autonomous execution until the run reaches a true human boundary.
- Make blocked work resumable without treating it as a failure or a generic retry.
- Provide a small, explicit operator surface in the API and UI.
- Persist pending human work durably across restarts.

## Non-Goals

- Building a live chat experience between the operator and the running agent.
- Requiring trackers to support rich comments, replies, or structured metadata.
- Making GitHub comment threads the source of truth for human interaction state.
- Relying on long-lived ACPX sessions as the core resume mechanism.
- Mandating a single approval or human review policy for all deployments.

## Design Principles

- Ensemble owns interaction lifecycle state.
- Trackers mirror coarse status when possible, but are not the source of truth.
- Human boundaries are neither success nor failure; they are a resumable waiting state.
- Operators should respond through Ensemble's API or UI in the first version.
- Resume behavior should be driven by durable state and re-dispatch, not session continuity.

## Core Model

Introduce a new durable domain object: `InteractionRequest`.

Suggested Rust shapes for v1:

```rust
pub struct InteractionRequest {
    pub id: String,
    pub schema_version: u32,
    pub issue_id: String,
    pub issue_identifier: String,
    pub step_name: String,
    pub agent_name: String,
    pub kind: InteractionKind,
    pub status: InteractionStatus,
    pub blocking: bool,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub artifacts: Vec<String>,
    pub response: Option<InteractionResponse>,
    pub requested_at: String,
    pub resolved_at: Option<String>,
}

pub enum InteractionKind {
    Question,
    Approval,
    Handoff,
}

pub enum InteractionStatus {
    Open,
    Resolved,
    Cancelled,
}

pub enum InteractionResponse {
    Question {
        response_schema_version: u32,
        text: String,
        selected_option: Option<String>,
    },
    Approval {
        response_schema_version: u32,
        approved: bool,
        reason: Option<String>,
    },
    Handoff {
        response_schema_version: u32,
        completed: bool,
        notes: Option<String>,
    },
}
```

Suggested fields:

- `id`
- `issue_id`
- `issue_identifier`
- `step_name`
- `agent_name`
- `kind`
  - `question`
  - `approval`
  - `handoff`
- `status`
  - `open`
  - `resolved`
  - `cancelled`
- `blocking` (bool)
- `title`
- `body`
- `options` (optional list of suggested choices)
- `artifacts` (optional list of related paths or URLs)
- `response` (optional structured payload)
- `requested_at`
- `resolved_at`

Suggested status and payload fields should be versioned from the start so future clients can evolve safely:

- `schema_version` for the interaction record
- `response_schema_version` for the response payload

The model is intentionally generic so one object can cover three common human interaction types:

### Question

Use when the agent cannot continue safely without information.

Expected operator action:

- answer in freeform text
- optionally choose from suggested options

Default resume rule:

- rerun the blocked step with the recorded response in context

Suggested response schema:

```json
{
  "text": "Use the repository setting from the staging environment.",
  "selected_option": "staging"
}
```

### Approval

Use when the workflow needs an explicit human accept or reject decision.

Expected operator action:

- approve
- reject with a reason

Default resume rule:

- approve resumes or unlocks the next step
- reject returns to a rework path defined by workflow policy

Suggested response schema:

```json
{
  "approved": false,
  "reason": "Update the rollout notes before requesting approval again."
}
```

### Handoff

Use when a person must perform an external action that is not best expressed as a simple question.

Examples:

- provide credentials
- confirm rollout timing
- review an artifact outside the repo
- complete an external operational step

Expected operator action:

- mark complete, optionally with notes

Default resume rule:

- rerun or advance according to workflow configuration

Suggested response schema:

```json
{
  "completed": true,
  "notes": "Credentials added to the deployment secret store."
}
```

## Agent Interface

The design needs a concrete way for an agent to ask Ensemble for human input.

Recommended first version:

- use a workspace file contract at `.ensemble/interaction-request.json`
- continue using ACP verdicts for approve or reject only
- treat the interaction request file as the blocked-on-human signal

Recommended file shape:

```json
{
  "schema_version": 1,
  "kind": "question",
  "blocking": true,
  "title": "Choose target environment",
  "body": "The issue does not specify whether this change should target staging or production.",
  "options": ["staging", "production"],
  "artifacts": ["docs/phases/example-feature/SPEC.md"]
}
```

Why this approach for v1:

- works with current workspace-oriented execution model
- avoids needing an ACP protocol extension before the feature can ship
- keeps the contract inspectable and testable
- matches the existing fallback pattern used for verdict files

Agent runner behavior:

1. run agent normally
2. if `.ensemble/interaction-request.json` exists when the step exits, parse it
3. treat the step outcome as `blocked_on_human`
4. persist the corresponding `InteractionRequest`
5. do not also accept an approve or reject verdict for the same step exit

This design does not prevent a later ACP extension for interaction requests. If ACP grows a native request event later, Ensemble can prefer ACP and keep the file as a compatibility fallback.

## Response Injection

The resume path must define exactly how a human response reaches the rerun step.

Recommended first version:

- write the resolved interaction to `.ensemble/interaction-response.json` in the workspace before redispatch
- expose a prompt variable such as `interaction_response`
- do not rely on environment variables as the primary transport

Recommended file shape:

```json
{
  "schema_version": 1,
  "interaction_id": "int_123",
  "kind": "question",
  "response": {
    "text": "Use staging.",
    "selected_option": "staging"
  },
  "resolved_at": "2026-04-03T12:00:00Z"
}
```

Prompt rendering should receive both the issue context and the latest resolved interaction response so the rerun step can reason from durable state rather than session memory.

Why file plus prompt variable:

- file transport is concrete, debuggable, and backend-agnostic
- prompt variables make the response easy to consume without forcing every agent to read files manually
- both survive the disposable-session model

The first version only needs to inject the latest resolved blocking interaction for the rerun step. A later version can add prior interaction history if needed.

## Engine Integration

This feature is additive to the existing pipeline engine. Existing issues and workflows continue to run normally unless a step explicitly emits an interaction request.

The current engine types in `crates/ensemble-core/src/pipeline/engine.rs` need explicit extensions.

Suggested `StepState` addition:

```rust
pub enum StepState {
    Pending,
    Running { session_id: String },
    Passed,
    Rejected { summary: String },
    Failed { error: String },
    BlockedOnHuman { interaction_request_id: String },
}
```

Suggested `PipelineAction` addition:

```rust
pub enum PipelineAction {
    Dispatch(Vec<DispatchRequest>),
    Succeeded,
    Failed { step: String, reason: String },
    BlockedOnHuman {
        step: String,
        interaction_request_id: String,
    },
    Waiting,
}
```

`PipelineRun::step_completed` should gain a blocked path that stores the blocked step state and returns `PipelineAction::BlockedOnHuman` so the orchestrator can persist the interaction, release runtime state, and wait for operator response.

## Execution Outcome

Add a third execution outcome alongside success and failure:

- `completed`
- `failed`
- `blocked_on_human`

`blocked_on_human` means:

- the current step stops cleanly
- the pipeline run is not marked failed
- the issue enters a waiting state inside Ensemble
- an `InteractionRequest` is persisted
- the issue becomes resumable once the interaction is resolved

This avoids overloading failure semantics for expected human review or clarification events.

## Lifecycle

When an agent reaches a human boundary:

1. The agent emits an interaction request.
2. Ensemble persists the `InteractionRequest`.
3. Ensemble records the run as `blocked_on_human`.
4. Ensemble removes the issue from the active running set and places it in a waiting state.
5. Ensemble mirrors tracker state or comments when the adapter supports them.
6. The operator responds through Ensemble.
7. Ensemble resolves the interaction and marks the issue eligible for resume.
8. Ensemble re-dispatches the same issue and blocked step with the human response available in context.

Important behavior:

- blocked work is resumable, not failed
- human response should not create a brand new logical issue
- the same issue remains the unit of record

## Multiple Interactions Per Issue

The first version should allow at most one open blocking interaction per issue.

That rule keeps resume semantics simple:

- one issue
- one blocked step
- one open blocking interaction
- one resume decision

Non-blocking interactions may be added later, but they should not delay the first version. If non-blocking interactions are introduced later, they should be treated as informational operator tasks that do not pause execution and should appear in a separate queue treatment from blocking requests.

If an agent attempts to emit a second blocking interaction while one is already open for the issue, Ensemble should reject the new request and treat that step exit as an error until the existing interaction is resolved or cancelled.

## Persistence

Pending interactions must survive process restarts.

Recommended v1 storage:

- JSON files under `<config_dir>/state/interactions/`
- one file per interaction request, keyed by interaction ID
- an optional small index file can be added later if listing performance becomes a problem

Recommended example paths:

- `<config_dir>/state/interactions/int_123.json`
- `<config_dir>/state/interactions/int_124.json`

Minimum persisted state:

- the `InteractionRequest` record
- current interaction status
- response payload
- timestamps
- associated issue and step
- whether the issue is resumable

In-memory state alone is not sufficient because restart would otherwise lose the human work queue. Tracker mirroring is also not sufficient because some trackers cannot preserve structured interaction data.

JSON files are the recommended first version because they match Ensemble's existing file-oriented design, avoid introducing a database dependency just for this feature, and remain easy to inspect during debugging. SQLite can remain a future optimization if interaction volume or query needs grow.

## Orchestrator Behavior

The orchestrator should gain explicit support for blocked-on-human runs.

Required behavior:

- accept a blocked outcome from the agent runner
- persist the interaction request and response lifecycle
- keep the pipeline run associated with the blocked step
- mark the issue as waiting on human interaction instead of failed or retrying
- requeue the same issue after resolution

Concurrency behavior must be explicit:

- a blocked issue is removed from `running`
- a blocked issue releases its active agent concurrency slot immediately
- the issue should remain claimed in a dedicated waiting-on-human set rather than the running set
- the issue should not count against `max_concurrent_agents` while waiting for human response

This matches the current orchestrator shape in `OrchestratorState`, where active concurrency is derived from `running`, and keeps blocked work from consuming execution capacity.

The first version should prefer explicit resume over automatic resume. That keeps operator intent visible and avoids surprising redispatch after partial or accidental responses.

Resume-time validation should confirm that the blocked step still exists in the current resolved DAG and still references a valid agent definition. Storing `step_name` is acceptable if resume performs this validation before redispatch.

If the workflow changed while the issue was waiting:

- missing step -> keep the interaction resolved but mark the issue as needing operator attention
- missing agent definition -> same behavior
- incompatible DAG change -> require operator review before redispatch

This keeps the first version compatible with the existing named-step model without inventing a new step identifier system prematurely.

## Error Model

Introduce an `InteractionError` type for API and orchestrator operations.

Suggested cases:

- `NotFound`
- `AlreadyResolved`
- `AlreadyCancelled`
- `InvalidResponse`
- `ConcurrentModification`
- `ResumeConflict`
- `MissingWorkspace`
- `StepNoLongerExists`
- `AgentNoLongerExists`

Expected behaviors:

- answering an already-resolved request -> `409 Conflict`
- two operators responding concurrently -> first wins, second gets `409 Conflict`
- resume requested after workspace cleanup -> recreate workspace if possible, otherwise return `409 Conflict` with `missing_workspace`
- invalid response payload for the interaction kind -> `400 Bad Request`

The API should use the existing `ApiError` response style with stable machine-readable error codes.

## Configuration

This feature should be additive and mostly zero-config in the first version.

Recommended v1 config additions:

```yaml
human_interaction:
  enabled: true
  default_resume_mode: manual
```

Suggested semantics:

- `enabled` controls whether blocked-on-human handling is allowed
- `default_resume_mode` supports `manual` in v1, leaving room for future `automatic`

The first version should not add step-level approval policy, max pending interaction limits, or blocked-issue cycle consumption settings until there is a concrete use case. Blocked-on-human waits should not consume `max_cycles`, because they are neither failures nor retries.

## Tracker Integration

Tracker integration should be best-effort projection.

Ensemble owns:

- pending interactions
- responses
- resume eligibility
- source-of-truth lifecycle

Trackers may mirror:

- coarse state like `Needs Input` or `In Review`
- a human-readable summary comment

Support tiers:

### Full mirror

Tracker supports state writes and comments.

Example behavior:

- move issue to `Needs Input`
- add a comment summarizing the request and where to respond

### State-only mirror

Tracker supports state writes but not comments.

Example behavior:

- move issue to `Needs Input`
- rely on Ensemble UI for full detail

### No-write mode

Tracker does not support writes.

Example behavior:

- no tracker mutation occurs
- Ensemble UI and API still expose the pending interaction queue

For the first version, Ensemble should not attempt to read tracker replies back into the interaction system. Operators should respond through Ensemble directly.

Tracker mirroring is one-way only in v1:

- Ensemble may write a state change or summary comment outward
- Ensemble does not ingest tracker-side human replies back into the structured interaction record
- the authoritative human response must arrive through Ensemble's own API or UI

Timeouts and SLAs should remain policy-level metadata in the first version rather than hard orchestration deadlines. The product should record age and timestamps so operators can identify stale interactions, but it does not need automatic expiration before teams have agreed on policy.

## API and UI

The first operator surface should stay small.

API capabilities:

- list open interactions
- get interaction details for an issue
- answer a question
- approve or reject an approval request
- mark a handoff complete
- mark an issue resumable

Recommended v1 HTTP endpoints:

- `GET /api/v1/interactions`
  - query params: `status`, `issue`, `kind`
  - returns list of interaction summaries
- `GET /api/v1/interactions/{id}`
  - returns the full interaction record
- `POST /api/v1/interactions/{id}/respond`
  - request body depends on interaction kind
  - resolves the interaction when valid
- `POST /api/v1/interactions/{id}/cancel`
  - cancels the interaction
- `POST /api/v1/issues/{identifier}/resume`
  - re-enqueues a resolved blocked issue for redispatch

Recommended status codes:

- `200 OK` on successful read or response
- `400 Bad Request` for invalid response payloads
- `404 Not Found` for unknown interactions or issues
- `409 Conflict` for already-resolved interactions, concurrent response races, or invalid resume state

UI capabilities:

- a queue of open interactions
- issue detail panel showing the interaction body and related artifacts
- response controls based on interaction kind
- explicit resume action for resolved issues

Suggested queue columns:

- issue
- kind
- title
- blocking
- step
- age
- status

Queue treatment should distinguish blocking from any future non-blocking interactions so operator attention goes first to work that prevents resume.

## Resume Model

Resume should be based on durable state and re-dispatch, not on long-lived agent session continuity.

The design intentionally does not rely on persistent ACPX sessions because:

- blocked states may last minutes, hours, or days
- sessions may die across restarts or agent crashes
- different agent backends may have different continuity behavior

If persistent session reuse is ever added later, it should be a best-effort optimization only. The core design should treat agent sessions as disposable.

## Guidance for Operators

This feature does not make interactive clarification loops the default operating model. Operators should still prefer prepared, execution-ready work:

- provide durable artifacts and explicit success criteria up front
- separate planning from execution
- use `Needs Input` only for real ambiguity or external dependency gaps
- use `In Review` for explicit approval boundaries
- avoid dispatching issues that depend on repeated live conversation

In short, Ensemble should support human input well, but it should still optimize for prepared work rather than live chat.

## Trade-Offs

### Advantages

- portable core model across trackers
- clean separation between orchestration state and tracker projection
- better support for spec-driven and review-heavy workflows
- explicit operator queue instead of scattered comments and conventions

### Costs

- new persistence and API surface area
- new UI state and queue design
- tracker mirrors may be lossy compared to the source-of-truth interaction model
- some workflow prompts will need to learn how to emit blocked interaction requests

## Open Questions

- Should resume be explicit-only in the first version, or configurable per workflow?
- How should approval rejection map back into workflow-specific rework states?
- Should step prompts receive prior interaction history, or only the latest resolved response?

## Status Semantics

The interaction statuses should be interpreted as follows:

- `open` -> waiting on a human response
- `resolved` -> the response has been recorded and the issue is eligible for resume or advancement according to interaction kind
- `cancelled` -> operator or administrator intentionally aborted the interaction without normal resolution

`cancelled` is distinct from a negative approval response:

- approval rejection lives inside the `InteractionResponse::Approval { approved: false, ... }` payload
- `cancelled` is an operational abort that can apply to any interaction kind

## Recommendation

Add a tracker-agnostic `InteractionRequest` model, a resumable `blocked_on_human` execution outcome, durable local persistence, and a small UI/API surface for operators. Keep trackers as optional mirrors and do not rely on long-lived ACPX sessions.
