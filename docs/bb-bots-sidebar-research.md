# Bots Sidebar research

Date: 2026-09-24. Read-only subagent investigation of
[tobi/bb-bots-sidebar](https://github.com/tobi/bb-bots-sidebar) at
[`4cbb4da10bdc0ef6456fb72404b4308e8439aea5`](https://github.com/tobi/bb-bots-sidebar/commit/4cbb4da10bdc0ef6456fb72404b4308e8439aea5).
Source inspected through GitHub after local clone failed DNS. Tests were read,
not run. No source or assets copied; no live BB changes.

## Recommendation

Adapt its conversation binding and navigation patterns. The subsequent accepted
product decision excludes persistent bot identities, personal bot state and a
bot management UI; reusable agent profiles are sufficient. Keep Ensemble's
task ownership, assignment history and result delivery explicit. Bots Sidebar
manages persistent bot identities and conversations; it does not establish the
durable task coordination contracts in our design.

| Pattern | Application to Ensemble | Evidence |
| --- | --- | --- |
| Persist a start token before spawning, bind at dispatch | Use assignment launch intent to recover a lost spawn response; still reconcile ambiguous launches | [Store](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/lib/bot-store.ts#L5-L15), [spawn](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/server.ts#L312-L322) |
| Identify the actual sender and distinguish agent messages from user authorization | Preserve actor provenance in owner/worker messages | [Messaging](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/lib/bots-cli.ts#L60-L80) |
| Canonical SQLite state, revision/hash checks, best-effort exports | Keep persisted records authoritative; exports do not become a second source of truth | [Private state](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/lib/private-state.ts#L114-L146) |
| Realtime sidebar refresh, reconnect refresh, stale-response suppression | Reuse the interaction design for project/task navigation and attention | [UI](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/app.tsx#L108-L152) |
| Stable manual conversation ordering | Avoid navigation jumping as agents become active | [Ordering](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/lib/conversation-order.ts#L1-L12) |

These are research recommendations, not newly accepted product requirements.
Project bot ownership routes new conversations; it is not task ownership or an
access boundary. Avoid importing its bot/state model wholesale.

## Queue and recovery limits

Its [dispatch hook](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/server.ts#L240-L254)
binds conversations and returns `proceed`. Its
[send path](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/lib/bots-cli.ts#L119-L138)
uses `threads.send` with `queue-if-active` and returns BB's sent/queued receipt.
It has no independent delivery ledger or processing acknowledgement in that path.
It therefore provides no demonstrated solution to the unresolved
[Ensemble-to-BB dispatch boundary](bb-capabilities.md#alternative-under-investigation-retain-pending-work-in-ensemble).

Tests cover lost spawn responses, queue receipts and ownership races through a
[fake SDK host](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/tests/backend-fixture.ts#L1-L6).
No live failed-startup or end-to-end BB evidence was found in this investigation.
The package declares BB >=0.42 and SDK >=0.4.47 and uses experimental APIs,
including the thread-list slot. Compatibility with our BB 0.43.4/SDK 0.5.9 remains
unverified.

## Source reuse

At the inspected revision, no repository LICENSE file or package license
declaration was found. The
[third-party notices](https://github.com/tobi/bb-bots-sidebar/blob/4cbb4da10bdc0ef6456fb72404b4308e8439aea5/THIRD_PARTY_NOTICES.md)
cover bloub material, not a general license for the plugin. Obtain a license grant
before copying its source or assets. The recommendation above is to adapt ideas.
