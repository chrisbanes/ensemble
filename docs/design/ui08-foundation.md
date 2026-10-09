# UI08 shared operator foundation

Status: implementation candidate on `cb/issue-765-shadcn-foundation`, based
on `adb13194e6730dd3d077a14c1b446875cada7fae`. This document records the
bounded presentation inventory and implementation choices for #765. It does not
claim integrated acceptance, deployment, or cutover.

## Shared foundation

The React/Vite operator uses locally owned shadcn/ui source in `web/src/ui/`:
Button, Input, Textarea, NativeSelect, Badge, Alert, Card, and Sheet. Button
composition uses Radix Slot; Sheet wraps the already installed Radix Dialog.
`web/src/lib/utils.ts` provides the small `cn` helper using clsx and
tailwind-merge. Tailwind v4 is integrated through its Vite plugin. The owned
sources adapt shadcn/ui's Radix button, native select, badge, alert, card, and
sheet patterns; no shadcn runtime package or init CLI is used. Installed exact versions are `class-variance-authority` 0.7.1, `clsx` 2.1.1,
`tailwind-merge` 3.7.0, `@radix-ui/react-slot` 1.3.3,
`@fontsource/geist-sans` 5.3.0, `@fontsource/geist-mono` 5.3.0,
`lucide-react` 1.51.0, and `tailwindcss` / `@tailwindcss/vite` 4.3.3.
The component source follows the official [shadcn/ui Vite setup](https://ui.shadcn.com/docs/installation/vite),
[Button](https://ui.shadcn.com/docs/components/radix/button),
[Native Select](https://ui.shadcn.com/docs/components/radix/native-select),
[Badge](https://ui.shadcn.com/docs/components/radix/badge),
[Alert](https://ui.shadcn.com/docs/components/radix/alert),
[Card](https://ui.shadcn.com/docs/components/radix/card), and
[Sheet](https://ui.shadcn.com/docs/components/radix/sheet) source patterns,
adapted to repository imports and existing Radix Dialog usage.

One semantic token set supplies Dark / Neutral / Default. Since
[#835](https://github.com/chrisbanes/ensemble/issues/835) the primitives follow
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
remains authoritative for all 84 control rows. The unchanged rendered-control
test now reports 15 concrete reachable replacement destinations, 42 rendered
forms, 13 command discriminants, 14 form actions, and 23 extension routes. The
published plan's 68-control/14-destination/38-form/12-action/16-route counts
were stale; UI08 adds no command or rendered control. This matrix adds
presentation ownership, navigation counterparts and visual evidence without
collapsing those individual dispositions.

| Existing surface / entry paths | Presentation owner and retained behaviour | Counterpart / coverage |
| --- | --- | --- |
| `/login`, unauthenticated `/app*`, first-use bootstrap and expired session; diagnostic login with web disabled | React uses Input/Button/Alert; password is intentionally cleared on failed login. Session expiry and retry remain server-owned. Web-disabled login remains minimal functional HTML. | `eIXDM`, `DOuyS` controls; no login composition frame. T4 records diagnostic fallback. |
| `/app` shell on direct load, reload, history navigation and modified links | React shell owns the 224px sidebar (Overview, Inbox with its unresolved count, Tasks with List/Board, Search, projects, New project) and its footer account group (Settings, Sign out); route links and `aria-current`. Existing controlled Radix dialog becomes Sheet with focus trap, Escape and trigger restoration. #835 removed the "Operator workspace" top bar and the global "Existing operator controls" link (agreed fallback, option (a)): the retained HTML stays reachable through the contextual "Advanced …" / "Open existing …" links, and `/` plus every service-served route is unchanged. At ≤1120px a top-level route shows a menu header (menu, title, Inbox count) and a nested route shows a detail header (Back to its static parent, title); one page header per route holds the single `h1` and at most one action. A page-owned refresh ("Refresh tasks", "Refresh task", "Refresh results") replaces the shell Refresh and also re-reads the workspace and Inbox count; the fresh "Fetched" line is removed. The Inbox count is shown only when the whole Inbox was read and the last read succeeded. | Sidebar `eifyp`, Overview `N9G11A`, phone headers `KthOL` / `p69Od`; navigation rows `mZoXC`. Sign out on a phone is reached from a top-level route's drawer; U2 (#836) replaces the footer group with the account menu. |
| `/app`, `/app/tasks`, `/app/projects/:id` and query/filter URLs | React owns work row/card composition, source identity, lead/next actor, List/Board pressed state, URL filters, selected phone column and named columns. No drag/drop or status mutation. | List `nD0nh`; boards `E7qC9`, `MUFPD`, `x9cPnW`; phone `GWXOi`, `CTUzI`; Overview `N9G11A`. |
| `/app/tasks/new`, project-scoped creation, local draft and receipt/reconciliation state | React owns controlled project/title/outcome/context/reference/assignee/dependency fields and current disclosure behavior; preserves local drafts, unknown outcome reconciliation and confirmed receipt. Existing optional inputs are not redesigned into new progressive disclosure. | `Z315o`, `MhM7z`, `i3glx`, `Z6U3T4`, `JX4dm`, `wXiWx`; absence of future composer disclosure is an explicit feature gap. |
| `/app/settings`, `/app/settings/projects/new`, `/app/settings/profiles/new`, `/app/profiles/:id/settings`, `/app/projects/:id/settings` | React owns public configuration drafts, native checkboxes/selects, validation/focus, private write-only replacement, dirty/reload/revision-adoption and unknown/recorded outcomes. Exact private values and advanced editors remain linked in retained HTML. | Shared controls `eIXDM`, `DOuyS`; no complete setup/configuration frame. |
| `/app/settings/runtime`, `/app/assignments/:id/recovery` | React presents capacity and curated read-only recovery evidence with independent holds, selected generation distinction and retained advanced evidence links. It does not establish termination or release ownership. | Shared controls `eIXDM`, `DOuyS`; no complete recovery frame. |
| Existing mobile navigation dialog | Sheet owns the existing controlled Radix Dialog interaction: trigger, title/description, close, overlay, Escape and focus return. | Sidebar frame `eifyp`; dialog behavior covered by browser tests. |
| Service-served HTML: `/`, `/project/:id`, `/task/:id`, `/assignment/:id`, `/runtime*`, `/coordination*`, including direct/query navigation and React-to-HTML links | The authenticated production bundle supplies validated same-origin CSS hrefs to `document()`. `.legacy-operator` styles existing labels, forms, controls, disclosure and navigation without hydration or handlers. Every CSRF token, idempotency key, revision, action and permission remains owned by its existing form/service. | Shared foundation `eIXDM`, `DOuyS`; no exact frames for legacy editors. T4 browser suite maps every documented destination. |
| Service HTML login/expired/error responses | Authenticated page wrapper may link the validated bundle stylesheet. Public unsupported-path and denied-request fragments stay minimal and disclose no session/private context. | Explicitly tested in T4; public fragments are intentional minimal responses. |
| Diagnostic service with web bundle disabled | Existing platform HTML stays functional and reachable. This mode intentionally has no bundle CSS link and is not qualified for production presentation parity. | Explicit gap, covered by retained field/action tests. |
| Inbox/task detail/question/search future surfaces | Existing Inbox handoff and retained task/coordination screens remain reachable. No new React Inbox, task-detail, search, or structured-question capability is included. | UI04/UI05 ownership; future frames are not implementation acceptance for #765. |

## Individual control presentation crosswalk

The rows below import the stable per-control/action dispositions from [UI06](ui06-configuration.md#individual-control-dispositions) and add the UI08 owner and primitive counterpart for every row. This preserves the original command, retained destination, replacement, disposition and identity rather than treating distinct controls as a category.

| Command/action | Control/read operation | Retained destination | Reachable replacement or retained destination | Disposition | UI08 presentation owner / counterpart |
| --- | --- | --- | --- | --- | --- |
| project.create | create project | / | /app/settings/projects/new | Implemented replacement; original control retained. | React shared foundation; Button |
| project.create | name | / | /app/settings/projects/new | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| project.create | lead | / | /app/settings/projects/new | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| profile.create | create profile | / | /app/settings/profiles/new | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| profile.create | name | / | /app/settings/profiles/new | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| profile.create | instructions | / | /app/settings/profiles/new | Implemented replacement; original control retained. | React shared foundation; Textarea / Input |
| profile.create | capabilities | / | /app/settings/profiles/new | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| project.configure | name | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| project.configure | lead | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| project.configure | instructions | /project/:id | /app/projects/:id/settings | Explicit write-only replacement in React; exact current private values and partial edits remain in retained editor. | React shared foundation; Textarea / Input |
| project.configure | pause | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| profile.configure | name | /profile/:id | /app/profiles/:id/settings | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| profile.configure | instructions | /profile/:id | /app/profiles/:id/settings | Explicit write-only replacement in React; exact current private values and partial edits remain in retained editor. | React shared foundation; Textarea / Input |
| profile.configure | capabilities | /profile/:id | /app/profiles/:id/settings | Explicit write-only replacement in React; exact current private values and partial edits remain in retained editor. | React shared foundation; NativeSelect / labelled native check |
| profile.configure | revoke | /profile/:id | /app/profiles/:id/settings | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| routing.configure | enable | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; Button / navigation link |
| routing.configure | guidance | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; Textarea / Input |
| routing.configure | candidates | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; NativeSelect / labelled native check |
| routing.configure | set/clear credential reference | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; Input / Textarea |
| github.configure | selections | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; NativeSelect / labelled native check |
| github.configure | readiness | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; NativeSelect / labelled native check |
| github.configure | repositories | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; Button / navigation link |
| github.configure | set/clear credential reference | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. | React shared foundation; Input / Textarea |
| github.preview | preview selections | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| github.preview | activation via preview receipt | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| github.refresh | refresh observation | /project/:id | /app/projects/:id/settings | Installation-wide observation request; no domain receipt or successful-sync claim. | React shared foundation; Card / Badge / Alert |
| github.place | conflicting placement | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| delivery.configure | completion mode | /project/:id | /project/:id | Retained exact policy/authority editor: completion mode, all nine grant kinds with repository/Project/field/options, required checks/app binding and credential set/clear; no public JSON command. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| delivery.configure | scoped grants | /project/:id | /project/:id | Retained exact policy/authority editor: completion mode, all nine grant kinds with repository/Project/field/options, required checks/app binding and credential set/clear; no public JSON command. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| delivery.configure | required checks | /project/:id | /project/:id | Retained exact policy/authority editor: completion mode, all nine grant kinds with repository/Project/field/options, required checks/app binding and credential set/clear; no public JSON command. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| delivery.configure | set/clear credential reference | /project/:id | /project/:id | Retained exact policy/authority editor: completion mode, all nine grant kinds with repository/Project/field/options, required checks/app binding and credential set/clear; no public JSON command. | Retained server HTML (`.legacy-operator`); Input / Textarea |
| delivery.read | issue observation | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| delivery.read | Project field observations | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| delivery.read | PR identity/head/state | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| delivery.read | provider feedback | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| delivery.read | external action states | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| delivery.read | local task state | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| delivery.read | delivery holds | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| /coordination/control/delivery/settle | Accept handback | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| /coordination/control/delivery/settle | Settle outcome as closed | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| /coordination/control/delivery/settle | task/delivery/policy revisions | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Input / Textarea |
| /coordination/control/delivery/settle | repository/PR/node/head guard | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| /coordination/control/delivery/refresh | refresh delivery observations | /coordination/task/:id | /coordination/task/:id | Retained UI04 delivery detail at this exact destination: cached provider/local facts and guarded settlement or observation request; no new React adapter or authority. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| task.create | draft | /project/:id | /app/tasks/new | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| task.create | create and start | /project/:id | /app/tasks/new | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| task.create | retained alongside delivered `/app/tasks/new` composer | /project/:id | /app/tasks/new | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| task.configure | local title | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| task.configure | outcome | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| task.configure | readiness | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| source.review | source identity | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| source.review | body | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| source.review | status | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| source.review | Project fields | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| source.review | native blockers | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| source.review | review | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| source.review | hold resolution | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| /runtime/control/capacity | global capacity | /runtime | /app/settings/runtime | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| /runtime/control/capacity | project override | /runtime | /app/settings/runtime | Implemented replacement; original control retained. | React shared foundation; NativeSelect / labelled native check |
| /runtime/control/capacity | remove override | /runtime | /app/settings/runtime | Implemented replacement; original control retained. | React shared foundation; Button / navigation link |
| /runtime/control/dependency/add | local dependency add | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| /runtime/control/dependency/remove | local dependency remove | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); NativeSelect / labelled native check |
| /runtime/control/instruction-apply | apply project instructions and profile revisions | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| /runtime/control/stop | stop request and observation | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| /runtime/control/resume | explicit resume | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| read | generation | /runtime/assignment/:id | /app/assignments/:id/recovery | Read-only curated evidence; exact advanced evidence and existing Apply remain retained. No ownership release or proof controls. | React shared foundation; Card / Badge / Alert |
| read | holds | /runtime/assignment/:id | /app/assignments/:id/recovery | Read-only curated evidence; exact advanced evidence and existing Apply remain retained. No ownership release or proof controls. | React shared foundation; Card / Badge / Alert |
| read | advanced recovery evidence | /runtime/assignment/:id | /app/assignments/:id/recovery | Read-only curated evidence; exact advanced evidence and existing Apply remain retained. No ownership release or proof controls. | React shared foundation; Card / Badge / Alert |
| /coordination/control/message | message recipient | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| /coordination/control/message | exact version | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| /coordination/control/message | durable message | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| /coordination/control/result/recipient | unresolved results | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| /coordination/control/result/recipient | destination reconciliation | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| read | retained captured history | /coordination/assignment/:id | /coordination/assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| read | omissions | /coordination/assignment/:id | /coordination/assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| read | results | /coordination/assignment/:id | /coordination/assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |
| /coordination/control/question/answer | plain question and exact revision answer | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Textarea / Input |
| /coordination/control/approval/decision | retained exact material | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| /coordination/control/approval/decision | approve | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| /coordination/control/approval/decision | deny | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Button / navigation link |
| /login | password sign-in | /login | /login | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Input / Textarea |
| /logout | sign-out | /app | /app | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | React shared foundation; Button / navigation link |
| navigation | delivered overview/project List/Board/composer | /app | /app | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | React shared foundation; NativeSelect / labelled native check |
| navigation | retained task/profile/assignment/Runtime/Coordination destinations | /app | /app | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | React shared foundation; NativeSelect / labelled native check |
| read | captured instructions/profile revision and result destination | /assignment/:id | /assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. | Retained server HTML (`.legacy-operator`); Card / Badge / Alert |

The base inventory test expands these rows from the UI02 screen/control matrix; its current result is 84 controls. The implementation plan's earlier count of 68 is stale for this reviewed base. UI08 adds no command or rendered control.

## State, keyboard and responsive coverage

The migrated React wrappers preserve native props, refs, IDs, descriptions and
caller classes. Native checkbox, select and `<details>` interactions remain
native. List/Board remains a presentation control using its existing pressed
state, not a false ARIA tab set. Error focus targets the first invalid field.
Mobile navigation remains controlled and restores focus; actions reach the
44px phone minimum.

Browser evidence is recorded in `docs/evidence/ui08-foundation.md` for T2–T4.
It includes 1366×820, 390×844 and 683×410 journeys, font readiness,
keyboard/focus, populated/empty/waiting/error states, screenshot hashes and
matched Pen frames. Login, setup and recovery will be explicitly labeled as
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
