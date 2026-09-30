# S04b live runtime evidence

This document records the bounded S04b live runtime journey and its retests on
30 September 2026. The most recent successful journey exercised repaired source
revision `d30bd166587ed61ec4b80a4959a8d07ace8f5715`; earlier evidence remains
below for history.

## Current-head retest

An initial attempt on source revision
`51718f50395de4ae8b33c344332a2634a9e80663` stopped at
`authenticated-runtime-start`. The sandbox prevented creation of the runtime's
PATH aliases (`Operation not permitted`), before an App Server process identity
was captured. No runtime callbacks, scheduler transitions, results, or events
were observed. The temporary fixture was removed; no process identity was
captured or verified because the runtime never started. This was an
environment-limited attempt, not protocol evidence.

The bounded `npm run s04b:live` retry with process access ran on source revision
`d30bd166587ed61ec4b80a4959a8d07ace8f5715` using Node.js `v24.21.0`, npm
`12.1.0`, and `codex-cli 0.159.0`. It passed with `failure: null`: service and
App Server restart preserved the lead and worker conversations, five
coordination callbacks succeeded, both worker result revisions were recorded,
and the task reached `done` with a finalized completion request. Registered
coordination tools were present on resumed conversations:
`ensemble_delegate`, `ensemble_report_result`, `ensemble_ask_question`,
`ensemble_request_approval`, `ensemble_request_follow_up`, and
`ensemble_request_completion`. TypeSafe calls were zero; routing was disabled
and no TypeSafe client was configured.

The journey used disposable project/task
`787098e9-d6f1-4ca8-8c5c-4575b335cfa1` /
`2394bf5d-8cb1-4e48-be1f-606012507b53`, lead assignment
`0682fd47-6f7f-4ad1-9e01-bc6de8e2820d`, and worker assignment
`1d4b492e-c504-4b48-aa10-0a0bb6ef1101`. The first worker result was
`a0d50ccb-b250-4ecd-bb3f-5a9172743aac`; the follow-up result was
`8f83e34c-043a-4b7d-833e-9b6587f5b73f`. At the explicit
`worker-revision-result-completed` checkpoint, the first result event
`c3a152b3-7264-41a6-bb6c-3a1bb45ad9fb` and follow-up event
`20526e1c-6f4b-40fd-b58a-587612ce88a8` were delivered, while second result
event `eea80219-fee6-4bb1-91d9-c98855f6b329` was queued for the resumed lead.
That snapshot precedes the lead's completion callback and is not a claim about
final delivery state. The harness separately verified the callback, completed
lead work, finalized request, final task state, and identity uniqueness.

| Callback | Thread / turn | Callback ID and bound work |
| --- | --- | --- |
| Lead delegates | `01a0f18d-96df-7f93-82f8-3ee936b61f78` / `01a0f18d-9863-7031-872e-0ac8cb29e991` | `exec-dc98eb18-3e73-41e2-8c24-c061f0b7f07f`; `assignment:0682fd47-6f7f-4ad1-9e01-bc6de8e2820d:initial`; success |
| Worker reports revision 1 | `01a0f18d-d9e5-7e63-97c2-163d47f6d0dd` / `01a0f18d-da5a-7433-a474-d22d4713f8b8` | `exec-0aabbe5b-00cf-451b-856b-4dc81ccad5f5`; `assignment:1d4b492e-c504-4b48-aa10-0a0bb6ef1101:initial`; success |
| Lead requests follow-up | `01a0f18d-96df-7f93-82f8-3ee936b61f78` / `01a0f18e-037f-7882-b3e6-f5acc5785215` | `exec-359067a2-4b4a-481a-ace0-7ac55b97acb1`; `assignment:0682fd47-6f7f-4ad1-9e01-bc6de8e2820d:v1:inbox:c3a152b3-7264-41a6-bb6c-3a1bb45ad9fb`; success |
| Worker reports revision 2 | `01a0f18d-d9e5-7e63-97c2-163d47f6d0dd` / `01a0f18e-3c89-70d3-ab5f-7250335e581e` | `exec-47fda9c9-18c3-4590-b50d-4054d1e86a82`; `assignment:1d4b492e-c504-4b48-aa10-0a0bb6ef1101:v2:inbox:20526e1c-6f4b-40fd-b58a-587612ce88a8`; success |
| Lead requests completion | `01a0f18d-96df-7f93-82f8-3ee936b61f78` / `01a0f18e-61b5-7ca0-a3bd-b2002980e87b` | `exec-8aaab7f7-d0d4-44ca-8f7d-a861b43f7fa4`; `assignment:0682fd47-6f7f-4ad1-9e01-bc6de8e2820d:v1:inbox:eea80219-fee6-4bb1-91d9-c98855f6b329`; success |

Cleanup removed the temporary fixture and verified App Server process identities
`64881` (started 10:03:02) and `65531` (started 10:03:30) had exited. Shared
Codex configuration was not read or changed; provider-side Codex thread records
may remain because the harness does not request their deletion.

## Verdict

**Passed for the latest bounded journey:** after service and Codex App Server
restart, the existing lead and worker conversations resumed with registered
coordination tools, callbacks were received, both worker results were recorded,
the lead requested completion, and the task reached `done`. The harness's
callback, result, event, and turn identity uniqueness assertions passed.

One earlier bounded attempt at `30b6cac88ba48f395c08462469d8367cb31bb6cb`
received a successful delegation callback but did not observe lead terminal
completion within 240 seconds. The single authorized retry changed only the
disposable task's prompt: it directed the lead to call `ensemble_delegate` once
and end that turn immediately, processing the durable result only after resume.
Production scheduling and capacity behavior were not changed for this retry.

## Earlier runtime trace (`5e68d898`)

The harness created a disposable project/task (`195efc50-4690-44a3-b0b2-aed587f867d0`,
`1ad1f4f5-6f98-4158-a1d3-6db6d11de56e`) with lead assignment
`dda19465-42d5-48ab-9845-88591397ffb1` and worker assignment
`b6a5501f-0e8d-4547-9668-f100434255a8`. Routing was disabled and capacity was
one.

| Stage | Conversation / turn | Callback and bound work |
| --- | --- | --- |
| Lead delegates once | Lead thread `01a0f143-b119-79f1-bbcb-dc4bdfb57bd6`; turn `01a0f143-b202-7be0-871a-3bd89ef45376` | `exec-ea44f252-d11f-461d-92b1-fcd47adfb5e1`, `ensemble_delegate`, exact worker profile `c0fec849-8e13-4024-9225-5b9218a757a4`; lead work `assignment:dda19465-42d5-48ab-9845-88591397ffb1:initial`; success |
| Worker reports first result | Worker thread `01a0f144-cef0-7000-92f4-380158a67e22`; turn `01a0f144-d0fb-71c1-ad75-ee717d034527` | `exec-2239c86e-4948-4aeb-b725-b65394c957e3`, `ensemble_report_result`; work `assignment:b6a5501f-0e8d-4547-9668-f100434255a8:initial`; success |
| Resumed lead requests follow-up | Same lead thread; resumed turn `01a0f145-5126-76e0-952e-8a4628a3ecdb` | `exec-f75e2153-b13e-47aa-9124-9130656a1d87`, `ensemble_request_follow_up`; work `assignment:dda19465-42d5-48ab-9845-88591397ffb1:v1:inbox:8cccd0f5-7ce7-4eb1-9e2c-6fa647e5e50c`; success |
| Worker reports revision 2 | Same worker thread; resumed turn `01a0f146-9089-7cd3-aa1c-78d3dbcca6a7` | `exec-41831443-c21d-4add-9e11-ab814f243e68`, `ensemble_report_result`; work `assignment:b6a5501f-0e8d-4547-9668-f100434255a8:v2:inbox:d77be8bf-adf1-405e-941e-837fa8a3b553`; success |
| Resumed lead requests completion | Same lead thread; resumed turn `01a0f146-c912-78b2-8fef-e3b797ce9fba` | `exec-467678bf-ee96-4747-b1f8-5fad762dae00`, `ensemble_request_completion`; work `assignment:dda19465-42d5-48ab-9845-88591397ffb1:v1:inbox:39762356-5994-480f-83ba-79c2e7e22e68`; success |

The restarted App Server registered `ensemble_delegate`,
`ensemble_report_result`, `ensemble_ask_question`,
`ensemble_request_approval`, `ensemble_request_follow_up`, and
`ensemble_request_completion` on each resumed lead/worker conversation. Five
callbacks were observed. The worker stayed on its original assignment and
profile; its first result had work revision 1 and its follow-up result had work
revision 2. Both results had resolved exact recipients
(`destinationDisposition: delivered`).

The event-state snapshot was taken at the `worker-revision-result-completed`
checkpoint, before the resumed lead picked up its second result. At that point,
event `8cccd0f5-7ce7-4eb1-9e2c-6fa647e5e50c` (first result to the lead) and event
`d77be8bf-adf1-405e-941e-837fa8a3b553` (follow-up to the worker) were delivered;
event `39762356-5994-480f-83ba-79c2e7e22e68` (second result to the lead) was
queued. That queued value is a pre-delivery checkpoint, not the final task
state: the subsequent completion callback was bound to the work ID containing
that event, its terminal work completed, and the task finalized. The harness
asserted one finalized completion request and final task state `done`.

The same lead thread ID was preserved across resume, and resumed turns/callback
IDs were distinct. No duplicate result, event, or turn identity was observed.

| Result | Assignment/work | Revision | Exact recipient disposition |
| --- | --- | --- | --- |
| `5abee639-bf75-448b-9e42-e469e467768b` | `b6a5501f-0e8d-4547-9668-f100434255a8` / `assignment:b6a5501f-0e8d-4547-9668-f100434255a8:initial` | 1 | `delivered`; lead inbox event `8cccd0f5-7ce7-4eb1-9e2c-6fa647e5e50c` |
| `9ea550d0-2c24-4bfd-9421-4dde5ac8593c` | `b6a5501f-0e8d-4547-9668-f100434255a8` / `assignment:b6a5501f-0e8d-4547-9668-f100434255a8:v2:inbox:d77be8bf-adf1-405e-941e-837fa8a3b553` | 2 | `delivered`; lead inbox event `39762356-5994-480f-83ba-79c2e7e22e68` |

## Earlier cleanup and limits

The harness created and removed the temporary fixture and managed task
workspace. Codex App Server process IDs `8367` (reported start time 08:42:19)
and `9099` (reported start time 08:44:06) were both verified exited. TypeSafe
calls: `0` (routing disabled; no TypeSafe client). Shared Codex configuration
was not read or changed. The harness does not request deletion of provider-side
Codex thread records, which may remain.

This is not evidence for TypeSafe quality/cost, production operator UI or
authentication, Tailscale access, universal resumed-thread reattachment,
physical sleep/wake, detached-child containment, or deployment/cutover. Those
remain separate acceptance work, including #694, #695, #703, and S05.
