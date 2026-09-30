# S04b live runtime evidence

Run on 30 September 2026 using the bounded `npm run s04b:live` harness at
source revision `5e68d8989ac62da3af6e791f0f036949d15a92f5`. This report records
the successful final run; the harness used Node.js `v24.21.0`, npm `12.1.0`,
and `codex-cli 0.159.0`.

## Verdict

**Passed for the bounded journey tested:** after service and Codex App Server
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

## Runtime trace

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

## Cleanup and limits

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
