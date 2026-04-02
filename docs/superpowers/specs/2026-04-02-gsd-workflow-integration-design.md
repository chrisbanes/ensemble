# GSD Workflow Integration Design

## Overview

This design describes how to run a GSD-inspired planning and execution workflow through Ensemble without forking GSD and without making GSD-specific changes to Ensemble.

The integration lives in three places:

- GitHub issue structure
- board states and promotion rules
- agent prompt and available GitHub write tooling

Ensemble stays a generic orchestrator. It reads eligible issues, creates workspaces, runs agents, and syncs tracker state. GSD remains an external workflow influence for how agents plan, decompose, execute, and verify work.

## Goals

- Use a GSD-style spec -> plan -> execute -> verify workflow with Ensemble.
- Keep the parent issue as the planning container for a larger feature.
- Create child issues only after the parent plan is finalized.
- Represent execution as wave issues, not one issue per internal plan.
- Preserve wave sequencing without teaching Ensemble about GSD waves.
- Keep durable planning artifacts in the repo and operational summaries in issues.
- Avoid a GSD fork and avoid GSD-specific product work inside Ensemble.

## Non-Goals

- Adding GSD-specific logic, concepts, or commands to Ensemble.
- Making Ensemble understand plan graphs or wave dependencies natively.
- Creating tracker issues for every internal plan or task.
- Requiring interactive clarifying-question loops during execution intake.
- Replacing GSD itself or tightly coupling Ensemble to GSD internals.

## Operating Model

The operating model separates planning from execution.

- The parent issue is the planning container for the whole feature or milestone slice.
- The planning agent works on the parent issue first and produces the durable spec and execution plan.
- After the plan is finalized, the planning agent creates child issues representing execution waves.
- Ensemble runs on the child wave issues, not the parent issue.
- Internal plans and tasks remain in repo artifacts rather than becoming first-class tracker tickets.

This gives GitHub a readable structure:

- parent issue = strategic context and approved plan
- wave issues = executable envelopes
- repo docs = detailed decomposition and verification record

### Planning Entrypoint

Planning on the parent issue is a separate agent workflow from Ensemble's normal child-issue execution loop.

Recommended entrypoints:

- manual invocation by the human against the parent issue
- a dedicated planning agent workflow triggered from the parent issue state or label

The important invariant is:

- parent issue planning produces approved artifacts and child wave issues
- Ensemble execution only runs on child wave issues in `Ready`

This keeps planning and execution clearly separated even when both use the same underlying agent runtime.

## Why Child Issues Represent Waves

Using child issues for waves instead of individual plans is the best fit for Ensemble's current model.

- It keeps the tracker compact and understandable.
- It preserves GSD's dependency-aware execution shape.
- It avoids needing Ensemble to reason about many tiny issue dependencies.
- It allows the agent to execute several internal tasks inside one wave issue using the approved plan artifact.

The trade-off is that fine-grained task visibility lives in docs rather than the tracker. That is acceptable because the tracker remains the operational surface while the repo remains the detailed source of truth.

## Issue Model

### Parent Issue

The parent issue is created by the human and acts as the planning hub.

It should contain:

- feature or milestone objective
- constraints and context
- high-level acceptance criteria
- links to approved spec and plan documents
- a wave summary table after planning is complete
- links to all generated child wave issues

The parent issue is where planning discussion happens. It is not the issue Ensemble should execute.

The parent issue should have a lightweight planning lifecycle outside the execution loop, for example:

- `Draft`
- `Planning`
- `Plan Review`
- `Planned`
- `Done`

Only the parent issue uses this planning lifecycle. Child wave issues use the execution lifecycle.

### Child Wave Issue

Each child issue represents one approved execution wave created from the parent plan.

Required fields:

- parent issue reference
- wave number and wave goal
- included plans or tasks from the approved plan
- dependencies on prior waves
- success criteria for the wave
- links to spec, plan, and verification artifacts

Optional best-effort fields:

- branch reference
- workspace reference
- last run timestamp
- attempt count
- latest verdict or blocking reason

The child issue should stay compact. It is an operational summary, not a duplicate of the spec and plan docs.

### Issue Metadata Ownership

Metadata ownership should be explicit:

- planning agent writes parent links, wave number, dependencies, artifact links, and initial success criteria when creating child issues
- Ensemble writes or derives execution metadata that belongs to runtime orchestration, such as workspace reference and attempt count, when available through its existing tracker updates
- execution agent writes compact operational summaries such as latest verdict, blockers, and verification links
- if branch names or PR links are produced by the execution workflow, the execution agent writes them back to the wave issue

If a field cannot be updated consistently by the available tooling, it should be omitted rather than partially maintained.

## Board Model

The board should use a small number of coarse states:

- `Planned`
- `Ready`
- `In Progress`
- `Needs Input`
- `In Review`
- `Done`

Only `Ready` issues are eligible for Ensemble pickup.

Wave promotion is handled through board policy rather than Ensemble logic:

- Wave 1 child issue starts as `Ready`.
- Later waves start as `Planned`.
- When a wave completes, the next wave is promoted to `Ready`.

This keeps wave sequencing visible while allowing Ensemble to remain unaware of wave semantics.

### Wave Sequencing Invariant

The workflow must enforce this rule:

- only waves whose dependencies are fully satisfied may be moved to `Ready`

Recommended enforcement options:

- a human follows a strict board policy
- a separate automation checks that all prior-wave issues are `Done` before promoting the next wave
- a planning or release agent performs promotion and validates dependencies before changing state

The recommended default is a small external automation or agent step that refuses to promote any wave whose dependency set is not fully complete. This allows multiple parallel waves to become `Ready` at the same time when the approved plan allows it.

## Artifact Model

Durable artifacts live in the repo. Transient execution state lives in the workspace.

Recommended durable artifacts:

- `docs/phases/<parent-or-feature-slug>/SPEC.md`
- `docs/phases/<parent-or-feature-slug>/PLAN.md`
- `docs/phases/<parent-or-feature-slug>/verification/WAVE-<n>.md`
- optional `docs/phases/<parent-or-feature-slug>/HANDOFF.md`

Recommended transient workspace state:

- run logs
- scratch notes
- partial research notes
- retry state
- temporary execution context files

The repo is the long-lived record. The issue links to that record. The workspace is disposable.

Using per-wave verification files avoids one large shared verification document becoming a conflict hotspot across multiple execution cycles.

## Agent Prompt Contract

The integration depends on a disciplined agent prompt rather than product changes inside Ensemble.

### Parent-Issue Prompt Responsibilities

When the agent is running against a parent issue, it should:

- read the parent issue, repository context, and any existing design docs
- create or update the durable spec and plan artifacts
- decompose the approved plan into execution waves
- create one child issue per wave after the plan is finalized
- update the parent issue with links to artifacts and created wave issues

### Wave-Issue Prompt Responsibilities

When the agent is running against a wave issue, it should:

- read the wave issue and linked artifacts
- execute the internal tasks assigned to that wave
- verify the results against the wave success criteria
- update artifacts and issue metadata with the latest result
- stop and surface blockers when confidence is too low

### Ambiguity Handling

The workflow should avoid interactive clarification during execution.

Agents should:

- infer from repository conventions, parent issue context, and existing docs
- proceed when confidence is high enough
- move the issue to `Needs Input` when ambiguity is too high
- document assumptions, missing information, and recommended defaults in the issue and artifacts

## Workflow

### 1. Plan On The Parent Issue

The human creates the parent issue with the feature brief. A planning agent produces the approved spec and execution plan in repo docs.

The parent issue enters `Planning` while this work is underway.

The planning workflow must publish the approved artifacts into the repository branch that child execution agents will later consume. In practice, that means the planning run either commits the artifacts directly to the working branch or lands them through a reviewable PR before any wave issue is released for execution.

### 2. Create Child Wave Issues

After the plan is finalized, the planning agent creates child issues for each wave described in the plan.

The plan is considered finalized when:

- the parent spec and plan artifacts exist and are linked from the parent issue
- the parent issue reaches `Planned` or an equivalent approval state
- the human has explicitly approved the plan, unless the team intentionally adopts an auto-approval policy

- Wave 1 is created in `Ready`.
- Later waves are created in `Planned`.

### 3. Execute The Current Wave

Ensemble picks up the `Ready` wave issue, creates the workspace, and runs the execution agent. The agent uses the linked artifacts to execute the wave's internal tasks.

### 4. Verify And Update

The execution agent records verification results in the repo artifacts and posts a compact operational update to the wave issue.

At minimum, that update should include:

- latest verdict
- links to any branch or PR created by the workflow
- verification artifact link
- blocker summary if the wave did not complete

### 5. Promote The Next Wave

When the current wave is complete, the next wave is promoted from `Planned` to `Ready` by a human or a separate automation outside Ensemble.

### 6. Finish The Parent Issue

When all wave issues are done, the parent issue represents a fully executed feature. GitHub's built-in rollup and sub-issue relationships provide the high-level progress view.

## State Transitions And Non-Happy Paths

### Parent Issue

Suggested parent states:

- `Draft` -> initial human-authored request
- `Planning` -> agent is producing or revising artifacts
- `Plan Review` -> plan is ready for human approval
- `Planned` -> approved and wave issues may be created or already exist
- `Done` -> all child wave issues are complete

The parent issue is updated by the planning or release workflow, not by Ensemble's child execution loop. That workflow is responsible for moving the parent into `Plan Review`, `Planned`, and `Done`.

### Child Wave Issue

Suggested child states:

- `Planned` -> wave exists but is not yet eligible
- `Ready` -> eligible for Ensemble pickup
- `In Progress` -> currently executing
- `Needs Input` -> blocked on ambiguity or missing product direction
- `In Review` -> code or deliverable is waiting for review
- `Done` -> wave completed successfully

State ownership for child issues:

- planning agent sets initial `Planned` or `Ready` when creating wave issues
- Ensemble moves `Ready` to `In Progress` when it dispatches a run, if the tracker integration supports that transition
- execution agent moves the issue to `Needs Input` or `In Review` when the result requires it and the available tracker tooling allows it
- execution completion or follow-up automation moves successfully completed issues to `Done`

If a particular tracker write is not supported by the runtime environment, the agent must still record the intended state in the issue comment or verification artifact so the missing transition is visible.

### Failure And Retry Behavior

- transient execution failure should remain within the same child wave issue and increment retry metadata rather than creating a new issue
- persistent ambiguity or product uncertainty should move the issue to `Needs Input`
- review-required outcomes should move the issue to `In Review`
- unrecoverable technical failure should remain attached to the same wave issue with an explicit failure summary and either retry or human intervention path
- review rejection should return the same child wave issue to `Ready` or `In Progress` depending on whether execution can resume automatically or needs a fresh dispatch

The key rule is that retries and blockers stay attached to the same wave issue so the tracker preserves one operational thread per wave.

Review rejection should never create a replacement wave issue. The same issue remains the unit of record until the wave is complete or deliberately cancelled.

## Issue Creation Capability

Agents do need a way to create child issues after planning is finalized, but this does not need to be a GSD-specific Ensemble feature.

The preferred model is to treat issue creation as part of the agent runtime environment:

- GitHub CLI such as `gh issue create`
- a GitHub MCP server
- another tracker-write tool already available to the agent

This capability belongs in prompt contract, runtime permissions, and agent tooling rather than in Ensemble's core orchestration model.

If Ensemble later grows a tracker write abstraction that can create issues generically, that could improve portability across trackers, but it is not required for this workflow design.

## Recommended Prompt Requirements

The planning prompt for parent issues should explicitly require the agent to:

- avoid clarifying-question loops unless blocked
- produce a finalized wave plan before creating child issues
- create exactly one child issue per wave
- include parent reference, wave number, dependencies, success criteria, and artifact links in each child issue
- set initial board state based on wave order

The execution prompt for wave issues should explicitly require the agent to:

- follow the approved plan artifact rather than replanning from scratch
- keep the issue summary compact and operational
- write detailed progress and verification into repo artifacts
- move to `Needs Input` instead of guessing when confidence falls below the allowed threshold

## Trade-Offs

### Advantages

- No GSD fork.
- No GSD-specific changes to Ensemble.
- Tracker stays readable and human-friendly.
- GSD-style decomposition survives in durable docs.
- Waves can be coordinated through board policy.

### Costs

- Wave promotion is external to Ensemble.
- Detailed task-level tracking lives in docs, not as tracker tickets.
- Success depends on prompt discipline and agent access to issue-creation tooling.

## Recommendation

Use the following model:

- parent issue = planning container
- child issue = wave container
- repo docs = spec, plan, and verification source of truth
- board states = coarse eligibility and review states
- issue creation = agent capability via GitHub tooling, not an Ensemble-specific feature

This keeps Ensemble generic, preserves the useful parts of GSD's operating model, and minimizes integration cost.
