# GSD-Style Workflow With Ensemble

## Who This Is For

This workflow is for teams using GitHub issues as the human-facing planning surface and Ensemble as the issue executor. It is useful when you want GSD-style planning and wave-based execution without forking GSD and without teaching Ensemble any GSD-specific concepts.

## What Ensemble Does And Does Not Know

Ensemble remains a generic orchestrator. It knows how to poll eligible issues, create isolated workspaces, run agents, and write tracker updates that its runtime supports.

Ensemble does not natively understand:

- planning issues versus execution issues
- wave graphs or dependency promotion rules
- issue creation on your behalf
- GSD-specific commands or artifacts

Those behaviors come from your board rules, issue templates, and agent prompts.

## Parent Issue Workflow

The parent issue is the planning container for the whole feature.

Recommended lifecycle:

- `Draft` - initial human request
- `Planning` - agent is writing or revising artifacts
- `Plan Review` - artifacts are ready for approval
- `Planned` - approved and ready to release waves
- `Done` - all child waves are complete

The planning agent should produce durable artifacts at:

- `docs/phases/<parent-or-feature-slug>/SPEC.md`
- `docs/phases/<parent-or-feature-slug>/PLAN.md`

Those approved artifacts must be committed or merged before any child wave issue is moved to `Ready`.

After approval, the planning agent creates one child issue per wave and updates the parent issue with a wave summary table plus links to every generated child issue.

Example wave summary table:

| Wave | Goal | Status | Issue |
|---|---|---|---|
| 1 | Write docs and templates | Ready | `#123` |
| 2 | Validate workflow on a real feature | Planned | `#124` |

## Wave Issue Workflow

Each child issue is an execution container for one approved wave.

Required fields:

- parent reference
- wave number and goal
- dependencies
- included tasks
- success criteria
- spec link
- plan link
- expected verification artifact path

Best-effort execution metadata:

- verification link
- branch
- workspace
- last run timestamp
- attempt count
- latest verdict
- PR link
- blocker summary

Best-effort metadata should be left blank or omitted when the runtime cannot maintain it reliably.

The execution agent should read the linked artifacts, execute only the current wave, and keep the issue summary compact. Detailed progress belongs in repo artifacts, especially the per-wave verification file.

## Branch Strategy

The recommended default is one branch per wave created from `main`.

This keeps each wave independently reviewable and matches the rule that dependency waves must already be complete and available on `main` before later waves become executable.

## Board States

Use one shared GitHub status field.

Parent issue states:

- `Draft`
- `Planning`
- `Plan Review`
- `Planned`
- `Done`

Child wave states:

- `Planned`
- `Ready`
- `In Progress`
- `Needs Input`
- `In Review`
- `Done`

`Ready` is the only state Ensemble should treat as executable.

Multiple wave issues may be `Ready` at the same time when their dependency sets are fully satisfied.

## Required Agent Capabilities

The agent runtime should provide:

- git access
- tracker write access through `gh`, MCP, or an equivalent tool
- permission to edit repo docs and issue bodies/comments

## Recommended Artifacts

Use durable docs under one feature-specific directory:

- `docs/phases/<parent-or-feature-slug>/SPEC.md`
- `docs/phases/<parent-or-feature-slug>/PLAN.md`
- `docs/phases/<parent-or-feature-slug>/verification/WAVE-<n>.md`
- optional `docs/phases/<parent-or-feature-slug>/HANDOFF.md`

This keeps detailed decomposition and verification in git while leaving tracker issues as operational summaries.

## Failure And Review Handling

Use the same wave issue for retries, review cycles, and ambiguity handling.

- low-confidence execution moves to `Needs Input`
- review-required work moves to `In Review`
- review rejection returns the same wave issue to `Ready`
- transient failures stay on the same wave issue and update retry metadata

If tracker state writes are unavailable, record the intended next state in the issue comment or verification artifact instead of silently dropping it.

## Guidance For Spec-Driven Workflows

Most SDD-style workflows can work with Ensemble if you import their discipline rather than their interaction model.

The practical rule is:

- convert conversations into durable artifacts
- convert approvals into explicit tracker or workflow gates
- convert open-ended collaboration into bounded handoffs

In practice, that means:

- planning work writes or updates `SPEC.md` and `PLAN.md`
- execution work consumes approved artifacts rather than replanning from scratch
- approval happens through issue state and review flow, not in-run chat
- missing information should move the issue to `Needs Input` instead of triggering long clarifying-question loops

Good fit for Ensemble:

- work with clear scope and success criteria
- parent issues that produce durable planning artifacts
- child execution issues that point at those artifacts
- review steps that can stop cleanly for human approval

Poor fit for autonomous execution:

- tasks that depend on repeated back-and-forth with a human
- vague execution issues with no durable plan or acceptance criteria
- workflows that assume the agent can pause for hours in a live conversation and then continue the same session

### Translating Common SDD Phases

Discovery or brainstorming:

- create a planning issue
- write a draft spec with explicit assumptions
- send that spec to review instead of trying to resolve every question live

Specification:

- write `SPEC.md`
- move to a review state such as `Plan Review`
- update the spec asynchronously after human feedback

Planning:

- write `PLAN.md`
- decompose into wave issues only after the plan is approved
- make each execution issue link to the exact artifacts it should follow

Implementation:

- dispatch only execution-ready issues
- prefer conservative decisions from repo context and approved artifacts
- stop only for true blockers, external dependencies, or explicit approval boundaries

Review and verification:

- keep review on the same issue
- use `In Review` for approval gates
- send rejected work back to `Ready` on the same issue

### Current Product Boundary

Today, human input is mostly a between-run workflow rather than a first-class live interaction system inside Ensemble.

That means the current recommended pattern is:

1. agent identifies a real blocker or review boundary
2. issue moves to `Needs Input` or `In Review`
3. human updates the issue, comments, or linked artifacts
4. issue returns to `Ready` for another run

This keeps Ensemble effective even before first-class human interaction requests exist in the product.

See also:

- `docs/superpowers/specs/2026-04-03-human-interaction-requests-design.md`

## Worked Example

Parent issue: `Add issue templates and planning workflow`

- Wave 1: write `docs/gsd-workflow.md`, issue templates, prompt examples, and board rules
- Wave 2: run the workflow on a real parent issue and polish anything confusing

See also:

- `docs/superpowers/specs/2026-04-02-gsd-workflow-integration-design.md`
- `docs/examples/issues/ensemble-parent-planning.md`
- `docs/examples/issues/ensemble-wave-execution.md`
- `docs/examples/prompts/gsd-parent-planning-prompt.md`
- `docs/examples/prompts/gsd-wave-execution-prompt.md`
- `docs/examples/github-projects/gsd-board-rules.md`
