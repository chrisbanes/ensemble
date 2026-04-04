# SDD Workflow Doc Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `docs/gsd-workflow.md` with a new canonical `docs/sdd-workflow.md` that documents SDD with Ensemble and aligns with the current human interaction model.

**Architecture:** This is a documentation-only replacement. The work should preserve the practical workflow guidance from the old doc, remove GSD-specific framing, and update direct references so the new SDD doc becomes the single canonical workflow entry point.

**Tech Stack:** Markdown docs, repository examples, git grep/search, no code changes.

---

### Task 1: Audit References And Draft The New Canonical Doc

**Files:**
- Create: `docs/sdd-workflow.md`
- Review: `docs/gsd-workflow.md`
- Review: `docs/superpowers/specs/2026-04-04-sdd-workflow-doc-design.md`
- Review: any files that reference `docs/gsd-workflow.md`

- [ ] **Step 1: Search repository references to the old workflow doc**

Run: `rg -n "docs/gsd-workflow\.md|gsd-workflow" .`
Expected: a concrete list of references to update or consciously leave as historical examples.

- [ ] **Step 2: Draft the new canonical workflow doc**

Write `docs/sdd-workflow.md` with these sections:

```md
# SDD With Ensemble

## Who This Is For
## What Ensemble Does And Does Not Know
## Core SDD Workflow
## Suggested Tracker Model
## Artifact Layout
## Human Interaction Model
## Good Fit / Poor Fit
## Worked Example
## See Also
```

Required content:

- planning issue states: `Draft`, `Planning`, `Plan Review`, `Planned`, `Done`
- execution issue states: `Planned`, `Ready`, `In Progress`, `Needs Input`, `In Review`, `Done`
- planning versus execution issue roles
- lifecycle guidance for both issue types
- `Ready` as the only executable state
- artifact paths under `docs/phases/<slug>/...`
- branch strategy
- retry/review handling on the same execution issue
- tracker gating semantics, including approval/review boundaries
- best-effort metadata guidance
- explicit statement that interaction records plus durable resume state are authoritative
- explicit statement that v1 human responses and resume happen through Ensemble UI/API, not by reading tracker comments back into the system
- explicit statement that tracker state/comments and repo artifacts are workflow context or best-effort mirrors rather than authoritative interaction records

- [ ] **Step 3: Review the new doc for removed GSD framing**

Confirm the new draft does not contain:

- `GSD-style`
- `without forking GSD`
- `Translating Common SDD Phases`
- any wording that treats tracker comments as the authoritative interaction record

---

### Task 2: Remove The Old Doc And Update Canonical References

**Files:**
- Delete: `docs/gsd-workflow.md`
- Modify: any repository files with direct links to `docs/gsd-workflow.md`
- Review only: `README.md`, `docs/examples/issues/ensemble-parent-planning.md`, `docs/examples/issues/ensemble-wave-execution.md`, `docs/examples/prompts/gsd-parent-planning-prompt.md`, `docs/examples/prompts/gsd-wave-execution-prompt.md`, `docs/examples/github-projects/gsd-board-rules.md`

- [ ] **Step 1: Update canonical references**

Replace direct links from `docs/gsd-workflow.md` to `docs/sdd-workflow.md` where the repository is pointing readers at the main workflow doc.

- [ ] **Step 2: Review existing example assets**

Check GSD-branded example files and apply this rule:

- update them only if they directly point at the deleted canonical doc or would otherwise break navigation
- explicitly decide for each listed file whether it is updated, retained as an example, or removed from the canonical workflow path
- do not expand scope into a full examples rename unless required for correctness

- [ ] **Step 3: Delete the old GSD workflow doc**

Remove `docs/gsd-workflow.md` once replacement references are in place.

---

### Task 3: Verify The Documentation Replacement

**Files:**
- Verify: `docs/sdd-workflow.md`
- Verify: repository references

- [ ] **Step 1: Re-run reference search**

Run: `rg -n "docs/gsd-workflow\.md|gsd-workflow" .`
Expected: no direct references to `docs/gsd-workflow.md`; any remaining `gsd-` hits should be intentional example/spec/history names and not the canonical workflow path.

- [ ] **Step 2: Read the final SDD doc for required content**

Confirm it includes:

- canonical planning and execution states
- planning versus execution issue roles
- artifact layout
- branch strategy
- retry/review handling
- `Ready` execution rule
- human interaction requests plus explicit resume
- UI/API-based human response path in v1
- tracker state/comments and repo artifacts described as best-effort mirrors or workflow context rather than authoritative interaction records

- [ ] **Step 3: Confirm one canonical workflow doc outcome**

Verify:

- `docs/sdd-workflow.md` exists as the canonical workflow doc
- `docs/gsd-workflow.md` is deleted
- repository-facing references now point to the SDD doc or intentionally point to example/spec history only

- [ ] **Step 4: Review deleted/added file status**

Run: `git status --short docs README.md`
Expected: shows `docs/sdd-workflow.md`, removal of `docs/gsd-workflow.md`, and only the intended reference updates.
