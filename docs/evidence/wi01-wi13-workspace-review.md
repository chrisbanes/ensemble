# #782 workspace inspection and local review (WI01–WI13)

**Status: deterministic service and production-browser evidence and the
granted bounded actual-runtime journey are recorded.** This record follows the
[#782 implementation plan](https://github.com/chrisbanes/ensemble/issues/782#issuecomment-6059477544)
and the [#782 implemented behaviour](../SPEC.md#782-workspace-inspection-and-local-review--implemented-behaviour).
No release, deployment or cutover is implied.

## Deterministic evidence

The suites below use the production service, real SQLite, real filesystem and
Git fixtures, the authenticated HTTP boundary and production Chromium builds.
Fake runtimes qualify only the service control boundary; they do not prove
native Codex behaviour.

| Criteria | Suites | What is asserted |
| --- | --- | --- |
| WI01–WI02 | `operator-files-browser`, `operator-pdf-render-browser` | Repository-free and multiple-repository browsing, ignored reveal, inert Markdown with Source lines, raster fit/zoom/pan, PDF on app-owned canvas with a local worker, bounded/unsupported states, no download or export, full-path disclosure, 390px phone list→preview and keyboard explorer. |
| WI03 | #779–#781 suites plus `local-review` | Server-side scope and exclusions; anchors outside linked repositories or excluded paths are rejected before capture. |
| WI04–WI05, WI08 | `operator-changes-browser`, `workspace-comparison`, `workspaces` | Per-repository baselines and change sets, staged/unstaged/untracked/deleted/renamed/binary entries, time-limit gaps, exact-ID stable reads, last-good refresh, Shift range from the focused line, phone unified diff with 44px rows. |
| WI06 | `operator-changes-browser`, `inspection-review-lifecycle` | Pending versus latest-finished Last turn provenance. Three starts: initial turn, automatic reporting repair, then the queued review's delivery turn, which reports a result and is stopped. Two finished captures, retained result bytes, a Stop hold and no fourth start. |
| WI07 | `operator-retained-inspection-browser` | Capture provenance, original text and raster bytes after later edits, removal and reload; a diff gap stays a gap; current bytes open only through an explicit Files action, which moves focus to Files. |
| WI09 | `operator-inspection-navigation-browser` | Board and Search origins through Files and back to the same URL and filters; exact file, comparison and sent-review links; missing targets explained; phone entry. |
| WI10–WI13 | `operator-local-review-browser`, `local-review` | Current-file range and Before deleted-line anchors, composer focus return and Escape, complete draft with original excerpts and status, edit and summary, reload continuity, a lost send response reconciled with one event, sent inspection, next review, and no unsent draft after sign-out. |

## Entry points

Files, Changes, Retained result evidence and Local review are sections of the
existing task route. Overview, Inbox, project and cross-project List and Board,
Search, and retained advanced routes open that route, so they reach the same
sections; section links keep the origin entry. The navigation suite exercises
Board and Search. Inbox, Overview and List rely on the same task route and
origin mechanism already covered by their existing suites. No context menu,
extension or notification inspection entry points exist, and none were added.

## Findings recorded during delivery

- Inspection policy rechecks spawned `git rev-parse` per bound repository
  dozens of times per comparison. On macOS this alone spent the 5-second
  comparison budget. Read-only rechecks now reuse a just-verified identity for
  up to 1 second while lstat identity is unchanged; execution admission still
  rereads Git.
- Task section links pushed hash history entries without origin state, which
  lost "Back to originating view". They now scroll in place.
- A sent draft could not be cleared, which blocked a second review in the same
  session. Discarding a sent draft now starts the next review and keeps the
  submitted context.
- Independent review found that drafts were removed on any task or
  configuration version change, including straight after a confirmed send
  rejection. Drafts now track only file-access inputs.
- The lead's review message lacked repository, side, source identity and
  excerpt. It now carries them, and the lifecycle test asserts the delivered
  text.
- Empty drafts produced a permanent "unsent draft removed" notice; send
  outcomes without a receipt could show as "not delivered"; and an unknown send
  could be recovered only from the original tab. All three are fixed.
- A lead that has completed its assignment cannot receive a local review,
  matching ordinary messages. The reduced live journey therefore sends no
  review; review delivery is qualified offline.

## Actual-runtime journey

**Result: passed (one granted attempt, 9 October 2026).** Chris granted a single
run of the entry below at source `3b39dae0cd13b021931541a876c4ed8dd71bff4f`.
Entry SHA-256 `74f2f29e8e567fb6a6e77f57c93cadc496027437e083513ed92edf286ca56e83`;
Node `v24.21.0`, npm `12.2.0`, Codex CLI `0.162.0-alpha.2`. Launcher SHA-256
`50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` (same as #780);
compiled adapter SHA-256
`bcc28b8af1df12eff5e4f63baaed96d241b3ebde67147ab5b037d08dd2e2806f`.

Preflight validated the ChatGPT account, `approvalPolicy=never` and
`sandboxMode=workspace-write`, with the project paused and zero starts before
dispatch. One runtime start and one process identity (pid 62528, same boot)
were observed. The guard recorded exactly 3 `Runtime.startTurn` calls, no
refused starts, no deviations and no unproved rows.

| Turn | Work | Thread / turn | Terminal | Result | Capture |
| --- | --- | --- | --- | --- | --- |
| T1 | `assignment:22ca054e-…:initial` | `01a11dd7-a6ce…` / `01a11dd7-a7f3…` | completed (9.3 s) | R1 `5a176a0e-df99-40d3-b1f5-7df6b817a9bd` | `89f968d0…` finished |
| T2 | `assignment:181de374-…:initial` | `01a11dd7-cc67…` / `01a11dd7-ce65…` | completed (9.7 s) | `87ab5f12-30aa-4102-9cc6-095e72063b04` | `e5d2b624…` finished, replaced C1 |
| T3 | `assignment:e494bbd1-…:initial` | `01a11dd7-f4b3…` / `01a11dd7-f53a…` | failed after Stop (78 ms) | none | `29c46ba3…` unsettled |

- **WI06:**
  - C2 replaced C1 as the latest finished capture; C1's row no longer exists.
  - T3's pending capture stayed unsettled, outcome failed, and the Stop left the hold `Task stopped`.
  - The Codex interrupt was acknowledged and the terminal observed.
  - Stop landed 26 ms after T3's turn start, before `marker-3.txt` existed, so this run observed an interruption without partial writes.
- **WI07:** R1's retained `marker-1.txt` kept the original bytes A (SHA-256 `ae09a9678bcb1c129a19ebaa541dd577c92da00f8f61299720a0ec7793317e7d`) after T2 overwrote the file. The authenticated evidence and item reads, and the read-only SQLite reopen, agree.
- **Production UI:** at 1366 and 390 px, Last turn showed T3's exact identity, the outcome, the unsettled capture and the separate latest finished T2 capture. Retained R1 showed bytes A and not B. There were no unexpected console errors and no tolerated race 503s. Screenshots are in the private attempt directory.
- **Shutdown:**
  - The service stop returned.
  - The exact Codex process exit was verified (`mac-pid-absent-same-boot`).
  - The fixture with its Stop hold is retained for recovery, not deleted.
  - Checkpoint status `shutdown-verified`.

This run proves only the native turn and capture behaviour listed above. Review
delivery remains qualified offline. Process exit does not prove that
descendant processes ended, and the accepted S01 limits still apply.

### Journey design

The approved reduced journey has no local review. Review delivery is qualified
offline only (`local-review`, `operator-local-review-browser` and
`inspection-review-lifecycle`). One disposable repository-free task, one
service lifetime and one Codex process make at most three `Runtime.startTurn`
calls in a single attempt:

1. **T1**, the lead's initial turn, writes `marker-1.txt` = A and reports R1
   with `review.changes.files: ["marker-1.txt"]`. Expected: completed, finished
   capture C1 bound to T1's thread and turn, and R1 retains bytes A.
2. **T2**, an operator-created assignment on the same task (same profile, result
   destination lead), overwrites `marker-1.txt` with B, creates `marker-2.txt`
   and reports. Expected: C2 replaces C1 as the latest finished capture, and R1
   still retains A (WI07).
3. **T3**, a third operator-created assignment, writes `marker-3.txt` and then
   runs a bounded `sleep 900`. Stop is requested once T3's thread and turn are
   bound and its pending capture exists. Expected: an interrupted or failed
   terminal, an unsettled or partial capture disclosure, and a Stop hold. The
   hold is not released.

The project is created paused and is unpaused only while one armed start is
admitted, then paused again. `InspectionJourneyGuard`
(`test/fixtures/inspection-journey-harness.ts`) persists a private checkpoint.
It accepts a start only for the armed role's exact work identity, workspace and
deadline. Any other start, including a fourth start, an automatic reporting
repair or a delivery, is refused before it reaches the runtime and is recorded,
and the journey stops. If T1 or T2 ends without a result, its automatic repair
is queued while admission is paused. The next admission then refuses to arm,
so the journey stops with the remaining rows unproved. It never makes a second
attempt.

After T3 settles, the entry makes authenticated HTTP reads of
`comparisons?target=last-turn`, R1's evidence and its `marker-1.txt` item, and
asserts exact identities and bytes. A production Chromium pass at 1366 and
390 px then screenshots Last turn and the retained R1 evidence and asserts
identity text, R1's bytes A, the absence of B, and no console errors other
than documented 503 read races. The service stops, the exact Codex process is
verified to have exited on the same boot, and SQLite is reopened read-only to
check the capture slots, R1's retained bytes and the hold. The fixture and
attempt directory are always retained, and their paths are recorded in the
mode-0600 evidence JSON.

Command, run from the repository root after `npm ci` and `npm run build`, only
with the grant and the controller-verified executable hash:

```sh
ENSEMBLE_WI782_CODEX_SHA256=<sha256> node test/wi782/live-inspection-journey.mjs --live --three-turns
```

Any other argument set exits with status 2 before anything loads or starts.

| Budget (`inspectionJourneyBudgets`) | ms |
| --- | ---: |
| Start limit | 3 starts |
| Admission (arm to start entered) | 30,000 |
| T1/T2 start to terminal | 300,000 |
| Terminal to settled result and capture | 30,000 |
| T3 start to Stop observed and settled | 60,000 |
| Authenticated reads | 60,000 |
| Production UI pass | 180,000 |
| Shutdown to verified exit | 10,000 |
| Total, from arming T1 | 1,200,000 |

Model behaviour is uncontrolled. A missing T1/T2 result, a T3 that completes
before Stop, a missing hold or a capture without an uncertainty disclosure is
recorded as an unproved row, not retried. Offline coverage is in
`inspection-journey-harness.test.ts`, which uses fake runtimes.

## Limits

Accepted S01 runtime trust, containment and history limits are unchanged.
Model-originated behaviour in the live journey is uncontrolled. Comparison
response time can still exceed 5 seconds when child cleanup or binding
validation waits. Verified exit of the Codex process does not prove that
descendants such as T3's `sleep` stopped or that all filesystem effects ended.
