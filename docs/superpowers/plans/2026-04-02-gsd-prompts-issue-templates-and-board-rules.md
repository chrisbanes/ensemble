# GSD Prompts, Issue Templates, and Board Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add concrete repository artifacts for the GSD-inspired operating model by documenting reusable agent prompts, GitHub issue templates, and board rules that work with Ensemble without changing Ensemble itself.

**Architecture:** Treat the workflow as a documentation-and-templates package rather than a product feature. Capture the operating contract in one implementation-facing doc, then add copy-pasteable parent issue templates, wave issue templates, and prompt templates that encode the approved behavior: parent-first planning, child issue per wave, branch-per-wave from `main`, non-interactive execution, and `Ready` as the only executable board state.

**Tech Stack:** Markdown docs, GitHub issue templates, GitHub Projects conventions, existing Ensemble docs structure

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `docs/gsd-workflow.md` | Create | End-user operational guide for using GSD-style workflows with Ensemble |
| `.github/ISSUE_TEMPLATE/ensemble-parent-planning.md` | Create | Parent issue template for feature planning containers |
| `.github/ISSUE_TEMPLATE/ensemble-wave-execution.md` | Create | Child wave issue template created after plan approval |
| `docs/examples/prompts/gsd-parent-planning-prompt.md` | Create | Reusable prompt for agents planning on parent issues |
| `docs/examples/prompts/gsd-wave-execution-prompt.md` | Create | Reusable prompt for agents executing wave issues |
| `docs/examples/github-projects/gsd-board-rules.md` | Create | Concrete board/state rules for parent and child issues |
| `README.md` | Modify | Link to the new workflow guide if it fits existing docs navigation |

---

### Task 1: Write the End-User Workflow Guide

**Files:**
- Create: `docs/gsd-workflow.md`

- [ ] **Step 1: Write the failing outline as headings only**

Create `docs/gsd-workflow.md` with this initial structure:

```md
# GSD-Style Workflow With Ensemble

## Who This Is For
## What Ensemble Does And Does Not Know
## Parent Issue Workflow
## Wave Issue Workflow
## Branch Strategy
## Board States
## Required Agent Capabilities
## Recommended Artifacts
## Failure And Review Handling
## Worked Example
```

- [ ] **Step 2: Fill in the guide with operational details from the approved design**

Document:

```text
- parent issue is the planning container
- child issue per wave, created after plan approval
- Ready is the only Ensemble-executable state
- branch per wave from main
- durable artifacts live under docs/phases/<parent-or-feature-slug>/
- verification docs live at docs/phases/<parent-or-feature-slug>/verification/WAVE-<n>.md
- issue creation uses gh or MCP, not Ensemble features
```

The finished guide must include these exact sections and contents:

```text
Who This Is For: explain this is a procedural workflow for teams using GitHub + Ensemble
What Ensemble Does And Does Not Know: explain Ensemble does not understand waves or create issues
Parent Issue Workflow: planning lifecycle, required outputs, wave summary table, and links to child wave issues
Wave Issue Workflow: execution lifecycle, required fields, and compact operational updates
Branch Strategy: branch per wave from main
Board States: one shared status field with parent and child subsets
Required Agent Capabilities: git, tracker write, repo doc editing
Recommended Artifacts: SPEC.md, PLAN.md, verification/WAVE-n.md
Failure And Review Handling: Needs Input, In Review, and review rejection back to Ready
Worked Example: one short parent-plus-waves example
```

The parent workflow section must explicitly state that approved `docs/phases/<parent-or-feature-slug>/SPEC.md` and `docs/phases/<parent-or-feature-slug>/PLAN.md` artifacts are committed or merged before any child wave issue is moved to `Ready`.

- [ ] **Step 3: Add one concrete example section**

Include a short worked example showing:

```text
Parent issue: "Add issue templates and planning workflow"
Wave 1: write docs and templates
Wave 2: validate flow with a real parent issue
```

- [ ] **Step 4: Review for duplication and keep it user-facing**

Verify all of the following acceptance checks:

```text
- the guide explains how to use the workflow rather than restating the full design doc
- the parent issue section includes a short wave summary table example
- the guide links to the parent issue template, wave issue template, prompt examples, and board rules doc
- the guide states that Ensemble does not create issues or understand waves natively
- the guide states that approved SPEC.md and PLAN.md artifacts land before any wave is released to Ready
```

- [ ] **Step 5: Commit**

```bash
git add docs/gsd-workflow.md
git commit -m "Document GSD-style Ensemble workflow"
```

---

### Task 2: Add the Parent Issue Template

**Files:**
- Create: `.github/ISSUE_TEMPLATE/ensemble-parent-planning.md`

- [ ] **Step 0: Verify the parent template directory exists before writing files**

Run:

```bash
ls .github
```

If `.github/ISSUE_TEMPLATE/` does not exist, create it before writing the template.

Run:

```bash
mkdir -p .github/ISSUE_TEMPLATE
```

- [ ] **Step 1: Create the template scaffold**

Use a GitHub issue template frontmatter and body like:

```md
---
name: Ensemble Parent Planning
about: Planning container for a GSD-style feature workflow
title: "[Parent] "
---

## Goal

## Context

## Constraints

## Acceptance Criteria

## Related Docs

## Planning Output Expectations
- SPEC.md
- PLAN.md
- child wave issues after approval
```

- [ ] **Step 2: Add instructions for the planning agent**

Include a short note in the template body telling the agent to:

```text
- treat this issue as the planning container
- do not create child issues until the plan is approved/finalized
- do not move any child wave issue to Ready until the approved SPEC.md and PLAN.md artifacts are committed or merged
- create one child issue per wave after approval
- update this parent issue with a wave summary table and links to all generated child wave issues
```

- [ ] **Step 3: Review the template for GitHub readability**

Verify all of the following acceptance checks:

```text
- a human can fill out Goal, Context, Constraints, and Acceptance Criteria without reading other docs
- the template tells the agent to wait for plan approval before creating child issues
- the template tells the agent to update the parent issue with a wave summary table and child links
```

- [ ] **Step 4: Commit**

```bash
git add .github/ISSUE_TEMPLATE/ensemble-parent-planning.md
git commit -m "Add parent planning issue template"
```

---

### Task 3: Add the Wave Issue Template

**Files:**
- Create: `.github/ISSUE_TEMPLATE/ensemble-wave-execution.md`

- [ ] **Step 0: Verify the wave template directory exists before writing files**

Run:

```bash
ls .github
```

If `.github/ISSUE_TEMPLATE/` does not exist, create it before writing the template.

Run:

```bash
mkdir -p .github/ISSUE_TEMPLATE
```

- [ ] **Step 1: Create the template scaffold**

Start with a wave-focused body:

```md
---
name: Ensemble Wave Execution
about: Execution container for one approved wave
title: "[Wave] "
---

## Parent

## Wave Number

## Goal

## Depends On

## Included Tasks

## Success Criteria

## Artifacts
- Spec:
- Plan:
- Expected Verification Path:
- Verification Link:

## Execution Metadata
- Branch:
- Workspace:
- Last Run Timestamp:
- Attempt Count:
- Latest Verdict:
- PR Link:
- Blocker Summary:
```

- [ ] **Step 2: Mark required versus best-effort fields in template text**

Make the body clearly distinguish:

```text
Required: parent, wave number, goal, dependencies, included tasks, success criteria, spec/plan links, expected verification path
Best-effort during execution: verification link, branch, workspace, attempt count, latest verdict, PR link, blocker summary
```

Add one sentence to the template notes stating that best-effort execution metadata should be left blank or omitted when the runtime cannot maintain it reliably.

- [ ] **Step 3: Add execution notes for the agent**

Add a small section that says:

```text
- follow the approved plan artifact
- do not replan from scratch
- move back to Ready if review rejects the wave
- use Needs Input when confidence is too low
```

- [ ] **Step 4: Commit**

```bash
git add .github/ISSUE_TEMPLATE/ensemble-wave-execution.md
git commit -m "Add wave execution issue template"
```

---

### Task 4: Write Reusable Parent And Wave Prompts

**Files:**
- Create: `docs/examples/prompts/gsd-parent-planning-prompt.md`
- Create: `docs/examples/prompts/gsd-wave-execution-prompt.md`

- [ ] **Step 0: Verify the prompt examples directory exists before writing files**

Run:

```bash
ls docs
```

If `docs/examples/prompts/` does not exist, create it before writing the prompt examples.

Run:

```bash
mkdir -p docs/examples/prompts
```

- [ ] **Step 1: Draft the parent planning prompt**

Write a reusable prompt that instructs an agent to:

```text
- read the parent issue and repo context
- produce docs at docs/phases/<parent-or-feature-slug>/SPEC.md and docs/phases/<parent-or-feature-slug>/PLAN.md
- decompose the plan into waves
- avoid clarifying-question loops unless blocked
- ensure the approved SPEC.md and PLAN.md artifacts are committed or merged before any child wave issue is moved to Ready
- wait for finalized approval before creating child issues
- create one child issue per wave using the wave template
- ensure each child wave issue includes parent reference, wave number, dependencies, success criteria, spec/plan links, and expected verification artifact path
- update the parent issue with a wave summary table and links to generated child issues
- set initial child issue states by wave order: wave 1 to Ready, later waves to Planned
```

- [ ] **Step 2: Draft the wave execution prompt**

Write a reusable prompt that instructs an agent to:

```text
- read the wave issue and linked artifacts
- execute only the current wave
- use branch-per-wave from main
- write verification to docs/phases/<parent-or-feature-slug>/verification/WAVE-<n>.md
- update issue state and metadata compactly
- include latest verdict, PR link when present, and blocker summary when relevant
- return to Ready after review rejection
- keep retries and technical failures on the same wave issue and update retry metadata instead of creating replacement issues
- move the issue to Needs Input instead of guessing when confidence is too low
- if tracker state writes are unavailable, record the intended next state in the issue comment or verification artifact
```

- [ ] **Step 3: Add explicit tool requirements to both prompts**

Document the expected runtime capabilities:

```text
- git access
- tracker write access via gh or MCP
- ability to edit repo docs
```

- [ ] **Step 4: Review both prompts for contradiction with the design doc**

Verify all of the following acceptance checks:

```text
- parent prompt says avoid clarifying-question loops unless blocked
- parent prompt says create one child issue per wave only after plan finalization
- parent prompt says each child issue must include the required wave fields from the spec
- parent prompt says wave 1 starts Ready and later waves start Planned
- wave prompt says branch per wave from main
- wave prompt says review rejection returns to Ready
- wave prompt says low-confidence execution moves to Needs Input
- wave prompt says retries stay on the same wave issue
- both prompts say tracker writes may fall back to issue comments or verification artifacts when direct state writes are unavailable
```

- [ ] **Step 5: Commit**

```bash
git add docs/examples/prompts/gsd-parent-planning-prompt.md docs/examples/prompts/gsd-wave-execution-prompt.md
git commit -m "Add GSD workflow prompt examples"
```

---

### Task 5: Document GitHub Board Rules

**Files:**
- Create: `docs/examples/github-projects/gsd-board-rules.md`

- [ ] **Step 0: Verify the board-rules directory exists before writing files**

Run:

```bash
ls docs
```

If `docs/examples/github-projects/` does not exist, create it before writing the board rules doc.

Run:

```bash
mkdir -p docs/examples/github-projects
```

- [ ] **Step 1: Write the board-state contract**

Document one shared GitHub status field with these states:

```text
Parent issues: Draft, Planning, Plan Review, Planned, Done
Child issues: Planned, Ready, In Progress, Needs Input, In Review, Done
```

- [ ] **Step 2: Add promotion and rejection rules**

Capture the key invariants:

```text
- only Ready is executable by Ensemble
- only waves with satisfied dependencies may move to Ready
- multiple waves may be Ready at the same time when their dependency sets are satisfied
- review rejection returns the same wave issue to Ready
- retries and technical failures stay attached to the same wave issue
- parent reaches Done only when all child waves are Done
```

- [ ] **Step 3: Add ownership notes**

Specify who usually performs each transition:

```text
- planning agent sets parent Planning/Plan Review and creates wave issues
- Ensemble dispatch moves Ready to In Progress when supported
- execution agent sets Needs Input, In Review, or Done when supported
- release/promotion workflow advances later waves and completes parent issue
```

Also include one explicit note that there is a single shared GitHub status field rather than separate parent and child boards.

Also include one explicit fallback note: if the runtime cannot write a board state directly, the agent must record the intended state transition in the issue comment or verification artifact.

- [ ] **Step 4: Verify the board rules against the key invariants**

Confirm the doc explicitly states:

```text
- only Ready is executable
- dependency-satisfied waves may become Ready in parallel
- review rejection returns to Ready
- retries stay on the same wave issue
- parent reaches Done only when all child waves are Done
```

- [ ] **Step 5: Commit**

```bash
git add docs/examples/github-projects/gsd-board-rules.md
git commit -m "Document GSD workflow board rules"
```

---

### Task 6: Link the New Workflow Docs From Existing Entry Points

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add one small docs link in the most relevant section**

Add a concise pointer to `docs/gsd-workflow.md` in the existing documentation list or the nearest equivalent docs navigation section. Do not add a new top-level README section just for this workflow.

If the README does not currently have a natural docs navigation location, skip the edit and record that decision in the final verification notes instead of forcing an awkward link.

- [ ] **Step 2: Verify the new link text matches existing README tone**

Keep the wording short and consistent with current documentation style.

- [ ] **Step 3: Commit**

```bash
git status --short README.md
```

Expected: either `M README.md` if a natural docs link was added, or no output if the README was intentionally left unchanged.

- [ ] **Step 4: Only if README.md changed, commit it**

```bash
git add README.md
git commit -m "Link GSD workflow guide from README"
```

---

### Task 7: Verify the Documentation Package End-to-End

**Files:**
- Modify as needed: any files created above

- [ ] **Step 1: Check all new file paths and references**

Verify every referenced path exists:

```bash
ls docs/gsd-workflow.md .github/ISSUE_TEMPLATE/ensemble-parent-planning.md .github/ISSUE_TEMPLATE/ensemble-wave-execution.md docs/examples/prompts/gsd-parent-planning-prompt.md docs/examples/prompts/gsd-wave-execution-prompt.md docs/examples/github-projects/gsd-board-rules.md
```

Expected: all files exist.

- [ ] **Step 2: Search for outdated contradictory wording**

Run:

```bash
rg -n "In Progress.*review rejection|shared feature branch|child issue per plan" docs .github/ISSUE_TEMPLATE README.md
```

Expected: no contradictory wording remains, or every hit is intentionally updated.

- [ ] **Step 3: Read the final doc set for consistency**

Confirm the same defaults appear everywhere:

```text
- parent issue plans first
- child issue per wave
- branch per wave from main
- Ready is the executable state
- review rejection returns to Ready
- direct tracker-write failures fall back to recording intended state in issue comments or verification docs
- approved SPEC.md and PLAN.md land before waves are released to Ready
- unsupported best-effort metadata is omitted rather than partially maintained
```

- [ ] **Step 4: Commit the final documentation package**

```bash
git status --short
```

Expected: either a clean working tree because the per-task commits already captured everything, or a small final consistency fix that still needs committing.

- [ ] **Step 5: Only if verification caused additional edits, create a final cleanup commit**

```bash
git add docs/gsd-workflow.md .github/ISSUE_TEMPLATE/ensemble-parent-planning.md .github/ISSUE_TEMPLATE/ensemble-wave-execution.md docs/examples/prompts/gsd-parent-planning-prompt.md docs/examples/prompts/gsd-wave-execution-prompt.md docs/examples/github-projects/gsd-board-rules.md README.md
git commit -m "Polish GSD workflow documentation package"
```
