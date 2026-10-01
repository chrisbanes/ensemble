# UI01 native input qualification

Issue [#739](https://github.com/chrisbanes/ensemble/issues/739), approved
[plan revision 1](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5942570298).
T1 preparation against `1a643463769b2c87f1503b22f9fb14068160d846`, 2 October 2026.

**Native availability and the operational receipt are unproved.** This candidate
prepares the protocol experiment and deterministic fixtures. It starts no real
Codex model turn and changes no production adapter, package, configuration, login
or installed service. T2–T6 remain gated on a passing live T1 result.

## Read-only installed evidence

`/opt/homebrew/bin/codex --version` reports `codex-cli 0.159.0`.
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
| Native availability under ordinary production settings | Unproved; requires the single live experiment |
| Blocking input with no auto-resolution | Fixture-qualified; only `true` / `null` is accepted live |
| Single choice | Fixture-qualified; fixed delivery options Local/Remote |
| Free text / grouped questions | Schema candidate; live support only if observed in the fixed request |
| Custom text | Fixture-qualified; live support only when `isOther` explicitly permits it |
| Multiple selection / explicit recommendation | Unsupported by the inspected schema; never inferred from arrays or label suffixes |
| Nonblocking / timed resolution / secret answers | Unsupported by this qualification |
| Same-turn answer consumption | Fixture-qualified report/nonce; live observation unproved |
| Service persistence, hold/restart integration, production UI | Untested here; later approved slices |

## Prepared protocol command

After pinned build and independent review, the lead runs exactly:

```sh
PATH=/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:$PATH /tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node test/ui01/runtime-contract.mjs --live --phase protocol
```

The CLI accepts only those three arguments. It uses existing ChatGPT login,
`experimentalApi: true`, `never`, `workspace-write`, a private marked workspace,
and the existing explicit per-turn workspace policy with network disabled and
both temporary-root exclusions. It supplies no collaboration-mode override.
There is one disposable repository-free task/thread, one turn, one native request
and one reporting callback. The native request deadline is 90 seconds; the total
budget is 240 seconds, reserving 10 seconds for scoped cleanup. There is no retry.

At the blocked checkpoint the probe has sent zero native replies and observed
no resolution, report or terminal. The synthetic answer, command receipt and
immutable intent/digest commit in one real SQLite transaction; a second connection
reads them while replies remain zero. The one reply preserves the typed RPC id.
Sequence evidence distinguishes write initiation, stdin callback and native
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
