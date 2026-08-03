# SDD With Ensemble

> **Superseded workflow guidance.** This historical SDD method is not a runtime contract. For the
> current trusted-local, single-operator runtime and GitHub Project lifecycle, see
> [`docs/SPEC.md`](SPEC.md) and [`docs/agents/run-github-project.md`](agents/run-github-project.md).

## Who This Is For

This workflow is for teams using GitHub issues as the human-facing planning surface and Ensemble as the issue executor. It provides a spec-driven development approach where planning work produces durable artifacts that execution work consumes.

This approach works well when you want clear separation between specification, planning, and implementation phases, with explicit approval gates and bounded handoffs between human and agent work.

## What Ensemble Does And Does Not Know

Ensemble remains a generic orchestrator. It knows how to poll eligible issues, create isolated workspaces, run agents, and write tracker updates that its runtime supports.

Ensemble does not natively understand:

- planning issues versus execution issues
- wave graphs or dependency promotion rules
- issue creation on your behalf
- SDD-specific commands or artifacts

Those behaviors come from your board rules, issue templates, and agent prompts.

## Core SDD Workflow

### Planning Issue Role

A planning issue represents the specification and planning container for a complete feature or deliverable.

Recommended lifecycle:

- `Draft` - initial human request
- `Planning` - agent is writing or revising artifacts
- `Plan Review` - artifacts are ready for approval
- `Planned` - approved and ready to release waves
- `Done` - all child execution issues are complete

The planning agent should produce durable artifacts at:

- `docs/phases/<slug>/SPEC.md`
- `docs/phases/<slug>/PLAN.md`

Those approved artifacts must be committed or merged before any child execution issue is moved to `Ready`.

After approval, the planning agent creates child execution issues and updates the planning issue with a wave summary table plus links to every generated child issue.

Example wave summary table:

| Wave | Goal | Status | Issue |
|---|---|---|---|
| 1 | Write docs and templates | Ready | `#123` |
| 2 | Validate workflow on a real feature | Planned | `#124` |

### Execution Issue Role

Each execution issue is an implementation container for one approved wave or task set.

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

## Suggested Tracker Model

Use one shared GitHub status field for both planning and execution issues.

Planning issue states:

- `Draft`
- `Planning`
- `Plan Review`
- `Planned`
- `Done`

Execution issue states:

- `Planned`
- `Ready`
- `In Progress`
- `Needs Input`
- `In Review`
- `Done`

`Ready` is the only state Ensemble should treat as executable.

Multiple execution issues may be `Ready` at the same time when their dependency sets are fully satisfied.

## Artifact Layout

Use durable docs under one feature-specific directory:

- `docs/phases/<slug>/SPEC.md`
- `docs/phases/<slug>/PLAN.md`
- `docs/phases/<slug>/verification/WAVE-<n>.md`
- optional `docs/phases/<slug>/HANDOFF.md` — captures decisions, context, and open questions when handing off between planning and execution agents or between waves

This keeps detailed decomposition and verification in git while leaving tracker issues as operational summaries.

## Branch Strategy

The recommended default is one branch per wave created from `main`.

This keeps each wave independently reviewable and matches the rule that dependency waves must already be complete and available on `main` before later waves become executable.

## Human Interaction Model

### Authority And State

Ensemble interaction records plus their durable resume state are the authoritative source of truth for the interaction lifecycle.

**Important:** In v1, human responses to blocking interactions and explicit resume happen through Ensemble's UI/API rather than through tracker comments being read back into the system.

Tracker state, comments, and repo artifacts serve as workflow context or best-effort mirrors rather than authoritative interaction records.

### Blocking Interactions

Use interaction requests for first-class blocked-on-human questions or approvals:

1. Agent identifies a blocker, ambiguity, or review boundary
2. Agent emits an interaction request with blocking context
3. Issue may be moved to `Needs Input` or `In Review` as a visible tracker signal
4. Human responds through Ensemble's interface
5. Explicit resume continues execution with the resolved context

### Tracker Gating

Use tracker states for planned approval/review gates:

- `Plan Review` for specification and plan approval
- `In Review` for implementation review
- Approval transitions move the issue forward
- Rejection returns the issue to an earlier state

Step-level approval gates (not just tracker states) are now the orchestration boundary. Ensemble pipelines can include steps with an `approval` block that causes the orchestrator to pause and wait for explicit `approve_gate` or `reject_gate` signals before continuing downstream steps.

### Recommended Superpowers Pipeline

The recommended operating model is a single Ensemble pipeline:

- `plan` — brainstorm, design, and planning. May request a manual approval gate before implementation.
- `implement` — build the planned solution.
- `review` — verify the implementation.

This three-step DAG allows the plan step to request human approval before implementation begins, ensuring designs are reviewed before code is written.

### Retry And Review Handling

Use the same execution issue for retries, review cycles, and ambiguity handling:

- low-confidence execution moves to `Needs Input`
- review-required work moves to `In Review`
- review rejection returns the same execution issue to `Ready`
- transient failures stay on the same execution issue and update retry metadata

If tracker state writes are unavailable, record the intended next state in the issue comment or verification artifact instead of silently dropping it.

## Good Fit / Poor Fit

Good fit for Ensemble:

- work with clear scope and success criteria
- planning issues that produce durable specification artifacts
- execution issues that point at approved artifacts
- review steps that can stop cleanly for human approval
- bounded handoffs with explicit state transitions

Poor fit for autonomous execution:

- tasks that depend on repeated back-and-forth with a human
- vague execution issues with no durable plan or acceptance criteria
- workflows that assume the agent can pause for hours in a live conversation and then continue the same session

## Worked Example

Planning issue: `Add dark mode to the dashboard UI`

- Wave 1: write `docs/phases/dark-mode/SPEC.md` (design tokens, component inventory, accessibility requirements) and `docs/phases/dark-mode/PLAN.md` (implementation order, testing strategy)
- Wave 2: implement theme provider and token system, update core layout components, add verification screenshots
- Wave 3: update remaining dashboard widgets, add user preference persistence, end-to-end test suite

Each wave links to the approved spec and plan. Wave 2 cannot start until Wave 1 artifacts are approved and merged. Wave 3 depends on Wave 2's theme provider being on `main`.

## Migrating From GSD Workflow

If you previously used the GSD-style workflow guide, the core mechanics are unchanged. Key differences:

- **Terminology**: "parent/child" is now "planning/execution" — the states and transitions are the same
- **Human interaction**: v1 now has first-class interaction requests through Ensemble's UI/API rather than relying on tracker comments as the input channel
- **Authority**: Interaction records and durable resume state are now the source of truth; tracker state and comments are best-effort mirrors
- **Examples**: Some example files still carry `gsd-` prefixes (prompts, board rules). These remain functionally valid and are being renamed incrementally

## See Also

- [Human interaction as durable runtime state](adr/0008-own-human-interaction-as-durable-runtime-state.md)
- [Development methods outside the runtime core](adr/0014-keep-development-methods-outside-the-runtime-core.md)
- `docs/examples/issues/ensemble-parent-planning.md`
- `docs/examples/issues/ensemble-wave-execution.md`
- `docs/examples/prompts/gsd-parent-planning-prompt.md`
- `docs/examples/prompts/gsd-wave-execution-prompt.md`
- `docs/examples/github-projects/gsd-board-rules.md`
