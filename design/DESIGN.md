# Ensemble UI design handoff

This is a portable reference for planning and implementing the reviewed Ensemble
web UI without opening Pen. It was extracted through Pen MCP on 1 October 2026
and refreshed from the latest semantic-colour and fixed-type-role system. The editable visual source is
[design.pen](design.pen); this document is a handoff snapshot, not a native Pen
Markdown export or evidence of implemented behaviour.

[SPEC.md](../docs/SPEC.md#operator-interface-and-human-requests) owns product
behaviour, [acceptance.md](../docs/acceptance.md#operator-ui-additions) owns required
evidence, and [#736](https://github.com/chrisbanes/ensemble/issues/736) owns delivery
scope and sequencing. Resolve conflicts in favour of those contracts. This file
records presentation and design references, without choosing a frontend stack.

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
The palette does not establish tested contrast or focus compliance.

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
| Inbox / request row | `LKh5F` | Request type, project/task context, requester and age; selection identifies the open detail |
| Source / GitHub issue identity | `GD5ht` | Neutral source identity and link, separate from urgency |
| Task / board card | `tR6lF` | White bordered surface, 10px corners, 12px padding and 8px gaps; project/source, outcome, state/reason and lead |
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

Laptop reference frames use 1366 × 820; other desktop frames use 1440 × 900 or
1440 × 960. Phone references use 390 × 844. These are review viewports, not fixed
application dimensions. Main laptop content has 24px vertical / 28px horizontal
padding and 16px gaps; Inbox and board workspaces use 24px padding and 16px gaps.
The imported desktop workspace uses 28px padding and 20px gaps.

- **Overview:** attention preview above the work list or board, with a route to the
  complete Inbox. Routine results are separate from requests requiring action.
- **Inbox:** sidebar, heading and filters remain available. Queue and detail scroll
  independently; request header and response/decision controls remain visible.
  Phone uses queue → detail → queue navigation with restored selection and position.
- **Composer:** scroll the brief and optional context; reserve space for the action
  bar so Create and start / Save draft never obscure inputs. Distinguish proposed
  on-device unfinished-input recovery from a confirmed Ensemble draft task.
- **Task detail:** retain unresolved requests outside collapsible history. History
  scrolls independently with reserved reply space. Keep dependency holds visible
  beside approvals. Opening an assignment shows its latest three messages and
  result; earlier content remains available through disclosure.
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

## Worktree handoff and limits

Keep the editable Pen document in the main design checkout. Worktrees can use this
Markdown reference without opening or creating competing copies of the canvas.
When the design changes, refresh this snapshot through MCP; do not parse the `.pen`
file directly. No screenshots, PDF or generated HTML are included in this handoff.

This snapshot covers the screens listed above. It does not supply complete login,
guided setup or every configuration/recovery screen. Those remaining product
obligations stay in the spec and issue. Fictional names, repositories, dates and
counts illustrate states rather than defining production defaults.

Static design review does not establish responsive implementation, font availability,
contrast compliance, keyboard behaviour, runtime question support or persistence.
Validate those against the acceptance plan. The current token and component
definitions, including the repaired colour bindings, are reflected here. This
extraction is not a new full visual audit or release acceptance.
