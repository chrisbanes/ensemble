# Superpowers Config And Approval Gates Design

## Summary

This design adapts Ensemble's configuration model to better support an Obra Superpowers-style workflow:

- brainstorm
- design
- plan
- implement
- review

The recommended operating model is a single Ensemble pipeline:

- `plan`
- `implement`
- `review`

The `plan` step covers brainstorm, design, and planning internally. It uses a dedicated planner agent, can choose a lightweight path for simple tasks, and can request a manual approval gate before implementation when full planning artifacts are needed.

The key product change is a new generic per-step approval gate in Ensemble. Tracker states remain visible workflow mirrors, but the true orchestration boundary lives in the step DAG and durable approval checkpoint state.

## Problem

The current local config at `/Users/chris/Library/Application Support/ensemble/config.yaml` is a simple two-step pipeline:

- `implement`
- `review`

That works for direct execution, but it does not express the front half of the desired Superpowers process:

- brainstorming
- design
- planning
- human approval before implementation when needed

Trying to model that workflow only with tracker states is fragile:

- tracker states are operator-facing projections rather than orchestration truth
- `todo_file` works differently from future GitHub tracking
- manual state edits do not clearly represent "step complete but downstream dispatch paused pending approval"

The workflow needs an explicit boundary between pipeline steps, not just more tracker labels.

## Goals

- Support a single Ensemble pipeline that matches the desired Superpowers flow.
- Combine brainstorm, design, and planning into one explicit planning step.
- Add a dedicated planner agent with its own prompt and model settings.
- Support a manual approval gate between steps.
- Keep approval logic generic so it can be reused for other workflows.
- Allow lightweight tasks to skip heavyweight planning artifacts and continue directly.
- Keep the design compatible with `todo_file` now and GitHub later.

## Non-Goals

- Adding Obra-specific hardcoding to Ensemble.
- Making tracker state changes the source of truth for approval.
- Requiring every issue to produce a full `SPEC.md` and `PLAN.md`.
- Depending on long-lived interactive sessions that wait for hours outside Ensemble's durable resume model.

## Decision

Add a generic step-level approval gate to Ensemble and rework the local config toward a three-step pipeline:

- `plan`
- `implement`
- `review`

The `plan` step uses a new `planner` agent and may operate in two modes:

1. **Full planning path**
   - produce durable planning artifacts
   - request human approval
   - pause before `implement`

2. **Lightweight path**
   - skip heavyweight artifacts when unnecessary
   - continue directly to `implement`

This keeps the pipeline unified while preserving a real approval checkpoint when appropriate.

## Recommended Config Shape

Conceptual target:

```yaml
tracker:
  kind: todo_file
  path: /Users/chris/ensemble/TODO.md
  active_states:
    - Todo
    - Ready
  terminal_states:
    - Done
    - Failed

repos:
  - path: /Users/chris/dev/ensemble
    branch: main

agents:
  planner:
    acpx_agent: codex
    model: gpt-5.4/high
    prompt_template: templates/plan.liquid

  builder:
    acpx_agent: codex
    model: gpt-5.4/medium
    prompt_template: templates/implement.liquid

  reviewer:
    acpx_agent: opencode
    model: github-copilot/gpt-5.4/xhigh
    prompt_template: templates/review.liquid

steps:
  - name: plan
    agent: planner
    tracker_state: Planning
    approval:
      mode: when_requested_by_agent
      state: Plan Review

  - name: implement
    agent: builder
    depends:
      - plan
    tracker_state: In Progress

  - name: review
    agent: reviewer
    depends:
      - implement
    tracker_state: Review

on_success: Done
on_failure: Failed
```

This YAML is an intended target shape, not a statement that the current product already supports every field shown above.

## Approval Gate Model

Approval should be defined on steps, not inferred from tracker movement.

Conceptual shape:

```yaml
approval:
  mode: when_requested_by_agent
  state: Plan Review
```

Recommended semantics:

- `mode: always`
  - step success always creates a manual approval checkpoint before downstream steps can dispatch

- `mode: when_requested_by_agent`
  - step success creates a manual approval checkpoint only when the agent explicitly asks for it
  - best fit for the `plan` step because some tasks should take the lightweight path

- `state`
  - optional tracker mirror state written when the checkpoint is created
  - visible to operators, but not the source of truth

This should be generic so the same mechanism can later gate:

- `implement -> review`
- `review -> release`
- any other step boundary

## Runtime Semantics

### Step success without approval

If a step succeeds and has no approval gate, or does not request one under `when_requested_by_agent`, downstream steps dispatch as usual.

### Step success with approval

If a step succeeds and triggers approval:

1. mark the step complete
2. persist a pending approval checkpoint
3. optionally write the approval mirror tracker state
4. do not dispatch downstream steps yet
5. wait for explicit human action in Ensemble

### Human actions

Minimum actions:

- **Approve**: continue pipeline execution from the next step
- **Reject**: do not continue; return to a configured rework state or leave awaiting operator intervention

This checkpoint must survive restart just like other human-interaction state.

### Failure semantics

- If the gated step fails, normal pipeline failure behavior applies and no approval checkpoint is created.
- If approval is rejected, the pipeline does not continue automatically.

## Tracker State Model

Recommended state set for the local `todo_file` workflow:

- `Todo`
- `Planning`
- `Plan Review`
- `Ready`
- `In Progress`
- `Review`
- `Done`
- `Failed`

Recommended meanings:

- `Todo`: new work eligible for planning
- `Planning`: planner step currently running
- `Plan Review`: waiting on a human approval gate created after planning
- `Ready`: approved or lightweight-planned work eligible for implementation
- `In Progress`: implementation step running
- `Review`: review step running
- `Done`: pipeline succeeded
- `Failed`: pipeline failed terminally

For dispatch eligibility, prefer keeping active states narrow:

- `Todo`
- `Ready`

This keeps orchestration entry states separate from in-flight mirror states.

## Artifact Model

For full planning tasks, the planner should write:

- `docs/phases/<slug>/SPEC.md`
- `docs/phases/<slug>/PLAN.md`

These become the durable handoff into implementation and review.

For lightweight tasks:

- full artifacts are optional
- the planner may instead leave a concise execution note or simply continue

The implementation and review prompts should treat artifacts as preferred when present, but not required for every task.

## Prompt And Template Responsibilities

### `templates/plan.liquid`

The planner prompt should instruct the agent to:

- follow brainstorm -> design -> plan internally
- use the correct Superpowers skills
- decide whether the task needs full planning or a lightweight path
- write `SPEC.md` and `PLAN.md` when full planning is warranted
- summarize assumptions, approval questions, and intended next steps
- explicitly request approval when human review is needed before implementation

### `templates/implement.liquid`

The implementation prompt should instruct the builder to:

- prefer approved planning artifacts when present
- proceed on lightweight tasks even when no formal artifacts exist
- avoid unnecessary re-planning
- produce durable verification output

### `templates/review.liquid`

The review prompt should instruct the reviewer to:

- review code, artifacts, and verification output
- check alignment with either approved planning artifacts or lightweight task intent
- produce the normal Ensemble verdict output

## Why Step Gates Are Better Than State Gates

Step-level approval gates are the recommended direction because:

- they make workflow policy explicit in the pipeline DAG
- they work the same across `todo_file` and future GitHub tracking
- they align with Ensemble's human-interaction and resume model
- they avoid overloading tracker states with orchestration semantics

State-only gating is a weaker design because it makes approval depend on external state transitions rather than on durable pipeline checkpoints.

## Migration Plan

### Near term

- keep using `todo_file`
- add a planner agent and `templates/plan.liquid`
- update prompts to support full-plan and lightweight paths
- move toward the new state vocabulary

### Product work

- add generic per-step approval gate support to Ensemble config and runtime
- persist step approval checkpoints
- expose approve/reject actions through Ensemble's UI/API

### Later GitHub migration

The same design should carry forward with GitHub project or issue states used only as mirrors:

- `Planning`
- `Plan Review`
- `Ready`
- `In Progress`
- `Review`
- `Done`
- `Failed`

The orchestration truth should remain inside Ensemble rather than in GitHub state movement.

## Open Questions

- What should the config surface for rejection handling be, if any?
- Should approval checkpoints support operator notes in the first version or only approve/reject?
- Should the planner emit a small standard metadata file describing whether it chose full or lightweight planning?

## Recommendation

Adopt the Superpowers workflow through a dedicated `plan` step and implement approval as a generic step-level Ensemble feature.

That gives the user a single pipeline matching the desired process while staying generic, durable, and tracker-agnostic.
