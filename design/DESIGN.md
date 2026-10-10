# Ensemble UI design handoff

This is a portable reference for planning and implementing the reviewed Ensemble
web UI without opening Pen. The editable visual source is [design.pen](design.pen);
this document is a handoff snapshot of it, not a native Pen Markdown export or
evidence of implemented behaviour. Refresh it through Pen MCP when the design
changes; never parse the `.pen` file directly.

[SPEC.md](../docs/SPEC.md#operator-interface-and-human-requests) owns product
behaviour, [acceptance.md](../docs/acceptance.md#operator-ui-scenarios) owns required
evidence, and [#736](https://github.com/chrisbanes/ensemble/issues/736) owns delivery
scope and sequencing. Resolve conflicts in favour of those contracts. This file
records presentation and design references. shadcn is the component foundation.

All names, repositories, dates, counts, identifiers and captures in the frames are
fictional fixtures that illustrate states; they are not observations of Ensemble's
backend, proof of a passed check or production defaults.

## Contents

- Foundations: visual direction, tokens, typography and shape, layout and
  responsive composition
- Shared components
- Screens: operator refinement brief, interaction guidance, fixtures, task
  overview, review interactions, assignment context and delivery, search,
  workspace inspection and local review, Files and diff editor, tablet and
  short-viewport refinements
- Implemented differences from the frames
- Using this snapshot, design limits, and proposed (not yet adopted) data support

## Visual direction

Use the installed shadcn Pen library (`X`) with Mode **Dark**, Base **Neutral**,
and Accent **Default**. Screens reference the library components directly.
Domain-specific request, task, evidence and history content occupies component
slots. These compositions preserve Ensemble's spec-owned behaviour. All screen
roots select Dark / Neutral / Default; a user-facing theme switch is not designed.

The canvas follows shadcn/ui's **Nova** style on the Base UI base (the `base-nova`
preset: Nova / Lucide / Geist, neutral, default 10px radius). The Pen library
cannot be edited, so Nova is applied as instance overrides on its components plus
local tokens. Nova reference:
[`style-nova.css`](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/styles/style-nova.css)
and the `base-nova` entry in
[`registry/config.ts`](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/config.ts).
The web app's `web/src/tokens.css` and UI primitives use Geist, Geist Mono and the
Nova radii and control heights.

Keep the compact workspace: 224px desktop sidebar, 20px main content padding,
12px workspace gaps, 18px screen titles and 14–16px section headings. Task and
request titles are 14px medium. Supporting text remains 12–14px. Desktop buttons,
inputs and selects use Nova's 32px height (36px large); phone actions keep 44px
targets. The outcome editor is 260px high on the representative desktop and 180px
on phone; the production textarea uses the growth cap described under
[tablet and short-viewport refinements](#tablet-and-short-viewport-refinements).

Domain meaning is carried by visible labels, symbols, explanations and available
actions. Routine waiting, success and dependency states use neutral library
treatments. Error text remains high-contrast foreground; error panels use
destructive borders. Colour never establishes repair ownership, delivery or
operator attention.

## Tokens

All colour references use installed library tokens directly. The installed Pen
library exposes colour variables only; do not describe imported typography or
spacing tokens. Apart from the Nova and the editor/diff tokens below, the variable
registry contains only imported `X` colour tokens.

| Purpose | Installed token |
| --- | --- |
| Page and text | `X:--background`, `X:--foreground` |
| Supporting text | `X:--muted-foreground` |
| Cards and alerts | `X:--card`, `X:--card-foreground` |
| Neutral state surfaces | `X:--muted`, `X:--secondary` |
| Navigation | `X:--sidebar` and sidebar component tokens |
| Borders and input outlines | `X:--border`, `X:--input` |
| Primary actions | `X:--primary`, `X:--primary-foreground` |
| Selection | `X:--accent`, `X:--accent-foreground` |
| Focus | `X:--ring` |
| Error panel borders | `X:--destructive` |

Code, diff and evidence views use themed local tokens with Light and Dark values:
`editor-bg`, `editor-panel`, `editor-line-highlight`, `editor-selection`,
`editor-selection-border`, `editor-hunk-bg`, `editor-hunk-text`, `editor-text`,
`diff-added-bg`, `diff-added-text`, `diff-removed-bg`, `diff-removed-text`,
`diff-marker`, `evidence-accent`, `removed-surface` and `overlay-scrim`. Diff
colour always pairs with `+`/`−` markers and Before/After labels. These semantic
code colours are local to inspection content; the shared Dark / Neutral / Default
UI tokens, sidebar and buttons are unchanged. Editor line numbers are `#A3A3A3`,
about 5.0:1 against the selected-line fill at lowest.

### Typography, spacing and shape

Geist (`$font-sans`) supplies interface text; Geist Mono (`$font-mono`)
identifies IDs and provenance. Use 12px metadata, 14px body/control text, 14px
medium task/request titles, 14–16px medium section headings and 18px semibold
screen titles (in the tablet and short-viewport frames, section headings are
16/600). Badges use 12px medium. Larger type sizes are reserved for canvas
documentation, not product screen headings. Code is 13px monospace with 12px line
numbers; phone source and diff rows are 24px high with 12–13px monospace text.

Nova shape and density, with number tokens `$radius-sm` 6, `$radius-md` 8,
`$radius-lg` 10 and `$radius-xl` 14:

| Element | Nova treatment |
| --- | --- |
| Buttons, inputs, selects, textareas, alerts, tabs list, menus | `$radius-lg`; controls 32px high with 10px side padding |
| Cards, dialogs and card-like panels | `$radius-xl`, 16px padding, no shadow, 1px border |
| Tab triggers, sidebar items, menu items | `$radius-md` |
| Badges | Pill, 20px high |
| Outline button and field backgrounds (dark) | `$nova-outline-bg`, `$nova-input-bg` (white at 3%) |
| Destructive button and badge | Tinted `$nova-destructive-bg` with `$nova-destructive-fg` text, not solid red |
| Switch | 32 × 18 track, 14px thumb |
| Table cells | 8px padding |

Local layout overrides apply only where content or the 44px phone targets require
them. Composition uses the same 4px spacing rhythm as the installed controls.
Custom semantic fields and prose are not forced into unnecessary cards. The design
is not an untouched library demo: retained adaptations are compact task/request
content, 18px screen headings, 14–16px sections, 44px phone controls, identifier
monospace, and Ensemble content/layout in library slots.

## Layout and responsive composition

The collapsed laptop composer uses 1366 × 820. Desktop screens use 1366 × 900;
full-content references are 1366 wide with their natural height. Tablet frames are
1024 × 768 (the compact Inbox is 800 × 768) and short phone frames are 390 × 480.
Phone references use 390 × 844. These are review viewports, not fixed application
dimensions. Main desktop content and board workspaces use 20px padding and 12px
gaps; the Inbox retains 24px padding and 16px gaps. The imported desktop workspace
uses 28px padding and 20px gaps.

The shell uses the navigation drawer through 1120 CSS pixels. The 224px sidebar
plus the 40px horizontal page padding leaves 857px of task content at 1121px; the
production browser test checks 1119, 1120 and 1121px as well as 759, 760 and
800px. This measured shell breakpoint does not qualify the task-row, Inbox or
reading layouts by itself. The tablet frames use the existing drawer at 1024px and
keep the Inbox queue and detail side by side at 800px. Phone controls must
accommodate touch, keyboard and safe-area space without covering content.

- **Overview:** attention preview above the work list or board, with a route to the
  complete Inbox. Routine results are separate from requests requiring action.
- **Inbox:** sidebar, heading and filters remain available. Queue and detail scroll
  independently; request header and response/decision controls remain visible.
  Phone uses queue → detail → queue navigation with restored selection and position.
- **Composer:** project, title and desired outcome lead. Optional context,
  references, permitted assignee and dependencies disclose below them; collapsed
  summaries retain supplied values and visible error counts. Reserve space for
  Create and start / Save draft. Unfinished on-device input is distinct from a
  confirmed Ensemble draft or Ready task, and confirmed creation is distinct from
  admission. There is no attachment hint.
- **Task detail:** outcome, current situation and next actor, unresolved decisions,
  then attributed evidence precede assignment history. Requests remain outside
  disclosure; independent holds remain beside approvals. Preserve task → assignment
  → conversation identities and accountable lead. Opening an assignment shows its
  bounded recent preview and result; earlier content and omission notices remain
  accessible. The illustrated three-message preview is not a fixed acceptance
  requirement. History updates preserve position, disclosures and replies.
- **Imported task:** source content and Ensemble execution are visually separate.
  Desktop has source/execution panes; phone has GitHub source and Ensemble tabs,
  each preserving its position. External state is never implied by local activity.
- **Structured questions:** related questions form one submission. Desktop can use
  the Inbox detail pane or an adjacent task pane; phone uses one scrolling form
  with a persistent submit area. The two phone question frames are scroll positions
  of the same request, not separate submissions.
- **Board:** desktop exposes named column links and horizontally navigable columns;
  columns scroll vertically. Phone shows one column with named tabs and previous/
  next navigation. Stopping and Uncertain remain reachable with visible counts.
  Ready-but-blocked retains its Ready label in the Waiting column: readiness is
  distinct from work-state grouping. Cross-project and project counts, phone
  selection and previous/next controls reflect this mapping. The cross-project
  Waiting viewport shows two of its three tasks, with a labelled continuation.
  SPEC.md requires grouping by Ensemble work state, separating readiness from
  dependency holds and preserving the existing board mapping; see the
  [UI03 mapping record](../docs/design/ui03-tasks.md#attention-and-board). Done,
  Cancelled and provider-closed fixtures remain in All tasks and task views without
  redefining the active-board mapping. List/Board is a presentation switch, not a
  status mutation; no drag-and-drop is depicted.

## Shared components

Local reusable specimens connect to the installed library. Screen instances
reference imported components directly. Content, visibility, semantic colour and
responsive size overrides are intentional; the library remains the shared
primitive foundation.

| Ensemble specimen | Local node | Installed component |
| --- | --- | --- |
| Navigation / projects | `eifyp` | Sidebar `X:PV1ln`, Sidebar items |
| Button / primary | `VWlEO` | Button/Default `X:VSnC2` |
| Button / secondary | `K7cX7` | Button/Outline `X:C10zH` |
| Inbox / request row | `V8fnr` | Card `X:pcGlv`, request content slot |
| Source / GitHub issue identity | `vCXTp` | Badge/Outline `X:3IiAS` |
| Task / board card | `cjNBk` | Card `X:pcGlv`, task content slot |
| Request / recorded response | `w5VRs` | Alert/Default `X:QyzNg` |
| Execution / unresolved GitHub blocker | `Ra7pQ` | Alert/Default `X:QyzNg` |
| Question / choice with description | `NNq5u` | Card plus selected/unselected Radio |
| Question / free-text answer | `qdM95` | Textarea Group/Filled `X:CrS3L` |
| Status / badge | `j3TsL` | Badge/Secondary `X:WuUMk` |
| Navigation / segmented item | `B8KRB` | Tab Item, active/inactive |
| Input / text field | `tQvAL` | Input/Filled `X:AfQIN` |
| Navigation / board column link | `Q5GVK` | Tab Item, active/inactive |
| Navigation / mobile column tab | `kZTPH` | Tab Item with 44px height |
| Navigation / phone header (top-level screens) | `KthOL` | Menu icon, title, Badge, Button/Outline |
| Navigation / phone detail header | `p69Od` | Button/Ghost back, title and subtitle, one Button/Outline action |
| Navigation / row (navigation, not actions) | `mZoXC` | Title, optional summary, chevron |

Other reusable components:

- Compact task progress: `cIimt`.
- Criterion rows `GA7Ra` and local-feedback context `xljAv`; reusable criterion
  and feedback context `njRTx`.
- Workspace inspection component frame `i8oSV`, holding the observation strip
  `l1wkQX` and the selectable code line `Idu62` (kept for focused specimens; it is
  not a second product theme).
- Editor row `rccke` in `KlKGO`: separate source, gutter and diff-marker columns;
  it supports code, retained evidence and both diff sides.

Rules:

- Project and permitted-assignee fields use Select Group/Default `X:w5c1O`.
  Task lists use Table/Row/Cell components; assignments use Accordion. Agent and
  operator initials use Avatar/Text. Grouped multi-select questions use Checkbox,
  while single-choice questions use Radio. Labels, descriptions, selected values,
  validation messages and response controls remain explicit.
- Phone screens use one of the two headers above; nested screens use the detail
  header with the parent as the back label.
- Use a navigation row for anything that only opens another view. Keep buttons
  for actions, with one primary action per screen. Desktop buttons hug their label.
- The sidebar lists Overview, Inbox, Tasks (List/Board) and Search, then projects.
  Settings, Runtime and Sign out live in the footer account menu.
- Stop uses Button/Destructive and confirms first; reversible states show their
  counterpart (for example Restore profile).
- Identifier-heavy provenance (R2 · A-105 · 8d31c4a) is 12px muted metadata
  below the plain-language state, never the headline.
- Status icons supplement visible state words. Running does not imply repair
  ownership; provider closure does not imply delivery. In implementation, treat
  these icons as decorative when adjacent text already conveys their meaning.
  Task lead names and accountability remain visible alongside avatars.

## Operator refinement brief

Make the next decision obvious, and keep its evidence close:

- **Attention:** show the specific decision/intervention, requester when known,
  reason the operator is needed and available response. Keep relevant evidence
  close. Use consistent meaning across Overview, Inbox, List/Board and task detail.
- **Work views:** distinguish work state, next actor and attention without changing
  the existing board mapping. A running agent alone is insufficient evidence of a
  repair. Show unknown responsibility honestly. Keep readiness, completed work,
  cancellation and provider closure without delivery distinguishable.
- **Task detail:** prioritise outcome, current situation/next actor, unresolved
  decisions and evidence. Disclose assignments and captured history underneath,
  retaining the task's accountable lead and assignment/conversation identities.
  Use recorded facts and attributed excerpts; add no invented summary capability.
- **Composer:** keep project, title and outcome prominent; disclose optional
  context, references, assignee and dependencies with a summary of supplied values.
  Preserve validation, drafts and truthful creation/admission feedback.
- **Readability:** give task meaning and the immediate next step more space than
  repeated navigation metadata. Keep titles distinguishable and supporting text
  readable. Retain semantic state meanings and readable typography; shadcn supplies
  their visual foundation.

Shared components and representative desktop/phone frames use fixtures for
agent-owned check repair, an operator question, approval with an independent
dependency hold, completion without a decision, uncertain execution and capacity
waiting. They also show unknown responsibility and distinguish cancelled/undelivered
work from success, and demonstrate evidence inspection, response, confirmation and
return to the prior context, including stale reads and failed submissions.

These designs preserve exact approval material, source ownership, Stop/Resume
limits and command-outcome semantics. They add no agent/provider selection,
attachments, terminal, browser, runtime or remote-write capabilities. This is a
presentation brief, not a delivery plan.

## Interaction guidance

Apply the exact state and permission rules from SPEC.md. These are presentation
details that the reviewed frames illustrate:

- Retain filters, selected request, scroll anchor, expanded groups and unfinished
  input while updates arrive. Follow new messages only when already at the bottom;
  otherwise provide New updates / Jump to latest.
- After a confirmed Inbox answer or decision, keep a confirmation visible instead
  of automatically selecting the next request. Failed submissions retain input.
- Recommended/preselected question options are not submitted answers. Show pending,
  recorded, failed, stale, cancelled, already answered, offline and unsupported
  interactions distinctly. Unsupported requests remain unresolved without a blind
  retry or conversion to ordinary chat.
- Distinguish Message lead, response to a specific question, approval of an exact
  action and Post comment to GitHub. Show destinations and persistence outcomes.
- Preserve source snapshots on failed refresh, showing last successful sync. A
  confirmed comment receipt does not mean the source snapshot was refreshed.
- Present Ready-but-blocked work honestly. No automatic GitHub writes are depicted.
- Keep visible keyboard focus, selection constraints and errors beside the affected
  question. The interaction notes specify radio arrow-key navigation, Space for
  selection, and focus on the first invalid field after submission.

### Entry points and return behaviour

- Overview, project/cross-project List and Board share the compact facts and task
  detail. Back restores filters, selection and position; Board also restores its
  column. Updated shared progress `cIimt` and frame `L2aXf` cover these entry points.
- Inbox enters at the relevant request and returns to that queue item, keeping its
  request anchor, queue filters, selected item and position. Task → inspection does
  not answer the request.
- Direct task entry retains project/source context, with the task's project as
  fallback when there is no in-session origin.
- Search is in the shared desktop sidebar and the phone header; see
  [Search](#search). Back through a journey restores the previous section and
  reading anchor.
- Existing pending-request access, exact-material approval, Deny and Leave pending
  flow, Execution, Stop and recovery remain reachable from every task view.
  Independent source and execution holds remain independent of approval, checks
  and merge.
- No context-menu, extension, notification or deep-link surface is designed.
  Native Codex/ChatGPT work is outside this design.

## Fixtures and journeys

Illustrative design records; existing excerpts keep their attribution. Added
records illustrate assignment ownership, creation receipts and lifecycle states.
No recommendation is inferred from running activity.

| Fixture / journey | Desktop references | Phone references |
| --- | --- | --- |
| Failed check with recorded repair owner, no attention | Overview `N9G11A`; List `nD0nh`; cross-project/project boards `E7qC9`, `MUFPD`; task `oipj4` | `zs53F` |
| Running with unknown repair responsibility | Overview `N9G11A`; List `nD0nh`; boards `E7qC9`, `MUFPD`; task `kiPK9` | `zs53F` |
| Specific audience question, requester, reason and evidence | Inbox `cGjau`; Overview and paused task row/card | Queue `U3RAH`; request `pmu7r`; evidence `YjRad` |
| Failed submission, stale read, confirmation and return | Lifecycle reference `jKzRk`, shared receipt `w5VRs`, interaction contract `BvX5O` | Failed `uJVe2`; stale `e1kkI`; recorded `o6O3M`; anchored return `q2vYE` |
| Exact approval and independent dependency hold | Review `DAeiN`; recorded approval `US7Kv`; imported task `biA7p` | Task `K045bl`; review `ZWQIU` |
| Completed result and retained evidence, no decision | Task `Q24BPH`; outcomes `zeoGi`; Overview recent results | `Thy1i` |
| Cancellation and provider closure without delivery | Outcomes `zeoGi` | Cancelled `rn49D`; provider-closed/Ensemble-paused `ALMfc` |
| Uncertain execution and honest recovery | Overview/List; later board `x9cPnW`; outcomes `zeoGi` | `CTUzI` |
| Confirmed creation waiting for capacity | Outcomes `zeoGi`; composer semantics `s34356` | Receipt `Z6U3T4` |
| Optional values, collapsed error count and expanded invalid dependency | Composer `Z315o`; full-content `MhM7z` | Composer `i3glx`; collapsed error `JX4dm`; expanded error `wXiWx` |

The question journey is queue → request → recorded evidence → request with
retained selection → submit → recorded confirmation → anchored queue. Failure
retains the choice; stale evidence retains the last read and requires checking the
current request. Exact unknown command outcomes require reconciliation, not a
blind retry. Confirmation does not automatically open another item.

The approval receipt authorises AP-17 revision 2 only. It explicitly says no
execution started and retains the source-owned GitHub dependency. It does not
claim PR creation or successful delivery. Existing source refresh/comment outcome
references remain in place; the design adds no remote-write capabilities.

Overview orders execution uncertainty first, then the 09:14 question before the
10:52 approval, matching Inbox. Task detail `RyH7J` and full-content reference
`QGdAx` identify AT-142 as imported from `acme/atlas#142` and retain the open
`acme/design-system#87` dependency independently of AP-17 approval, consistent
with the board, imported detail and approval screens. Composer `Z315o` uses 12px
for the shared sidebar workspace label.

Frame `BvX5O` annotates focus restoration, scrolling, keyboard operation,
safe-area handling, persistence and command reconciliation, plus the review
checklist. Existing expanded-history and grouped question references remain the
disclosure/state inventory; representative initial screens prioritise evidence
above history.

## Screen reference map

Use the viewport frames for composition. Full-content frames show content inventory
and disclosure detail; do not shrink their entire height into a laptop viewport.

| Surface | Frames and Pen nodes |
| --- | --- |
| Foundations and control library | `DOuyS`, `eIXDM` |
| Attention overview | 01 `N9G11A` |
| Laptop composer and task detail | 02a `Z315o`, 03a `RyH7J` |
| Composer/history interaction notes | `s34356`, `ILOxx` |
| Inbox question, approval and empty | 06 `cGjau`, 07 `DAeiN`, 08 `VVYuZ` |
| Phone Inbox and question | 09 `U3RAH`, 10 `pmu7r` |
| Inbox filters and lifecycle | 11 `jKzRk` |
| Imported desktop and expanded history | 12 `biA7p`, 13 `rEGDJ` |
| Phone source and execution | 14 `C5mb7`, 15 `K045bl` |
| GitHub outcomes and connected surfaces | 16 `jHghC`, 17 `xoFAQ` |
| Grouped questions in Inbox and task | 19 `eowDX`, 20 `bOQnB` |
| Phone grouped form, initial and scrolled | 21 `YzbOM`, 21b `m6ZUJR` |
| Question lifecycle and interaction notes | 22 `evQB1`, 26 `e839O` |
| Matching list and cross-project board | 24 `nD0nh`, 18 `E7qC9`, 18b `x9cPnW` |
| Project board | 23 `MUFPD` |
| Phone Waiting (Ready with a hold) and Uncertain columns | 25 `GWXOi`, 25b `CTUzI` |
| Full-content composer and task detail | 02 `MhM7z`, 03 `QGdAx` |
| Expanded captured history and state references | 05 `nfqO8`, 04 `wLhJT` |
| Refinement section and evidence/response journey | Section `uhRIV`; 27 `YjRad`, 28 `uJVe2`, 29 `e1kkI`, 30 `o6O3M`, 31 `q2vYE` |
| Approval confirmation and phone review | 32 `US7Kv`, 33 `ZWQIU` |
| Phone composer and validation disclosure | 34 `i3glx`, 35 `wXiWx`, 35b `JX4dm` |
| Repair, completed and unknown-responsibility task details | 36 `oipj4`, 37 `Q24BPH`, 45 `kiPK9` |
| Phone repair, capacity, completion, cancellation and closure | 38 `zs53F`, 39 `Z6U3T4`, 40 `Thy1i`, 41 `rn49D`, 42 `ALMfc` |
| Desktop lifecycle comparison and interaction checklist | 43 `zeoGi`, 44 `BvX5O` |
| Canvas contents (every section and frame with node IDs) | `H7aUq1` |
| Settings, sign-in & recovery section | Section `dwLnk`; review notes 130 `DuF5u` |
| Sign-in desktop and phone | 108 `nQvin`, 109 `MxgGj`, 110 `Wut6u`, 111 `yr1m8`, 112 `W64weN` |
| Account menu and settings index | 113 `DhtZq`, 114 `vEr15` |
| Guided project setup, error, first run, discovery unavailable and folder picker | 115 `wk678`, 116 `q6ZqlW`, 117 `bkNmZ`, 117b `T6VX5`, 131 `M6N2BQ` |
| Project configuration and phone state | 118 `gi83t`, 119 `w0ozf`, 120 `SBB7W`, 121 `Pwzju` |
| Profiles and routing | 122 `F6d3SQ`, 123 `O96oS`, 124 `Z8uZnh`, 125 `c8af5` |
| Runtime, assignment recovery and not found | 126 `AqYk0`, 127 `iEF1o`, 128 `ur1mr`, 129 `HCNJ2` |
| Stop confirmation | 132 `uQrNE` |
| Operator refinement (section 10, renamed 800A–800H) | `qIVmm`; `h23qD`, `FsTwL`, `dUUIS`, `Z8BqXF`, `LBzlj`, `nKHGv`, `Sejey`, `g5wmIu` |

Workspace inspection frames 77–106 and the task-overview, review, assignment and
search frames have their own node tables in the sections below.

## Task overview

Shared brief, delegation, evidence and compact progress requirements are in the
[task overview specification](../docs/SPEC.md) and
[design-review criteria](../docs/acceptance.md). #742 owns task review, search and
its shared navigation; #745 owns integrated qualification. These frames are
reviewed design, not an implemented UI.

The task header establishes project, source, accountable lead and current wait.
Actionable requests sit above disclosure. Desktop places the shared brief beside
the latest result, its evidence and compact delegation rows; phone discloses the
brief, result detail and assignment history from a single task summary. Existing
shadcn controls, semantic colours, identifier roles and the reusable compact
progress component `cIimt` remain the foundation.

Fixture: criterion labels C1/C2, validation V-22, revisions and results illustrate
recorded relationships. AT-142 retains the existing AP-17 v2 exact-material
approval and independent GitHub dependency. A-105 and A-106 have parallel
responsibilities using the same Builder profile; their IDs, requesters and result
destinations distinguish them. At the illustrated snapshot, A-105 has reported R2
and A-106 has recorded a failed focus check before waiting on the dependency.
FN-58's empty and expanded views are different moments in the same local-task
journey.

| Review surface | Pen node |
| --- | --- |
| Desktop task, 1366 × 900 | `MRbe2` |
| Full-content task inventory | `TG3LC` |
| Phone task, 390 × 844 | `YFLwX` |
| Phone evidence and earlier results | `XQI9S` |
| Empty, dependency, refresh and uncertainty specimens | `oJHx1` |
| Expanded local brief, question, history and retained draft | `vesIN` |
| Phone long brief and retained draft | `LrM0E` |
| Phone empty local task | `Crq7h` |
| Phone failed refresh and uncertain execution | `F2OKCj` |
| Shared compact progress and entry-point specimens | `L2aXf` |
| Phone delegation and history access | `qCkVq` |

- **Brief:** GitHub requirements remain read-only with links to the full source
  brief on GitHub. Local brief content expands in the task reading area. Local
  requirements identify the operator. Approach and recorded decisions identify
  the reporting assignment. Missing criteria say “None supplied”. Requests are
  never hidden by collapsing either the brief or history.
- **Results:** the latest reported result identifies assignment and revision.
  Criterion-linked validation shows scope, outcome and provenance; it does not
  establish whole-task delivery. Screenshot and log links open the associated
  material. The phone evidence view illustrates a failed screenshot preview;
  retry fetches the artifact, not execution. Earlier results are separately
  labelled with their revision. Old validation does not verify newer work.
  Missing, stale, unavailable and redacted evidence have distinct explanations.
- **Delegation:** responsibility, profile, assignment ID, requester, destination
  and known wait reason remain visible. The laptop's compact arrow means
  requester → result destination. Opening a row discloses its result and bounded
  history. Unknown observations remain unknown; conversation text does not
  establish execution state or repair ownership.
- **Attention and controls:** AP-17 links to existing desktop `DAeiN` / phone
  `ZWQIU` exact-material review, preserving action, target, patch and description
  revisions, Deny and Leave pending. Changed material needs renewed review.
  Approval leaves independent holds intact. Execution, Stop and recovery remain
  reachable through existing controls; existing Resume/reconciliation boundaries
  are unchanged. Q-24 uses the existing structured-answer flow. A message to the
  lead is local and does not submit a question response or GitHub comment.
- **Updates:** preserve the visible record anchor, expansion choices, focus and
  unsent replies. Append routine activity behind “new updates”; reveal it on
  request without silently jumping or discarding drafts. Load earlier history
  inserts above the current anchor. Fresh actionable requests update the visible
  request area without stealing focus. Failed refresh keeps the last successful
  read and timestamp. If a pending request changes while answering, retain the
  draft and use the existing stale-request review flow before submission.
- **Phone:** use 44px controls and one reading column. Detail subviews retain the
  pending-request shortcut and return anchor. Keep request access and response
  actions reachable while scrolling and with the keyboard open. The full-content
  desktop frame is an inventory, not a screen to shrink.

## Review interactions

The task summaries prioritise supplied criterion outcomes and contextual feedback.
Comparison and revision changes disclose from the result; they are not new
dashboard panels. Shared brief, delegation, attention and execution/recovery
access remain.

| Review surface | Pen node |
| --- | --- |
| Reusable criterion and feedback context | `njRTx` |
| Revised result and criteria needing another look | `gAT6T` |
| Labelled before/after comparison | `dKc4O` |
| Inspect evidence and edit contextual feedback | `WEBvT` |
| Confirmed send failure with editable draft | `uqbVh` |
| Confirmed local-message receipt | `AVuFr` |
| Phone before/after comparison | `mrRXI` |
| Missing before and unavailable after material | `OisQm` |
| Revision changes, no baseline and failed-source alternatives | `ge1Mm` |
| Revised phone task summary | `IuukL` |
| Phone changes disclosure | `cP92Q` |

The comparison uses fictional UI captures created on the canvas. The two image
assets are in `design/assets/` (including `command-menu-after.png`) and are
referenced by five canvas image references; screen preview exports are omitted. The
images illustrate evidence presentation; they are not screenshots of implemented
behaviour or real validation. Earlier unavailable/unverified fixtures are
alternative or earlier states, not simultaneous claims about the latest result.

### Correction journey and outcome semantics

1. At the first review, source snapshot S1 supplies only C1 and C2. R2 is A-105's
   report at `8d31c4a`. C1 is supported by recorded keyboard check V-22. A-106's
   V-23 records a focus-restoration failure; E-31 illustrates the missing focus
   ring. The agent's earlier implementation claim stays separate from that check.
2. Open C2 evidence, then Ask lead for changes. The editable local message is
   addressed to Mira and bound to C2, source S1, R2 and `8d31c4a`. The example asks
   for focus restoration and a regression test. A confirmed send failure keeps
   the draft editable. M-42 at 11:15 confirms only that the local message was
   recorded; it does not establish that an agent acted or changed task state.
3. R3 at `b72e910`, reported by A-105 at 11:40, claims the correction. V-24 records
   two passing checks for the default opener; E-32 illustrates its visible ring.
   R2's failure remains historical. C1's V-22 is stale for the new work revision.
4. GitHub snapshot S2, captured at 11:35, adds toolbar launch to C2's focus
   requirement. No recorded check covers that new scope. C2 is unverified against
   S2 even though V-24 supports the default-opener scope. The operator can inspect
   the source change and request further work without an invented overall pass.

Supported, failed, unverified and stale describe the displayed evidence scope.
There is no overall pass, acceptance percentage or automatic task transition.
Tasks without supplied criteria retain “None supplied”; inferred criteria are
not generated. Source requirements remain read-only with GitHub attribution.

### Interaction details

- **Contextual feedback:** result actions bind R2/R3; criterion actions also bind
  the supplied criterion and source snapshot; artifact actions bind E-31/E-32.
  All retain the relevant work revision. Show the destination and reference before
  sending, and allow editing. Back keeps the draft. The reference must not silently
  retarget if a newer result arrives. A confirmed rejection offers Retry; an
  unknown send outcome needs status reconciliation before retry. Success returns
  to the selected evidence anchor, without discarding other unfinished replies.
  This is an Ensemble message, not a GitHub comment, rejection or approval.
- **Comparison:** desktop places labelled captures side by side; phone stacks the
  same pair with persistent Before/After labels and result/revision attribution.
  Details reach originals and associated checks. Missing material and failed
  preview loading remain distinct. Retain available material and labels; retry
  fetching does not rerun execution. Never substitute a different revision to
  fill an empty slot. Images alone do not verify focus behaviour.
- **Since viewed:** disclose newer results, superseded evidence and recorded
  requirement changes relative to the illustrated 11:12 viewing reference. The
  marker is neither acceptance nor approval. With no reference, show the current
  result without labelling everything new. If source comparison is unavailable,
  retain the last read and do not claim requirements are unchanged. Opening the
  disclosure never answers an approval or clears a hold.
- **Preserved context:** updates retain reading anchors, comparison selection,
  expansion choices, focus and unsent feedback. New activity does not replace the
  selected evidence. Actionable requests remain outside collapsed history and
  reachable from the evidence, feedback and changes views. Phone forms use 44px
  actions; keyboard/safe-area behaviour remains an implementation check.
- **Approval boundary:** initial views retain AP-17 v2 for `8d31c4a` and description
  v2. The later fictional snapshot contains a recorded AP-17 v3 for `b72e910` and
  description v3; v2 is superseded. The design does not assume a new request is
  created merely because a result changed. Both preserve the independent
  `acme/design-system#87` hold and existing exact-material review, Deny and Leave
  pending flow. Execution and recovery remain available through task navigation.
- **Entry points:** `cIimt` and `L2aXf` reach the same result/criteria view and
  restore the origin's filters, selected task, column and position on return.
  Inbox still opens the exact actionable request; Open task reaches review tools
  without converting new results into attention.

## Assignment context, delivery and search

These are fictional design fixtures, not provider observations. They reuse the
sidebar, buttons, input, result criteria and feedback journeys.

| Surface | Pen node |
| --- | --- |
| Desktop captured assignment and current requirements | `DBsYv` |
| Phone captured assignment and references | `tK66S` |
| Desktop recorded changes, evidence and delivery | `M41aTm` |
| Phone changes and delivery | `eP5LX` |
| Desktop PR, repair, head and delivery alternatives | `ExcLV` |
| Phone delivery alternatives | `c3utBY` |
| Desktop search with attributed excerpts | `WaBk5` |
| Phone search and restored selected match | `JPf7F` |
| Desktop search coverage, recovery and historical result | `qYS87` |
| Phone search recovery and historical result | `IzE97` |

### Connected journey and hierarchy

Desktop: `WaBk5` → matching result in `gAT6T` → assignment context `DBsYv`
→ changes/delivery `M41aTm` → selected match in `WaBk5`.
Phone: `JPf7F` → matching result in `IuukL` → context `tK66S`
→ delivery `eP5LX` → selected match in `JPf7F`.
The relevant canvas controls carry destination-node annotations. These are
static design annotations, not working navigation or prescribed application routes.

The desktop result leads with “Focus correction reported; toolbar needs another
look”. Work revision and evidence gaps remain immediately visible. Assignment,
result, instruction/profile, source-snapshot, commit and validation identities sit
beneath the outcome or in the context/provenance disclosure. The parallel-assignment
rows remain in the document behind disclosure; the initial result view uses a
compact summary. Attribution remains available without competing with the outcome.
`IuukL` retains phone criterion summaries and links into assignment context and
delivery.

The C1/C2 summary, comparison `dKc4O` / `mrRXI`, contextual feedback `WEBvT`,
send-failure recovery `uqbVh`, confirmation `AVuFr`, and since-viewed `ge1Mm` /
`cP92Q` remain. Contextual feedback keeps its exact result/material reference when
newer work appears; it does not silently retarget.

### Assignment context and delivery

- **Assignment context:** enter from the task’s assignment/provenance disclosure
  or a selected assignment. Show the captured brief and its supplier, instruction
  and profile revisions, and attributed references. S1 is captured context;
  source-owned S2 is current requirements. Profile revision 5 is distinct from
  captured revision 4 and is not silently applied. Missing toolbar reference,
  unavailable guidance snapshot and changed requirements are represented on both
  sizes. Available material never claims that the agent read it. Open captured
  material and retry access keep assignment/result selection and reading position.
- **Changes and delivery:** enter from the result or assignment context. The
  primary fixture has recorded files/commit, result revision, diff and evidence
  access, stale and scope-limited checks, an outstanding finding, unknown repair
  ownership and no linked PR. Alternative snapshots show linked PR #214, a
  failing check with recorded A-106 repair, the same failure with unknown owner,
  changed head, stale provider data and merged-but-task-not-complete. Alternatives
  are labelled; they are not simultaneous facts or evidence that approval or
  publication happened in the primary fixture. Provider observations identify
  their timestamp and revision. Refresh retries a read, not execution. Result
  diffs stay bound to the result revision; head comparisons are separate.
- **Returning:** Back through the journey restores the previous section and
  reading anchor. External evidence opens with task context retained; returning
  restores that exact material. Preserve expansion, comparison selection, focus
  and drafts while updates arrive. If the selected item is unavailable, keep its
  unavailable state rather than substituting a newer record.

### Search

Search is a shared destination for tasks, recorded decisions and results. Project,
record type, date and inclusion of historical records are the filters. Each match
has an attributed excerpt; opening it selects the matching requirement, decision
or result section, including historical R2 rather than silently opening current
R3. Search makes no complete transcript claim. Unavailable destinations retain
attribution and offer retry or return; absence of matches does not establish
absence from omitted records. Return to search restores the query, every filter,
selected match and position.

- **Discoverable entry:** Search sits beside Overview and Inbox in the desktop
  navigation component and the representative Overview, List, Board, Inbox,
  task, context and delivery screens. Phone Inbox exposes a labelled 44px Search
  action in its reusable header; the phone Board uses the same labelled action.
  Search has the active desktop navigation treatment; Overview is inactive there.
  The phone search header identifies the current Search view and offers Workspace
  return. No keyboard shortcut is required to discover it.
- **Connected journey:** desktop `N9G11A` → Search `WaBk5` → selected AT-142
  result `gAT6T` → Back to `WaBk5`; phone `U3RAH` or `GWXOi` → `JPf7F` →
  `IuukL` → Back to `JPf7F`. Opening selects the exact matching requirement,
  decision or result section. Returning restores `focus`, All projects, All types,
  Any date, history included, match 2 of 4 and its reading position. Return to
  Workspace restores the originating queue/board selection, filters and position.
  Existing task context, delivery, comparison and feedback disclosures retain
  their anchors, disclosure choices and drafts. These are static interaction
  annotations, not working routes.
- **Independent attribution:** four fictional matches span Atlas AT-142 (Command
  menu) and Relay RL-88 (Connection dialog). Both result matches have the similar
  title “Focus correction”; each identifies its own project, task ID/title,
  reporting assignment, result and work revision, and current/historical status.
  Task requirements identify their GitHub source and source revision. The decision
  identifies Mira/A-104, D1/S1 and historical status. Matching excerpts lead;
  metadata is compact and remains within the owning row, even with All projects
  selected. Historical R2 in the state specimens has the same complete ownership.
- **States belong to flows:** search filters edit the current query scope; Refresh
  provider status retries the read in the current delivery view. Existing checks,
  findings, comparison and recovery controls remain. `qYS87`, `IzE97`, `ExcLV`
  and `c3utBY` are canvas review specimens with no product navigation into them.
  Their loading, no-match, failure with retained earlier matches, partial-coverage,
  historical-result, unavailable-destination and changed-head snapshots replace
  content within the owning flow. Retry retains previous observations with their
  age, selected material, drafts and all holds.

| Updated entry reference | Pen node |
| --- | --- |
| Desktop shared navigation | `m0d2bc` |
| Desktop Overview → Search | `N9G11A` |
| Phone Inbox → Search | `U3RAH` |
| Phone Board → Search | `GWXOi` |

Older reference screens are historical examples; apply the shared navigation
treatment during implementation.

## Workspace inspection and local review

Design handoff for [#793](https://github.com/chrisbanes/ensemble/issues/793), under
[#776](https://github.com/chrisbanes/ensemble/issues/776). Read it alongside the
[SPEC](../docs/SPEC.md), [WI01–WI13](../docs/acceptance.md), and the Agent Briefs in
[#779](https://github.com/chrisbanes/ensemble/issues/779),
[#780](https://github.com/chrisbanes/ensemble/issues/780),
[#781](https://github.com/chrisbanes/ensemble/issues/781) and
[#782](https://github.com/chrisbanes/ensemble/issues/782). This design adds no
application implementation, dispatch, acceptance result or cutover authority. It
extends, rather than replaces, existing task, evidence, contextual feedback,
execution, approval and recovery flows.

### Visual source and node references

The frames are in [design.pen](design.pen), in the section starting at canvas
position **2952, 27789**. Desktop frames are 1366 × 900; phone frames are 390 × 844.
Read the desktop rows left to right, then the phone rows below. The state
specimens are review aids, not destinations in the product.

The shared shadcn library remains **Dark / Neutral / Default**. The work reuses the
installed sidebar and buttons, phone header `KthOL`, local-feedback context `xljAv`,
and the existing task/result compositions. Inspection editors use edge-to-edge
panes and compact toolbars; other desktop content retains 20px padding. Phone
reading content uses 16–20px padding and phone action targets are at least
44 × 44px.

| Composition / render reference | Exact Pen node |
| --- | --- |
| 77 · Shared inspection components and section introduction | `i8oSV` |
| 78 · Current Files, code preview and single-line selection | `unmyA` |
| 79 · Repository-free generated Markdown output | `pUX8f` |
| 80 · Branch diff, both sides and deleted-range comment composer | `V0DCi` |
| 81 · Repository/base selection, comparison menu and Uncommitted | `rlw92` |
| 82 · Original retained R3 file after workspace removal | `xD63J` |
| 83 · Complete editable two-file review and summary | `bRkWF` |
| 84 · Actual latest-turn identity and complete/partial/unavailable alternatives | `dHsfB` |
| 85 · Raster and PDF output preview alternatives | `JCGmX` |
| 86 · Inspection, capture, ignored-reveal and workspace states | `oA8pq` |
| 87 · Current/outdated/unknown/unavailable anchors and Refresh | `SQRtH` |
| 88 · Phone file list and current observation | `gQhwY` |
| 89 · Phone Before-side deleted-line range selection | `TEkRK` |
| 90 · Phone add/edit/remove anchored comment | `J2AwE` |
| 91 · Phone complete review, first reading position | `aB35C` |
| 92 · Same complete review, second comment and summary position | `EZasz` |
| 93 · Phone repository-free Markdown output | `bz4VC` |
| 94 · Phone sending / original payload locked | `OHIOZ` |
| 95 · Phone confirmed failure / editable draft / retry | `OBijt` |
| 96 · Phone unknown outcome / original-operation reconciliation | `X3wI8B` |
| 97 · Phone confirmed receipt and sent-review access | `CACzF` |
| 98 · Phone retained result bytes after workspace removal | `KVIG2` |
| 99 · Phone PDF page and zoom controls | `FCvHl` |
| 100 · Phone raster fit/zoom/pan | `MKzws` |
| 101 · Phone comparison/base selection and staged/unstaged filters | `lQbVM` |
| 102 · Phone unsettled turn, deletion and read recovery | `rD02Q` |
| 103 · Phone authentication expiry and private-state purge | `OwZka` |
| 104 · Desktop sent review with original comments and summary | `u0YEF` |
| 105 · Retained original R3 diff after later workspace changes | `Mn97J` |
| 106 · Keyboard range selection, editing and focus return | `EKC1J` |

Existing desktop task `gAT6T`, phone task `IuukL`, and result/delivery view
`M41aTm` are extended in place; their contextual feedback, criteria, approval,
assignments, execution and source-owned dependency controls remain. Desktop task
entry nodes: Files `Nid6O`, Changes `O0Eyx4`, Review `wSt5b`, retained R3
`Y4ifBs`. Phone entry row: `pi945`. Result/delivery entry row: `R2IFU`.

### Fixture material

Atlas task **AT-142**, Command menu, retains **Mira** as accountable project lead,
**A-105 / Builder**, source S2, work W-18 and **R3 / b72e910 at 11:40**.
AP-17 v3 and external dependency #87 remain independently reachable. Current
workspace inspection is observed at **12:06**. Repository `acme/atlas` has
authorised root `/tasks/AT-142/atlas`, base `main`, and exact merge base
`7e9c20d8a15b63f0449d716ef09af6bd8279c311`. Shortened hashes in compact phone
labels disclose the full value; they do not replace it in the underlying context.
`acme/design-system` is a second task worktree with its own unknown base.

T-208 / Builder succeeded with observations 11:32–11:39. The later T-209 was
interrupted, with observations 12:02:11–12:04:38 and partial capture. These are
alternative moments, not two selectable historical turns. The running T-210
specimen explicitly distinguishes it from the latest finished capture T-209.
R3 evidence survives replacement of T-208 and workspace removal. `c-73a1`,
`c-4e91` and `d-19f2` are illustrative immutable content/capture identities,
not real hashes. Review operation RV-42 carries two comments and a summary;
confirmed local receipt LR-42 is shown at 12:14. Sending/failure/unknown/sent
frames are alternative outcomes of that operation, not simultaneous states.

Repository-free **Fieldnotes / FN-58**, Research brief, also has Mira as lead,
with root `/tasks/FN-58/outputs`, no Git repository and no holds. Its Markdown
journey is separate from AT-142's draft; drafts never cross tasks. The fictional
command-menu PNG is reused as an image preview. PDF pages are drawn content
fixtures, not an implemented PDF renderer or passing keyboard evidence. Displayed
file sizes/page counts illustrate metadata, not configured limits.

### Connected journey and entry/return map

1. Task → Files opens `unmyA` / phone `gQhwY` at a current observation. Generated
   output has the same prominence and controls as code. FN-58 opens `pUX8f` /
   `bz4VC`; raster/PDF open `JCGmX`, `MKzws` or `FCvHl`.
2. Changes opens the same task's selected repository and comparison. Branch
   uses `V0DCi`; dropdown/base states use `rlw92` / `lQbVM`; actual-turn views
   use `dHsfB` / `rD02Q`. Selecting a repository restores its own comparison
   and baseline, not another repository's main branch.
3. Select one text line or a range, including either diff side and deleted
   lines. Add/Edit opens the anchored composer (`V0DCi` / `J2AwE`) using the
   originating selection, as specified under parameterised composer entry. Save
   adds to the task's local draft and returns to that selection. It does not send.
4. Move to another file and add another comment. Review opens the **complete**
   draft (`bRkWF`; phone `aB35C` → scroll → `EZasz`). Every comment, original
   excerpt, comparison and status can be inspected. Edit/remove and optional
   summary stay here. The destination is visibly Mira before Send review.
5. Send freezes that exact logical submission. `OHIOZ` → confirmed failure
   `OBijt`, unknown `X3wI8B`, or confirmed `CACzF`. Inspect sent review opens
   the read-only equivalent of `u0YEF`; original context remains accessible.
6. From R3 evidence or result delivery, open `xD63J` / `KVIG2` (original file)
   or `Mn97J` (original diff), retaining R3/A-105/b72e910. Opening current
   contents is a separate explicit navigation; a missing historical capture
   never redirects there. Returning restores the exact result/evidence anchor.

| Origin | Inspection entry and return contract |
| --- | --- |
| Overview `N9G11A` | Open shared task `gAT6T`, then current Files/Changes; return to the same task row, filters and position. |
| Project/cross-project List `nD0nh` and Board `E7qC9` / `MUFPD`; phone `GWXOi` | Same task entry; return restores project/task filters, selected task, view, board column and scroll. |
| Inbox `cGjau` / phone `U3RAH` | Retain originating request AP-17, queue filters, selected item and position. Task → inspection does not answer the request. Back returns to that request, not a generic task list. |
| Result, criterion and evidence | Preserve selected result, assignment/work revision, criterion/source reference and evidence identity, including older results. Existing single-message Ask lead for changes remains distinct from batched review. |
| Search `WaBk5` / `JPf7F` | Retain query, scope, filters, match and exact historical section through task → inspection → return. |
| Assignment context `DBsYv` / `tK66S`, delivery `M41aTm` / `eP5LX` | Carry the selected assignment/result into retained evidence; return to the same expanded disclosure and reading position. Current inspection is explicitly labelled. |
| Direct task/file/comparison/result/review links | Resolve authorised task and exact requested context. Direct historical links stay historical. If missing or forbidden, explain the unavailable destination; never substitute current bytes. Without an in-session origin, offer the task/project as fallback. Exact URL syntax is an implementation choice. |
| Retained advanced execution, approval and recovery routes | Reachable through task controls / Holds on phone. Keep the original task/request/result return anchor. Inspection never resolves ownership or execution uncertainty. |
| Context menus, extensions and notifications | No applicable entry points are established by the current design. Native Codex/ChatGPT work is outside this design. |

### Desktop, phone and keyboard behaviour

#### Parameterised composer entry

Composer references in canvas actions are layout templates, not navigation to
the fixture's prefilled anchor. In particular, screen 78's Add comment reference
to `J2AwE` must instantiate a **current-file** composer for the selected current
line 42; it must not copy that specimen's Branch / Before / deleted lines 41–43.
The same parameterised contract applies on desktop and phone, in code and
Markdown Source, and when editing an existing draft comment.

| Origin | Composer context that must remain unchanged |
| --- | --- |
| Files screen 78 (`unmyA`), current line 42 | AT-142 / `acme/atlas` / `src/components/CommandMenu.tsx`; Current workspace, observation 12:06, exact observed content identity and excerpt, line 42 only; no diff side or Branch comparison. |
| Changes screen 80 (`V0DCi`) or phone 89 (`TEkRK`), deleted range | Same task/repository/path; Branch comparison and exact merge base; Before side, deleted lines 41–43, original compared content identity and excerpt. This is the fixture drawn in `J2AwE`. |
| Retained result/evidence or an existing draft | That retained result/capture or saved comment's original immutable context, including its comparison/side/range when applicable; never the current file or another fixture's values. |

Add comment captures the origin's task, repository/root, full path, current/
comparison/result context, exact content identity and bounded excerpt, logical
line/range and side (only for a diff), observation/capture time and return/focus
anchor. The composer displays these supplied values. Save preserves them in the
draft and returns to the originating selection; Cancel returns there without
creating a comment. Refresh, responsive layout or switching composer templates
cannot rebind the anchor. If that original context cannot be supplied, explain
the unavailable anchor rather than falling back to the specimen's values.

#### Layout

Desktop uses a file tree/list beside the dominant preview. A range composer sits
beside the diff; complete review has its own reading surface. Files, Changes and
Review preserve independent reading positions within the task. Full paths wrap
in provenance disclosure; compact labels must not lose repository or file
identity. File lists and previews scroll independently; task identity, observation
controls and access to holds remain reachable. Long code can wrap or horizontally
scroll with a stable line gutter. Diff panes retain explicit Before/After labels
and do not confuse old and new line numbers. Large documents use bounded reads,
with explicit truncation/omission notices rather than an implied complete file.

Phone is list → preview → anchored comment → complete review. It is not a scaled
desktop split pane. Mobile source and diff rows are 24px high, with 12–13px
monospace text; explorer rows, range controls and action buttons keep their 44px
targets. Tap a gutter to select a line, or use the labelled 44px Start/End
controls for precise selection and range adjustment. The selected side is
explicit; switching sides starts a new selection, never transforms an existing
anchor. `TEkRK` shows deleted Before lines 41–43 with visible focus/selection.
Use the same selection controls in source text/Markdown. Rendered Markdown
offers Source lines; images and PDFs keep ordinary exact-context feedback rather
than inventing image coordinates or PDF text-line anchors.

`aB35C` and `EZasz` are two scroll positions of **one complete-review page**, not
a pagination gate or separate batches. Every comment is reachable before Send;
no arbitrary checkbox or forced reading confirmation is introduced. Content and
action areas scroll above keyboard/safe-area insets. A pinned action bar, if used,
must reserve content space. Root `clip:true` defines the viewport; the fixtures
show bounded excerpts and separate reading positions, not an unscrollable app.

#### Keyboard

Keyboard path (drawn in `EKC1J`): Tab into the named file tree, arrows move the
active item and Enter opens it. Tab reaches the preview gutter; arrows move the
line cursor, Space selects one line, Shift+Up/Down extends the range. Labelled
side and Start/End controls provide an equivalent explicit path. Tab → Add
comment → Enter puts focus in the labelled input. Tab/Shift+Tab reach Save and
Cancel; Escape cancels the edit and returns to the invoking line/comment.
Saving returns focus to the original selected range. Review has a heading,
ordered comments and labelled Edit/Remove actions; removing a draft comment
returns focus to the next comment or the empty-draft heading. Menus close with
Escape and restore focus to their trigger. The ring is visible; no hover-only
or mouse-only action is required. Actual browser focus/assistive-technology
behaviour remains an implementation acceptance obligation.

### Observation, provenance and preview semantics

Three contexts remain unmistakable: **Current workspace · observed time**,
**Last turn · actual turn/agent/outcome and before/after times**, and **Retained
result evidence · result/capture time**. Detailed root, repository, baseline,
content identity, assignment/work/result provenance and capture limits disclose
below this summary. Material uncertainty is never hidden in the disclosure.

- Current inspection is stable until explicit Refresh. Known changes show a
  notice; inspecting neither pauses work nor releases any hold. Failed Refresh
  retains the last successful read and its time. Successful Refresh preserves
  selected file/comparison/disclosures and reading position where still valid;
  changed/deleted/unavailable content is stated explicitly. Old comments stay
  attached to their original bytes/range. A renamed path is evidence of a new
  location, not authority to retarget an anchor.
- Branch compares observed current contents with the merge base of the selected
  repository's task base branch. Show the exact baseline commit and observation
  time. Unknown base offers only locally available branches; selecting one
  neither fetches nor checks out. No usable merge base means unavailable.
- Uncommitted retains staged and unstaged distinctions even for a file appearing
  in both. Untracked entries have no Before bytes; deleted entries retain a
  commentable Before side; renames show both paths; binary entries have metadata,
  not an invented text diff. No arbitrary revision selector is added.
- Last turn is the latest relevant actual agent turn, never a result revision or
  completed assignment. Identify separately any currently running turn and the
  latest finished capture. Only the latter is browsable turn history. Partial
  failed/interrupted/uncertain observations do not establish that writes ended.
  Complete means complete within the disclosed capture bound, not the whole tree.
- Markdown renders inertly and can switch to source; raster has Fit/zoom/pan;
  PDF has page navigation and fit/zoom. Unsupported/binary, oversized, excluded,
  changing, failed and missing states explain what is and is not available.
  There are no editing, terminal, download or export actions.
- Show ignored / Hide ignored is reversible and initially off. Sensitive
  exclusions apply to lists, direct previews, captures and retained evidence in
  both states. Access failures use non-leaking explanations. Unsafe paths,
  symlink escapes, cross-task anchors and inconsistent reads cannot yield a
  preview or falsely exact capture. These are required service guarantees,
  not properties proved by a canvas.
- Result evidence and bounded review context have lifetimes independent of
  workspace cleanup and latest-turn replacement. Original file bytes and diffs
  remain exact through later changes, restart and removal when retained.
  Excluded/oversized/changing/missing/failed captures record specific gaps
  without rejecting the result. Older uncaptured R1 remains unavailable;
  retrying a preview cannot backfill history using newer contents.

### Draft, anchor, submission and privacy semantics

Each comment binds task, authorised root/repository (or explicit no repository),
original path, immutable content identity, selected range, applicable diff side,
and the current/comparison/result/actual-turn context. Path and line number alone
are insufficient. Retain the bounded original excerpt needed to inspect the
comment, including for current-file reviews without a result record. Show
**Current at last comparison**, **Outdated** when change/rename/deletion is
established, **Unknown** when comparison cannot be established, and
**Unavailable** when original material is absent/inaccessible. Never substitute
new bytes. A failure to retain an exact new anchor keeps the typed comment but
blocks adding it until valid context is available. Existing unavailable anchors
remain inspectable as records with their specific gap; do not silently discard
them or silently send a partial batch.

Draft comments can be edited or removed; submitted comments cannot. The complete
draft shows every comment and optional summary. An empty draft has no enabled
Send action. The named accountable lead is checked again before submission;
if destination or reviewed material changes, return to the complete review
instead of silently changing who or what will be sent.

| State | Presentation and permitted next step |
| --- | --- |
| Editable | Add/edit/remove comments, inspect original contexts, edit summary, continue inspection, or Send the complete review to Mira. |
| Sending | Freeze the submitted payload and identity; show progress and inspection access. Do not offer another send. |
| Confirmed failure | Explicitly no delivery; draft remains editable. Retry the unchanged logical operation safely; edited payload requires a distinct logical submission identity. |
| Unknown outcome | Preserve original operation and payload for reconciliation. Check status and inspect it; no edited retry or replacement delivery while unresolved. Reconciliation determines confirmed failure or the original receipt. |
| Sent | Confirmed receipt, destination, task, time and batch scope; inspect exact comments, summary and original contexts. No retraction, formal verdict or thread-resolution controls. |

Submission is one logical local-feedback delivery; a partial delivery cannot
look complete. It performs no GitHub publication, approval/rejection, readiness
or completion change, merge-authority grant or release of execution/dependency/
ownership holds. Existing single-message Ask lead for changes is preserved with
its own exact context and draft, separate from the multi-comment review.

Authenticated navigation and inspection Refresh preserve draft text, anchors,
selected file, comparison, disclosures, reading position and return context where
valid. The application explicitly purges private task/reply/search/Inbox state on
authentication expiry or session-identity change (`web/src/app.tsx`, `expired` /
`acceptSession`, and `web/src/task-workspace-state.ts`, `purge`). `OwZka`
therefore promises neither unsent-draft restoration after expiry nor indefinite
client storage. Sign out and access loss follow the same privacy boundary. After
reauthentication, reload authorised context; recover pending/submitted operation
records before allowing another send. Clearing private client state does not erase
an already-recorded operation or permit duplication.

#781/#782 own settling and documenting authenticated draft persistence through
browser reload, bounded retention/cleanup and operation recovery. This design
requires navigation/Refresh continuity and safe reconciliation; it does not
choose a database schema, API/route, renderer, storage quota or retention period.
An implementation unable to restore a draft must disclose that loss, never
claim it was saved. Numeric listing/byte/render/time bounds are engineering
choices; replace illustrative metadata with actual values and truthful limits.

### Coverage against #793 and WI01–WI13

| Requirement | Drawn coverage | Implementation evidence still required |
| --- | --- | --- |
| WI01 · task roots, outputs, multiple repositories, ignored and missing workspace | 78, 79, 81, 86, 88, 93, 101 | Authorised filesystem listings, exclusions and repository binding. |
| WI02 · all preview formats and truthful limits | 78, 79, 85, 86, 93, 99, 100 | Bounded reads/rendering, inert content and unsupported formats. |
| WI03 · secure scope and inconsistent reads | 86, 87 | Traversal, absolute-path, symlink, cross-task and file-replacement tests; visual states cannot prove enforcement. |
| WI04 · Branch/Uncommitted and entry kinds | 80, 81, 101 | Real Git staged/unstaged/rename/delete/untracked/binary fixtures, exact per-repository baselines. |
| WI05 · unknown/unusable local base | 81, 101 | No guessing/fetch/checkout and unavailable merge base. |
| WI06 · actual latest turn and capture uncertainty | 84, 102 | Bound real turn/agent/time, successive replacement, partial execution and persistence. |
| WI07 · exact retained evidence and explicit gaps | 82, 86, 98, 105 | Original file/diff bytes after edits, restart, turn replacement and cleanup. |
| WI08 · stable read and explicit Refresh | 78, 87, 88, 102 | Live concurrent changes, reading-position restoration and unaffected holds. |
| WI09 · entry/return, desktop/phone/keyboard | Modified task/result screens; 78–106; entry map above | Actual routes, origin/filter/scroll restoration and long-content navigation. |
| WI10 · single/range/either-side comments and multi-file draft | 78, 80, 83, 89–92, 106 | Anchor validation, edit/remove, invalid-range/excluded/cross-task rejection. |
| WI11 · original/outdated/unknown/unavailable review context | 82, 87, 98, 104, 105 | Retention through rename/delete/restart/cleanup and honest gaps. |
| WI12 · review before send and reliable outcomes | 83, 91, 92, 94–97, 104 | One logical delivery and receipt; confirmed rejection versus uncertainty; zero duplicate delivery or authority changes. |
| WI13 · drafting across views, sent context and privacy | 80, 83, 88–98, 103, 104, 106 | Production desktop/phone/keyboard journeys, auth purge and reconciliation; preserve single-message feedback. |

The scope excludes workspace editing, terminals, downloads/export, whole-workspace
snapshots, arbitrary comparisons or older-turn browsing, formal review verdicts,
retraction, threaded resolution, native integrations, deployment and cutover.
Source/service policy and delivery authority are unchanged.

## Files and diff editor

The Files and diff interiors take their conventions from
[Codex code review](https://developers.openai.com/codex/app/review/) and
[VS Code's changes and diff editor](https://code.visualstudio.com/docs/sourcecontrol/staging-commits):
a navigable file rail, open-file tabs, path breadcrumbs, separate line gutters,
readable diff hunks and comments close to their source. Ensemble does not add
their write, staging or commit actions. The root IDs, entry points and the
#793 / WI01–WI13 contracts above are unchanged.

| Composition | Root / key render references |
| --- | --- |
| Files: explorer, source and single-line selection | `unmyA`; explorer `dM3KL`; editor `w0EoyN`; selection `jNeDu` |
| Generated Markdown with an output explorer and rendered/source modes | `pUX8f`; document `ZmnP5` |
| Branch: changed-file rail, split diff and inline deleted-range draft | `V0DCi`; diff `pGGwv`; inline draft `k0qaG` |
| Repository, comparison and local-base menus; Uncommitted alternatives | `rlw92`; menus `GUH1I`, `A9NYX`; filters `xxayQ` |
| Original R3 file and diff in the same editor language | `xD63J` / `ChMwt`; `Mn97J` / `i0qqt` |
| Phone explorer and unified deleted-range selection | `gQhwY` / `Kz0T5`; `TEkRK` / `TOMyK`, `t3rHJu` |
| Phone generated Markdown and retained original source | `bz4VC` / `Jo87G`; `KVIG2` / `q02M0E` |
| Shared editor row: number, marker and source | `KlKGO` / `rccke`; children `zUmct`, `kUOqQ`, `nxeiM` |

Desktop uses a 238px file rail beside the 224px application sidebar. The top task
controls, Files/Changes navigation and observation strip together occupy 132px.
File tabs, breadcrumbs and metadata sit immediately above the reading area. The
explorer uses 32px rows with folder indentation and file-type icons. Changed-file
rows pair the filename with its parent path and explicit M/U/D/R/B status; colour
is supplemental. Generated outputs have the same visual priority and reading space
as source files.

A selected line has a blue selection fill; diff additions/deletions use restrained
green/red fills plus explicit +/− markers and Before/After labels.

`V0DCi` places the draft composer below the selected hunk, with its exact
Before 41–43 deleted-range anchor visible. Save comment adds to the local draft;
it does not send. Review opens the complete-review screen `bRkWF`. Cancel restores
focus to the originating range without changing other comments. Split/Unified
changes presentation only, and hunk arrows move within the same comparison.
Baseline selection uses only local branches and retains the per-repository
baseline. `rlw92` deliberately draws mutually exclusive menus and states together
as labelled specimens, not as one product screen state.

On phone, the explorer is a full-width destination with 44px file rows. Opening a
change leads to `TEkRK`'s unified diff, with distinct old/new gutter columns.
Deleted rows remain selectable. Start/End controls choose the range without
requiring a precise drag; Clear removes only the selection. Add comment uses the
`J2AwE` template with that origin's exact anchor, then the complete-review
journey is `aB35C` → `EZasz`. Both phone range controls and comment actions are
44px high. Files, Markdown and retained evidence use the same compact navigation,
without squeezing a desktop rail onto the phone. `TEkRK` and `KVIG2` use compact
24px editor rows (13 mobile editor rows at 24px); the desktop row component and
instances are unchanged.

Keyboard traversal is task controls → Files/Changes → observation/Refresh →
explorer → open tabs → preview controls → source selection → comment action.
Arrow keys navigate the tree; Right/Left expand/collapse; Enter opens a file and
preserves explorer focus context. Tab enters the line-selection surface. Up/Down
moves a single-line anchor and Shift+Up/Down extends it on the selected diff
side. Enter on Add comment focuses the composer. Tab reaches Cancel/Save;
Escape cancels the composer and restores the original line/range. Saving returns
focus to its comment marker. `EKC1J` continues to specify comment editing and
return from the complete review.

Long filenames elide in the narrow rail; hover/focus discloses the exact path,
and the selected file's breadcrumb/provenance exposes it without ambiguity.
Screen 78 (`unmyA`) is drawn with the explorer labels `CommandMenu.tsx` and
`CommandMenu.test…` wrapped onto two lines; the implementation uses single-line
elision with exact-path disclosure as specified here. Tabs open bounded read-only
previews, not editable buffers. Closing a tab only closes its preview; it cannot
remove a draft comment. Source is unwrapped with horizontal scrolling and sticky
gutters; Wrap is a presentation toggle that keeps logical line numbers. The editor
and explorer scroll independently, with the task/observation bars and review
action remaining reachable. Phone uses one vertical reading surface and horizontal
code scrolling; scrolling must not change the selected side or range. These
scroll and focus behaviours are implementation requirements rather than
executable canvas interactions.

The current fixture shows `returnFocus(opener ?? toolbarRef)` while R3 retains
`returnFocus(opener)`, making later contents visibly different. Original R3 bytes,
return context, capture time and unavailable current anchor remain bound to R3;
opening them never refreshes into current contents. The known-change strip
remains stable until explicit Refresh. Raster, PDF, capture/error and submission
specimens apply as before.

## Tablet and short-viewport refinements

Canvas section `qIVmm` (`#800 · Operator refinement review`) contains eight static
compositions. They use the installed Dark / Neutral / Default shadcn library,
Geist Mono where identifiers appear, and a 12px minimum supporting-text size. They
add no reusable components, theme, entry point or product behaviour. [#800](https://github.com/chrisbanes/ensemble/issues/800)
owns this design; its
[implementation plan](https://github.com/chrisbanes/ensemble/issues/800#issuecomment-6047644893)
is the exact scope. Existing product contracts and #793 source, return and task
anchors are unchanged.

| Canvas composition | Node | Size | Review purpose |
| --- | --- | --- | --- |
| Tablet Overview / List | `h23qD` | 1024 × 768 | Existing drawer, attention summary, compact task rows, and List/Board switch. |
| Compact tablet Inbox / question | `FsTwL` | 800 × 768 | Fieldnotes Q-204/r2 is one three-question form with one disabled Submit answers action while Q2 exceeds its limit; the task remains Paused. |
| Tablet task detail / evidence | `dUUIS` | 1024 × 768 | Task situation and next actor stay distinct from the evidence rail. |
| Tablet Search / selected result | `Z8BqXF` | 1024 × 768 | Canonical Atlas AT-142 identity, source, next actor and return anchor; AT-155 is the separate running cold-start task and A-108 its recorded Eli repair assignment. |
| Tablet composer / validation disclosure | `LBzlj` | 1024 × 768 | Optional summaries, expanded dependency error, focus treatment, and both actions. |
| Tablet all-projects Board | `nKHGv` | 1024 × 768 | Ready 0, Running 2, Waiting 3 and Paused 1; Stopping and Uncertain remain reachable. Held Ready work remains Ready and is grouped in Waiting. |
| Phone question / short viewport | `Sejey` | 390 × 480 | Q-204/r2 Q2–Q3 scroll position, retained Q1 selection, over-limit Q2 error, Q3 draft, and one disabled Submit answers action. |
| Phone composer / short viewport | `g5wmIu` | 390 × 480 | Long fields and optional summaries; unavailable dependency shows its error before submit while Save draft and Create and start stay enabled. |

The desktop baseline is `N9G11A` (Overview), `nD0nh` (List), `E7qC9` / `MUFPD`
(Board), `cGjau` (Inbox), `RyH7J` (task detail), `WaBk5` (Search), and `Z315o` /
`MhM7z` (collapsed/full composer). Phone references are `pmu7r` / `YzbOM` /
`m6ZUJR` (question), `i3glx` (composer), and `wXiWx` / `JX4dm` (expanded/collapsed
validation).

Textarea growth is capped against content and scrolls inside each named viewport.
These rules supersede the 760px drawer and the fixed 260px desktop / 180px phone
outcome-editor heights of the representative frames for the production UI; measure
and record the textarea cap, scroll ownership, safe areas, focus and input-resize
behaviour as slices are implemented.

The List, Board, Inbox, Search and composer specimens preserve current routing
and state semantics:

- Q-204/r2 is one unsubmitted three-answer group: Q1 is valid, Q2 has all three
  fixed choices selected and exceeds its 1–2 limit, and Q3 retains its supplied
  text. The single Submit answers action stays disabled until the answers are
  valid. Recording answers does not resume Fieldnotes F-203 or clear independent
  holds. The Q2 limit error uses the destructive colour in `Sejey` and `FsTwL`.
- Search keeps its query, filters, selected result and return origin; selected
  Atlas AT-142 retains `acme/atlas#142`, Mira, A-105 / Builder, source S2, W-18, R3
  `b72e910` at 11:40, and its next actor. The separate cold-start result is task
  AT-155; A-108 names Eli's recorded repair assignment. Task evidence does not
  decide source ownership or release a hold.
- The All-projects Board preserves Ready readiness while grouping tasks with
  dependency holds in Waiting; Q-204 remains Paused until separately resumed.
- The cold-start fixture is running task AT-155: its latest check failed, Eli's
  check-repair assignment A-108 is recorded, and no operator request is recorded.
  Overview, Board, Search and detail preserve that same state and next actor.
  `Document retry policy` remains Waiting with the operator action to choose retry
  limits and Jonas as lead in both List and Board. List / Board changes
  presentation only and does not imply drag or state mutation.
- Composer summaries show the supplied context, references, assignee and
  dependency; expanding the dependency reveals the validation error without
  discarding its value. Save draft and Create and start stay enabled; either one
  focuses the error and sends no command. The phone composer `g5wmIu` shows the
  same four Context / References / Assignee / Dependencies rows as `LBzlj` and the
  production composer, scrolled to its end so the unavailable dependency and its
  error sit above the enabled actions. The supplied-values panel keeps its
  unfinished-input notice concise and omits creation-receipt/admission explanation
  before submission.
- Screen and task titles are 18/600 and section headings 16/600. The tablet
  Overview header has no extra product label.

Implementation notes: measure navigation and textarea behaviour, verify scroll
ownership and caret retention, and validate focus before submission.

The entry and recovery inventory is limited to existing references: desktop
sidebar `X:PV1ln`; phone header `KthOL`; authentication expiry and private-state
purge `OwZka`; interrupted-read recovery `rD02Q`; retained original file
`xD63J` / `KVIG2` and diff `Mn97J`; Markdown `pUX8f` / `bz4VC`; and raster/PDF
specimens `JCGmX`, `MKzws` and `FCvHl`. The design has no dedicated
account-settings, guided-login, or retained-HTML viewer composition in this
section. Their route and recovery obligations remain in the specification; this
canvas does not show a browser renderer for retained HTML.

The short phone question frame intentionally clips `wHhpl`, the long answer body
inside the 390 × 480 scroll viewport (the other intended scroll region is `fTREM`);
the Q2–Q3 view ends at the pinned action area. Three disabled `Card Actions` slots
in reused option components are zero-sized and do not appear in the render. The
scroll owner is the named body or queue region, not the page. Board columns may
scroll horizontally. A client still needs to apply real bottom safe-area insets,
and must preserve the selected answer, draft, text selection and caret while these
regions scroll or resize.

## Implemented differences from the frames

Where the production UI intentionally differs from the frames, the differences are
below. The web app is the ground truth for these items.

### Question actions, composer and test matrix

- Question actions on the task page sit in flow directly below the bounded
  question body rather than sticking to the page; a page-sticky footer covered the
  last field after it scrolled into view. At 390 × 480 the actions are reached by
  scrolling the task page. They are not always on screen as in `Sejey`.
- Create and start is not disabled for an unavailable assignee or dependency.
  When fresh options show a stored selection is no longer permitted, the
  composer opens that section with its error before submit. Either action then
  refocuses the error and sends no command; the same check also blocks Save draft.
  The frames show the same behaviour.
- Browser evidence covers Chromium and Playwright WebKit (`ux800-matrix`,
  `ui08-shell`, `ui05-questions` and the task/composer suites). Forced colours
  are emulated in Chromium only. The safe-area inset is checked through an
  emulated custom property. Physical Safari/iPhone, virtual keyboards, the
  recovery route and the retained HTML operator are outside this matrix.

### Sign-in, account menu and Not found

- The account label is "Operator" with initials "OP", not a person's name. A
  session carries no operator name, and the frames' name is an example. The
  trigger's accessible name is "Operator account".
- The expired-session entry is the sign-in screen with a status notice rather
  than a separate screen. It keeps frame `OwZka`'s headline and "Private state
  cleared" card but not its review-recovery paragraph (that belongs to the
  review flow). The card's detail adds one sentence: unfinished task input is
  offered for recovery on this device, because the composer keeps it in the
  tab under its own recovery prompt.
- Failed sign-in text uses the brighter destructive foreground so it reads at
  4.5:1 against the page; the frame's tint is lower contrast.
- The phone drawer shows the account group as navigation rows plus a Sign out
  button, with no nested popup. Only the desktop popup is drawn. Sign out from a
  nested phone screen needs Back first.
- Unknown `/app/*` addresses are served by the service as the shell with status
  404 so "Page not found" can render. The Not found header has no divider and,
  on a phone, keeps its sentence visible because the screen has no other copy.

### Inbox and structured questions

Production Inbox and shared question response
([#838](https://github.com/chrisbanes/ensemble/issues/838)) differ from frames
06–11, 19, 21 and 27–33 as follows:

- Phone Back is the page header's link ("Back to Inbox"), as frames 10, 21 and 27–30 draw it, not an in-body "Back to queue" button. After a recorded answer the confirmation card's button reads "Back to Inbox". A wide layout has no back control.
- Approvals show the exact action, target, revision, requester, the independent holds (frames 07 and 33) and the bound-decision statement, with one "Review material & decide" link to the retained `/coordination/task/:id#<interaction>` destination. There is no Approve or Deny in the Inbox (frame 32 is not built); an in-app decision would be a new authority surface and a separate scope decision.
- Evidence stays the existing "Question evidence" and "Task evidence" links; the read has no excerpt field, so frame 27's in-pane excerpt is not drawn. Returning from the task restores the selection, scroll position and the link's focus.
- A single question's choice cards stay in the reading flow (frame 06 pins them); only the submit area is sticky, inside the one scroll owner `.inbox-detail`, so a pinned option list cannot trap scrolling or cover a field.
- Queue rows use read-model facts only: "PROJECT / KIND", the task title, the reason, the action ("Answer question", "Review material & decide", "Inspect execution") and "Requester · HH:MM · age". There are no short identifiers (Q-204, A-201: U3 #837), no "Execution uncertain" versus "Intervention problems" subtype (one "Interventions" option), and no grouped-question title on a phone.
- Kept or omitted on purpose: the shell Refresh stays on the Inbox; the frame's "Today · 11:00" clock and the phone "Search" header action are not built; the header title is 18/600, not the older large title of frames 07 and 08.
- "Recommended by <requester>" appears in the Inbox. The task page (`/app/tasks/:id?request=`) uses the same component but does not pass the requester yet, so it reads "Recommended" until U5 (#839) does.
- Choice labels use the focus ring on `:focus-within`, because WebKit drops `:focus-visible` on a radio after arrow keys.
- Entry points that apply: Inbox desktop and phone; the shared `QuestionResponse` at `/app/tasks/:id?request=`; the Overview and task-row attention links (unchanged); the retained HTML coordination page (unchanged). Counterparts: failed answer, Retry answer; stale read, Refresh request; conflict, Review current request; recorded, Back to Inbox; filter, Clear filters; approval, decision at the retained destination.
- Hold copy in the approval pane, from the task read's `admission.reasons`; each reads "Approval does not clear it" or "Approving does not clear it":
  - Blocked GitHub dependencies: "Execution blocked by dependency", the open blockers as `owner/repo#n`, and "Source-owned hold … execution still waits for the GitHub blocker."
  - Unconfirmed dependencies (`imported-blockers-unknown`): "Execution held: dependencies unconfirmed", "GitHub blockers could not be confirmed." It never claims a blocker that was not found.
  - A source review or hold (`source-held`, which the read folds `source-hold`, `source-unknown` and `source-review-required` into): "Execution held by the source".
  - Local dependencies: "Execution blocked by dependency" with the unfinished tasks. Project paused: "Project paused. Approval does not resume work."
  - Any other reason (`task-unready`, `task-not-open`, `project-lead-unconfigured`, `project-lead-revoked`, `admission-blocked`): "Execution held (<reason label>)". An ineligible task with no known reason reads "Execution held".
- The question-level hold line drawn in frames 06, 19, 10 and 21 ("Task paused. Recording answers does not resume execution…") is not built: the question response does not read the task. This is a known gap; the approval pane shows holds.
- "· confirmation retained" in the Inbox subtitle appears only when this session recorded the answer; a request answered elsewhere that has left the queue keeps the neutral count.

### Overview, task list and Board

Production Overview, List and Board
([#837](https://github.com/chrisbanes/ensemble/issues/837)) differ from the frames as follows:

- Route titles stay "Overview", "All tasks" and the project name. Frames 01, 24,
  18 and 18b title these screens "Your workspace"; the frame's second line is
  the subtitle ("Decisions first. Work and completed results stay separate.",
  "8 active tasks · 3 projects", "5 active tasks · accountable lead Mira Chen").
  The phone Tasks header keeps one New task action, not the drawn Search.
- There is no Recent results strip. A result excerpt, time and counter are not in
  the task-list read model and no endpoint lists results across tasks. Overview
  ends with a "Completed work" line (count, no recency claim) linking to
  `/app/tasks?state=Done`. A real strip needs a read-model slice.
- No short identifiers (AT-142, A-104, Q-204, R2) are shown: no read model
  carries them. Imported tasks show `repository#number`, local tasks "Local task",
  and no raw UUID appears on Overview, List or Board.
- Task titles stay underlined links (an established shared-foundation contract);
  the frames draw them plain. The Project dropdown is not drawn on project routes,
  where the project is already the route.
- Active tasks is the default State, so Done and Cancelled are reached through
  "All tasks", a column name or the Completed work link.
- Board: only the selected column tab is emphasised (the frames embolden the
  columns in view); the footer reads "Scroll horizontally or choose a column
  above. Empty columns are collapsed." rather than "Columns 1–3 of 6"; "task 1 of
  3", "N more waiting tasks" and the per-card phone readiness note are not built;
  the phone attention summary reflows the desktop bar instead of the shorter
  two-line variant; relative age ("1h 46m ago") is omitted. Items "Check failed",
  "repair assignment A-108" and "Repair owner unknown" need assignment and check
  records the list summary lacks.
- "Refresh tasks" and "More filters" (Search, Source, Readiness) are existing
  capabilities the frames do not draw.
- There is no phone Overview or phone List frame; both phone layouts are
  composed from the shell and desktop frames.

## Using this snapshot

Worktrees may edit `design.pen` through Pen MCP, or use this Markdown reference
when Pen is unavailable. Review the design in Pen using the node references above.
Screen preview exports are omitted; comparison image assets are in `design/assets/`
for use by the canvas.

This snapshot covers the screens listed above. It does not supply every
configuration/recovery screen; remaining product obligations stay in the spec and
issues. The design does not cover every fixture at every viewport and entry point;
the matrices name the representative coverage and interaction annotations.

## Design limits

Canvas review is bounded and static: it checks hierarchy, spacing, contrast,
readable state labels and clipping on rendered frames, and is not an accessibility
audit. Intended clipping regions are the scroll viewports named above (for
example `wHhpl` and `fTREM`).

Static design does not establish responsive implementation, font availability,
real resizing/zoom, text scale, keyboard/focus restoration, screen-reader or
forced-colour behaviour, virtual-keyboard and safe-area behaviour, scrolling and
scrollbar ownership, textarea growth and caret retention, scroll/query/filter and
draft persistence, live updates, provider reconciliation, runtime question
support, message delivery, source comparison, permissions or command
reconciliation. These need browser and physical-device evidence against the
acceptance plan. The five comparison-image references still render placeholders in
Pen MCP, so comparison-image loading is unverified. Static frames and destination
annotations are not working navigation.

## Proposed (not yet adopted): data support to settle

These are questions to settle against available records, not prescribed API
fields, routes, storage contracts or renderers.

Task overview and review interactions:

- Explicit evidence-to-result/criterion relationships, revision identity,
  validation provenance and freshness. Without records, show unlinked artifacts
  or an agent report; never infer a verified criterion.
- Durable responsibility, requester, destination and waiting observations for
  assignment summaries, including explicit unknown values.
- Attribution for approach/decisions, ordering of current versus earlier results,
  and stable history identities for reading-position restoration.
- Artifact availability/redaction and preview support. The design supplies an
  unavailable-preview state and open-material controls, not an attachment service.
- Can a supplied criterion retain its identity and source revision across edits,
  and can recorded checks express exactly which scope and work revision they cover?
- Which records establish result supersession and before/after capture pairing,
  including scenario, assignment, revision and unavailable/redacted material?
- Can a local lead message preserve its result/criterion/artifact reference and
  provide confirmed success, confirmed failure and unknown-outcome reconciliation?
- Is a per-operator viewing reference available, and what establishes it? How
  should missing or expired references and unavailable source history be shown?
- Can stable record identities preserve drafts, open disclosures and reading
  anchors while newer source and result revisions arrive?

Assignment context, delivery and search: confirm availability of captured
brief/instruction/profile revisions, reference attribution and
unavailable/missing distinctions; current requirements and explicit revision
comparisons; recorded file/commit/result relationships; PR-head and check
provenance, observation age, findings and recorded repair ownership; and
independently reported task/delivery holds. Do not infer a record from an agent
claim. Establish which record types and historical excerpts search can cover and
how unavailable destinations are identified. Confirm support for stable
matching-section anchors and retained query/filter/draft/reading context. The
design adds no transcript ingestion, source writes or runtime powers.
