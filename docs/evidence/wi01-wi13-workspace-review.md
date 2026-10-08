# #782 workspace inspection and local review (WI01–WI13)

**Status: deterministic service and production-browser evidence recorded;
the bounded actual-runtime journey has not been run.** This record follows the
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
  matching ordinary messages. The live journey therefore sends its review
  before any result is reported.

## Actual-runtime journey

Not run. It needs a separately reviewed #782 grant; #780's spent journey does
not cover it. The deterministic lifecycle fixes the supported three-start
order. A real model may report a result in its first or repair turn, which
would complete the lead before the review is delivered; the grant request
must settle how the journey handles that.

## Limits

Accepted S01 runtime trust, containment and history limits are unchanged.
Model-originated behaviour in the live journey is uncontrolled. Comparison
response time can still exceed 5 seconds when child cleanup or binding
validation waits.
