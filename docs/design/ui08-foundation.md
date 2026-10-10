# UI08 shared operator foundation

This document records the shared presentation foundation, its surface inventory
and implementation choices. It does not claim integrated acceptance, deployment,
or cutover.

## Shared foundation

The React/Vite operator uses locally owned shadcn/ui source in `web/src/ui/`:
Button, Input, Textarea, NativeSelect, Badge, Alert, Card, and Sheet. Button
composition uses Radix Slot; Sheet wraps the already installed Radix Dialog.
`web/src/lib/utils.ts` provides the small `cn` helper using clsx and
tailwind-merge. Tailwind v4 is integrated through its Vite plugin. The owned
sources adapt shadcn/ui's Radix button, native select, badge, alert, card, and
sheet patterns; no shadcn runtime package or init CLI is used. Exact dependency
versions are pinned in [`package.json`](../../package.json).
The component source follows the official [shadcn/ui Vite setup](https://ui.shadcn.com/docs/installation/vite),
[Button](https://ui.shadcn.com/docs/components/radix/button),
[Native Select](https://ui.shadcn.com/docs/components/radix/native-select),
[Badge](https://ui.shadcn.com/docs/components/radix/badge),
[Alert](https://ui.shadcn.com/docs/components/radix/alert),
[Card](https://ui.shadcn.com/docs/components/radix/card), and
[Sheet](https://ui.shadcn.com/docs/components/radix/sheet) source patterns,
adapted to repository imports and existing Radix Dialog usage.

One semantic token set supplies Dark / Neutral / Default. The primitives follow
shadcn Nova: Geist 400/500/600 is interface text and Geist Mono 400 is for
identifiers and provenance. Desktop controls are 32px (`--radius-lg` 10px);
cards use `--radius-xl` 14px and 16px padding; badges are 20px pills; outline
and field backgrounds use `--nova-outline-bg` / `--nova-input-bg`; destructive
buttons and badges are tinted (`--nova-destructive-bg` / `-fg`), not solid. Phone
actions and labelled touch targets are at least 44px.
The shell uses a 224px sidebar, 20px main padding and 12px composition gaps.
The 760px phone breakpoint and the 1120px sidebar-to-drawer threshold are retained and tested against real content. The outcome
textarea is 260px on desktop and 180px on phone. Waiting, success and dependency
panels remain neutral with explicit labels. Errors use foreground text and a
destructive border.

## Surface and entry-point inventory

The detailed individual command/control table in
[UI06 configuration and recovery](ui06-configuration.md#individual-control-dispositions)
remains authoritative for all 84 control rows. The rendered-control test reports
15 concrete reachable replacement destinations, 42 rendered forms, 13 command
discriminants, 14 form actions, and 23 extension routes. The shared foundation
adds no command or rendered control. This matrix adds presentation ownership,
navigation counterparts and visual evidence without collapsing those individual
dispositions.

| Existing surface / entry paths | Presentation owner and retained behaviour | Counterpart / coverage |
| --- | --- | --- |
| `/login`, unauthenticated `/app*`, first-use bootstrap and expired session; diagnostic login with web disabled | React uses Input/Button/Alert; a failed login shows one generic message, clears the password and returns focus to it. Session expiry shows the sign-in screen at the same address with a status notice ("Your session expired. Sign in to continue." and "Private state cleared"); it is never shown on a first visit. Session expiry and retry remain server-owned. A signed-in visit to `/login` lands on `/app`. Web-disabled login remains minimal functional HTML. | Sign-in `nQvin`, `MxgGj`, `Wut6u`, `yr1m8`, `W64weN`; expired `OwZka`. The browser suite records the diagnostic fallback. |
| Unknown `/app/*` addresses (typed, stale or bookmarked) | The service serves the public shell with status 404 for any `GET`/`HEAD` under `/app/` that is not a client route (`/assets/*` and `/api/*` misses stay JSON 404). The client renders "Page not found" with one "Go to Overview" link inside the shell, no navigation item selected and no Refresh. A malformed task id still reaches the task's own not-found state; a malformed project, profile or assignment id is "Page not found". | `HCNJ2`; no phone frame. |
| `/app` shell on direct load, reload, history navigation and modified links | React shell owns the 224px sidebar (Overview, Inbox with its unresolved count, one Tasks item that is current for both views, Search, projects, New project; the List/Board switch stays in the task page) and its footer account menu (an avatar, name and chevrons trigger that opens Settings, Runtime and Sign out; below 1121px the drawer shows the same entries as always-visible rows); route links and `aria-current`. The existing controlled Radix dialog is the Sheet, with focus trap, Escape and trigger restoration. There is no "Operator workspace" top bar or global "Existing operator controls" link: the retained HTML stays reachable through the contextual "Advanced …" / "Open existing …" links, and `/` plus every service-served route is unchanged. At ≤1120px a top-level route shows a menu header (menu, title, Inbox count) and a nested route shows a detail header (Back to its static parent, title); one page header per route holds the single `h1`, an optional subtitle (the task views' intro, the Inbox "N unresolved across M projects") and at most one action (New task on the task views, Refresh elsewhere). A page-owned refresh ("Refresh tasks", "Refresh task", "Refresh results") replaces the shell Refresh and also re-reads the workspace and Inbox count; the fresh "Fetched" line is removed. The Inbox count is shown only when the whole Inbox was read and the last read succeeded. | Sidebar `eifyp`, account menu `DhtZq`, Overview `N9G11A`, phone headers `KthOL` / `p69Od`; navigation rows `mZoXC`. The phone account rows have no drawn frame. Sign out on a phone is reached from a top-level route's drawer; a nested phone screen keeps its Back header, so Sign out there is one Back away (accepted). |
| `/app`, `/app/tasks`, `/app/projects/:id` and query/filter URLs | React owns one toolbar row (heading, List/Board switch, inline Project and State dropdowns, count, Refresh tasks) and a "More filters" disclosure for Search, Source and Readiness, which opens for a URL filter. `state` is empty for Active tasks (every column except Done and Cancelled, so Draft stays visible), `all` or one column; Completed work on Overview links to `?state=Done`. Rows (Overview compact, List table) show title, project and identity (`repository#number` or Local task), state as icon and word, next actor derived from recorded attention only ("Next: you · answer question", "Next: none · no decision"), reasons and lead. Overview attention is one row per Inbox request, read from the shell's whole-Inbox read (kind, requester, time, one action, "N more in the Inbox"; failed and partial reads say so and show no total). List and Board carry a persistent attention summary (uncertain ownership, else Stopping) with the Inbox count. The Board has a link bar with every count, collapsed empty columns, drawn cards (https-only source links) and phone column tabs with previous/next buttons. Choosing a State selects that column (also on an open Board, without a reload); while the State is unchanged the operator's own tab choice stays. The attention summary names the requester of the matching Inbox request, as Overview does, never the task lead; the row, card and summary share one "ownership uncertain" rule. No drag/drop or status mutation. | List `nD0nh`; boards `E7qC9`, `MUFPD`, `x9cPnW`; phone `GWXOi`, `CTUzI`; Overview `N9G11A`. |
| `/app/tasks/new`, project-scoped creation, local draft and receipt/reconciliation state | React owns controlled project/title/outcome/context/reference/assignee/dependency fields and current disclosure behavior; preserves local drafts, unknown outcome reconciliation and confirmed receipt. Existing optional inputs are not redesigned into new progressive disclosure. | `Z315o`, `MhM7z`, `i3glx`, `Z6U3T4`, `JX4dm`, `wXiWx`; absence of the progressive composer disclosure is an explicit feature gap. |
| `/app/settings`, `/app/settings/projects/new`, `/app/settings/profiles/new`, `/app/profiles/:id/settings`, `/app/projects/:id/settings` | React owns public configuration drafts, native checkboxes/selects, validation/focus, private write-only replacement, dirty/reload/revision-adoption and unknown/recorded outcomes. Exact private values and advanced editors remain linked in retained HTML. | Shared controls `eIXDM`, `DOuyS`; no complete setup/configuration frame. |
| `/app/settings/runtime`, `/app/assignments/:id/recovery` | React presents capacity and curated read-only recovery evidence with independent holds, selected generation distinction and retained advanced evidence links. It does not establish termination or release ownership. | Shared controls `eIXDM`, `DOuyS`; no complete recovery frame. |
| Existing mobile navigation dialog | Sheet owns the existing controlled Radix Dialog interaction: trigger, title/description, close, overlay, Escape and focus return. | Sidebar frame `eifyp`; dialog behavior covered by browser tests. |
| Service-served HTML: `/`, `/project/:id`, `/task/:id`, `/assignment/:id`, `/runtime*`, `/coordination*`, including direct/query navigation and React-to-HTML links | The authenticated production bundle supplies validated same-origin CSS hrefs to `document()`. `.legacy-operator` styles existing labels, forms, controls, disclosure and navigation without hydration or handlers. Every CSRF token, idempotency key, revision, action and permission remains owned by its existing form/service. | Shared foundation `eIXDM`, `DOuyS`; no exact frames for legacy editors. The browser suite maps every documented destination. |
| Service HTML login/expired/error responses | Authenticated page wrapper may link the validated bundle stylesheet. Public unsupported-path and denied-request fragments stay minimal and disclose no session/private context. | Explicitly tested; public fragments are intentional minimal responses. |
| Diagnostic service with web bundle disabled | Existing platform HTML stays functional and reachable. This mode intentionally has no bundle CSS link and is not qualified for production presentation parity. | Explicit gap, covered by retained field/action tests. |
| Inbox and structured questions | The Inbox matches and the shared question response to frames 06–11, 19, 21 and 27–33: summary-only request cards (kind, action, relative age), compact filters, designed empty states, desktop auto-selection of the first request, two scroll regions with a sticky detail header and submit/decision area, a phone detail header (Back to Inbox, "Question · N of M", Open task), choice cards, two-column grouped questions, progress, "Recommended by …", failed, stale and recorded states, and approvals with their independent holds. Approval decisions stay at the retained `/coordination/task/:id#<interaction>` destination (control crosswalk unchanged). Differences and gaps are listed in `design/DESIGN.md` ("Inbox and structured questions"). Task detail and search are not covered by these frames. | Frames are not acceptance for other surfaces. |

## Individual control presentation

Each of the 84 rows in [UI06](ui06-configuration.md#individual-control-dispositions)
keeps its command, retained destination, replacement and disposition. Presentation
follows the disposition:

| UI06 disposition | Presentation |
| --- | --- |
| Implemented replacement, or explicit write-only/complete replacement (project, profile, routing, source, task composer, capacity, navigation, sign-out) | React shared foundation: Button, Input, Textarea, NativeSelect and labelled native checks; Alert, Badge and Card for status |
| Observation request (`github.refresh`) and read-only recovery evidence (`/runtime/assignment/:id` reads) | React shared foundation: Card, Badge and Alert |
| Retained exact editors and details (delivery policy and detail, task and source review, Runtime task controls, Coordination controls, captured assignment reads, `/login`) | Retained server HTML styled by `.legacy-operator` with the shared appearance; no hydration or handlers |

## State, keyboard and responsive coverage

The migrated React wrappers preserve native props, refs, IDs, descriptions and
caller classes. Native checkbox, select and `<details>` interactions remain
native. List/Board remains a presentation control using its existing pressed
state, not a false ARIA tab set. Error focus targets the first invalid field.
Mobile navigation remains controlled and restores focus; actions reach the
44px phone minimum.

Browser evidence is recorded in `docs/evidence/ui08-foundation.md`. It includes 1366×820, 390×844 and 683×410 journeys, font readiness,
keyboard/focus, populated/empty/waiting/error states, screenshot hashes and
matched Pen frames. Login, setup and recovery are explicitly labelled as
shared-foundation comparisons because the handoff has no complete matching
composition. Static Pen pixels do not qualify runtime behavior.

## Retained control scope

The existing UI06 individual control inventory is the source for form/action
identity and counterparts. UI08 changes presentation ownership only. The 11
authenticated retained HTML content destinations are exercised in the UI08
production-bundle browser journey; `/login` is also checked through that same
wrapper by the HTTP suite. React `/app`, task composer, configuration and
recovery paths are exercised by existing UI02/UI03/UI06 suites. The unchanged
rendered inventory reports 15 reachable replacement destinations and 42 forms;
all retain their original action, method, fields, hidden CSRF/idempotency/revision
values, and server permission checks. UI08 adds
no route, command, handler, write authority, or external provider call. The
intentionally minimal web-disabled and public error responses above are the only
service HTML surfaces without the common production bundle stylesheet.
