# S08b final recovery and cutover proposal

Local technical qualification for [#698](https://github.com/chrisbanes/ensemble/issues/698), following the [reviewed v2 rev1 plan](https://github.com/chrisbanes/ensemble/issues/698#issuecomment-5996272405). The only production change uses absolute `/usr/sbin/sysctl` for macOS boot identity; the rendered LaunchAgent environment remains unchanged. No prototype database was opened and no deployment, reboot, power experiment, model turn or external provider effect was performed.

> **Post-merge status, 8 October 2026:** [PR #773](https://github.com/chrisbanes/ensemble/pull/773) merged on 5 October at `6064bd0c889d3a0caaa2aee8bffd93bbe8a87d81`. Its fresh independent review passed for frozen head `b8f6a87d1d64231c8f16da33c5619ea067964ccb`, and that head's remote check passed, closing the review and final-head gates recorded as pending below. Physical sleep/wake #732 and the separately approved cutover #761 remain open.

## Tested candidate and environment

Starting revision: `b972978895957400cf808d3a8e6ab18224d79af2`. Tested source/test tree: `9758b0dacc3f58c2b33d43e3dca3c83c38c466cc`. This tree contains the five owned source/test paths below and baseline documentation. The final evidence, operations prose, proposal and R06 inventory are a documentation-only follow-up; the report does not invent its own final commit identity.

| Input | SHA-256 |
| --- | --- |
| `src/standalone/termination.ts` | `ad1322285dc302aafc5cf6a242d0cfdee3d6d8714941a4b19f27a0693c739ee2` |
| `test/termination.test.ts` | `68c9a9ce831cd51fc084bdf64a4f5b8608b425e23b90507e7dc3bbe1b6c585e8` |
| `test/operations-final-candidate.test.ts` | `1a806d84261dced325048e7569a9240436c9eb8a4bf6f8defac725d56815ee92` |
| `test/fixtures/s07b-delivery.ts` | `26d46f4dcf6808e128f6817e896103b4114165614c51e226679d1e38dca6bceb` |
| `test/s08b/owned-recovery.mjs` | `e04126aaf5dd949b2b2496a3430e72078051a835b5aa41218202162ecf6ba455` |

Runtime: actual macOS, Node `24.21.0`, npm `12.2.0`. The generated plist environment has only its supported non-secret keys and fixed PATH `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`. Tests and the explicit runner launch absolute Node using that extracted environment; no shell PATH is added to make identity work. This PATH excludes `/usr/sbin`, which explains the lookup repair.

## Complete identity and exact recovery

`test/termination.test.ts` exercises actual PID, process birth and boot-session capture under the generated environment. It deliberately skips off macOS rather than claiming host proof there. The separate opt-in `test/s08b/owned-recovery.mjs --qualify` runner passed on this Mac in **259 ms** with 20 passed steps. It creates one harmless owned child, zero descendants at the independent topology checkpoint, zero model/provider calls and zero admissions after restart. Its actual identity is independently captured and the real `MacProcessTerminationVerifier` sees a conflict while the child is alive.

The service uses real file-backed SQLite and an identified fake runtime bound to that owned generation. Public Stop, shutdown and restart retain writer/capacity ownership and independent Stop. Wrong generation, wrong process identity, absent original identity, acknowledgement without termination and an alive survivor cannot release ownership. The exact child exits gracefully through its retained handle. Independent same-boot PID absence then supports the exact receipt: only the matching intent is reconciled and its writer/capacity holds release. Stop remains until explicit Resume. An unkeyed repeat receipt refuses and does not duplicate the release. Resume clears only Stop and does not revive the old request.

The child writes one sentinel and one synthetic-effects record (`writes=1`, `externalEffects=0`). Independent readback after the exact child exit and before receipt remains unchanged. Receipt and Resume assertions cover control/ownership state; they do not claim another independent file readback. Exact PID/PPID topology readback shows no descendants. This is finite owned-process evidence, not universal Codex reattachment, child-tree containment or model-tool isolation.

The runner reserves 50 seconds for main work, 5 seconds per step and 10 seconds for cleanup, within the 60-second envelope. Abort-aware waits cancel their timers, tracked asynchronous operations drain before removing the root, and exact child identity is checked before any fallback signal. A deliberately failed wait exits with its primary failure in **5.104 seconds**; cleanup finishes in 19 ms with child exit, independent absence, service shutdown and root removal all true. The passing runner's same cleanup readbacks are all true. Earlier failed fixture roots were retained when cleanup was uncertain, then reconciled and removed only after exact owned sessions ended and child absence was established. No name-based termination was used.

## Final-schema snapshot and restored startup

`test/operations-final-candidate.test.ts` reuses the existing S07b fixture and closed scripted production `GitHubHttpDeliveryProvider` dispatcher with synthetic credentials. Unknown endpoints fail and cannot forward to external fetch. Public domain, service and bound tools create representative final records: routing provenance; nested result destinations; result metadata and a real PNG reference; answered question and approved exact material; dependency controls; Stop/pause; writer and capacity admissions/holds; conversation history; inbox supersession; confirmed, denied and uncertain external actions; PR handback settlement and terminal completion. Named categories are asserted populated, not qualified through equality of empty tables.

The production operations CLI backs up, verifies and restores the current schema-6 database. Independent read-only SQLite integrity/foreign-key checks and an ordered schema/whole-row digest prove **all 105 tables match exactly before restored startup**. The manifest schema fingerprint is `35889091802f03126403c83c0136d32d68faed443ba8c3201883290860fe90a4`; each run's logical digest is retained in its private log. Snapshot contents are only the database and manifest; auth and workspaces are not copied.

Pending preparation can append attributable `service:work-preparation` contexts during source service stop/drain. The test binds these new captures to actual tasks, assignments and work and proves all earlier captured bytes remain. The stopped database is the exact snapshot baseline. After restored startup, all nine populated protected history/receipt/context tables and routing records remain exactly equal to that baseline.

A directly delayed source refresh admits zero work before completion; it then reports unavailable, with zero admission. Runtime and provider reconciliation ordering is reused from existing recovery/operations tests, rather than described as a new direct delay of all three surfaces. Relocated workspace identity refuses before access to either old managed root; independent sentinel/image bytes remain unchanged. The uncertain comment is not replayed, and the task's Stop and workspace holds remain. Exact synthetic provider observation of its operation marker confirms only that operation; the earlier confirmed operation remains confirmed, comment writes remain two and merge writes remain zero. Settlement/readback never clears independent controls.

A separate repository-free task is provisioned through the ordinary service seam. Unpause alone still admits zero because its Stop remains. Explicit Resume admits exactly one fake-runtime turn; a durable waiting question ends it, and a further real-storage restart admits zero duplicates. The old task remains held. The owned delayed-start gate is released in `finally`; existing bounded fixture lifecycle drains startup, stops the service and only then removes its root, preserving primary failures. Successful cleanup asserts that root absent.

## Validation and retained evidence

- Required pinned `npm ci`: passed, 80 packages installed.
- `npm run test:fixture-preflight`: 3/3 passed, including expected browser failure and cleanup.
- Focused termination/recovery/no-turn/operations checks: 116/116 passed.
- Affected existing S07b service/browser checks plus restore: 23/23 passed.
- Final restored lifecycle check: 1/1 passed, 4.126 seconds.
- Full `npm run check`: 957/957 passed, zero failures/cancellations/skips, 64.113 seconds. The first run failed 956/957 in the existing browser-diagnostics fixture: browser event preparation exceeded its 100 ms execution budget before its finish callback was assigned. Targeted checks passed 8/8 without changes, then the unchanged candidate passed the renewed full check. No timeout was increased.
- `git diff --check`: passed; exact inventory and proposal syntax checks are recorded separately.

Private logs retain the initial sandbox identity denial, unavailable automatic approval review, helper termination wait failure, unkeyed-receipt and null/undefined assertion mistakes, operations tests' required `npm_execpath`, invalid TypeScript arguments, excluded profile-instruction prose, reporting/inbox/terminal-order fixture mismatches and stop/drain appended contexts. Those are failed observations followed by bounded repairs; they are not hidden successes or new production defects. The sole demonstrated production lookup repair is the absolute sysctl executable. Credentials, private paths, process identities and fixture databases are not committed.

[S08a](s08a-operations-2026-09-30.md) retains its real disposable launchd/bootstrap/restart/backup/restore source identity `3543097763ca00245824b9fca8d5f5f615b56f2f` and 210-test evidence. This run does not repeat LaunchAgent loading or expand its guarantees. [S07b](s07b-release-candidate.md) and the inventory retain the real S07a 9/12-turn handback/through-merge journeys and the single UI07 journey, with their exact historical source/runtime identities and accepted limits. New deterministic fixture assertions do not constitute new live model/provider qualification.

## Proposal and remaining gates

The [named Haze proposal](../operations/standalone-cutover-proposal.md) binds discovered repository/Project/host identities and gives ordered executable stages, exact CLI arities, preservation/rollback and fail-closed old-controller discovery. Its proposed witness is one small named task, concurrency one, reviewable PR/no merge, at most one PR, three model turns and 30 minutes. #761 must select and bind that task and every production path/control before execution approval; the implementation agent monitors aggregate bounds, which the service is not claimed to enforce automatically.

One-off shell parsing and CLI argument-count checks passed without executing any proposal command. Proposal SHA-256: `e0f94a3772e968779b2f1b18ec109e835e597d258c52f1e94be40852325eea6e`. BB controller metadata remains unavailable; connection failure does not prove no writers. No old-work disposition, deployment, physical sleep/wake or cutover is claimed. R06 technical recovery/proposal preparation is qualified locally; independent proposal review and final-head remote gates remain pending. Its actual cutover limb remains #761, and physical R03 remains #732.
