# UI01 native input qualification

Issue [#739](https://github.com/chrisbanes/ensemble/issues/739), approved
[plan revision 2](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5952311804),
prepared against `e544bcb8f7b9a6dc8b716d429937f4017fa3a444`, 2 October 2026.

**The additional replay-repair T1 failed at the consumption witness; its grant is consumed.**
The [additional one-turn resume](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5954021251)
ran the reviewed exact-replay repair. It observed the direct synchronous native
callback, Default/settings, one exact resume replay, held-zero checkpoint, durable
answer readback, one exact reply and confirmed ordered receipt. The turn ended
without the required answer-consumption report. No complete T1 pass is claimed.
Exact process cleanup was verified; failed fixtures and the committed answer/receipt
remain preserved. The earlier zero-turn and duplicate-notification failures below
remain historical evidence. No retry is authorized. T2–T6, #743 and #745 remain
gated; T6 has no live grant. No production adapter, login, global configuration
or installed service was changed.

## Read-only installed evidence

`codex --version` reports `codex-cli 0.159.0`.
`codex app-server generate-ts --experimental` was refreshed without execution.
The generated bundle remains outside the repository. These SHA-256 fingerprints
identify the relevant definitions; the CLI refreshes fingerprints and records
its executable hash, revision, Node and npm versions before the experiment.

| Generated definition | SHA-256 |
| --- | --- |
| `v2/ToolRequestUserInputParams.ts` | `0e3063b70a99b815e170b3c157416924315308a1c8af201dcc2f3fb459e4144a` |
| `v2/ToolRequestUserInputQuestion.ts` | `d0eaa32baa3b41a8ee3a3b764e84ffd75f7474f385eebeb779fe61f18deb2b24` |
| `v2/ToolRequestUserInputOption.ts` | `ec2f4b008b872a96c8460f4a830b8d0c20b60ef0421541970e3db62f329ef485` |
| `v2/ToolRequestUserInputResponse.ts` | `39e4959095a1b31de3f7bf28422a6536d51d651581ad1f50bc5e30c02140498b` |
| `v2/ToolRequestUserInputAnswer.ts` | `271fbffc377b53570fae244df734bb666cb902bdff633bf27842a5bdd7e3d628` |
| `v2/ServerRequestResolvedNotification.ts` | `e428ba289071d7b2e04cedc8b3cd7e6adbe57409dbbc333c38178b316f122ec5` |
| `InitializeParams.ts` | `bfc13b4fc9e37f629ee67b42d6e7f342ba38668ff528e738a911de5ebcfd545f` |
| `v2/ThreadStartParams.ts` | `dc8bebec4181a5502fc141b0122cc48e066b3b5c77d9fd2a4de875fcd6d66a68` |
| `v2/TurnStartParams.ts` | `18a8492238c2b7476d1db5a96ec4dd57df6eb49e05e49f13820eb9298c412dfa` |

The request schema contains thread, turn, item, questions, `isBlocking` and
`autoResolutionMs`. Questions contain id, header, text, `isOther`, `isSecret`,
and nullable options; options contain label and description. Responses map each
question id to `{answers: string[]}`. Resolution has thread and typed request id
only. There is no explicit cardinality or recommended-option field.

| Capability | Current evidence / disposition |
| --- | --- |
| Native availability under ordinary production settings | Observed in the approved mode-order attempt; held waiting and full round trip remain unqualified |
| Synchronous Default input with no auto-resolution | Fixture-qualified; exact version/mode/route plus observed `false` / `null` and actual held waiting required |
| Single choice | Fixture-qualified; fixed delivery options Local/Remote |
| Standalone free text / grouped questions | Excluded from the renewed fixed proof; no live support claimed |
| Custom text | Fixture-qualified; live support only when `isOther` explicitly permits it |
| Multiple selection / explicit recommendation | Unsupported by the inspected schema; never inferred from arrays or label suffixes |
| Async / nonawaited / timed resolution / secret answers | Unsupported; flags alone never prove synchronous origin |
| Same-turn answer consumption | Fixture-qualified report/nonce; live observation unproved |
| Service persistence, hold/restart integration, production UI | Untested here; later approved slices |

## Protocol experiment contract

This section records revision 1. The approved revision-2 differences appear below;
the historical command and consumed grant do not authorize another run.

After independent review, the lead invoked this command using pinned Node
`24.21.0` and npm `12.2.0`:

```sh
node test/ui01/runtime-contract.mjs --live --phase protocol
```

This records the executed experiment; it does not authorize another run.

The CLI accepts only those three arguments. It uses existing ChatGPT login,
`experimentalApi: true`, `never`, `workspace-write`, a private marked workspace,
and the existing explicit per-turn workspace policy with network disabled and
both temporary-root exclusions. It supplies no collaboration-mode override.
The limits are one disposable repository-free task/thread, one turn, one native
request and one reporting callback. The native request deadline is 90 seconds;
the total budget is 240 seconds, reserving 10 seconds for scoped cleanup. There is no retry.

The harness requires a blocked checkpoint with zero native replies and no
resolution, report or terminal. The live attempt did not reach this checkpoint.
For a supported request the harness commits the synthetic answer, command receipt
and immutable intent/digest in one real SQLite transaction; a second connection
must read them while replies remain zero. The one reply preserves the typed RPC
id. Sequence evidence distinguishes write initiation, stdin callback and native
resolution. A resolution during the write waits for callback success. Neither
signal alone confirms receipt. Reporting callback resolution is tracked separately.
A matching report establishes experiment consumption, then its response must end
and the same turn must report successful completion. A nonce is introduced only
in the answer where a supported free/custom-text shape permits it.

Malformed, duplicate, mismatched, secret, unsupported, cancelled, failed or timed
out input stops the experiment. An absent optional variant is recorded explicitly;
an unsupported question actually supplied in the blocking request is never given
a fabricated answer. The proof reports failure if any mandatory contract fails.
A failed consumption experiment does not rewrite an already confirmed historical
runtime receipt, and cannot pass T1.

Only the created App Server is interrupted/terminated. Live cleanup uses the
existing same-boot process termination verifier; deterministic fixtures use the
observed exit of their exact child. Unproved cleanup prevents pass and retains the
fixture. Failure also retains fixture state. Owner-only sanitized JSON evidence
remains at the printed `evidencePath`; raw stderr and history are never retained.
Provider thread records may remain. Callback waiting retains the same process/turn;
this proves no suspension, released capacity or live reattachment.

## Deterministic validation

Public seams are the explicit CLI and exported disposable `runProtocol` fixture
runner. Fixtures are executable stdio App Servers; only OS/stdio failure boundaries
are injected. Red-to-green checks covered missing CLI/probe, committed pre-effect
readback, verifier exceptions, reporting resolution and bounded cleanup. The
receipt ordering, typed identity, failed-write, cancellation, duplicate, deadline,
unsupported-shape and retained-evidence tests exercise the same runner as live.

The implementation handoff records exact targeted/full check logs and the clean
candidate HEAD. These automated results qualify harness behavior only. No live
pass, production confirmation contract or UI01 completion is claimed by this file.

Pinned Node `24.21.0` / npm `12.2.0`: `npm ci` passed; `npm run check`
passed all **334 tests**, with no failures, cancellations or skips. All **20**
new harness tests passed. The initial sandboxed check failed eight existing
loopback HTTP/browser tests with `listen EPERM`; the exact check passed when
rerun with local process/network permissions. Existing lint warnings and the
Biome schema-version informational diagnostic remain. `git diff --check` passed.

## Startup envelope repair

The lead's first protocol attempt at `ab7d786836a2406f3d9cd2b4cfd10b1cb4f0acff`
stopped during `initialize-and-policy` with `oversized-message`. It created
**zero threads and zero turns**, with no native request, answer or report. The
exact created process `49274` was independently verified absent on the same boot.
Its sanitized evidence artifact, `ensemble-ui01-protocol-UzleQs.json`, is retained
by the lead with the failed fixture.
This attempt proves a harness startup defect, not a native capability failure.

The subsequent lead-owned startup-only diagnostic observed initialize at 180
bytes, account/read at 274 bytes, notifications at 210/105 bytes, and the
**config/read response at 1,601,330 bytes**. It retained message types and byte
counts only, no configuration payload. It also created **zero threads and zero
turns**; exact process `50666` was independently verified absent on the same boot.
The sanitized diagnostic artifact is `ensemble-ui01-startup-diagnostic.json`.

The repaired probe keeps the 1 MiB limit for every other message. Only an exact
typed pending `config/read` response with no RPC error can use an envelope up to
2 MiB. The pending request records its method; type-coerced or unknown ids do not
qualify for the exception. Message size uses UTF-8 bytes rather than string length.
The response is projected immediately to `approval_policy` and `sandbox_mode`;
unrelated config fields are discarded and never serialized into evidence.
Startup evidence records only the fixed method and byte count. Execution settings,
native callback/receipt semantics, total/request budgets and cleanup are unchanged.

Executable-fixture regressions first failed for the observed-size config response
and oversized multibyte native input, then passed after this repair. Native/unknown
messages, other responses, wrong-typed config ids, config error responses and
config above 2 MiB still fail closed. **27 harness tests pass.** This is an ordinary
harness interoperability repair; no factual-plan-mismatch budget is consumed.
Live native availability and the operational receipt remain **unproved**.

The repaired candidate passed pinned `npm run check`: **341 tests**, no failures,
cancellations or skips. All 27 harness tests passed. The sandboxed check again
failed only the eight existing loopback HTTP/browser tests; the exact rerun with
local process/network permissions passed. Final diff whitespace validation passed.
No App Server or real model turn was executed by the repair owner.

## Bounded live result — 2 October 2026

The lead ran the independently reviewed repaired harness at
`7ca45e15f749f5b854ffcc1e1849321833749421`. The runtime was
`codex-cli 0.159.0`, executable SHA-256
`e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a`,
with the schema fingerprints above. Existing ChatGPT login, experimental API,
`never`, `workspace-write`, the explicit workspace-only write roots, disabled
network, both temporary-root exclusions and no collaboration-mode override were
retained. Startup successfully consumed the 1,601,330-byte `config/read` response
without retaining its unrelated payload.

| Observation | Result |
| --- | --- |
| Created disposable tasks / threads / model turns | 1 / 1 / 1 |
| Native input requests / replies / reporting callbacks | 0 / 0 / 0 |
| Input deadline / total budget / reserved cleanup | 90 s / 240 s / 10 s |
| Failure stage / reason | `native-request` / `terminal-before-receipt-or-report` |
| Live native availability / operational receipt / answer consumption | Unproved / unproved / unproved |
| Qualified endpoint item / typed request id | None established |
| Fixture | Retained; removal was not attempted after failed proof |
| Created process | `68482`, birth identity `Fri Oct  2 00:59:52 2026` |
| Scoped cleanup | Interrupt requested; exact process exit independently verified on the same boot by `mac-pid-absent-same-boot` at `2026-10-02T00:00:02.780Z` |

The sanitized artifact `ensemble-ui01-protocol-vaBwMI.json` and failed fixture
remain with the lead. Raw stderr, model history, unrelated configuration and
credentials are excluded from this document. Provider thread records may remain;
cleanup did not request their deletion. No durable native answer, reply intent,
callback receipt or consumption report was created because no native request was
observed.

The mandatory T1 transport contract failed qualification: this one-turn experiment
did not demonstrate a usable native blocking/no-auto-resolution callback, its
qualified receipt, or the same-turn answer-consumption round trip. This result
leaves broader runtime availability and the cause unresolved.
The one-turn proof budget is consumed. Stop T2–T6, keep #739 incomplete and
[#743](https://github.com/chrisbanes/ensemble/issues/743) /
[#745](https://github.com/chrisbanes/ensemble/issues/745) gated, and request an
upstream scope decision before any retry or change to the accepted contract.
There was no plaintext answer substitute, second turn or policy/mode change.

All existing S01 trust and recovery boundaries remain: successful terminal alone
does not qualify this native proof, historical resume is not live reattachment,
and no crash, Stop, ownership or unresolved-execution hold is released by this
result. The exact created App Server's verified exit is scoped cleanup evidence;
it is no guarantee of descendant containment or an independent Ensemble sandbox.

This final change is documentation only. Reuse the repaired harness's passing
341-test full check and 27-test targeted evidence; proportional validation checks
this document's facts, scope, privacy and diff whitespace. The documentation owner
ran no App Server or model turn.

## Approved renewal preparation — revision 2

This section preserves the reviewed preparation at `9227d741250f1ea7825ae75c7417c901181eeb4b`.
Its live attempt and the proposed mode-order repair are recorded below. The
pre-turn readback described here failed; it is not the proposed new order.

The prompt now directly invokes `functions.request_user_input` synchronously once
and awaits it. It forbids exec/ALL_TOOLS discovery, async or nonawaited substitutes,
plaintext fallback and unsupported question variants. The fixed request is one
Delivery question with Local/Remote options. A custom answer carries the fresh
nonce only if the observed request explicitly permits `isOther`; otherwise the
answer is Local and the supported-shape evidence remains narrower.

The installed executable is resolved once and the same path supplies version,
schema generation and runtime launch. Eligibility requires `codex-cli 0.159.0`
and executable SHA-256
`e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a`.
Immediately after thread creation, a same-thread `thread/resume` reads effective
mode without model, effort, mode or instruction overrides. Exact thread, Default,
unchanged model/provider/effort/tier and matching mode settings are required before
the sole turn. Private instructions are projected to a digest and discarded;
raw configuration/history/instructions are never retained in evidence.

The source-qualified synchronous RPC has no tool-name field. Tagged
[direct registration](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/tools/spec_plan.rs#L1169),
[synchronous handler](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/tools/handlers/request_user_input.rs#L74)
and [session wait](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/session/mod.rs#L3110)
explain the direct-only tool and Default false/null metadata while awaiting the answer.
The tagged [async handler](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/tools/handlers/request_user_input_async.rs#L127)
instead emits an async AgentMessage with questions and returns accepted; its inspected
source SHA-256 is `16be7e521e3f91aaede5bd233a52671e0cd5454ef4d8a4a67eeb71908ab06096`.
The source path/tag/fingerprint is recorded as inspected attribution, not a claim
of runtime tool-history completeness. Explicit async delivery/question markers,
async function outputs and async/unknown server-request methods fail proof.
Unattributable alternative origins remain unproved; no universal tool allowlist
or exhaustive history requirement is added.

Selected installed schema fingerprints added to each live evidence artifact:

| Generated definition | SHA-256 |
| --- | --- |
| `v2/ThreadResumeResponse.ts` | `080196e4c158212de187a0d3331de28bf8a62df17d90663cf5d1fc2665dd8177` |
| `CollaborationMode.ts` | `b45d07e3c94550cff97e3d57d33045bd2d47b26a5f25a918fe2978cb08e0948f` |
| `Settings.ts` | `75a444fb4aa9ce8c906871e5eedeaa04f4da1943fe89906725be16f582044066` |
| `v2/ThreadItem.ts` | `047df9febb13b40263fb5b0abe244171c4dcb5e83229bbf9efba31abae840746` |
| `v2/ItemStartedNotification.ts` | `99f52740d4e34f5c2b9850953ef8b41aaf3283ff3a733021d04a2dcec3681cce` |
| `v2/AgentMessageDelivery.ts` | `2fa497987aab791b697c9dee5cdd634ec566bf0b82cd56b5a796f26241a95957` |

The held checkpoint still requires zero reply/resolution/report/terminal effects.
Committed answer, command receipt and immutable reply intent must be read through
an independent SQLite connection before the exact typed reply. The original
ordered stdin/resolution predicate and same-turn report/nonce/successful terminal
remain required. Async evidence before write prevents all answer effects; later
async evidence fails proof and retains uncertain effects or an already confirmed
historical receipt without rewriting it. Exact process cleanup and retained failed
fixtures remain unchanged. A new fixture process with reused textual endpoint IDs
cannot replay a failed generation's answer; this is deterministic harness evidence,
not service restart or live reattachment qualification.

Only the root may invoke the renewed proof after fresh independent review: one
thread/turn/request/reply/report, request deadline 90 seconds, total 240 seconds
including 10 seconds cleanup, existing model/login, never/workspace-write,
disabled network and workspace-only write roots. Any qualification failure retains
evidence, stops T2–T6 and leaves UI01 incomplete. No renewed model turn was run by
the repair owner; no ownership or recovery hold was released.

Revision-2 deterministic validation used pinned Node `24.21.0` / npm `12.2.0`.
The fresh build passed, targeted harness tests passed **57/57**, and the fresh full
`npm run check` passed **513/513** with no failures, cancellations or skips. The
sandboxed attempt encountered the existing localhost `listen EPERM` boundary;
the exact command passed with local process/network permissions. Existing lint,
Biome schema-version and Vite directive warnings remain. No real App Server/model
turn was included. These results qualify the harness only. The final candidate
packet binds exact file/diff and fresh log hashes; historical 334/341-test logs
above do not validate this new candidate. Final diff whitespace validation passed.

## Revision-2 zero-turn failure and proposed mode-order repair

Root invoked the reviewed candidate at
`9227d741250f1ea7825ae75c7417c901181eeb4b`. The attempt created one disposable
thread, but `thread/resume` failed before `turn/start`:

| Observation | Result |
| --- | --- |
| Threads / model turns / native requests / replies / reports | 1 / 0 / 0 / 0 / 0 |
| Failure stage / reason | `effective-mode` / `rpc-failed` |
| Answer persistence / receipt / consumption | None / unavailable / unproved |
| Native Default, waiting and round trip | Unproved |
| Scoped cleanup | Exact created process exit independently verified on the same boot |
| Failed fixture | Retained; no hold or ownership release |

The private sanitized live artifact remains with root at
`/tmp/ensemble-ui01-approved-t1-live-20261002.json`. Root's separate zero-turn
metadata diagnosis, `/tmp/ensemble-ui01-zero-turn-mode-diagnostic.json`, received
`-32600` (no rollout found) both with the earlier overrides and with identity-only
resume. It dispatched zero turns and independently verified exact process cleanup.
The generated `ThreadResumeParams` documents active-thread rejoin by thread ID;
root's tagged-source diagnosis establishes that the first turn persists the rollout.
Neither diagnosis nor schema evidence qualifies live input or effective Default.

**Proposed, pending explicit decision:** retain source/version/login/policy checks
before the single turn. Bind the exact `turn/start` response and native callback;
while that callback is held unanswered, issue only
`thread/resume {threadId}`. Supply no approval, sandbox, tools, config, model,
effort, workspace, history, path or instruction overrides. Require exact-thread
Default, unchanged start model/provider/effort/tier and matching mode settings,
projecting private instructions to a digest and discarding raw history. This
observes mode after the first turn starts; it cannot prove that first turn's mode
before actual provider readback. Missing, conflicting or failed readback stops
with zero answers/replies and retained evidence, even though one turn may have run.

Only after valid readback may the harness validate synchronous false/null shape,
hold for the unchanged 250 ms zero-effect checkpoint, commit/read back the answer,
command receipt and immutable intent, reply once and prove the existing ordered
receipt, consumption report and successful same-turn terminal. Early resolution,
report, terminal, async or foreign identity while mode readback is pending fails
closed before answer persistence or reply. The 90-second native request deadline,
240-second total budget and 10-second cleanup reserve remain unchanged. No second
turn, alternate origin/shape, policy/mode override, ownership release or T2–T6
implementation is included. This repair's fixtures cannot prove actual active
resume while native input is held; that remains a live boundary for root review.

The schema-faithful fixture now rejects resume before the first turn and accepts
only identity-only rejoin while the native callback remains unanswered. The
positive regression first failed under the old ordering, then passed after the
move. Wrong/missing mode/settings now consume one fixture turn and zero replies;
regressions cover delayed readback, RPC failure/timeout and pending-mode confounders,
with no SQLite answer file before qualification. Source mismatches still create
zero threads/turns. Prior receipt, config privacy, held-checkpoint and cleanup
safeguards remain covered. No real runtime/model turn was run by the repair owner.

The existing grant stopped on the failed attempt. A numerically unused model turn
does not authorize rerun. Root retains the architectural decision, fresh independent
review and any final approval request. Until that explicit decision, keep UI01
unqualified, preserve prior artifacts/holds and do not invoke the live CLI again.

Mode-order repair preparation passed fresh pinned Node `24.21.0` / npm `12.2.0`
build, **66/66** targeted harness cases and **522/522** full-check tests, with no
failures, cancellations or skips. The sandboxed full check hit existing localhost
`listen EPERM`; its log was preserved and the exact command passed with local
process/network permissions. Final diff whitespace validation passed. The new
repair packet binds fresh logs and file/diff hashes separately from the earlier
57/513-test preparation. This validates deterministic repair only, leaves the
existing grant stopped and does not qualify live held-callback mode readback.

## Approved mode-order live attempt — failed, no retry

At reviewed head `a84c92696b03d8daeed74b33ead51597ede7c2cb`, root ran the
single explicitly approved attempt with existing login/model and unchanged
90-second request / 240-second total / 10-second cleanup-reserve limits.

| Observation | Result |
| --- | --- |
| Threads / model turns / native requests accepted / replies / reports | 1 / 1 / 1 / 0 / 0 |
| Native callback | Synchronous `isBlocking=false`, `autoResolutionMs=null`; Local/Remote plus explicit custom text |
| Same-thread mode readback | Default with unchanged model/provider/effort/tier and projected instruction digest |
| Failure stage / reason | `blocked-checkpoint` / `duplicate-native-request` |
| Answer persistence / receipt / consumption | None / unavailable / unproved |
| Scoped cleanup | Exact created process exit independently verified on the same boot |
| Failed fixture and previous attempts | Retained; no hold or ownership release |

The harness retained the first callback identity but did not capture the second
notification's identity/body. The result cannot distinguish an identical provider
replay from a second model request. Source investigation may explain replay
semantics; it cannot retrospectively prove the discarded payload. No successful
held checkpoint, operational receipt or successful terminal is claimed. The
one-turn grant is consumed; deterministic investigation/repairs do not grant a
further real attempt. T2–T6 stay gated and T6 remains unauthorized.

Tagged-source follow-up explains an expected replay path: warm
[`thread/resume`](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L780)
queues the resume response, optional updates and pending callbacks even for an
already subscribed connection. The
[outgoing replay path](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/app-server/src/outgoing_message.rs#L446)
sends the stored server request with the same request ID/body; new server requests
allocate fresh IDs. This supports replay as the likely explanation, but does not
prove the discarded second payload was identical. A deterministic repair must
recognize only exact same-identity/body replay during that explicit rejoin window,
and continue rejecting new IDs, changed payloads and callbacks after reply.

## Deterministic exact resume-replay repair

The repaired harness accepts at most one repeated native delivery after the sole
explicit identity-only resume response and before any reply/resolution/report or
terminal. Every delivery still receives identity/envelope checks. The repeated
RPC method and typed ID, thread/turn/item and complete parsed parameters must match
the first callback structurally: array order, unknown fields and null versus absence
are significant; object key order is equivalent. The owned child receiver and
captured first process/generation provide provenance; callback parameters do not
independently attest a process or generation. No provider identity fields or general
replay framework were added.

An accepted replay records a separate observation and replay count while retaining
one unique request and the original endpoint. It creates no additional persistence,
reply or receipt. A rejected second native delivery retains only safe identity and
SHA-256 of its serialized complete parameters; raw duplicate body/history is not
exported. Rejection covers changed ID/type/body, foreign identity, pre-resume or
pre-response deliveries, excess replays and callbacks after a reply. Original
mode/settings/source qualification, 250 ms held-zero checkpoint, durable readback,
ordered receipt, consumption, terminal and cleanup gates remain unchanged.

A fixture matching resume response → optional status update → pending callback
first failed the old duplicate guard, then passed with one commit/reply and the
existing receipt/consumption/terminal proof. Regressions cover complete-body changes,
null/absence, option-array order, unknown fields, equivalent object-key order,
new/wrong-typed IDs, foreign identities, replay outside the response window, excess
replay, effects already begun and separate owned child generations reusing textual
RPC IDs. These are deterministic harness results only. The discarded second live
payload remains unknown; the likely source-level replay explanation cannot become
a retrospective identity claim.

The next proof delta, if separately authorized, is to observe at most one exact
resume replay separately from the sole native request, then reach the unchanged
held checkpoint and round trip. The actual one-turn grant is consumed, with zero
remaining model turns and no new live authority. No real runtime/model turn,
production adapter, T2–T6 work, setting change, remote mutation or ownership/hold
release was performed by the repair owner. Actual held waiting, receipt,
consumption and successful terminal remain unqualified.

Fresh replay-repair validation used pinned Node `24.21.0` / npm `12.2.0`:
build passed, targeted **83/83** and full `npm run check` **539/539**, with no
failures, cancellations or skips. The existing localhost `listen EPERM` sandbox
log was preserved; the exact command passed with local process/network permissions.
Final diff whitespace validation passed. Fresh log/file/diff hashes are bound in
the replay candidate packet; earlier passing logs remain historical. These checks
include no real runtime/model turn and confer no new live authority.

## Additional replay-repair live attempt — failed consumption witness

At reviewed head `341a21ef55be7ec0945c1bf2400f0d086732d49e`, root executed
exactly one newly approved bounded T1 turn under the unchanged deadlines and
receipt/consumption criteria.

| Observation | Result |
| --- | --- |
| Threads / model turns / unique native requests / replies / reports | 1 / 1 / 1 / 1 / 0 |
| Exact resume replay | One accepted; original callback/endpoint retained |
| Default/settings and synchronous native callback | Observed |
| Held-zero checkpoint and durable answer/intent readback before effect | Observed |
| Ordered stdin/native resolution receipt | Confirmed; retained despite later proof failure |
| Failure stage / reason | `receipt-and-consumption` / `terminal-before-receipt-or-report` |
| Required consumption witness and complete qualification | Unproved / failed |
| Scoped cleanup | Exact created process exit independently verified on the same boot |
| Failed fixture, committed answer/intent/receipt | Retained; no replay or ownership release |

The existing CLI configuration and provider readback reported `gpt-6-astra` with
`medium` reasoning; the earlier mode-order attempt used `gpt-6.1-sol` / `high`.
Root did not override the model or change its global configuration. This attempt
qualified observed start/resume consistency, not identical settings across attempts.

Sanitized retained history contains one direct input call and no report call. The
visible final response says the reporting tool was accessible only through
`functions.exec`, which the prompt prohibited. This supports a prompt/access
conflict rather than proving failed native answer delivery. The original answer
and confirmed receipt remain facts; history does not replace the required report
or qualify a complete successful handoff. A proposed narrow correction would keep
input direct-only and forbid discovery/other calls, while permitting only the
known reporting tool after the native answer. Independent contract review is
pending. The consumed grant gives no further live-turn authority; T2–T6 remain gated.

## Deterministic reporting-tool access repair

The prompt now separates the input and reporting phases. Native input remains one
synchronous direct `functions.request_user_input` call. Before its answer, exec,
ALL_TOOLS/search/discovery, async/nonawaited calls and plaintext input fallback
remain prohibited. Only after the native answer may the model invoke
`functions.exec` once, containing solely the awaited known call
`await tools.ui01_report_answers({answers: <exact received answers map>})`, await
its result and end. Discovery and other calls remain prohibited. The prompt contains
no synthetic nonce or answer; the report must copy the actual received answer map.

Tagged [native registration](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/tools/spec_plan.rs#L1169)
marks the input tool direct-only. The ordinary
[dynamic tool handler](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/tools/handlers/dynamic.rs#L38)
awaits its RPC response; [plain-name mapping](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/tools/src/code_mode.rs#L230)
and [code-mode description](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/code-mode-protocol/src/description.rs#L20)
explain the known reporting call through code mode. This narrow access correction
is source/fixture evidence, not a successful live consumption witness.

The fake provider checks separate direct-input, pre-answer prohibitions and
post-answer known-report clauses, rather than accepting isolated keyword presence.
The new prompt regression failed the original blanket ban, then passed the phase
exception and original public-seam round trip. A missing-report fixture preserves
a confirmed native receipt while proof fails at the unchanged consumption/terminal
gate. A discovery callback cannot impersonate the known report, and the existing
incorrect-report test still rejects an unequal answer map. Native RPC identity,
unique counts, report equality/count, report callback ending, receipt ordering,
held checkpoint and successful-terminal gates were not modified.

This repair leaves the existing CLI model/configuration alone. The last provider
readback was Astra/medium and the previous attempt Sol/high; only within-attempt
start/resume consistency was observed. No identical-settings claim across attempts
is made. The current one-turn grant is consumed: numerical remaining turns zero,
new live authority zero. No real runtime/model turn, production adapter/T2–T6 work,
setting change, remote action or hold/ownership release was performed. Actual
consumption and complete successful qualification remain unproved. A separately
authorized next proof would use only this post-answer report access route while
retaining all existing native/mode/replay/persistence/receipt/terminal criteria.

Fresh reporting-access repair validation used pinned Node `24.21.0` / npm `12.2.0`:
build passed, targeted **85/85** and full `npm run check` **541/541**, with no
failures, cancellations or skips. The existing localhost `listen EPERM` sandbox
log was preserved and the exact command passed with local process/network
permissions. Final diff whitespace validation passed. The new candidate packet
binds fresh file/diff/log hashes separately from earlier preparation. These
deterministic checks include no real runtime/model turn or new live authority.

## Renewed T1 protocol qualification — passed

Root ran the separately granted proof at reviewed head
7dbd2afd13bf7e2372d99c408704594af70c0cfa under
[resume 5955887756](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5955887756).
The [durable outcome](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5955928383)
records one thread, one model turn, one unique synchronous native question, one
reply and one exact answer-only consumption report. One identical warm-resume
replay was observed separately. The 250 ms zero-reply checkpoint preceded answer
and intent commit and independent SQLite readback. Initiated write, successful
stdin callback and matching native resolution confirmed the receipt before the
report callback ended and the same-turn successful terminal.

Codex 0.159.0, effective Default and preserved settings were verified inside
this attempt (gpt-6.1-sol, high). Earlier Astra/medium attempts remain history;
there is no claim of identical settings across attempts. Root independently
verified exact PID 19056 absent on the same boot and removed the successful
fixture. Earlier failed fixtures, accepted answers and confirmed receipts remain
preserved. Private result SHA-256:
3dcc3dcade860fcfa9288e8dfa21b4b3c46f53f2f2dbf28ca0859e5998cbe6e6.
The finite T1 grant is consumed. This proves the protocol only; it grants no
further turn and does not qualify production forms or the integrated service.

## Native adapter and durable service seam

The adapter admits only the exact qualified executable/version and synchronous
native RPC route. It holds the callback while the bound turn's identity-only
warm resume verifies Default, unchanged model/provider/effort/tier and a private
instruction digest. No mode or instruction override is sent. Non-Default,
unknown version/hash, async markers, true/blocking metadata, timed resolution,
secret questions, standalone free text, multiple selection and explicit native
recommendation fields remain unsupported. Single choice and permitted custom
text are observed in T1. Grouped sets of those shapes are validated
**deterministically only**, with no grouped live-support claim.

CoordinationStore persists the interaction, exact endpoint and attention before
exposure; a complete answer and operator receipt commit before the answer command
returns. Native answers create no ordinary inbox event or new turn. Immutable
reply intent commits inside the final synchronous eligibility gate immediately
before write. Successful stdin alone is sent-unconfirmed. Resolution before write
makes the endpoint unavailable; resolution during write waits for successful
stdin completion. Write errors, Stop/cancellation, lost/replaced process, wrong
thread or typed request identity cannot confirm. Duplicate confirmation and later
controls preserve the historical receipt. The service commits the receipt before
settling its owned callback. A failed commit retains execution ownership and the
callback hold. Confirmation does not complete the assignment without its bound
successful terminal and ended callbacks, and releases no independent hold.

The curated CoordinationView task projection and answerRuntimeQuestion command
are the seam for UI05. They expose supported question text, answers and delivery
state, excluding process identity, qualification internals and private instructions.
Ordinary answerQuestion rejects native interactions. No React forms, browser
native-answer route, context-menu action, extension, deep link or notification
answer action is introduced; existing plain-text entry points retain their behavior.
Native request cancellation/Stop and conservative restart are the recovery paths;
no force-unlock or replacement-process answer replay is added.

### Deterministic acceptance coverage

| Contract | Test evidence |
| --- | --- |
| Source text and bounded qualified single/group schemas; invalid selections, unknown/incomplete IDs, secret/free-text/multiple/recommendation variants | native-input.test.ts |
| Current executable hash/version, Default readback, exact typed identity and one reply; an earlier async-origin marker remains disqualifying | codex-runtime.test.ts: qualified native runtime and unsupported version/mode/hash cases |
| Early resolution; buffered resolution before stdin success; successful write without resolution; write error; cancellation; wrong thread/type; replacement process; duplicate effect protection | codex-runtime.test.ts: native early resolution, stdin-only, ordered receipt matrix, replacement process |
| Question/answer persistence, immutable intent/digest, matching/conflicting command replay, no inbox, pending attention and monotonic confirmation | runtime-question-store.test.ts |
| Pause, unready, revoked profile, ownership, power, final-gate Stop, local/open/unknown imported dependencies, independent holds, exact two-task answer scope | runtime-question-service.test.ts: hold/dependency/final-gate/two-task matrix |
| Early native prebinding, exact/conflicting response, intervening Stop or changed process generation; failed receipt commit retains callback/ownership | runtime-question-service.test.ts: prebinding and failed commit cases |
| Restart after request, answer, reply intent, and write before confirmation; retained answers/receipts, uncertainty, zero restored turns/replies, delayed old resolution | runtime-question-store.test.ts and runtime-question-service.test.ts: four named boundaries |
| Pause after initiated reply preserves confirmation; Stop before confirmation stays uncertain | runtime-question-service.test.ts: post-intent control matrix |
| Existing approval rejection, ordinary coordination/inbox and operator runtime recovery | Existing runtime, coordination, standalone, S04b and operator-runtime regression suites |
| Service-mediated paused answer command, zero-reply independent committed SQLite readback, ordinary unpause, one exact reply/receipt/report/terminal, unsupported shape and unproved cleanup | ui01-live-harness.test.ts: service phase and failure cases |
| Awaited startup/stop/verifier deadlines retain unresolved identity; finite grant binds exact head/resource/budgets and atomic one-use consumption | ui01-live-harness.test.ts: three service deadline boundaries and synthetic grant admission (zero runtime execution) |

## T6 preparation — live service journey not granted

The deterministic service harness uses StandaloneService, real SQLite and its
curated answer command. A persisted project pause prevents every flush while the
answer command completes and a separate read-only connection verifies the
immutable answer and operator receipt, held delivery and absent reply intent.
Ordinary unpause releases one reply on the admitted requesting turn. Its one bound
answer-only reporting callback records the existing coordination result; no second
model turn or native reply is permitted. Fixture OS/process facts are identified
as deterministic, and cannot qualify actual runtime availability or cleanup.

The prepared command is npm run ui01:live, requiring a separate root-owned
finite grant and the canonical shared resource
existing-login:codex-app-server:qualification. The root must acquire the matching
resource/holder 739/fresh grant ID before execution. The CLI atomically consumes
that exact-head grant before metadata or runtime creation. Proposed limits remain
one task/thread/turn/request/reply/report, 90-second request deadline, 240 seconds
total with 10 seconds reserved for exact-process cleanup, no retry or settings/mode
fallback. Awaited startup, provisioning, answer command, service Stop and exact
process verification share those absolute deadlines. A timed-out cleanup wait
retains the unresolved identity and fixture; it never establishes successful Stop.
The typed runtime receipt retains endpoint-local sequence numbers for write
initiation, successful stdin completion and matching resolution, including a
resolution buffered before the stdin callback. Provider records may remain after scoped cleanup. Failed or unsettled
fixtures are retained. Only root may authorize and execute this later live journey;
no T6 actual turn has occurred during implementation. #739 remains unqualified
for the integrated service, and #743/#745 remain gated until the required live
result and final review. UI01–UI03 frontend acceptance and parent #736 remain separate.

### Same-thread turn reuse and storage-failure cleanup

The pre-repair frozen candidate passed root's pinned external full check:
**600/600**, no failures, skips or cancellations. That result belongs to its exact
source manifest; it does not qualify subsequent changes or replace actual T6.

Each new turn retires the previous ephemeral native readback before the provider
can emit an early callback. The new callback waits for the new turn response and
its identity-only Default/settings readback before exposure. Historical endpoints,
confirmed receipts and disqualified turn identities remain preserved. Actual
stdio fixtures cover a resumed thread's second question arriving before the
turn/start response, late old callback/terminal replay, conflicting new request,
async origin, non-Default readback and duplicate matching resolution. In that historical candidate, a replay
after reply initiation cancelled its still-unconfirmed endpoint and retained
uncertainty; the earlier confirmed receipt remains immutable.

Native invalidation failure during Stop joins the existing cleanup error
collection. Exact owned runtime, power, supervisor, database and owner cleanup
continue, and the original storage error is rethrown. A real SQLite abort trigger
verifies this path and repeated Stop; existing closed/cleared-database crash
cleanup retains its recovery behavior. The final focused repair matrix passed
**8/8**; the earlier interaction matrix passed **18/18**. These fixtures use no
actual model turn. Actual T6 remains pending a separate root-owned finite grant,
final reviewed source and the canonical shared qualification resource.

### Early resolution on a reused thread

Root's unchanged repair1 candidate passed pinned external full checks **608/608**;
that result belongs to the repair1 source manifest. Subsequent changes require
fresh validation, with actual T6 still pending separately.

A historical endpoint on the same thread cannot hide an early resolution of a
new pending request. Before qualification, resolution matching uses the current
attached process, exact thread and typed RPC identity. Matching resolution before
the new turn response makes that pending request unavailable: it is never exposed
as supported and cannot receive a later reply. The actual stdio two-turn fixture
asserts zero second-question exposure, zero later write-gate calls and an unchanged
first confirmed receipt. Wrong typed ID/foreign resolution, buffered receipt,
async-origin, warm/new-turn qualification and early service prebinding controls
remain covered; the affected matrix passed **21/21**. No model turn, authority,
settings change or new runtime guarantee is introduced by these deterministic
fixtures.


## T6 failure and approved delayed-replay repair

The separately approved T6 ran once at `af440a94079310616842691e0401ab02dc8629ff`.
Its [durable failure record](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5958685532)
records one thread, turn, request, reply and report. Default/settings qualification,
pause, durable answer and independent SQLite readback with zero replies passed.
After ordinary unpause, delivery became uncertain with conflicting or late native
replay. The execution retained its unfinished-callback hold until the deadline.
The rejected payload was not captured, so this result cannot establish whether
that live replay was identical or changed, or whether a later resolution arrived.
Root independently verified the exact child absent on its recorded boot before
releasing only its matching scheduler resource. The failed fixture, consumed
one-use ledger and recovery holds remain preserved; no retry was made.

Chris approved a narrow deterministic repair after reviewing this failure. One
exact warm-resume retransmission may arrive before exposure, during write, while
resolution is pending, or after confirmation while the requesting turn remains
active. It must match the current attached process, typed RPC ID and complete
request payload, follow that request's resume response, and consume its sole replay
allowance. It exposes no new question and causes no second answer, intent or reply.
Changed/excess deliveries, invalidated or terminal turns, lost/replaced processes
and unavailable/uncertain endpoints retain rejection and recovery behaviour.
Cancellation and interruption retire replay eligibility independently of the
immutable confirmed receipt.
A replay alone never confirms delivery: successful stdin and matching resolution
remain required, followed by committed confirmation, ended callbacks and a bound
successful terminal without other holds.

The actual stdio fixture now exercises retransmission after reply initiation,
including while the stdin callback is outstanding and after confirmation, plus
changed payload, typed-ID mismatch and excess replay rejection. A no-resolution
case remains sent-unconfirmed. The service fixture reproduces the original
uncertain-delivery/unfinished-callback failure before the repair, then exercises
pause, independent durable readback, one reply and settled completion afterwards.
Rejected-replay evidence includes safe endpoint identity, original/received payload
digests, endpoint state, replay count and equality; raw questions and configuration
are excluded. This repair covers the adapter shared by the curated service seam;
no new frontend, context-menu, deep-link or notification entry point is added.

These are deterministic repairs, not a live T6 pass. The original grant remains
consumed, PR #755 stays draft, #739 stays incomplete and dependent completion gates
remain. A reviewed new candidate and fresh finite authority are required before
another live invocation. #737 holds/settlement/fixtures and paused X scope are
unchanged.


Pinned Node `24.21.0` / npm `12.2.0` validation passed `npm ci --offline`,
type checking, lint, formatting, build and **619/619** full-check tests, with no
failures, cancellations or skips. The affected runtime/service/harness suite passed
**161/161**. Fresh independent review cleared correctness/standards,
reuse/clarity/efficiency and over-engineering after fixing cancellation eligibility
and adding an explicit replay-processing barrier to the outstanding-write test.
Both new cancellation regressions failed before their repair. The sandbox run's
localhost restrictions and a later unchanged scheduler test's 25 ms timing failure
were preserved; that scheduler test passed in isolation and the unchanged final
candidate passed the repeated full check. No live T6 turn was run during this repair.
