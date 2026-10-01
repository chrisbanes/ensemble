# X01 native Codex feasibility

**Disposition: X01 and X02 remain unproved.** The planned baseline exposes a supported standalone thread API, but the inspected public surfaces do not establish placement into a saved native project, linked native workers, or project/task navigation and change-view control. The same baseline has no existing task-scoped Ensemble human-handover and return operation. T1 therefore failed its prerequisite check; T2–T4 were skipped as unproved. No native project, task, worker, worktree fixture, or runtime turn was created.

This is a bounded finding about the installed App Server and SDK contracts inspected here and the exact Ensemble baseline. It does not prove that OpenAI can never expose such an API. Under [#724](https://github.com/chrisbanes/ensemble/issues/724) and its parent [#649](https://github.com/chrisbanes/ensemble/issues/649), this report does not pass X01/X02 or release [#725](https://github.com/chrisbanes/ensemble/issues/725).

## Evidence identity

| Evidence source | Identity and result |
| --- | --- |
| Planned Ensemble baseline | `8173a312a3e6a094e6280c2eaf0196ae1a070c61`; branch `cb/issue-724-native-proof`; clean before this evidence file was added |
| Accepted source packet | [PR #729](https://github.com/chrisbanes/ensemble/pull/729), still open and unmerged when checked; exact head `62ed7a986084fcb40bcb6b131e3d9632b30027c9`, based on the planned baseline |
| Desktop host | `/Applications/ChatGPT.app`; bundle `com.openai.codex`; Info.plist version `26.928.21956` |
| Codex CLI / App Server | `/opt/homebrew/bin/codex`; `codex-cli 0.159.0` |
| Local runtime used for version checks | Node `24.21.0`, matching `.node-version`; npm `12.1.0`, matching `package.json` (`npm@12.1.0`) |
| Disposable native identities | None. T2 did not run, so no saved-project ID, native task/thread IDs, change file, or task-worktree path exists to report. |

The product scope and X01/X02 acceptance source was the [accepted ADR-1006 and integration design in PR #729](https://github.com/chrisbanes/ensemble/tree/62ed7a986084fcb40bcb6b131e3d9632b30027c9). That source records the required behavior; it does not implement or qualify it.

## Public native API inventory

| Required capability | Inspected public surface | Result |
| --- | --- | --- |
| Standalone thread execution | The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) documents `codex.startThread()`, `thread.run()`, and `codex.resumeThread(threadId)`. [App Server](https://learn.chatgpt.com/docs/app-server) documents `thread/start`, `thread/resume`, `thread/fork`, thread read/list, turns, and `cwd`. | Supported for local Codex threads. This does not establish saved-project placement or a native task. |
| Saved-project identity and placement | The installed generated App Server request types contain no project request method. `ThreadStartParams` has no `projectId`; `ThreadMetadataUpdateParams` only patches Git metadata. A `Thread` response type has a `projectId` field, and the schema includes project-change notifications, but these provide no standalone project create/list/read/assign operation. | No qualifying standalone saved-project create/link API was identified. Project placement remains unproved. |
| Main task and linked worker | App Server exposes `thread/fork`; its thread type records `forkedFromId`, `parentThreadId`, and subagent metadata. The inspected request surface does not provide a standalone operation to create and link a worker conversation under a native main task. | Unproved. A history fork or subagent metadata is not evidence of the required task/worker relationship. |
| Native opening and change view | [Projects and chats](https://learn.chatgpt.com/docs/projects) describes saved projects, local folders, project chats, worktrees, and the review pane. It gives UI workflows; it does not document a standalone API to open a project/task or display its change view. The page also says Codex CLI does not expose the ChatGPT Projects view. | UI behavior is documented; standalone navigation and change-view control remain unproved. |
| Native execution status and control | App Server thread reads/lists expose thread status and status notifications; `turn/interrupt` requests cancellation of a specific active turn. These APIs do not express Ensemble task ownership or an explicit human handover and return. | Thread-level status/cancellation is supported. The required task-level ownership control is unproved. |

The installed request inventory was generated from the installed CLI with `codex app-server generate-ts`. It contains `Thread.projectId` and project notifications but no project RPC, no project selector on thread start, and no method that associates a thread with an existing saved project. Official OpenAI documentation was accessed on 1 October 2026. The public desktop tools available inside this Codex session (`mcp__codex_app__create_thread`, `mcp__codex_app__navigate_to_codex_page`, `mcp__codex_app__open_in_codex`, `mcp__codex_app__read_thread`, and `mcp__codex_app__wait_threads`) are host-mediated session tools. They are not an API available to the independent Ensemble service, so they were not counted as a qualifying integration.

## Ensemble ownership seam on the planned baseline

| Existing service surface | Contract observed | Why it does not satisfy handover |
| --- | --- | --- |
| `StandaloneServiceOptions` | Options cover routing, supervision, termination verification, workspace management, power, and retry. There is no native ownership or human-handover admission callback. | No public seam accepts and persists human task ownership. |
| `CodexRuntime.startThread` / `startTurn` | Start passes the workspace as `cwd` and returns a thread ID; turn start and interrupt operate on that thread/turn. | No native project identity is bound to the Ensemble task. |
| `provisionTask` / `taskWorkspace` | Provisioning and reading retain an Ensemble task-to-worktree binding independently of a conversation. | Workspace identity exists, but there is no native project/thread binding or transfer command. |
| `taskHold` | Reads the currently reported task hold. | Read-only; it cannot acquire a human hold. |
| `stopTask` / `resumeTask` | Stop persists the operator Stop and requests best-effort cancellation. Resume clears only that Stop and wakes the scheduler. | Stop retains its separate cancellation semantics; it is not a human handover or settled return. |
| `resolveHeldExecution(receipt)` | Recovery requires matching the existing work revision, request, thread, turn, and process identity, then independently verifying process termination. The receipt records settled effects and workspace disposition. | This reconciles an already held uncertain execution. It does not acquire human task ownership before a native continuation or implement the native return protocol. |
| `holdKnownSurvivor` / restart recovery | Holds a known unfinished execution; service opening holds unresolved submitting/running work. | These preserve uncertainty and recovery holds; neither represents an explicit human handover. |
| Project pause | Project configuration can pause a project. The [behavioral specification](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/docs/SPEC.md) allows active turns to finish while project dispatch is paused. | Project-wide pause cannot transfer one task's writer ownership before human continuation. |

Source references at baseline `8173a312a3e6a094e6280c2eaf0196ae1a070c61`: [runtime thread lifecycle](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/codex.ts#L435-L495), [service options and task workspace](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/service.ts#L90-L106), [recovery and hold reads](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/service.ts#L452-L475), [workspace and task controls](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/service.ts#L539-L619), [Stop, Resume and read-only task hold](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/state.ts#L490-L695), [restart hold and `begin` transaction entry point](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/state.ts#L1734-L1761), [task, ambiguity, and archival hold checks on admission](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/state.ts#L1888-L1905), [recovery receipt requirements](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/recovery-types.ts#L51-L61), and [verified recovery](https://github.com/chrisbanes/ensemble/blob/8173a312a3e6a094e6280c2eaf0196ae1a070c61/src/standalone/supervisor.ts#L229-L278).

**T1 result: failed to establish both prerequisites.** The installed public surfaces do not provide the required saved-project integration contract, and the exact service baseline has no public operation that persists task-scoped human ownership before native continuation and explicitly returns it after settled execution while retaining independent holds.

## Finite result and cleanup

| #724 finite row | Status | Evidence |
| --- | --- | --- |
| 1. Supported entrypoint, versions, saved-project identity, and task worktree | Unproved | Entrypoints and versions are identified. No disposable project or workspace identity was created because T1 failed. |
| 2. Main native task, linked worker, project placement, opening, and change view | Skipped-unproved | T1 did not establish a supported standalone project/task API. |
| 3. Explicit human handover and settled return | Skipped-unproved | T1 found no existing task-scoped service handover/return seam. |
| 4. Restart reconciliation, no duplicate launch, and retained uncertainty holds | Skipped-unproved | T3 did not run; no native execution or ownership transfer existed to reconcile. |
| 5. Complete results, limitations, and cleanup report | Passed | This document records each row and the exact cleanup. This reporting result does not pass X01 or X02. |

X01 and X02 are both **unproved**, not passed. There is no sanitized JSONL trace because no supported live phase ran. No disposable native or Ensemble service fixture was created, so there were no fixture IDs or workspace paths to clean. The only temporary artifact was the generated public TypeScript schema at `/private/tmp/ensemble-724-appserver-schema.VfE6bO`; that directory was removed after inspection. No saved Codex task, shared login/configuration, production task, or Haze prototype was changed.

## Validation and release scope

| Check | Result |
| --- | --- |
| Planned-baseline `git rev-parse HEAD` | `8173a312a3e6a094e6280c2eaf0196ae1a070c61` |
| Initial `git status --porcelain=v1 -uall` | Empty |
| `/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node --version` | `v24.21.0` |
| Pinned npm CLI via that Node binary | `12.1.0` |
| `codex --version` | `codex-cli 0.159.0`; the CLI also printed a non-fatal warning that PATH aliases could not be created (`Operation not permitted`). |
| Host bundle Info.plist reads | `com.openai.codex`, version `26.928.21956` |
| `codex app-server generate-ts --out /private/tmp/ensemble-724-appserver-schema.VfE6bO` | Completed; generated schema inspected; temporary output removed |
| Existing baseline check | [CI job 110116180631](https://github.com/chrisbanes/ensemble/actions/runs/36782577199/job/110116180631) passed for unchanged code. It is not native integration evidence or validation of this new document. |

No runtime tests or `npm run check` were run: T1 stopped before any executable harness or code change. Only documentation checks apply to this change. #724 remains open and #725 remains blocked pending a concrete release-scope decision from Chris: retain X01/X02 and bring back a reviewed path for the missing supported integration and ownership seams, or explicitly revise the first-release native-task scope. This report does not choose a fallback or weaken either requirement.
