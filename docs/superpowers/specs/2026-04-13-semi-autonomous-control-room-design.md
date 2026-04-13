# Semi-Autonomous Control Room Design

Date: 2026-04-13  
Status: Draft for review

## Goal

Pivot Ensemble from a primarily autonomous issue-runner into a semi-autonomous control room that still executes declarative multi-agent workflows, but lets humans step into any running workflow when an agent needs help.

## Scope

In scope:
- Keep ticket-based multi-agent workflows as the product backbone
- Make step execution interruptible and resumable for human input
- Make the web UI's primary surface a control room for supervision
- Introduce first-class agent questions and human replies in runtime state
- Treat external trackers and boards as optional ticket sources/sinks rather than required runtime authorities

Out of scope:
- Multi-user ownership, assignment, and routing workflows
- Automatic detection of confused or looping agents for MVP
- Rich collaborative task-planning UI beyond the control-room and ticket detail surfaces
- Replacing `config.yaml` workflow definition with fully dynamic UI-authored workflows

## Requirements (Validated)

1. Ensemble must still support a defined workflow of agents.
2. The primary operating surface should be a control room, not a board view.
3. The most important human intervention is clicking into an agent and answering its question.
4. The most important context on entry is the exact question the agent is asking.
5. MVP should stay simple and prefer explicit agent asks over inferred stuckness.
6. Tickets remain the canonical unit of work.
7. External systems like GitHub may provide tickets, but should not be required to model live execution.
8. Workflow definition remains declarative; human replies should change runtime state, not workflow policy.

## Product Model

Ensemble should be framed as:

> Ensemble runs agent workflows for tickets, and humans can step into any workflow when an agent needs help.

This preserves the existing strengths of the project:
- ticket-scoped workspaces
- declarative agent workflows
- orchestrated multi-step execution

But changes the operating assumption from:
- a step runs unattended until verdict

to:
- a step may pause for a human, then resume within the same workflow run

## Canonical Entities

Ensemble should treat these as first-class concepts:
- `Ticket` — canonical unit of work
- `Workflow` — declarative definition of agents and step ordering
- `WorkflowRun` — execution of a workflow for a ticket
- `StepRun` — runtime state for a single workflow step
- `AgentSession` — live execution/conversation context for one agent invocation
- `AgentAsk` — structured request for human input
- `HumanReply` — response attached to the same runtime thread/session

External systems may still map into `Ticket`, but they should no longer define the runtime model.

## Architecture

### 1) Workflow Backbone Stays Declarative

`config.yaml` should continue to define stable policy:
- agents
- prompts/templates
- step DAG / dependencies
- retry, timeout, and concurrency policy
- optional integration mappings

This avoids turning workflow authoring into an ad hoc runtime concern.

### 2) Runtime Execution Becomes Interactive

A step should no longer be modeled as only:
- launch agent
- wait
- read verdict

Instead, a step becomes a small runtime state machine:
- `pending`
- `running`
- `waiting_on_dependency`
- `waiting_for_human`
- `paused`
- `completed`
- `failed`

The key addition is `waiting_for_human`, which is a valid non-terminal execution state rather than a failure mode.

### 3) Agent Questions Become First-Class Events

A running agent session should be able to emit events such as:
- `progress_updated`
- `question_asked`
- `human_replied`
- `paused`
- `resumed`
- `completed`
- `failed`

For MVP, `question_asked` should carry a lightweight structured payload:
- `question` — required
- `why_blocked` — required
- `suggested_answer` — optional
- `extra_context` — optional

This keeps the top-level UI easy to scan while preserving room for richer context later.

### 4) Orchestrator Behavior

When an agent emits `question_asked`, the orchestrator should:
1. Mark the current `StepRun` as `waiting_for_human`
2. Persist the ask in runtime state
3. Surface the ticket/session in the control-room attention queue
4. Preserve the active session/thread context
5. Block downstream dependent steps for that workflow run
6. Resume the same step when a `HumanReply` arrives

Human input should be treated as a valid workflow dependency, not an exception path.

### 5) Persistent Runtime Store

This design pushes Ensemble toward a clear split between config and durable runtime state.

Persistent runtime state should hold:
- tickets
- workflow runs
- step runs
- agent sessions
- asks and replies
- event timeline
- UI-facing attention queue projections
- artifacts, logs, and optional summaries

Without this split, human-in-the-loop collaboration will be smeared across in-memory orchestrator state and external tracker state, which will get brittle quickly.

## UI Design

### 1) Primary Surface: Control Room

The web UI home screen should become a supervision-oriented control room.

Primary buckets:
- `Needs attention`
- `Running normally`
- `Completed / failed`

`Needs attention` is the most important bucket and should rise above pure status reporting.

### 2) Question-First Ticket Detail

When a user clicks into a waiting ticket/agent, the top of the screen should show:
- the exact question
- why the agent is blocked
- a reply box

Secondary sections may sit below or behind disclosure:
- transcript
- logs
- files/diff
- checks
- workflow context
- prior asks/replies

The page should answer one question immediately:

> What does the agent need from me right now?

### 3) Workflow Context Still Visible

Even though the UI is question-first, the ticket detail view should still show where the question sits inside the broader workflow:
- active step name
- agent name
- upstream/downstream steps
- what happens after the answer is given

This keeps the control room grounded in workflow execution rather than drifting into a pure chat product.

## Tickets, Trackers, and Boards

The canonical unit of work remains the `Ticket`.

However, task boards and external trackers should move from being the core product model to being optional integrations.

Recommended framing:
- external systems can create/import tickets
- Ensemble owns live execution state for those tickets
- Ensemble may optionally mirror status or comments back out

This means boards like GitHub Projects are no longer required to understand or operate Ensemble effectively.

## Configuration vs Runtime State

### Keep in `config.yaml` (policy)
- agents
- workflow steps and dependencies
- prompt templates
- execution policy
- workspace/repo setup
- integration configuration

### Keep in runtime state (execution)
- ticket metadata and provenance
- current workflow run state
- current step state
- session/thread state
- asks and replies
- timeline, artifacts, logs
- attention queue state

Human replies must mutate runtime state only. They should not rewrite workflow definition.

## MVP Design

The first version should stay intentionally narrow:
- explicit agent asks only
- one active ask per step/session
- reply in the same session/thread
- no automatic stuckness detection yet
- simple control-room attention queue
- ticket detail optimized around the current question

This keeps the product focused on the core loop:
- an agent needs help
- the human sees the question
- the human answers
- the workflow resumes

## Rollout Plan

Phase 1:
- Add first-class `waiting_for_human` step state
- Add `question_asked` and `human_replied` runtime events
- Add control-room `Needs attention` queue
- Add question-first ticket detail with reply flow

Phase 2:
- Persist richer session/thread history and summaries
- Add clearer workflow context in ticket detail
- Add optional status mirroring back to external ticket systems

Phase 3:
- Add richer pause types, triage features, and optional heuristics for probable stuckness
- Explore native Ensemble ticket creation/editing independent of external systems

## Success Criteria

- Ensemble still runs declarative multi-agent workflows for tickets.
- A step can pause for human input without being treated as failed.
- The web UI is centered around a control room and an attention queue.
- Clicking a waiting ticket shows the exact agent question first.
- A human can answer in-place and resume the same step/session.
- External boards are optional integrations rather than required runtime authorities.

## Open Questions

1. Whether native ticket creation should be in the initial product pivot or deferred until after tracker-backed tickets are stable.
2. How much workflow editing, if any, should eventually move into the UI versus staying in `config.yaml`.
