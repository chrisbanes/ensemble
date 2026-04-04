# SDD Workflow Doc Replacement Design

## Goal

Replace `docs/gsd-workflow.md` with a new canonical `docs/sdd-workflow.md` that documents spec-driven development with Ensemble without preserving GSD-specific framing.

## Scope

This change is documentation-only.

Files in scope:

- delete `docs/gsd-workflow.md`
- add `docs/sdd-workflow.md`
- update repository references that still point to `docs/gsd-workflow.md`

## Problem

The current `docs/gsd-workflow.md` mixes two concerns:

- GSD-specific positioning and terminology
- broader Ensemble workflow guidance that now applies to spec-driven workflows in general

That makes the doc harder to position as the canonical workflow guide now that Ensemble has first-class human interaction requests and explicit resume support.

## Decision

Create a new canonical `docs/sdd-workflow.md` and remove `docs/gsd-workflow.md` entirely.

The new doc will be explicitly about using Ensemble in an SDD workflow. It will remain Ensemble-specific rather than tool-agnostic, and it will keep concrete operational guidance such as issue states, artifact paths, and tracker conventions.

## Content Structure

`docs/sdd-workflow.md` will contain these sections:

1. Purpose and audience
2. What Ensemble does and does not know
3. Core SDD workflow
4. Suggested tracker model
5. Artifact layout
6. Human interaction model
7. Good fit / poor fit
8. Worked example
9. See also

## Canonical Workflow States

The replacement doc should keep concrete suggested tracker states.

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

`Ready` remains the only state Ensemble should treat as executable.

## Content Migration Rules

Keep and rewrite:

- issue lifecycle guidance
- planning and execution issue roles
- artifact paths under `docs/phases/...`
- branch strategy
- retry/review handling
- tracker gating and `Ready` semantics
- best-effort metadata guidance

Remove or replace:

- `GSD-style` branding
- wording about not forking or teaching Ensemble GSD-specific concepts
- any implication that human input is only a between-run workaround
- the section titled `Translating Common SDD Phases`, since the new doc should speak directly in SDD terms

## Human Interaction Guidance

The new doc should reflect current product behavior:

- use tracker states for planned approval/review gates
- use interaction requests for first-class blocked-on-human questions or approvals
- use explicit resume after a resolved blocking interaction
- describe Ensemble interaction records plus their durable resume state as the source of truth for interaction lifecycle
- state explicitly that, in v1, humans respond to blocking interactions and trigger resume through Ensemble's UI/API rather than through tracker comments being read back into the system
- describe tracker state/comments and repo artifacts as workflow context or best-effort mirrors rather than the authoritative interaction record

## Existing GSD References And Examples

The implementation should explicitly review current GSD-branded references and decide whether they should be updated, retained as examples, or removed from the canonical workflow path.

At minimum, review references under:

- `README.md`
- `docs/examples/issues/ensemble-parent-planning.md`
- `docs/examples/issues/ensemble-wave-execution.md`
- `docs/examples/prompts/gsd-parent-planning-prompt.md`
- `docs/examples/prompts/gsd-wave-execution-prompt.md`
- `docs/examples/github-projects/gsd-board-rules.md`

Implementation rule:

- update direct references to `docs/gsd-workflow.md`
- do not leave GSD-branded examples linked as the primary canonical workflow path
- it is acceptable for some example assets to remain temporarily GSD-branded if they are clearly examples rather than the main workflow documentation

## Reference Updates

Any remaining links to `docs/gsd-workflow.md` should be updated to `docs/sdd-workflow.md` or removed if they are now obsolete.

## Validation

Success criteria:

- there is one canonical workflow doc at `docs/sdd-workflow.md`
- no repository references require `docs/gsd-workflow.md`
- the new doc keeps practical Ensemble workflow guidance while removing GSD-specific framing
- human interaction guidance matches the current runtime model
