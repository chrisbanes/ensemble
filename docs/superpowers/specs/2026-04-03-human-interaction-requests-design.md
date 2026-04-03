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
  - `answered`
  - `approved`
  - `rejected`
  - `completed`
  - `cancelled`
- `blocking` (bool)
- `title`
- `body`
- `options` (optional list of suggested choices)
- `artifacts` (optional list of related paths or URLs)
- `response` (optional structured payload)
- `requested_at`
- `resolved_at`

The model is intentionally generic so one object can cover three common human interaction types:

### Question

Use when the agent cannot continue safely without information.

Expected operator action:

- answer in freeform text
- optionally choose from suggested options

Default resume rule:

- rerun the blocked step with the recorded response in context

### Approval

Use when the workflow needs an explicit human accept or reject decision.

Expected operator action:

- approve
- reject with a reason

Default resume rule:

- approve resumes or unlocks the next step
- reject returns to a rework path defined by workflow policy

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

## Persistence

Pending interactions must survive process restarts.

Minimum persisted state:

- the `InteractionRequest` record
- current interaction status
- response payload
- timestamps
- associated issue and step
- whether the issue is resumable

In-memory state alone is not sufficient because restart would otherwise lose the human work queue. Tracker mirroring is also not sufficient because some trackers cannot preserve structured interaction data.

## Orchestrator Behavior

The orchestrator should gain explicit support for blocked-on-human runs.

Required behavior:

- accept a blocked outcome from the agent runner
- persist the interaction request and response lifecycle
- keep the pipeline run associated with the blocked step
- mark the issue as waiting on human interaction instead of failed or retrying
- requeue the same issue after resolution

The first version should prefer explicit resume over automatic resume. That keeps operator intent visible and avoids surprising redispatch after partial or accidental responses.

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

## API and UI

The first operator surface should stay small.

API capabilities:

- list open interactions
- get interaction details for an issue
- answer a question
- approve or reject an approval request
- mark a handoff complete
- mark an issue resumable

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

- What is the minimal durable storage format for interaction records?
- Should resume be explicit-only in the first version, or configurable per workflow?
- How should approval rejection map back into workflow-specific rework states?
- Should step prompts receive prior interaction history, or only the latest resolved response?

## Recommendation

Add a tracker-agnostic `InteractionRequest` model, a resumable `blocked_on_human` execution outcome, durable local persistence, and a small UI/API surface for operators. Keep trackers as optional mirrors and do not rely on long-lived ACPX sessions.
