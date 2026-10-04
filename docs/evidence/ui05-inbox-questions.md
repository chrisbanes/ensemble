# UI05 action Inbox and exact question responses

UI05 #743 adds a summary-only action Inbox and a shared full response form for
Inbox, task detail and exact request links. Own-tool version-1 forms persist
independently of the legacy interaction text. Recording a response commits its
validated answer, requester-scoped inbox event and command receipt atomically.
Receipt confirmation is separate from admission, native delivery and terminal
settlement. Approval/recovery material retains its existing exact controls.

## Verification identity

Implementation base: `6e1a70d3e0b4ab4b8957328cc67a30a7effbc23f` on
`cb/issue-743-inbox-structured-questions`. Node `24.21.0`, npm `12.2.0`.
`npm ci` passed before implementation. Final candidate identity, complete owned
source/fixture SHA-256 inventory, commands, preserved failures, screenshot paths
and cleanup manifests are recorded in the executor's `/tmp/ui05-delivery.json`.
Generated assets and disposable fixture databases are not committed.

The final integrated validation is `npm run check` (type checking, lint,
formatting, service/web builds and the complete deterministic test suite), followed
by `git diff --check`. Final validation: 912/912 tests passed, zero failures/cancellations/skips; all
required type/lint/format/build stages passed. Final complete log:
`/tmp/ui05-dom-id-full-check.log` (48.503 seconds for tests).
No App Server/model/live/paid attempt was added by UI05. Browser evidence uses the
production Vite bundle, real disposable SQLite and deterministic runtime doubles.

| Changed source | SHA-256 |
| --- | --- |
| `src/core/question-forms.ts` | `7798a80cfc49964e3645fa3d00a6152c01d81edbee576efa7f54f19c387724d3` |
| `src/core/coordination.ts` | `b07f11c5158ec2488adf3f93741feb127bfb2454fa82249732de9bbe78d81c9b` |
| `src/standalone/operator-api.ts` | `553f8ec918046b20891d5b8e5ef1f0a3972d8b40db32644ecb15f491dd71d440` |
| `src/standalone/operator.ts` | `48de0dede752441d0c2d78aa000773d09be5e981ac2d86cebb6c88df8779bc3e` |
| `web/src/inbox.tsx` | `c33d94f0fff3f543c0799733426561bfd53218ab6caad25ed563827a050e375f` |
| `web/src/question-response.tsx` | `c6f8a0335a7c34d33b2f888af325359241a21d8f8ba660f69c6dce47170ff9fe` |
| `web/src/question-response-state.ts` | `572cab75387e5b5a11c2c12e23cde29961970f8497efd29b668a284cc343545a` |
| Generated `index-CsF3lIED.js` | `b424a9ee46bb490a73abec949c83102014f310bc04fcfb8dd479d4251eda7c01` |

## Acceptance evidence

These named tests run in the final complete check; focused logs retain the earlier
bounded probes and failures. Executed totals that included imported test fixtures
are historical counts, not unique coverage counts. Shared form data now lives in
passive fixture modules.

| Criterion | Concrete evidence |
| --- | --- |
| AC1: action-only cross-project context, urgency/age, normal waits/results excluded | `operator-inbox.test.ts`: cross-project summary-only projection; combined approval/question age and 100-row cursor/fingerprint pages; directly addressed form outside first page. `operator-task-workspace-browser.test.ts`: routine result absent; questions, approvals and unknown ownership discovered by timer/header refresh; retained focused queue row and failed-refresh data. Queue timestamps explicitly convert SQLite unix seconds to milliseconds; production browser asserts the current year. |
| AC2 / UI01: full form and explicit submit | `question-forms.test.ts`: free text, single/multiple choice, recommendations/preselection, option descriptions, exact custom text, explicit empty optional answers and lower constraints. Contradictory required-zero-capacity/custom-cardinality forms reject; optional-empty and valid choices remain valid. `operator-question-browser.test.ts`: radio arrow keys, checkbox Space, preselection causes zero command, field validation focuses the first invalid question. |
| AC3: stored schema, atomic acknowledgement, exact requester | `structured-question-store.test.ts`: callback replay has one interaction; changed arguments reject; injected schema/receipt failures roll back; separate SQLite connection observes exact committed answer and one receipt. Typed event retains original work/version attribution. `structured-question-service.test.ts`: legal 24,000-character grouped answer survives view/event and exact subsequent requester prompt. Native command test records a native receipt with one native effect and zero ordinary question-answer events. |
| AC4: migration, replay/restart and stale identity | Populated plain request/response/receipt bytes survive additive migration and two reopens. Same key returns the original event before current eligibility; altered payload/fresh answered key reject. Store tests cover unrelated work, ordinary same-assignment continuation, actual conversation replacement, cancellation, completed assignment and explicit supersession. Service test restarts before answer, after recorded answer and after answer admission; original question survives ordinary continuation with one answer event/admission. |
| AC5: failure/unknown/recorded states and independent holds | Production browser retains failed input; a committed answer whose response is lost freezes the exact original command/key, then reconciles to one event. Shared state test keeps oversized aggregate drafts editable and reports validation. Own service tests retain recorded answers behind pause/Stop with zero new turns. Existing native service tests cover pause, Stop, unready/profile/ownership/power/dependency holds, restart at answer/intent/write and failed receipt commit. Unsupported/mismatched/async native shapes remain existing unresolved holds. |
| AC6: desktop/phone and stable selection | Dedicated queue/form panes scroll independently; project/kind filters and selected request remain stable. Browser covers Inbox → task evidence → exact request → back, preserving draft; after recording, the original selected detail remains and another request stays open. Captures use 1366×900, 390×844 and 390×480 viewports. Both footer actions have full viewport bounds/unoccluded hit targets; final field is reachable above reserved actions. No physical-device test is claimed. |
| AC7 / A12: exact conversation, SQLite/service/UI and qualified native reuse | Task/Inbox exact request views link the requesting assignment/conversation. Production mixed form records exactly once and keeps typed content. Curated native API adapts exact labels/custom values; deterministic grouped 32-question identity coverage remains distinct from live native shape qualification. See native evidence below. |
| Post-await privacy/session boundaries | Entire unsafe form/answer is withheld rather than relabelling options. Exact form rechecks task/workspace/visibility after awaits. Inbox retains bounded catalog/workspace/task snapshots and rejects earlier-row workspace removal or task mutation while a later exclusion read is held. Authenticated held upload followed by logout finishes 401 with zero answer event/receipt/effect. Existing post-commit logout privacy checks retain the historical receipt while denying private output. |
| Bounded transport / recovery | Same keepalive socket exercises canonical exactly-256-KiB answer plus strict derived envelope; raw overflow, whitespace/escape expansion, answer overflow and non-question 64-KiB overflow reject before persistence. Source refresh retains its prior raw limit. Rejected uploads drain after iterator listener cleanup; the exact socket remains usable for valid command/replay. Other route limits are unchanged. |

## Literal question identity repair

A bounded root probe found that Zod record parsing omitted a supplied `__proto__`
key, and absent-key validation could read inherited prototype values. The follow-up
preserves literal bounded IDs by validating each own dictionary entry and rebuilding
with `Object.fromEntries`; absent answers use `Object.hasOwn`. Shared field errors
use a null-prototype dictionary. Schema/state/API/SQLite tests cover supplied and
missing `__proto__`, `constructor` and `toString`, exact readback and one-event
receipt replay, without prototype mutation. The API JSON shape is unchanged.
Runtime tool JSON-schema generation consumes the form argument schema, not this
answer decoder, so its existing generated input schema remains supported. Native
codec/adapter/delivery source remains unchanged. Original candidate
`2a33f6019e6d08d6c73a6fd9f901c516c26476c9` and its 908-test check remain historical
attribution in the delivery record; the repaired complete check is authoritative.

## Presentation identity repair

Independent review found valid question IDs `x`, `x-0`, `x-custom` and `x-error`
could collide with literal-derived DOM control/error IDs. Presentation identities
now use stable form question ordinals and explicit control roles, preserving the
original domain IDs, answer dictionaries and `data-question-id`. The production
browser regression checks unique group/control/error IDs, actual label activation,
independent values, restored focus across task → Inbox → task, and exact SQLite
answers. Successful fail-fast build and affected browser check passed 3/3; the
renewed integrated check passed 912/912 without timeout changes. Candidate
`6bc18e691894ea2faec48c1134728fb520d1c388` and its 911-test source/capture attribution
remain historical in the delivery record. Root final acceptance remains pending.

## Entry points and recovery

Inbox rows use summary context, not question-option payloads. Exact selected forms
are independently read at `/api/operator/tasks/:taskId/questions/:interactionId`.
Task `?request=` links and legacy structured/native entries reach the same form
and auth-scoped draft/command state. Plain legacy answers retain their original
command path with the same fresh identity guard; approvals retain reviewed exact
material and denial controls. Web-disabled legacy structured/native entries
explicitly report that the shared form is unavailable. Overview, task List/Board,
search, direct task links and advanced coordination controls retain their task
entry points; their existing production browser journeys pass in the final check.
Hash-only evidence paths and query-plus-hash request paths are normalised before
routing/query parsing.

Submission is an intentional durable decision. Editing is disabled while sending,
while outcome is unknown or after receipt confirmation. Failed validation/transport
retains input. Unknown outcome must reconcile the original command and key before
new input; refresh cannot retarget that command. Correcting a recorded answer
requires a new agent request. Authentication expiry/logout purges private drafts,
selection and command state and suppresses late prior-session responses. Recorded
native-but-unconfirmed answers remain in the queue; confirmation never implies a
new admission grant or bypass of independent holds.

## Native qualification reused

UI05 leaves the native codec, adapter and delivery implementation unchanged.
Reuse is grounded in [UI01 runtime input evidence](ui01-runtime-input.md), its
[sanitised service projection](ui01-service-2026-10-02.json), and
[#739 T6 outcome](https://github.com/chrisbanes/ensemble/issues/739#issuecomment-5959595667).
The projection identifies source `f0002f0a1b1dd899eb5423c8321565dafa324265`,
Codex `0.159.0`, executable SHA-256
`e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a`,
and one synchronous single-choice/custom request, reply and exact consumption
report. The qualified protocol retains the observed false/null continuation
values. UI05 renews deterministic native store/service/API integration and grouped
identity adaptation, without a new live attempt. Standalone native free text,
multiple selection, recommendation fields, grouped live questions and general
live reattachment remain unproved/unsupported as recorded in the acceptance
amendment; no ordinary-chat conversion is fabricated.

## Failed evidence and capture provenance

Original HTTP connection-reset logs remain retained. The bounded investigation
pinned stranded rejected-upload draining to iterator-listener cleanup ordering;
new same-socket coverage qualifies the scoped repair. Historical failing raw
variant attribution remains unknown.

The first successful-build T3 browser timeout remains historical cause unproved.
Later T3/DOM runs used an older production bundle because TS2769 stopped service
compilation before web build. Those browser/auth-build claims were invalidated
and renewed after fail-fast successful complete builds. Subsequent failures were
concrete fixtures/labels/hash routes/captured-control expectations and are retained
with their dispositions in the delivery record.

Early 390×480 screenshots had a blank footer despite in-viewport DOM bounds.
The inconsistent pixels are preserved. Two animation frames after resize/scroll
produce readable settled-paint captures with unchanged footer CSS; both controls
and final-field placement are asserted immediately before capture. A product
layout cause was not proved by the inconsistent artifacts. Final capture manifest,
viewport, SHA-256 and inspected pixels are listed in the delivery record.

Disposable listeners, browser and runtime fixtures close using the existing
lifecycle helpers; cleanup manifests report completion. Evidence files survive
fixture database deletion. UI05 does not qualify #736 final assembled visual
acceptance, #745/#697 provider/release journeys, or #761 cutover. Paused X work,
installed Haze and native recovery limits remain separate.

## Final inspected capture fingerprints

These production captures are from the final integrated run. Actual paths and
manifest hashes live in the delivery record; successful manifests report complete
execution and cleanup. The last-field task capture is the inspected reduced-height
proof; the separate early recorded capture remains inconsistent paint evidence.

| Capture | Viewport / observed state | SHA-256 |
| --- | --- | --- |
| `1366-inbox-draft.png` | 1366×900; populated summary queue, styled filters, exact draft | `05f7b16f47c9fec705434a5466ad7a085fea4748067425fc4bcac96c481422eb` |
| `390x480-inbox-draft.png` | 390×480; phone detail, draft and visible actions | `8cc436c4964baec3a23fcbb6cf187d2349735d2bc294735c1359ceb20c4ae1fc` |
| `390x480-last-field.png` | 390×480; recorded task, full last field above readable actions | `e720ff1a424747c0f0fe1a09427eebb5fcfb225dcc17fd9c4c4423afbb3ff05b` |
| `390x844-last-field.png` | 390×844; task field/actions | `899f7f601dc59450f6b26fb88ab0fb334805bb6c0d0294a25bfd79f69054f9fa` |
| `1366-collision-ids.png` | 1366×900; independent choice and literal-ID fields after label activation | `7656f639bd1c4fe646b7593be17268e74fe9ff90dbb7dbc826b20b6fef1f7b0d` |
