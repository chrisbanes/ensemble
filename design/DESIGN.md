# Ensemble UI design handoff

This is a portable reference for planning and implementing the reviewed Ensemble
web UI without opening Pen. It was refreshed through Pen MCP on 3 October 2026
after revising the operator UX and migrating the canvas to the installed shadcn Pen library. The editable visual source is
[design.pen](design.pen); this document is a handoff snapshot, not a native Pen
Markdown export or evidence of implemented behaviour.

[SPEC.md](../docs/SPEC.md#operator-interface-and-human-requests) owns product
behaviour, [acceptance.md](../docs/acceptance.md#operator-ui-additions) owns required
evidence, and [#736](https://github.com/chrisbanes/ensemble/issues/736) owns delivery
scope and sequencing. Resolve conflicts in favour of those contracts. This file
records presentation and design references. The user approved shadcn as the component foundation; this canvas migration does not install or implement the application frontend.

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
implemented, browser-tested or runtime-qualified behaviour. The shadcn migration supersedes the earlier bespoke light and charcoal styling passes;
the approved product behaviour is unchanged. No competing canvas was created.

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
  readable. Retain semantic state meanings and readable typography; shadcn supplies their visual foundation.

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

Use the installed shadcn Pen library (`X`) with Mode **Dark**, Base **Neutral**,
and Accent **Default**. Screens now reference the library components directly.
Domain-specific request, task, evidence and history content occupies component
slots. These compositions preserve Ensemble's spec-owned behaviour.

Keep the compact workspace: 224px desktop sidebar, 20px main content padding,
12px workspace gaps, 18px screen titles and 14–16px section headings. Task and
request titles remain 14px semibold. Supporting text remains 12–14px rather than
shrinking to accommodate the migration. Desktop buttons use the library's compact
36px treatment; phone actions retain 44px targets. The outcome editor retains
260px height on the representative desktop and 180px on phone.

## Tokens

All active colour references now use installed library tokens directly. The
former Ensemble colour aliases and custom warning/error/success palette have
been removed, along with the unused local typography, radius and spacing
variables. The document's variable registry now contains only imported `X`
colour tokens. All screen roots select Dark / Neutral / Default; a user-facing
theme switch is not designed.

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

Routine waiting, success and dependency states use neutral library treatments.
Visible labels, symbols, explanations and available actions distinguish their
meaning. Error text remains high-contrast foreground; error panels use destructive
borders. Colour never establishes repair ownership, delivery or operator attention.

### Typography, spacing and shape

Inter supplies interface text; JetBrains Mono identifies IDs and provenance.
Use 12px metadata, 14px body/control text, 14px semibold task/request titles,
14–16px section headings and 18px screen titles. Library controls use their
500 weight; custom headings retain 600. Larger type sizes are reserved for canvas documentation, not product screen headings.

Use library control geometry, 6px control corners and 8px card corners, with
local layout overrides only where content or the 44px phone targets require them.
Composition uses the same 4px spacing rhythm as the installed controls. Custom
semantic fields and prose are not forced into unnecessary cards.

## Shared components

These local reusable specimens now connect to the installed library. Screen
instances reference imported components directly, rather than the old bespoke
sources. Content, visibility, semantic colour and responsive size overrides are
intentional; the library remains the shared primitive foundation.

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

Project and permitted-assignee fields use Select Group/Default `X:w5c1O`.
Task lists use Table/Row/Cell components; assignments use Accordion. Agent and
operator initials use Avatar/Text. Grouped multi-select questions use Checkbox,
while single-choice questions use Radio. Labels, descriptions, selected values,
validation messages and response controls remain explicit.

Status icons supplement visible state words. Running does not imply repair
ownership; provider closure does not imply delivery. In implementation, treat
these icons as decorative when adjacent text already conveys their meaning.
Task lead names and accountability remain visible alongside avatars.

## Layout and responsive composition

The collapsed laptop composer uses 1366 × 820. Revised task, approval and work
views use 1366 × 900; other desktop frames use 1440 × 900 or 1440 × 960.
Phone references use 390 × 844. These are review viewports, not fixed
application dimensions. Main desktop content and board workspaces use 20px padding and 12px gaps;
the Inbox retains 24px padding and 16px gaps.
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
  Ready-but-blocked retains its Ready label in the Waiting column: readiness is
  distinct from work-state grouping. Cross-project and project counts, phone
  selection and previous/next controls reflect this mapping. The cross-project
  Waiting viewport shows two of its three tasks, with a labelled continuation.

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
| Phone Waiting (Ready with a hold) and Uncertain columns | 25 `GWXOi`, 25b `CTUzI` |
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
no clipping; root-frame overlap checks also passed. The current library theme was visually reviewed. This is a bounded canvas review, not a full accessibility audit.

Static design review does not establish responsive implementation, font availability,
keyboard behaviour, runtime question support or persistence. Validate those against
the acceptance plan. No application code, GitHub issues or implementation evidence
were changed. The design does not cover every fixture at every viewport and entry
point; the matrix names the representative coverage and interaction annotations.

### Spec authority and resolved board mapping

SPEC.md is the source of truth. It requires grouping by Ensemble work state,
separating readiness from dependency holds and preserving the existing board
mapping. A task can retain Ready readiness while appearing in Waiting, as the
[UI03 mapping record](../docs/design/ui03-tasks.md#attention-and-board) describes.
The stale Pen placement has been corrected across cross-project, project and
phone boards. This is a presentation correction, not a change to readiness,
dependency or admission rules. The mapping question is resolved.

Done, Cancelled and provider-closed fixtures remain in All tasks and task views
without redefining the existing active-board mapping.

## shadcn migration review — 3 October 2026

The migration covers the existing 68 top-level frames, including component
specimens, desktop/phone screens and annotations. It replaces the bespoke
primitive references with connected installed-library components, and migrates
additional standalone fields, tabs, history disclosures, alerts and task rows.
Domain content remains editable in slots; no competing canvas was created.

Representative reviewed frames include Overview `N9G11A`, composer `Z315o`,
task workspace `RyH7J`, Inbox `cGjau`, approval `DAeiN`, List `nD0nh`, boards
`E7qC9` / `MUFPD`, phone composer `i3glx`, phone Waiting `GWXOi`, phone approval
`ZWQIU`, failed/stale response fixtures `uJVe2` / `e1kkI`, repair `oipj4` and
completed work `Q24BPH`. Remaining existing fixtures share the same imported
controls and direct library colour tokens. The screen reference map above remains valid.

The final settled resolved-node audit reported zero visible clipping problems
and zero visible default library placeholder labels. Renders were inspected for
wrapping, contrast, selected states and visible controls. Repairs included source
identity sizing, horizontal uncertainty alerts, inactive phone tabs and grouped
multi-select checkbox semantics. All root placeholders were cleared after review.

The migration preserves exact approval material and the independent dependency
hold, Ready-in-Waiting mapping, unknown repair responsibility, source ownership,
Stop/Resume, retained response drafts and truthful command outcomes. It introduces
no new product question or runtime capability.

Remaining coverage gaps are real resizing/zoom, keyboard and focus restoration,
virtual keyboard overlays, scrolling, persistence and command reconciliation.
These are designed/annotated behaviours, not implemented or tested behaviours.
Not every fixture is shown at every viewport or entry point. No application code,
GitHub issue or implementation evidence was changed.

The corrected canvas was saved through Pen's native Save command after the review
repairs below. The Edited indicator cleared and the on-disk file changed. Reopening
the saved document has not been tested.

### Library reconciliation — 3 October 2026

The follow-up reconciliation updates 3,110 nodes/overrides across the existing
68 frames, replaces local styling-variable references with direct library colour
tokens and matching literal type/spacing values, and normalises 45 corner-radius
overrides. The unused local variable definitions were removed. The installed Pen
library exposes colour variables only: claiming imported typography or spacing
tokens would be inaccurate.

Retained adaptations are explicit: compact task/request content, 18px screen
headings, 14–16px sections, 44px phone controls, identifier monospace, and Ensemble
content/layout in library slots. These are still custom compositions; the design
is not an untouched library demo. Component connections and product semantics
remain unchanged.

Reviewed foundations, desktop List/composer, phone Waiting, and failed/stale
response renders. The settled visible-node audit across all 68 roots found zero
clipping and zero remaining legacy styling-variable references. Static renders
do not test keyboard behaviour, persistence or runtime interactions. Wiki access
was unavailable during this pass; current SPEC.md and the live canvas supplied
the relevant requirements. No application code or implementation evidence changed.

### Review repairs — 3 October 2026

Overview now orders execution uncertainty first, then the 09:14 question before
the 10:52 approval, matching Inbox. Task workspace `RyH7J` and full-content reference
`QGdAx` identify AT-142 as imported from `acme/atlas#142` and retain the open
`acme/design-system#87` dependency independently of AP-17 approval, consistent with
the board, imported detail and approval screens. Composer `Z315o` now uses 12px
for the shared sidebar workspace label. The four affected renders were inspected;
resolved-node checks found no clipping. These are canvas checks, not application
or runtime validation.
