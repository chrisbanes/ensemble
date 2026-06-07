# Interactive Threaded Human Interactions Design

## Summary

This design extends Ensemble with first-class human interaction flows that are durable in Ensemble state and operated through tracker comment threads.

The v1 design is intentionally strict: thread-scoped slash commands, deterministic resolution, and append-only event handling.

## Problem

Ensemble can block for human input conceptually, but the operator experience and command semantics are not yet standardized for planning-heavy or review-heavy workflows.

Without a strict contract, systems drift into:

- ambiguous free-text parsing
- race conditions across multiple replies
- hidden state in tracker comments
- inconsistent prompting behavior across agent templates

## Goals

- Keep Ensemble as source of truth for interaction state.
- Provide convenient tracker-native interaction through issue comments.
- Make command intake deterministic and auditable.
- Support planning and approval loops without live-chat/session requirements.
- Reduce question ping-pong by encouraging proactive, batched agent questions.

## Non-Goals

- Live conversational chat between operator and running agent.
- Free-text intent inference from comments.
- Reliance on edited/deleted comment content for orchestration decisions.
- Tracker comment history as canonical state.

## v1 Product Decisions (Locked)

1. **Canonical state**: Ensemble durable interaction records.
2. **Tracker UX**: dedicated comment thread per interaction request.
3. **Command format**: slash commands required.
4. **Command scope**: accepted only in the request thread (thread-only).
5. **Authors**: any commenter can issue commands in v1.
6. **Edits**: ignored for state transitions; only original posted text is valid.
7. **Conflict policy**: first valid original command wins; request locks immediately.
8. **Expiry**: no auto-expiry in v1.
9. **Staleness**: optional reminder nudges only.
10. **Prompting**: automatic runtime injection of interaction policy with soft batching preference.

## Interaction Thread Model

For each open interaction request, Ensemble creates one root bot comment and stores:

- tracker issue identifier
- root comment identifier
- request identifier

Replies to that root comment are the only comment events eligible for command parsing.

Non-command replies are treated as discussion context only and do not mutate orchestration state.

## Command Contract (v1)

Illustrative command set:

- `/approve`
- `/reject <reason>`
- `/answer <text>`

Rules:

- command must be in a reply to the interaction root comment
- command text is parsed from original posted comment body only
- once one valid command is accepted, request transitions to resolved/locked
- subsequent commands on that request are acknowledged as ignored

## State and Event Handling

Ensemble persists:

- interaction request lifecycle state
- tracker linkage metadata (issue + root comment id)
- accepted command event (author, timestamp, original body, parsed action)
- ignored command events (optional audit trail)

Event handling is append-only for decision integrity:

- edits do not retroactively alter accepted intent
- deletions do not roll back resolved decisions

## Prompt Policy Injection (Automatic)

Ensemble injects a standard interaction policy block into agent runtime prompts, independent from template authoring.

Policy requirements:

- prefer batching related uncertainties into one interaction request
- single-question requests are allowed when urgency or sequential discovery requires it
- each requested question should include:
  - question
  - why it matters
  - default if unanswered

Configuration should support policy mode overrides:

- `inherit` (default global behavior)
- `custom` (agent/step-specific override text)
- `off` (disable injection for specific agent/step)

## API/UI/Tracker Behavior

- API/UI remain authoritative control surfaces because they operate on Ensemble state directly.
- Tracker comments act as an adapter channel into that same state model.
- Resolution is mirrored back into the same thread with an explicit bot status update.
- Reminder nudges can be emitted for long-open requests; they do not auto-close requests.

## Risks and Mitigations

- **Risk: command ambiguity**
  - Mitigation: slash-only grammar + thread-only intake.
- **Risk: command override races**
  - Mitigation: first-valid-command-wins lock.
- **Risk: silent behavior drift across prompts**
  - Mitigation: automatic runtime policy injection.
- **Risk: accidental loss from auto-timeouts**
  - Mitigation: no auto-expiry in v1; nudges only.

## Rollout Plan (High-Level)

1. Add/extend interaction request model with thread linkage metadata.
2. Implement tracker adapter for root comment creation and reply ingestion.
3. Implement command parser + validator + deterministic resolution policy.
4. Add prompt policy injection path with override controls.
5. Add observability/audit fields for accepted and ignored commands.
6. Ship behind a config flag, then enable by default after validation.

## Open Questions Deferred

- Permission hardening beyond “any commenter” (e.g., allowlists/role checks).
- Expanded command taxonomy and richer payload schemas.
- Optional top-level fallback commands for trackers without reliable thread semantics.

