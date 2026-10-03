# Ensemble UI design handoff

This is a portable reference for planning and implementing the reviewed Ensemble
web UI without opening Pen. It was refreshed through Pen MCP on 3 October 2026
after revising and inspecting the approved operator UX refinements. The editable visual source is
[design.pen](design.pen); this document is a handoff snapshot, not a native Pen
Markdown export or evidence of implemented behaviour.

[SPEC.md](../docs/SPEC.md#operator-interface-and-human-requests) owns product
behaviour, [acceptance.md](../docs/acceptance.md#operator-ui-additions) owns required
evidence, and [#736](https://github.com/chrisbanes/ensemble/issues/736) owns delivery
scope and sequencing. Resolve conflicts in favour of those contracts. This file
records presentation and design references, without choosing a frontend stack.

## Pending task overview design — 3 October 2026

The [task overview specification amendment](../docs/SPEC.md#task-overview-and-evidence--design-direction-3-october-2026)
and [design-review criteria](../docs/acceptance.md#task-overview-and-evidence-design-review--3-october-2026)
add shared brief, delegation, evidence and compact progress requirements. Design
and review these in Pen before implementation. The existing canvas and handoff
are not evidence that this amendment has been designed or approved visually.
After review, update the relevant screen/state references and interaction handoff
here, and link the reviewed design from the specification and delivery issues.

## Approved refinement brief — 3 October 2026

The approved direction is now represented in the existing editable Pen document.
Shared components, representative existing screens and the supplementary fixtures
below were inspected through Pen MCP. This records **designed behaviour**, not
implemented, browser-tested or runtime-qualified behaviour. The palette and fixed
typography roles are unchanged. No competing canvas was created.

Make the next decision obvious, and keep its evidence close:

- **Attention:** show the specific decision/intervention, requester when known,
  reason the operator is needed and available response. Keep relevant evidence
  close. Use consistent meaning across Overview, Inbox, List/Board and task detail.
- **Work views:** distinguish work state, next actor and attention without changing
  the existing board mapping. A running agent alone is insufficient evidence of a
  repair. Show unknown responsibility honestly. Keep readiness, completed work,
  cancellation and provider closure without delivery distinguishable.
- **Task workspace:** prioritise outcome, current situation/next actor, unresolved
  decisions and evidence. Disclose assignments and captured history underneath,
  retaining the task's accountable lead and assignment/conversation identities.
  Use recorded facts and attributed excerpts; add no invented summary capability.
- **Composer:** keep project, title and outcome prominent; disclose optional
  context, references, assignee and dependencies with a summary of supplied values.
  Preserve validation, drafts and truthful creation/admission feedback.
- **Readability:** give task meaning and the immediate next step more space than
  repeated navigation metadata. Keep titles distinguishable and supporting text
  readable. Retain the existing semantic palette and fixed typography roles.

Revise shared components and representative desktop/phone frames using fixtures for
agent-owned check repair, an operator question, approval with an independent
dependency hold, completion without a decision, uncertain execution and capacity
waiting. Also show unknown responsibility and distinguish cancelled/undelivered
work from success. Demonstrate evidence inspection, response, confirmation and
return to the prior context, including stale reads and failed submissions.

These changes preserve exact approval material, source ownership, Stop/Resume
limits and command-outcome semantics. They add no agent/provider selection,
attachments, terminal, browser, runtime or remote-write capabilities. GitHub issues
remain authoritative for delivery scope and sequencing; this is a presentation
brief, not a parallel delivery plan.

## Visual direction

The named palette describes a calm, light operator workspace: pale blue-grey canvas, white content
surfaces, dark blue-grey text and a clear blue action colour. Reserve amber, red
and green for meaningful states. Keep hierarchy visible through typography,
spacing and alignment; avoid decorative dashboard metrics and unnecessary cards.
Cards have a purpose in boards, decisions and selectable options. Lists and
history use compact rows and disclosure instead of a box around every message.

Overview is attention-first. The dedicated Inbox is the complete action queue.
Projects remain accessible from the desktop sidebar. Source identity, execution
state and requests for action are distinct pieces of information.

### Colour bindings

The canvas colour bindings were repaired after a token rename converted fills and
strokes to literal black. Components and instance overrides now use the semantic
roles below. Desktop, phone, navigation and control-library renders were checked
against the light palette.

## Tokens

Names and values below are from Pen's named variables. Pen references them with a
`$` prefix, for example `$color/primary`; retain a traceable mapping if the code uses
another naming convention. Only a light presentation is represented in this file.

### Colour

| Token | Value |
| --- | --- |
| `color/surface` | `#FFFFFF` |
| `color/scroll-thumb` | `#B8BFCB` |
| `color/on-surface` | `#202B3D` |
| `color/on-surface-variant` | `#59677D` |
| `color/surface-container` | `#F4F7FC` |
| `color/surface-container-low` | `#F8FAFD` |
| `color/outline` | `#DFE6F0` |
| `color/primary` | `#2864D7` |
| `color/primary-container` | `#EEF0FC` |
| `color/on-warning-container` | `#865F18` |
| `color/warning-container` | `#FFF8E8` |
| `color/on-error-container` | `#A53C38` |
| `color/error-container` | `#FCF1F0` |
| `color/on-success-container` | `#286A53` |
| `color/success-container` | `#ECF5F0` |
| `color/scroll-track` | `#EEF0F4` |
| `color/outline-selected` | `#D3D3EE` |
| `color/outline-focus` | `#BCCDEE` |
| `color/outline-error` | `#EED6D3` |
| `color/on-primary` | `#FFFFFF` |
| `color/on-primary-container` | `#202B3D` |

Use `color/on-surface` and `color/on-surface-variant` for main and supporting
text. `color/surface-container` is the workspace and muted/input background;
`color/surface-container-low` is navigation. Pair primary with on-primary, and
primary/warning/error/success containers with their corresponding on-container
foregrounds. Keep status words visible. Avatar fills remain local examples.
Calculated token-pair contrast is 14.24:1 for body text on white, 5.74:1 for
supporting text on white, 5.34:1 for supporting text on the workspace canvas,
5.39:1 for primary on white, and 5.42–5.76:1 for warning/error/success container
pairs. These are calculations from the named colours, not rendered browser
accessibility or focus-compliance results. The focused specimens use a 2px primary
outline; radio selection is independently shown by a filled dot.

### Typography

| Token | Family | Use |
| --- | --- | --- |
| `font/heading` | Space Grotesk | Wordmark, page and section headings |
| `font/body` | Instrument Sans | Body, controls and supporting context |
| `font/mono` | IBM Plex Mono | Identifiers and provenance |

The foundations now define fixed roles. Use only these roles; do not introduce
custom sizes or override typography on component instances. Content and semantic
colour may vary.

| Role | Family | Size token | Weight | Line height |
| --- | --- | --- | --- | --- |
| Metadata | Body | `type/xs` · 12px | Regular or semibold | 1.25 |
| Identifier | Mono | `type/xs` · 12px | Regular | 1.25 |
| Control | Body | `type/sm` · 14px | Regular or semibold | 1.25 |
| Body | Body | `type/sm` · 14px | Regular | 1.5 |
| Introduction | Body | `type/md` · 16px | Regular or semibold | 1.5 |
| Callout | Body | `type/lg` · 18px | Regular | 1.5 |
| Small heading | Heading | `type/md` · 16px | Semibold | 1.25 |
| Card heading | Heading | `type/lg` · 18px | Semibold | 1.25 |
| Section heading | Heading | `type/xl` · 22px | Semibold | 1.25 |
| Feature heading | Heading | `type/2xl` · 26px | Semibold | 1.25 |
| Page heading | Heading | `type/3xl` · 32px | Semibold | 1.12 |
| Display heading | Heading | `type/4xl` · 40px | Semibold | 1.1 |

Weights are `weight/regular` (`normal`) and `weight/semibold` (`600`). The medium
weight and numeric `type/N` tokens have been removed. Available line-height tokens
are `leading/1-1`, `leading/1-12`, `leading/1-25` and `leading/1-5`.
The current board-card source uses the 16px small-heading role; the wordmark uses
26px semibold. These are observed component choices, rather than extra type sizes.

### Spacing and shape

Prefer `space/4`, `space/8`, `space/12`, `space/16`, `space/24` and `space/32`.
Each suffix is its pixel value. All gaps and padding use the 4px grid. The complete
spacing scale is 0, 4, 8, 12, 16, 20, 24, 28, 32 and 40. Use intermediate values
where denser controls or larger layouts need them.

Prefer 6px corners on small controls and 8px on controls and cards. Existing
board cards use 10px. Available `radius/N` values are 2, 6, 8, 10, 12, 14 and 15.
Standard component borders are 1px; selected mobile column tabs use a 2px action
border. Frame dimensions and one-off offsets stay local rather than becoming
global tokens.

## Shared components

These are connected reusable sources in the tidied Pen file. Node IDs are included
for future MCP inspection; implementation worktrees do not need Pen to read this
document. Labels, content, semantic state colours and local sizing are overrides. Typography
uses the fixed roles above; do not add per-instance typography overrides.

| Component | Pen node | Presentation contract |
| --- | --- | --- |
| Navigation / projects | `vV9lW` | 216px desktop sidebar; workspace selector, Overview, Inbox count, projects and profile; 24px vertical / 16px horizontal padding |
| Button / primary | `gFnEM` | Primary/on-primary colour pair; 8px corners, 12px vertical / 16px horizontal padding, 14px semibold control type |
| Button / secondary | `QXGhI` | White surface with outline border and on-surface text. Same base sizing and 14px semibold type as primary |
| Inbox / request row | `LKh5F` | Specific decision/intervention, project/task, reason the operator is needed, available response, requester and time; 12px padding and 4px gaps; selection identifies the open detail |
| Source / GitHub issue identity | `GD5ht` | Neutral source identity and link, separate from urgency |
| Task / board card | `tR6lF` | Title first; source, work state, situation, next actor and attention are separate fields; white surface, 10px corners, 12px padding, 4px gaps; accountable lead retained |
| Request / recorded response | `pDmEe` | Confirmed recorded outcome, exact request/value/time and remaining delivery or execution hold; reusable in response and creation confirmations |
| Execution / unresolved GitHub blocker | `g6phYl` | Warning with source link and explicit explanation that approval does not clear the dependency |
| Question / choice with description | `tzNkV` | Selection indicator beside label/description; 12px padding, 8px gap, 8px corners; recommendation only when supplied |
| Question / free-text answer | `ADuk1` | White bordered input, 12px padding, 8px corners; 14px body type at 1.5 line height |
| Status / badge | `i5qvLV` | Semantic foreground/background, visible label, 12px semibold type, 4px vertical / 8px horizontal padding |
| Navigation / segmented item | `EbZ9i` | List/Board control; 6px corners, 8px vertical / 12px horizontal padding; selected surface/border/action label |
| Input / text field | `RuvSD` | Standard border, 8px corners, 12px padding, 16px introduction value at 1.5 line height; height follows content |
| Navigation / board column link | `qv8FM` | Named desktop column and count; selection surface, 14px semibold label |
| Navigation / mobile column tab | `tNyAS` | 44px height, centred 12px semibold label; selected action border |

Desktop and compact buttons use 12px vertical padding on the same button source. Do not
reintroduce separate compact component families. Use actual accessible controls
for radio buttons, checkboxes and inputs; the canvas glyphs illustrate appearance.

## Layout and responsive composition

The collapsed laptop composer uses 1366 × 820. Revised task, approval and work
views use 1366 × 900; other desktop frames use 1440 × 900 or 1440 × 960.
Phone references use 390 × 844. These are review viewports, not fixed
application dimensions. Main laptop content has 24px vertical / 28px horizontal
padding and 16px gaps; Inbox and board workspaces use 24px padding and 16px gaps.
The imported desktop workspace uses 28px padding and 20px gaps.

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
  admission. The old attachment hint has been removed.
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

The earlier responsive notes propose switching the sidebar to a drawer below
760px. Treat that as a design starting point to validate with actual content,
zoom and the chosen frontend, not proof of a tested breakpoint. Phone controls
must accommodate touch, keyboard and safe-area space without covering content.

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
- Present Ready-but-blocked work honestly. List/Board is a presentation switch,
  not a status mutation. No drag-and-drop or automatic GitHub writes are depicted.
- Keep visible keyboard focus, selection constraints and errors beside the affected
  question. The interaction notes specify radio arrow-key navigation, Space for
  selection, and focus on the first invalid field after submission.

## Refinement fixtures and interaction coverage

The following are illustrative design records, not observations of real tasks or
claims of newly implemented summarisation. Existing excerpts were retained with
attribution. Added records explicitly illustrate assignment ownership, creation
receipts and lifecycle states. No recommendation is inferred from running activity.

| Fixture / journey | Desktop references | Phone references |
| --- | --- | --- |
| Failed check with recorded repair owner, no attention | Overview `N9G11A`; List `nD0nh`; cross-project/project boards `E7qC9`, `MUFPD`; task `oipj4` | `zs53F` |
| Running with unknown repair responsibility | Overview `N9G11A`; List `nD0nh`; boards `E7qC9`, `MUFPD`; task `kiPK9` | `zs53F` |
| Specific audience question, requester, reason and evidence | Inbox `cGjau`; Overview and paused task row/card | Queue `U3RAH`; request `pmu7r`; evidence `YjRad` |
| Failed submission, stale read, confirmation and return | Existing lifecycle reference `jKzRk`, shared receipt `pDmEe`, interaction contract `BvX5O` | Failed `uJVe2`; stale `e1kkI`; recorded `o6O3M`; anchored return `q2vYE` |
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
references remain in place; this refinement adds no remote-write capabilities.

Static frames cannot execute focus restoration, scrolling, keyboard operation,
safe-area handling, persistence or command reconciliation. Frame `BvX5O` annotates
those interactions and the review checklist. Existing expanded-history and grouped
question references remain the disclosure/state inventory; representative initial
screens now prioritise evidence above history.

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
| Phone Ready and Uncertain columns | 25 `GWXOi`, 25b `CTUzI` |
| Full-content composer and task detail | 02 `MhM7z`, 03 `QGdAx` |
| Expanded captured history and state references | 05 `nfqO8`, 04 `wLhJT` |
| Refinement section and evidence/response journey | Section `uhRIV`; 27 `YjRad`, 28 `uJVe2`, 29 `e1kkI`, 30 `o6O3M`, 31 `q2vYE` |
| Approval confirmation and phone review | 32 `US7Kv`, 33 `ZWQIU` |
| Phone composer and validation disclosure | 34 `i3glx`, 35 `wXiWx`, 35b `JX4dm` |
| Repair, completed and unknown-responsibility task workspaces | 36 `oipj4`, 37 `Q24BPH`, 45 `kiPK9` |
| Phone repair, capacity, completion, cancellation and closure | 38 `zs53F`, 39 `Z6U3T4`, 40 `Thy1i`, 41 `rn49D`, 42 `ALMfc` |
| Desktop lifecycle comparison and interaction checklist | 43 `zeoGi`, 44 `BvX5O` |

## Worktree handoff and limits

Keep the editable Pen document in the main design checkout. Worktrees can use this
Markdown reference without opening or creating competing copies of the canvas.
When the design changes, refresh this snapshot through MCP; do not parse the `.pen`
file directly. No screenshots, PDF or generated HTML are included in this handoff.

This snapshot covers the screens listed above. It does not supply complete login,
guided setup or every configuration/recovery screen. Those remaining product
obligations stay in the spec and issue. Fictional names, repositories, dates and
counts illustrate states rather than defining production defaults.

The 3 October review inspected the revised desktop and phone renders, checked
resolved visible-node bounds including component instances, and repaired queue,
card, history and phone-control overflow. Settled visible-node readbacks reported
no clipping; root-frame overlap checks also passed. Colour-pair calculations are recorded
above. This is a bounded canvas review, not a full accessibility audit.

Static design review does not establish responsive implementation, font availability,
keyboard behaviour, runtime question support or persistence. Validate those against
the acceptance plan. No application code, GitHub issues or implementation evidence
were changed. The design does not cover every fixture at every viewport and entry
point; the matrix names the representative coverage and interaction annotations.

### Open mapping handoff question

The pre-existing Pen board places Ready-but-blocked work in its Ready column. The
current [UI03 implementation record](../docs/design/ui03-tasks.md#attention-and-board)
places the same work in Waiting while retaining its Ready readiness. This revision
preserves the existing Pen mapping as requested, pending clarification, and adds
no new board grouping rule. Resolve that discrepancy before implementing these
screens. Done, Cancelled and provider-closed fixtures are shown in All tasks and
task views without redefining the existing active-board mapping.
