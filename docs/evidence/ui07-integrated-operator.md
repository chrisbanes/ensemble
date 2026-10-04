# UI07 integrated operator qualification

The integrated browser path now creates a local task, records its exact native
answer, and inspects the bound result using the production UI, authenticated
service and persistent SQLite. Offline qualification uses a fake App Server.
The sole live attempt is still pending a new root grant. Chris's final
visual/usability acceptance remains pending on [#736](https://github.com/chrisbanes/ensemble/issues/736).

## Candidate and evidence boundary

The assembled baseline is `4932405fc97b0f00d4facc310c398e2908f2f719`, tree
`7b80280ec013f33cccbe1a9b614230cde88d5503`. This consumes delivered UI01, UI04,
UI05 and UI08. [The shared inventory](release-candidate-inventory.json) maps all
11 acceptance criteria to their source and test scopes. Original evidence remains
in [UI01](ui01-runtime-input.md), [UI04](ui04-task-workspace.md),
[UI05](ui05-inbox-questions.md) and [UI08](ui08-foundation.md).

The selected [capture manifest](ui07/captures.json) identifies synthetic scenarios,
viewports, source/test/bundle hashes and corresponding design nodes or composition
gaps. These images come from the real production Vite bundle and disposable
service/store fixtures. They do not supply runtime/provider qualification or
physical-device acceptance. Raw databases, credentials, configuration, histories,
process identities and grants are excluded from this packet.

## Connected walkthrough

1. Sign in, open New task, select the disposable project and assignee, enter the
   title and desired outcome, then explicitly choose Create and start. Task Ready
   is a creation receipt; execution status remains an independent observation.
2. Open the task's exact request. The shared form preserves the requesting
   assignment/conversation and literal native question. Task, Inbox and direct
   `?request=` entry use that form. Preselection sends no command.
3. Pause the project using the ordinary project command, submit the explicit
   answer through the production browser, then inspect its receipt using a
   separate read-only SQLite connection. The answer is committed with zero native
   replies while admission remains held.
4. Unpause normally. The exact received answer map goes through the qualification
   report bridge to the real `ensemble_report_result` callback. Inspect the
   persisted result in the browser. One successful bound terminal, an ended
   callback and no independent hold are required through final inspection.
5. Search from shared desktop/phone navigation or a task/workspace origin. Inspect
   the exact historical result/section, then return with query, filters, selected
   match, reading anchor, workspace view and unsent drafts retained.

The bridge proves answer consumption and result persistence. It does not prove
ordinary model-authored artifact production. Deterministic review fixtures supply
actual PNG bytes, previews, artifact/result/criterion relations and contextual
feedback receipts. Recorded PR/check/finding states qualify presentation; actual
provider integration remains [#697](https://github.com/chrisbanes/ensemble/issues/697)'s additional gate.

## Integration repairs

A browser-created Ready local task previously queued forever without its first
workspace binding. Shared service admission now provisions the initial
repository-free binding. Imported tasks still need explicit repository grants.
Existing held, lost or archived bindings and prior execution/workspace evidence
prevent automatic recreation. The manager's existing task lock preserves
concurrent explicit provisioning. The same service behavior covers React,
retained HTML and ordinary local task/assignment commands.

Shutdown could close SQLite while an asynchronous scheduler admission still
finished. The service now stops scheduling, stops the runtime, and settles the
existing scheduler drain while storage remains open before clearing active state.
Failed-start cleanup applies the same accounting and preserves the primary error.
Offline faults retain exact fixture/hold evidence and restart with zero new turns.
Successful cleanup verifies the exact owned child; it does not establish descendant
containment.

## Qualification scopes

| Acceptance | Concrete proof |
| --- | --- |
| AC1 pinned validation/reuse | Final `npm ci` / `npm run check` and exact input identities in the shared inventory. Historical evidence stays labelled with its own source. |
| AC2 connected create/observe/answer/result and holds | `ui07-live-harness`, `operator-integrated-browser`, `runtime-question-service`, `s05-runtime-integration`; live attempt pending. |
| AC3 forms, List/Board, imported content, histories and expiry | `operator-question-browser`, `structured-question-store/service`, `operator-task-browser`, `operator-task-workspace-browser`, `operator-api` and `operator-web-browser`. |
| AC4 keyboard/focus/layout/captures | Question, task, review, search, foundation and settings production browser suites; selected laptop/phone/reduced-height captures below. |
| AC5 runtime/version/continuation/limits | UI01's unchanged native codec evidence; UI07's changed assembled boundary requires its own finite live proof. |
| AC6 defects/blockers/human review | Repairs above, retained failed fixtures and current gate states in inventory; Chris review remains pending. |
| AC7 attributable evidence/context/feedback/delivery | `operator-review-browser`, `task-review-store/service`, `delivery-operator/service`; real local bytes/receipts, recorded provider observations. |
| AC8 search origins/history/return/errors | `operator-search-browser`, workspace/task browser suites; exact historical destinations and shared draft/selection restoration. |
| AC9 approvals/independent holds/source/destinations | `operator-inbox`, `operator-api`, `runtime-question-service`, `s05-runtime-integration`, delivery suites and retained exact approval controls. Viewing grants no approval; merge grants no task completion. |
| AC10 Pen/current loading/shared inventory | Current design blob and narrowed native loading observation below; one inventory/journey shared with #697. |
| AC11 UI08 foundation/alternate surfaces | `operator-foundation-browser`, `operator-settings-browser`, `operator-web-browser`, control inventory; retained HTML, login, setup, runtime, configuration and recovery entries. |

Full Ensemble forms have deterministic browser/service/SQLite proof for individual
and grouped free text, single/multiple choice, literal IDs, descriptions,
recommendations, custom permissions, optional empty answers and constraints.
Native live scope remains one synchronous single-choice/custom-text round trip,
with observed `isBlocking=false` and `autoResolutionMs=null`. Unsupported native
shapes remain unresolved. No new native free-text, multiple-selection,
recommendation, grouped-live or comprehensive tool-history claim is made.

Shared entry points include Overview, Inbox, project/cross-project List and Board,
task/request links, shared Search, Settings and retained HTML coordination/runtime
controls. The delivered control inventory covers 84 controls, 15 destinations,
42 forms, 13 command discriminants, 14 actions and 23 extension routes. No separate
context-menu, extension or notification UI is exposed for these workflows.
Review-only state specimens remain outside product controls. Web-disabled
platform HTML stays minimal; login/setup/recovery composition gaps remain explicit.

## Design and human review packet

The current `design/design.pen` blob is
`49059c17efa78fe42b5b8df8c5fb6ce3650c9c8b`. Root read-only native inspection on
4 October saw both fictional comparison images at desktop `dKc4O` and phone
`mrRXI`, four placements in total. The fifth historical placement, whole-canvas
inspection and OS save/reopen remain unverified. This narrows the historical
loading gap without claiming saved-design visual acceptance.

Selected captures will be linked here after hash and pixel inspection.

## Remaining gates

The sole finite UI07 live journey remains grant-gated. The accepted limits are one
App Server/thread/turn/native request/reply/exact-map report, zero retries or
follow-up/resume turns, a 90-second request deadline, 240-second total deadline
including setup/readback, 10 seconds reserved for cleanup, and each action capped
at 10 seconds or the earlier global deadline. Missing/unsupported/foreign material,
unexpected operations, early terminal, missing receipt/report, drift or unresolved
cleanup block qualification and preserve the consumed attempt.

Technical proof does not close #736's human review, #697's additional provider
integration, #698/#704/#732/#761 operational/physical/cutover work or paused X01–X08.
No deployment or installed Haze cutover was performed.
