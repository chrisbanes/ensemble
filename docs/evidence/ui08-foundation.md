# UI08 shared operator foundation evidence

Status: implementation candidate; parent #736 human UI/release acceptance has
not been performed. This evidence qualifies the changed presentation using the
real production Vite bundle, `OperatorWebBundle`, same-origin service and
disposable SQLite fixtures. It does not qualify a deployed service or invoke a
runtime/provider.

## Reproduction identity

- Source base: `adb13194e6730dd3d077a14c1b446875cada7fae`.
- Candidate branch: `cb/issue-765-shadcn-foundation`.
- Candidate commit and tree identity are recorded in `/tmp/ui08-delivery.json`
  after the integrated check and clean commit. Do not treat these screenshots
  as evidence for a later source tree without comparing that identity.
- Runtime: Node `v24.21.0`, npm `12.2.0`, Playwright Chromium `153.0.8010.12`.
- Browser fixtures use `createOperatorFixture`, real SQLite and the compiled
  production bundle. Runtime/provider calls are deterministic fixture paths;
  these visual tests do not dispatch external work.
- Browser viewports: `1366×820` and `390×844` for the retained service HTML;
  UI03 covers `1366×820`, `390×844`, and `683×410` scaled layout. Browser waits
  for Inter and JetBrains Mono before taking the saved screenshots.

## Changed-surface checks

The focused build and browser run passed **17/17 tests** with no skips or
diagnostics. It included the retained-route foundation test, route and HTTP
guard checks, and UI03 browser journeys at desktop, phone and scaled sizes.
The UI08 retained-route test visited all 11 authenticated HTML content paths:
`/`, `/project/:id`, `/profile/:id`, `/task/:id`, `/assignment/:id`, `/runtime`,
`/runtime/task/:id`, `/runtime/assignment/:id`, `/coordination`,
`/coordination/task/:id`, and `/coordination/assignment/:id`. Each used the same
validated bundle stylesheet, no client scripts, no horizontal overflow, and
same-origin requests. It loaded and checked Inter and JetBrains Mono FontFaceSet
faces on every destination; the route's actual CSP permits `font-src 'self'`.
The 1366 project editor and 390 runtime controls verified computed 36px and 44px
control heights respectively; phone focus stayed on the native input.

The plan's destination count was not the same measure as the UI06 rendered
inventory. That unchanged test resolves **15 unique reachable replacement or
retained destinations** from the UI06 table: `/app`, `/app/assignments/:id/recovery`,
`/app/profiles/:id/settings`, `/app/projects/:id/settings`,
`/app/settings/profiles/new`, `/app/settings/projects/new`,
`/app/settings/runtime`, `/app/tasks/new`, `/assignment/:id`,
`/coordination/assignment/:id`, `/coordination/task/:id`, `/login`,
`/project/:id`, `/runtime/task/:id`, and `/task/:id`. Its passing result is
**84 individual controls, 42 rendered forms, 13 command discriminants, 14 form
actions, and 23 extension routes**. The stale plan counts (68 controls, 14
destinations, 38 forms, 12 actions/discriminants, 16 routes) are superseded by
that actual output; the test's control rows and assertions were not reduced.
The separate T4 browser route set is 11 authenticated service-HTML content
paths; it is not a subtotal used to produce the 15 replacement destinations.
Outside that direct path loop, HTTP tests check the production HTML login
response through the same `document()` wrapper, the T4 journey visits `/app` for
sign-in and React-to-HTML navigation/return, UI03 exercises the app shell and
`/app/tasks/new`, and UI06 suites cover the remaining React setup, configuration
and recovery routes.
The web-disabled login assertion confirms no bundle stylesheet link. Its
platform HTML remains functional but is not qualified for production visual
parity. Public denied and unsupported-path fragments remain intentionally
minimal and contain no authenticated page context.

The UI03 work-view suite preserves filter URLs, selected List/Board presentation,
task IDs and zero command submissions while switching views. It asserts a
desktop task row uses a compact grid and that a rendered task title computes to
14px/600. The primary native button and action anchor have measured contrasting
foreground/background pairs. Existing lifecycle, dirty-draft, unknown receipt,
exact reconciliation, retained field and independent hold assertions remain.
The invalid-field browser assertion waits for the shared `aria-invalid` border
transition to settle on the resolved destructive token; it uses no route-level
inline style or CSP exception.

The reviewed Pen handoff supplied design references but not a complete frame
for login, retained HTML editors, setup, or recovery. Those surfaces are
documented as shared-foundation comparisons, not pixel matches. The React
Overview comparison to `N9G11A` has the same dark neutral hierarchy and
work/attention concepts. The implemented fixture keeps its actual app
navigation, source/readiness/status labels and real fixture content; the Pen
frame has a different workspace/sidebar and sample inbox/work rows. Its work
rows retain the necessary source, lead, state and wait information in a compact
three-column desktop grid and stack on phone; the fixture's long status/reason
content makes individual rows taller than the shorter Pen examples. The
composer comparison to `Z315o`/`MhM7z`/`i3glx` preserves existing supported
fields, state, and actions; optional-input presentation remains the current
inline design. New task detail, search, structured Inbox/question grouping and
other future UI04/UI05 compositions remain out of scope.

## Attributable screenshots

Files were generated by `captureBrowserEvidence` and retained in the test
evidence directories. SHA-256 values below identify the exact PNGs:

| Screenshot | Pen association and observed state | File and SHA-256 |
| --- | --- | --- |
| 1366 overview, attention and work | `N9G11A`; real UI03 paused/uncertain/ready/waiting/source fixture, compact three-column rows | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-U9BKab/ui03-1432/310b8a0ff7a3bdee/1366-overview-attention-work.png` — `ded7b24fee21e699e171482a8fa72470cd812e04d71df48c2b8377306f3477aa` |
| 1366 long composer | `Z315o`, `MhM7z`, `i3glx`; actual supported composer fixture and unchanged disclosure behavior | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-U9BKab/ui03-1432/310b8a0ff7a3bdee/1366-long-composer.png` — `5c994c1b725940a4cc7741a3af938c6c1fd81cd3e3b47130cedad2789074f995` |
| 1366 retained Project editor | `eIXDM`/`DOuyS` shared-control comparison; real retained settings and exact editor fixture | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-ukmMjB/ui08-legacy-1431/f28e1b6f758ee08b/1366-retained-project-editor.png` — `3790817273d2675cc1b43d1578a9c0a2db4fda5e4dae13eac4c428a0b5f2d44a` |
| 390 retained Runtime controls | `CTUzI`/`zeoGi` shared-control and uncertainty comparison; native focus, 44px controls, no clipping | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-ukmMjB/ui08-legacy-1431/f28e1b6f758ee08b/390-retained-runtime-controls.png` — `6c0af523c409f95164f01d5d54038b31d8185ce85953773dbfe2807fd3210d8b` |
| 390 Overview, attention and work | `GWXOi`/`CTUzI`; real UI03 phone fixture and selected-column behavior | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-U9BKab/ui03-1432/739e5e2e50b16f27/390-overview-attention-work.png` — `509ff469c7196253c795c27190f1289d9840bbfb7d1ba8e149249dfc91622029` |
| 390 long composer | `Z315o`/`MhM7z`/`i3glx`; supported phone composer behavior | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-U9BKab/ui03-1432/739e5e2e50b16f27/390-long-composer.png` — `a87263286759941e75824990e033110bd904d8044551151afaaeec85ddf1c7ee` |
| 1366 empty project | `nD0nh`; production UI03 empty-project fixture | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-U9BKab/ui03-1432/310b8a0ff7a3bdee/1366-empty-project.png` — `d340a4c7e7c9ad27d8ffbb79831d0fa09272e3e1453f91b9cc0479d6dcc8016a` |

The new HTML captures show the shared tokens and real retained controls, not a
new server-rendered information architecture. Pen sidebar/drawer, exact legacy
editor layouts, and complete setup/recovery frames are unavailable; the
responsive adapter and accessible native controls are therefore qualified by
browser assertions rather than claimed as frame-level visual matches.

## Independent-review repairs

The authenticated production HTML phone fixture now seeds a persisted, 190+
character approval-material JSON record and a long assignment-history item,
then opens `/coordination/task/:id` and `/coordination/assignment/:id` at 390px.
The browser asserts the `<pre>` retains each exact string, stays within the
viewport, and does not widen the document. It also reads the approval form's
hidden key, CSRF token, task ID, interaction ID, revision, decision, action,
target and exact `materialJson`; it does not submit the form or start runtime
work. These fixture rows are inserted directly into the test SQLite store to
exercise the retained display paths, so they demonstrate presentation of
persisted records rather than runtime-originated history or a live approval.

`NativeSelect` now carries the same shared invalid-border/ring utilities as
`Input` and `Textarea`. The settings browser test covers its actual
“Readiness matching” `DraftField`: a deterministic HTTP 400 fixture response
with `readiness.mode` verifies the rendered select retains `aria-invalid`, its
`aria-describedby` error text, and the settled destructive border color. That
synthetic response qualifies the existing field-error presentation path; it
does not add or claim a backend validation case.

| Capture | Evidence and limitation | File and SHA-256 |
| --- | --- | --- |
| 390 long approval material | Authenticated production HTML route; exact seeded material and approval form hidden identities retained; no horizontal overflow | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-f6jDx9/ui08-legacy-33918/f28e1b6f758ee08b/390-retained-long-approval-material.png` — `3ae12f28b5a2a97d734ce6b74ac93f20015617aed15594ddb08da71969032f04` |
| 390 long assignment history | Authenticated production HTML route; exact seeded history text retained and contained | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-f6jDx9/ui08-legacy-33918/f28e1b6f758ee08b/390-retained-long-assignment-history.png` — `b56ebeb998042fd02e21fc12f9e1fcce49cd853fe8e3320e1859bf96f08a8c72` |
| 1366 invalid readiness select | Real settings select with fixture 400 field path, associated error and settled destructive border | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-NBrtZ5/ui06-33919/970680a2c5810715/1366-readiness-mode-select-error.png` — `18d696c7554d33f5d095d2b4cb9b93439480f04c1c25141a6a6d7e3e9fcf5143` |

The repaired browser suites passed 19/19, including the production HTML route
containment assertions and the readiness select state. Output is retained at
`/tmp/ui08-review-repair-browser.log`; the build output is
`/tmp/ui08-review-repair-build.log`.

The follow-up link and long-label repairs keep ordinary inline/editor and task
title links underlined in React and retained HTML while `.nav-link` and action
anchors retain their designed treatment. Browser checks measure the ordinary
link, sidebar navigation and primary action anchor; the action retains its
original foreground/background contrast. The source-observation button
measures 36px at desktop, grows to wrap its label at 320px, and stays within the
page at 320px and 360px while retaining the 44px phone minimum. No action was
submitted.

| Capture | Evidence | File and SHA-256 |
| --- | --- | --- |
| 320 long source-observation button | Real project-settings route; wrapped label, inline links visible, no horizontal page overflow | `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-an6zuo/ui06-94343/8a8f80356a0779e7/320-long-source-observations-button.png` — `d09cf710f96803f7b673b06b35f720e1bafb144b29f2a351de1ebdc95293196e` |

The affected React-shell, retained-HTML, settings and task browser suites passed
34/34 at `/tmp/ui08-review-r3r4-browser-final.log`; build output is
`/tmp/ui08-review-r3r4-build-final.log`. The first R3/R4 browser attempt is preserved
at `/tmp/ui08-review-r3r4-browser.log`; it exposed an overly strict test
expectation that the label must wrap at 360px, which was narrowed to require
wrapping at 320px and viewport containment at both widths.

The R5 phone-navigation repair applies a 44px minimum to every `.nav-link` in
the production Sheet portal below 760px. At 390px and 683px, the real populated
navigation sheet exposed six destinations (Overview, Inbox, All tasks, the
fixture project, Settings, and Existing operator controls); each link measured
44px, except the long wrapped project label at 97.5px. At 1366px, the first
desktop sidebar link remained 33.5px, preserving its existing geometry. The
browser assertion checks the full destination list, every phone target's
bounding-box height, desktop height, and the existing focus containment,
Escape-close, and trigger-focus restoration paths. The production route was
exercised at both phone breakpoints with real SQLite-backed app data.

The affected production browser suite passed 5/5 with zero skipped tests at
`/tmp/ui08-r5-browser-final.log`; build output is `/tmp/ui08-r5-build-final.log`.
The captured populated phone sheet shows the 390px state:
`/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-test-evidence-1my1zx/ui02-24373/606e3a9c3dc93c3e/390-populated.png`
(SHA-256 `ce33fa0a12ca5547dd6e1b5dd8f2fd42ccf950241c87ec89f3c662f0c50aa202`).
The final pinned `npm run check` passed **809/809** tests with zero failures,
cancellations, or skips after R5; its attributable output is
`/tmp/ui08-r5-check-final.log`. The initial attempt stopped at formatting and
is retained at `/tmp/ui08-r5-check.log`; its single Biome line-wrap issue was
corrected before the passing run.

## Integrated validation

After removing the three unused Space Grotesk, Instrument Sans and IBM Plex
Mono packages, pinned `npm ci` passed with 80 packages added, 81 audited and no
vulnerabilities. At the first independent-review checkpoint (R1/R2), the
pinned integrated `npm run check` passed: TypeScript typecheck, Biome lint,
formatting, build, and all **808 tests** (808 pass, 0 fail, 0 skipped). The
first repair run had one transient
failure in the untouched scheduler capacity test; that exact test passed in
isolation and the complete retry passed. Logs are retained at
`/tmp/ui08-review-repairs-check-final.log` (first attempt) and
`/tmp/ui08-review-repairs-check-final-retry.log` (pass). The earlier candidate
check remains at `/tmp/ui08-check-final.log`; clean install output is
`/tmp/ui08-npm-ci.log`. The renewed UI03 and retained-HTML
browser check passed 15/15 at `/tmp/ui08-final-browser.log`; its build output is
`/tmp/ui08-final-build.log`. The complete T4 suite passed 24/24 at
`/tmp/ui08-t4-tests.log`; its build output is `/tmp/ui08-build.log`. `git diff
--check` passed, and the active source/package grep found no old font package or
token references. These test counts and artifact paths are also captured in
`/tmp/ui08-delivery.json` with final commit/tree identity.

After the R3/R4 link and button-wrap repairs, the pinned full check passed on
the integrated candidate with **809 tests** (809 pass, 0 fail, 0 skipped);
output is `/tmp/ui08-review-r3r4-check-final.log`. The final affected browser
suite passed 34/34 at `/tmp/ui08-review-r3r4-browser-final.log`.
