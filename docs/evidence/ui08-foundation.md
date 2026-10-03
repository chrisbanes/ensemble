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

## Integrated validation

After removing the three unused Space Grotesk, Instrument Sans and IBM Plex
Mono packages, pinned `npm ci` passed with 80 packages added, 81 audited and no
vulnerabilities. The pinned integrated `npm run check` passed: TypeScript
typecheck, Biome lint, formatting, build, and all **808 tests** (808 pass, 0
fail, 0 skipped). Full output is retained at `/tmp/ui08-check.log`; clean
install output is `/tmp/ui08-npm-ci.log`. The complete T4 suite passed 24/24 at
`/tmp/ui08-t4-tests.log`; its build output is `/tmp/ui08-build.log`. `git diff
--check` passed, and the active source/package grep found no old font package or
token references. These test counts and artifact paths are also captured in
`/tmp/ui08-delivery.json` with final commit/tree identity.
