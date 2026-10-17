# Ensemble UI design handoff

This is a portable reference for planning and implementing the reviewed Ensemble
web UI without opening the design canvas. The editable visual source is the
**Ensemble operator UI** Design canvas on claude.ai
(<https://claude.ai/artifact/6JBCAUn25QRBPVnyJNCBxY>, private to the owner). This
document is a handoff snapshot of it, not evidence of implemented behaviour.
Refresh it when the canvas changes.

[SPEC.md](../docs/SPEC.md#operator-interface-and-human-requests) owns product
behaviour, [acceptance.md](../docs/acceptance.md#operator-ui-scenarios) owns required
evidence, and [#736](https://github.com/chrisbanes/ensemble/issues/736) owns delivery
scope and sequencing. Resolve conflicts in favour of those contracts. This file
records presentation, layout and per-screen presentation rules.

All names, repositories, dates, counts, identifiers and captures on the canvas are
fictional fixtures that illustrate states; they are not observations of Ensemble's
backend, proof of a passed check or production defaults.

Screens are referenced by artboard name, which is the artboard's file stem on the
canvas (for example `02-inbox-approval`). Artboard names keep the screen numbers
that issues and evidence records cite (06, 133, 800B and so on).

## Contents

- Foundations: visual direction, tokens, typography and shape, layout and
  responsive composition, shared components
- Guidance: operator refinement brief, interaction guidance, fixtures and journeys,
  canvas map
- Screens: settings, credentials, onboarding and action feedback; settings,
  recovery and responsive states; task overview;
  review interactions; assignment context, delivery and search; workspace
  inspection and local review; Files and diff editor; tablet and short viewport
- Interaction notes
- Implementation status, using this snapshot, design limits and proposed data support

## Visual direction

A dense dark workbench for one trusted operator: obsidian surfaces separated by
hairlines, tonal depth instead of shadows, one indigo accent, and compact rows with
monospaced identifiers. Calm surfaces, clear decisions: the next decision and its
evidence get the space; navigation metadata stays quiet.

State colour supports meaning and never carries it alone. Every state badge pairs a
symbol and a word with its colour. Colour never establishes repair ownership,
delivery or operator attention on its own; running does not imply a repair owner,
and provider closure is never shown as success.

The canvas is dark only; a user-facing theme switch is not designed.

## Tokens

Each artboard defines the tokens as CSS custom properties. The production web app
maps them onto its own token layer.

| Token | Value | Purpose |
| --- | --- | --- |
| `--bg` | `#090A0F` | Page ground, inputs, segmented-control track |
| `--surface` | `#0D0F17` | Sidebar, panels, lists, cards, sticky bars |
| `--raised` | `#151824` | Row hover, secondary buttons, evidence and excerpt blocks |
| `--overlay` | `#1E2235` | Selection, menus, dialogs, active tab |
| `--line`, `--line-strong` | `#23283B`, `#2A3047` | Hairline separators; control and card borders |
| `--fg`, `--fg-2`, `--fg-3` | `#F1F5F9`, `#A6B0C3`, `#8390A6` | Primary, secondary and muted text (muted is at least 5.4:1 on `--raised`) |
| `--accent` | `#4F46E5` | Primary action fill, white text (6.3:1) |
| `--accent-text` | `#A5B4FC` | Links, running state text, selection marks |
| `--focus` | `#818CF8` | 2px focus outline with 2px offset |
| `--attn`, `--attn-soft`, `--attn-border` | `#FBBF24`, amber 12%, amber 35% | Attention: questions, approvals, "Next: you" |
| `--risk`, `--risk-soft`, `--risk-border` | `#FB7185`, rose 12%, rose 38% | Uncertain execution, interventions, confirmed failures, destructive actions, field errors |
| `--ok`, `--ok-soft`, `--ok-border` | `#34D399`, emerald 12%, emerald 32% | Completed results, recorded answers, confirmed saves |
| `--idle`, `--idle-soft`, `--idle-border` | `#A6B0C3`, slate 14%, slate 35% | Waiting, paused, queued, capacity, ready, stopping, stopped, cancelled, provider closed, unknown |

Project identity uses a small square dot per project (Atlas indigo, Relay teal,
Fieldnotes violet); it is never a state colour.

Code, diff and evidence views use local values: editor ground `#0B0D14`; hunk header
indigo 10% with `#A5B4FC` text; added lines emerald 12% with `#6EE7B7`; removed lines
rose 12% with `#FDA4AF` (20% when selected, with a 2px `--focus` inset edge); line
numbers `#7C879B`. Diff colour always pairs with `+`/`−` markers and Before/After
labels.

### Typography, spacing and shape

Geist supplies interface text; Geist Mono identifies IDs, hashes, times, paths,
counts and code. Page titles are 18/600 and task titles 20/600; section headings
15/600; task and request titles 14/500; body, rows and controls 13; request prose
14; metadata and badges 12; section labels 11 uppercase with 0.04em tracking in
`--fg-3`; code 12–13 Geist Mono with `white-space: pre` on each code line.
Identifier-heavy provenance (R2 · A-105 · 8d31c4a) is 12px muted metadata below the
plain-language state, never the headline.

| Element | Treatment |
| --- | --- |
| Badges | 20px high, 4px radius, soft fill + border + text in the state colour, symbol + word |
| Buttons, inputs, selects | 30–32px desktop, 6px radius, 10–12px side padding; phone 44px |
| Primary button | `--accent` fill, white text, 1px white 12% border; one per view |
| Secondary button | `--raised` fill, `--line-strong` border |
| Destructive button | rose-tinted fill and border with `--risk` text, never solid red |
| Panels, cards, dialogs | 8px radius, 1px `--line` border, `--surface` fill; header row separated by a hairline |
| Evidence blocks, chips | `--raised` fill, 6px radius |
| Keyboard keys | 18px high, 4px radius, `--bg` fill, mono 11px |
| Selection in lists | `--overlay` fill plus a 2px `#6366F1` left edge; tabs use a 2px underline |
| Menus and dialogs | `--overlay` with one shadow, `0 8px 24px rgba(0,0,0,0.5)` |

Spacing follows a 4px rhythm (4, 8, 12, 16, 20, 24, 32). Status icons supplement
visible state words; treat them as decorative when adjacent text conveys the
meaning.

## Layout and responsive composition

Desktop frames are 1366 wide at their content height (at least 768); full-content
references are the same width at their natural height. Phone frames are 390 × 844
(longer where a frame shows a scrolled page), tablet frames 1024 × 768 or 800 × 768,
and short phone frames 390 × 480. These are review viewports, not fixed application
dimensions.

- **Shell:** a 232px sidebar (Ensemble mark, installation name, Search work field
  with ⌘K, Overview, Inbox with an amber count, Tasks, the projects list with
  activity meta, a capacity meter and the account menu), a 48px top bar
  (breadcrumb, connection status — Connected, Updates delayed or Disconnected — and
  New task with its key), then the page. Settings, Getting started, Approval and
  delivery forms and Sign out live in the account menu. Main content uses 20px padding and 12–16px gaps; multi-pane screens
  run panes edge to edge with hairline dividers.
- **Breakpoints:** the production shell uses the navigation drawer through 1120 CSS
  pixels; the browser test checks 1119, 1120 and 1121px as well as 759, 760 and
  800px. Tablet frames show the drawer behind a 44px Open navigation button in the
  top bar. This shell breakpoint does not qualify task-row, Inbox or reading
  layouts by itself. Phone controls accommodate touch, keyboard and safe-area space
  without covering content.
- **Overview (`01-attention-overview`):** title and a stat strip (Needs you,
  Uncertain, Active tasks, Running turns), then Needs you as cards — an exhausted
  runtime first, then execution uncertainty, then questions and approvals oldest
  first — each with the request, reason, inline evidence and its response. The
  runtime card (risk tone) shows the headline "Codex runtime unavailable", the reason
  "Restart retries exhausted" and one "Open runtime settings" link; it has no project
  or task line, and it counts in Needs you and the sidebar total. A single-choice question can be
  answered in its card; an approval always opens exact material. A dashed row names
  further requests and opens the Inbox. Below, the work table (List/Board switch,
  filters; Task, State, Next, Lead, Updated) sits beside a Projects panel (lead,
  activity, source sync) and Recent results, which stay separate from requests.
- **Inbox (`02-inbox-approval`, `02b-inbox-runtime-exhausted`):** three panes. The
  queue is grouped (Intervention, then Questions & approvals oldest first) under its
  filters. A runtime whose automatic restarts are exhausted is a non-task item that
  leads Intervention (`02b`): the row reads "Codex runtime unavailable · Retries
  exhausted", appears under All projects only and counts in the totals. Its request
  pane shows the kind "Runtime", the position, the headline, the reason "Restart
  retries exhausted", the last failure ("The runtime process exited") and the
  attempts ("Attempt 1 · 14:02 · Failed — The runtime failed to start"), then a sticky
  bar with one "Open runtime settings" link. It has no Open task, no task-context
  inspector and no task read; the phone detail has the same content, a Back to Inbox
  header and no Open task (not drawn, same layout). The request pane shows
  kind, position, project/task, the request as a question, requester and identities,
  exact material, version and hold notes, and a sticky response bar. Questions are
  answered there; an approval ends with the statement of what a decision covers and
  one Review material & decide link to the retained exact-material destination.
  The Inbox never approves or denies. The task-context inspector lists the task, lead,
  requester, assignment chain, holds and evidence. Queue and detail scroll
  independently; phone uses queue → detail → queue with restored selection and
  position.
- **Composer (`05-composer`):** project, title and desired outcome lead. Optional
  context, references, permitted assignee and dependencies disclose below them;
  collapsed, they show chips of the supplied values and any error count. The right
  column shows "If you create it now" (Starts now or Will wait, with numbered
  reasons and their Fix or link; "Created ≠ running" appears only with Will wait)
  and the facts inherited from the project. A sticky
  bar separates unfinished on-device input from a confirmed Ensemble draft and holds
  Save draft and Create and start. Confirmed creation is distinct from admission.
  There is no attachment hint.
- **Task detail (`03-task-detail`):** a header with the task ID, a source chip for
  imported tasks, title, desired outcome, actions (Execution, and Stop… while the
  task is open; there is no task pause), a status strip (state badge, readiness and holds, next actor, lead,
  updated) and tabs (Overview, Files, Changes, Review, History). Overview leads with
  any decision card, then the latest result (its criterion rows with evidence
  outcomes), the reply to the lead, and the shared brief (requirements with
  provenance, approach and decisions, the supplied-criteria table), evidence and the
  assignments table as collapsed disclosures (`46a-task-overview-laptop`;
  `03-task-detail` shows them open). The inspector holds source sync,
  holds, dependencies, execution facts and results and artifacts; the holds a
  decision does not clear also appear as lines in the decision card; with no
  approval selected, the open approvals are not repeated as a hold. Requests remain
  outside disclosure; independent holds stay beside approvals. History updates
  preserve position, disclosures and replies.
- **Imported task:** source content and Ensemble execution are visually separate:
  GitHub requirements are read-only and attributed, and the inspector carries the
  source state (issue state, last sync, View source, Refresh). Phone uses GitHub
  source and Ensemble tabs, each preserving its position. External state is never
  implied by local activity.
- **Structured questions:** related questions form one submission with one Submit
  answers action. Desktop answers in the Inbox request pane or the task's answering
  panel; phone uses one scrolling form with a persistent submit area.
- **Board (`04-tasks-board`):** columns by Ensemble work state, equal width, all on
  one screen at 1366 (an empty Ready column collapses to a narrow labelled rail).
  Cards show title, project and source identity, the recorded reasons, the next actor
  when an attention code names one (amber when it is you) and the lead. Capacity is
  stated once above the work, never on a card. Phone shows one column with named tabs and
  previous/next. Ready-but-blocked work keeps its Ready label in the Waiting column;
  Stopping and Uncertain stay reachable with counts. A closure-held task reads
  "Held · closed on GitHub" and groups in the Paused column; when GitHub's closure
  cannot be attributed to Ensemble's delivery it reads "Held · closure not attributed
  to Ensemble" in the same place (text variant of `42-phone-provider-closed`). List/Board is a presentation
  switch, not a status mutation; no drag-and-drop is depicted.
- **Settings (`114-settings-index`):** in-page section navigation (Projects, Runtime
  & recovery, Profiles, Routing, GitHub discovery, CLI credentials, Notifications,
  Readiness)
  beside one column of bordered sections in the same order. Until a task starts a
  turn, Readiness comes first in the page and in the navigation (`114c-settings-first-run`);
  afterwards it is last. The order is the reading order: nothing is reordered with CSS. The
  navigation is not sticky. On a phone a section select with a **Go**
  button replaces it (`179a-phone-settings-index`): choosing an option never
  navigates, because arrow keys on a closed select fire change on some platforms; Go
  jumps, and the same section again lands again. Project configuration adds General, Routing, GitHub
  source and Sync & placement tabs. The navigation entry is drawn on the four index frames
  (`114`, `114c`, `179a`, `180a`); the section frames that predate it keep their earlier
  list of seven.

## Shared components

| Component | Canvas artboard | Use |
| --- | --- | --- |
| Sidebar | `Sidebar` | Every desktop screen. Props: `active` (overview, inbox, tasks, search, none), `inbox`, `project`, `projects` (fixtures, none, fixture-app or a comma list), `capacity`, `fixtureMeta` |
| Top bar | `TopBar` | Every desktop screen. Props: `crumbs` (slash-separated), `status` (connected, stale, disconnected) |
| Foundations and controls | `Main` | Tokens, state colours, typography, buttons, fields, choice controls, switch, segmented control, feedback lines and alerts, evidence and diff specimens |
| Domain components | `ds-domain-components` | Request row, board card, source identity chip, execution blocker, recorded response, structured answers, phone headers, navigation row, column tabs |
| Action feedback | `ds-action-feedback` | Success line, Details toggle and panel, warning and destructive alerts |
| Compact progress | `54-compact-progress-entry-points` | Task progress across Overview, List, Board and Inbox entry points |
| Review components | `56-review-components` | Criterion rows and local-feedback context |
| Inspection components | `77-workspace-inspection-specimen`, `107-editor-inspection-specimen` | Observation strip, selectable code line, editor row with separate gutter, marker and source |

Rules:

- Project and permitted-assignee fields are selects. Task lists are tables;
  assignments are table rows that disclose their history. Grouped multi-select
  questions use checkboxes, single-choice questions radios. Labels, descriptions,
  selected values, validation messages and response controls remain explicit.
- Phone screens use one of two headers: top-level (menu, title, count badge, one
  icon or outline action) or detail (back with the parent label, centred title and
  mono subtitle, at most one outline action).
- Use a navigation row for anything that only opens another view. Keep buttons for
  actions, with one primary action per view. Desktop buttons hug their label.
- Stop uses the destructive treatment and confirms first; reversible states show
  their counterpart (for example Restore profile).
- Task lead names and accountability remain visible wherever a task appears.

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
  readable. Retain semantic state meanings and readable typography.

Shared components and representative desktop/phone artboards use fixtures for
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
details that the canvas illustrates:

- Retain filters, selected request, scroll anchor, expanded groups and unfinished
  input while updates arrive. Follow new messages only when already at the bottom;
  otherwise provide New updates / Jump to latest.
- After a confirmed Inbox answer or decision, keep a confirmation visible instead
  of automatically selecting the next request. Failed submissions retain input.
- Recommended/preselected question options are not submitted answers. Show pending,
  recorded, failed, stale, cancelled, already answered, offline and unsupported
  interactions distinctly. Unsupported requests remain unresolved without a blind
  retry or conversion to ordinary chat.
- Every question action reads Answer question, in Overview, Inbox, List/Board and
  task detail; the question text carries the specifics.
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
  column. Compact progress (`54-compact-progress-entry-points`) covers these entry points.
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
- No context-menu, extension or deep-link surface is designed. The one notification
  surface is the opt-in browser notification controlled in Settings → Notifications
  (`181`–`185`); it opens the Inbox and never changes a task. Native Codex/ChatGPT work is
  outside this design.

## Fixtures and journeys

Illustrative design records; existing excerpts keep their attribution. Added
records illustrate assignment ownership, creation receipts and lifecycle states.
No recommendation is inferred from running activity.

| Fixture / journey | Desktop references | Phone references |
| --- | --- | --- |
| Failed check with recorded repair owner, no attention | Overview `01-attention-overview`; List `24-all-projects-list`; cross-project/project boards `04-tasks-board`, `23-atlas-project-board`; task `36-task-known-repair` | `38-phone-repair-responsibility` |
| Running with unknown repair responsibility | Overview `01-attention-overview`; List `24-all-projects-list`; boards `04-tasks-board`, `23-atlas-project-board`; task `45-task-repair-unknown` | `38-phone-repair-responsibility` |
| Specific audience question, requester, reason and evidence | Inbox `06-inbox-question-audience`; Overview and paused task row/card | Queue `09-phone-inbox-queue`; request `10-phone-question`; evidence `27-phone-question-evidence` |
| Failed submission, stale read, confirmation and return | Question states `22-question-states-specimen`; recorded response in `ds-domain-components` | Failed `28-phone-question-failed-answer`; stale `29-phone-question-stale-read`; sent `30-phone-question-answer-sent`; anchored return `31-phone-inbox-anchored-return` |
| Exact approval and independent dependency hold | Review `02-inbox-approval`; recorded approval `32-inbox-approved-dependency-held`; imported task `12-imported-task-source-execution` | Task `15-phone-imported-task-ensemble`; review `33-phone-exact-approval-source-hold` |
| Completed result and retained evidence, no decision | Task `37-task-completed-result`; outcomes `43-desktop-lifecycle-outcomes`; Overview recent results | `40-phone-completed-result` |
| Cancellation and provider closure without delivery | Outcomes `43-desktop-lifecycle-outcomes` | Cancelled `41-phone-cancelled`; closure hold `42-phone-provider-closed` |
| Uncertain execution and honest recovery | Overview/List; later board `04-tasks-board`; outcomes `43-desktop-lifecycle-outcomes` | `25b-phone-board-uncertain` |
| Confirmed creation waiting for capacity | Outcomes `43-desktop-lifecycle-outcomes`; composer `161-composer-created-project-paused` | Created `39-phone-created-waiting-capacity` |
| Optional values, collapsed error count and expanded invalid dependency | Composer `05-composer`; full-content `02-composer-optional-expanded` | Composer `34-phone-composer-collapsed`; collapsed error `35b-phone-collapsed-validation`; expanded error `35-phone-optional-settings-error` |

The question journey is queue → request → recorded evidence → request with
retained selection → submit → recorded confirmation → anchored queue. Failure
retains the choice; stale evidence retains the last read and requires checking the
current request. Exact unknown command outcomes require reconciliation, not a
blind retry. Confirmation does not automatically open another item.

Approval happens on the retained exact-material page. Returning to the Inbox shows
one success line, "Approved. Waiting on the GitHub dependency.", with AP-17 v2 in
Details, and the request leaves the queue (`32-inbox-approved-dependency-held`). The source-owned GitHub dependency stays visible. It
does not claim PR creation or successful delivery. Existing source refresh/comment outcome
references remain in place; the design adds no remote-write capabilities.

Overview orders execution uncertainty first, then the 09:14 question before the
10:52 approval, matching Inbox. Task detail `03-task-detail` identifies AT-142 as imported from `acme/atlas#142` and retain the open
`acme/design-system#87` dependency independently of AP-17 approval, consistent
with the board, imported detail and approval screens.

[Interaction notes](#interaction-notes) cover focus restoration, scrolling,
keyboard operation, safe-area handling, persistence and command reconciliation. Existing expanded-history and grouped question references remain the
disclosure/state inventory; representative initial screens prioritise evidence
above history.

## Canvas map

Each canvas page groups one area. Desktop artboards come first on a page, then
phone and tablet. Notes and review checklists from earlier design rounds are
carried into [Interaction notes](#interaction-notes), not drawn.

| Page | Artboards |
| --- | --- |
| 01 Core surfaces | `01-attention-overview`, `02-inbox-approval`, `02b-inbox-runtime-exhausted`, `03-task-detail`, `04-tasks-board`, `05-composer`, `06-workspace-changes-review`, `09-phone-inbox-queue`, `10-phone-question`, `114-settings-index` |
| 02 Inbox & questions | `06-inbox-question-audience`, `08-inbox-empty`, `19-inbox-grouped-questions`, `20-task-answering-grouped-request`, `32-inbox-approved-dependency-held`, `22-question-states-specimen`, `17-imported-source-overview-inbox`, `21-phone-grouped-questions`, `21b-phone-grouped-questions-scrolled`, `27-phone-question-evidence`, `28-phone-question-failed-answer`, `29-phone-question-stale-read`, `30-phone-question-answer-sent`, `31-phone-inbox-anchored-return`, `33-phone-exact-approval-source-hold`, `800g-phone-grouped-question-short` |
| 03 Task views | `46a-task-overview-laptop`, `36-task-known-repair`, `45-task-repair-unknown`, `37-task-completed-result`, `43-desktop-lifecycle-outcomes`, `49-state-comparisons`, `54-compact-progress-entry-points`, `12-imported-task-source-execution`, `12b-imported-task-comment-unavailable`, `05-task-history-grouped`, `50-local-task-brief-history-expanded`, `132-task-stop-confirmation`, `16-github-sync-comment-outcomes`, `13-imported-task-expanded-history`, `14-phone-imported-task-source`, `15-phone-imported-task-ensemble`, `38-phone-repair-responsibility`, `39-phone-created-waiting-capacity`, `40-phone-completed-result`, `41-phone-cancelled`, `42-phone-provider-closed`, `47-phone-task-overview`, `47b-phone-task-actions-open`, `48-phone-evidence-earlier-results`, `51-phone-expanded-brief-reply`, `52-phone-empty-local-task`, `53-phone-failed-refresh-uncertain`, `55-phone-parallel-delegation` |
| 04 Results & review | `57-task-revised-result`, `58-compare-evidence`, `59-inspect-criterion-feedback`, `64-changes-since-viewed`, `56-review-components`, `fixture-before-r2`, `fixture-after-r3`, `60-phone-feedback-failed`, `61-phone-message-sent`, `62-phone-before-after`, `63-phone-comparison-unavailable`, `65-phone-revised-result`, `66-phone-changes-since-viewed` |
| 05 Assignment, delivery & search | `67-assignment-context`, `69-changes-delivery`, `71-delivery-alternatives`, `73-search`, `75-search-states`, `68-phone-assignment-context`, `70-phone-changes-delivery`, `72-phone-delivery-alternatives`, `74-phone-search`, `76-phone-search-states` |
| 06 Workspace inspection | `78-files-current-observation`, `79-files-generated-markdown`, `81-changes-comparison-alternatives`, `82-result-r3-retained-files`, `83-review-complete-draft`, `84-last-turn-capture-states`, `85-generated-output-previews`, `86-inspection-capture-states`, `87-review-anchor-states`, `104-review-sent-original-comments`, `105-result-r3-retained-diff`, `106-keyboard-review-journey`, `77-workspace-inspection-specimen`, `107-editor-inspection-specimen`, `88-phone-task-files-list`, `89-phone-deleted-side-range-selection`, `90-phone-edit-anchored-draft-comment`, `91-phone-complete-review-first-scroll`, `92-phone-complete-review-summary-scroll`, `93-phone-generated-markdown-preview`, `94-phone-review-sending`, `95-phone-review-confirmed-failure`, `96-phone-review-unknown-outcome`, `97-phone-review-sent`, `98-phone-retained-result-bytes`, `99-phone-generated-pdf-preview`, `100-phone-generated-raster-preview`, `101-phone-local-base-selection`, `102-phone-unsettled-turn-missing-file`, `103-phone-auth-expired-private-state-cleared` |
| 07 Tasks, composer & tablet | `24-all-projects-list`, `23-atlas-project-board`, `23b-atlas-project-paused`, `02-composer-optional-expanded`, `800a-tablet-overview-list`, `800b-tablet-inbox-question`, `800c-tablet-task-evidence`, `800d-tablet-search-result`, `800e-tablet-composer-validation`, `800f-tablet-all-projects-board`, `25-phone-board-waiting`, `25b-phone-board-uncertain`, `34-phone-composer-collapsed`, `35-phone-optional-settings-error`, `35b-phone-collapsed-validation`, `800h-phone-composer-short` |
| 08 Settings, sign-in & recovery | `133-settings-cli-credentials-empty`, `134-settings-cli-credentials-list`, `135-settings-cli-credentials-name-error`, `136-settings-cli-credentials-unconfirmed`, `137-settings-cli-credentials-token`, `138-settings-cli-credentials-rotation`, `139-settings-cli-credentials-revoke-failed`, `122-profile-create`, `123-profile-revoked`, `123b-profile-instructions-revealed`, `124-routing-relay-unsaved`, `125-routing-relay-saved`, `126-runtime-capacity-recovery`, `126b-runtime-switches-specimen`, `126c-runtime-disable-confirm-specimen`, `127-assignment-recovery-relay`, `129-page-not-found`, `108-signin-desktop`, `109-signin-failed`, `113-account-menu`, `114b-settings-discovery-credential`, `115-project-setup`, `116-project-setup-field-error`, `116b-project-setup-duplicate-name`, `116c-project-name-suffix-specimen`, `117-first-project-setup`, `117b-first-setup-discovery-unavailable`, `117c-first-setup-add-repository`, `131-project-setup-choose-folder`, `118-project-config-general`, `118b-project-instructions-revealed`, `119-project-config-github-source`, `119b-project-source-credential-change`, `119c-source-credential-clear-unknown`, `119d-github-source-import-ready`, `119e-github-source-imported`, `120-project-config-sync-placement`, `120b-sync-credential-unusable`, `140-phone-cli-credentials`, `141-phone-cli-credentials-token`, `142-phone-cli-credentials-revoke`, `181-settings-notifications-off`, `182-settings-notifications-on`, `183-settings-notifications-blocked`, `184-settings-notifications-revoke`, `185-phone-settings-notifications`, `128-phone-assignment-recovery`, `110-phone-signin`, `111-phone-signin-pending`, `112-phone-signin-failed`, `121-phone-atlas-configuration` |
| 09 First run & onboarding | `143-home-getting-started`, `143b-home-checklist-runtime-regressed`, `145-setup-inline-lead-profile`, `145b-setup-profile-created`, `146-setup-ready-check`, `146b-setup-ready-check-blocked`, `148-composer-project-paused`, `149-task-waiting-project-paused`, `149b-task-fix-resume-confirm`, `151-settings-readiness`, `114c-settings-first-run`, `152-runtime-add-claude`, `152b-runtime-claude-token-unavailable`, `149c-wait-reasons-specimen`, `151b-readiness-no-runtime-specimen`, `144-phone-getting-started`, `147-phone-setup-ready-check`, `150-phone-task-waiting-fix` |
| 10 Action feedback | `154-project-configuration-saved`, `154b-project-configuration-details-expanded`, `155-routing-saved`, `156-project-configuration-field-error`, `157-project-configuration-changed-elsewhere`, `158-project-configuration-unknown-outcome`, `159-change-list-remove-last-repository`, `160-discovery-credential-saved`, `161-composer-created-project-paused`, `162-grouped-questions-answered`, `162b-grouped-questions-send-failed`, `163-task-reply-sent`, `164-stop-confirmation`, `165-cli-credential-revoked`, `ds-action-feedback`, `166a-phone-project-configuration-saved`, `166b-phone-unknown-outcome-locked`, `166c-phone-task-created-project-paused` |
| 11 Settings, recovery & responsive states | `167-profile-field-error`, `168-routing-field-error`, `169-runtime-capacity-field-error`, `178-profile-revoke-available`, `170-source-config-changed-elsewhere`, `170b-source-config-latest-loaded`, `171-source-config-unknown-outcome`, `172-routing-typesafe-unavailable`, `173-recovery-evidence-unavailable`, `174-recovery-no-admitted-generation`, `175-recovery-pre-turn-witness`, `176-recovery-no-turn-witness`, `177-project-setup-ref-open`, `180a-tablet-settings-index`, `180b-tablet-project-setup`, `180c-tablet-profile`, `180d-tablet-routing`, `180e-tablet-runtime`, `179a-phone-settings-index`, `179b-phone-project-setup`, `179c-phone-profile`, `179d-phone-routing`, `179e-phone-runtime` |
| 00 Foundations & components | `Main`, `Sidebar`, `TopBar`, `ds-domain-components` |

## Settings, credentials, onboarding and feedback

### GitHub discovery credential

Frame 114's GitHub discovery section, after Routing, carries the installation
discovery credential row; `114b-settings-discovery-credential` draws it open, and
`117b-first-setup-discovery-unavailable` draws the setup alert when discovery is
unconfigured and step 3 is opened; `117c-first-setup-add-repository` draws step 3
collapsed.

- **Configured (114):** "GitHub discovery credential · GitHub CLI · @account ·
  read-only use" with Change and Clear. Clear removes the reference and is the
  reverse of choosing a source. An environment-variable reference keeps its
  existing lines.
- **Open (114b):** a source choice, with GitHub CLI marked recommended and
  Environment variable marked advanced.
  - **GitHub CLI.** The service detects a login non-interactively. When it finds
    one, the row shows "Signed in to github.com as @account" with **Use this
    login**. Otherwise it shows exactly one of the following, with no action:
    "gh not installed", "gh not signed in · run gh auth login" or "gh login
    unreadable from the service".
  - **Environment variable.** A Variable name field; `env:` is implied.
  - The form also carries the use note (read-only use, removed from agent and
    helper environments, keychain limit) and Cancel. The token itself is never
    shown.
- **Setup alert (117b, 117c):** while discovery is unconfigured, step 3 starts
  collapsed (117c): its heading, the line "Optional. Without a repository the
  project is repository-free; adding one also offers GitHub discovery." and a
  secondary **Add a repository**. Opening it moves focus to its first control and
  draws 117b, the opened state: when the service detects a gh login the alert offers
  **Use GitHub CLI login (@account)** before **Set discovery credential**, the one
  place setup offers it, even when gh is signed in. The action configures the
  reference in one step and re-reads discovery. Without a detected login, only **Set
  discovery credential** appears. Discovery never reads with a gh login the operator
  did not choose for it. The section opens by itself for a row that holds a value, a
  rejected repository or GitHub Project, and an unsettled GitHub CLI login, and it
  never closes again: clearing a row means choosing "No repository · repository-free",
  an intentional one-way disclosure with no close control. Frame 116 draws discovery
  available and is unchanged.
- **Readiness offer (114c):** the Readiness GitHub discovery row, when it reads Not
  configured, no discovery credential is configured and the service detects a
  signed-in gh login, shows a secondary **Use GitHub CLI login (@account)** in
  place of its fix line. It is the same one-step configure as the setup alert, as
  a separate, explicit offer: the first-run path (setup step 3, behind Add a
  repository) offers it where a new project needs discovery, and Settings offers it
  where an installation already exists, while the Home checklist row stays
  informational and links to the GitHub discovery section. Run again still only
  re-reads. Signed out, not installed, unreadable, a configured
  but unreadable credential and a failed discovery read keep the server's fix line.
  Saving or clearing the credential here or in the section re-reads both, so Clear
  brings the offer back.
- **Setup source credential (116, 116b, 117, 117b, 131, 145, 145b, 177):** step 3 states the
  source credential setup will record, as a line after the GitHub Project field, only
  while a repository row is filled; "What creation does" has exactly two bullets
  ("The project starts Paused. Creating it starts no execution." and "Repository
  access is exactly the list in step 3."). The line reads "GitHub source credential:
  GitHub CLI · @account", recorded as the new project's `gh:github.com` source
  credential and changed or cleared later in GitHub source settings, or, in the
  unusable case, "GitHub source credential: none", where the source starts without a
  credential. 115 draws no repository, so it has no line. A repository-free project
  records no credential and shows none, here and in the ready check. Not drawn: the
  line reads "checking…" until the login read returns, and a failed read says the
  login could not be checked; neither records a credential. There is no opt-out
  control in setup.

### Project source credential

Frame `119-project-config-github-source` shows the configured GitHub CLI account with Change and Clear.
Frame `119b-project-source-credential-change` opens GitHub CLI and Environment variable choices;
the detected account is an offer, and selecting a source identity is explicit;
the panel description says a guided-setup project starts with the GitHub CLI login
setup detected, when it was usable. A cleared source stays cleared.
Cancel abandons only the credential edit, keeping unrelated source draft changes.
The environment field takes the full `env:NAME` reference; reads show the reference
kind and status, never the variable name or value.
Discovery never supplies the source identity.

Frame `119c-source-credential-clear-unknown` draws an uncertain Clear save with the retained draft and
**Check whether it saved**. Confirmed Change or Clear preserves definitions and
history, invalidates activation and requires preview at the new source version.
Reconciliation uses the same request; no new save is issued while its outcome is
unknown.

Frame `120-project-config-sync-placement` shows missing credentials in its preview and observations panels, with a route to GitHub source settings and no invented attempt or success
timestamp. Frame `120b-sync-credential-unusable` shows a configured but unusable login: sign in on the
service host or change the source credential. Not installed and unreadable use the
same blocked presentation with their own actionable reason. Stale success is not
proof of current completeness; blocker status remains unknown. Frame `121-phone-atlas-configuration`
shows the missing-source state and the credential-then-preview next step, preserving independent placement holds and the phone's read-only design.

### CLI credentials

Artboards 133–142 show Settings with CLI credentials selected in the section
navigation. On phone, 140 shows the panel under the phone header; phone states
without an artboard use the desktop copy.

| State | Desktop | Phone |
| --- | --- | --- |
| Empty, with the create form | `133-settings-cli-credentials-empty` | — |
| List: active read-only, active read-write never used with Replaces, revoked, expired | `134-settings-cli-credentials-list` | `140-phone-cli-credentials` |
| Name validation error | `135-settings-cli-credentials-name-error` | — |
| Unconfirmed create with Check the list; list unavailable with Retry | `136-settings-cli-credentials-unconfirmed` | — |
| One-time token after create (copy failed) | `137-settings-cli-credentials-token` | `141-phone-cli-credentials-token` (copied) |
| Rotation: replacement token; the old credential is still Active | `138-settings-cli-credentials-rotation` | — |
| Revoke confirmation with a failed or unknown request | `139-settings-cli-credentials-revoke-failed` | `142-phone-cli-credentials-revoke` |

- The create form is always inline: Credential name, Scope (Read-only or
  Read-write, Read-only by default) and Lifetime (7, 30, 60 or 90 days, 90 by
  default). The service accepts any lifetime from 1 to 90 days; the form offers
  these presets.
- Each row shows the name, a badge, and ID (first 8 characters), Scope, Created,
  Expires and Last used ("never" until first use), plus Replaces on a rotation
  replacement and Revoked on a revoked credential. Names may repeat, so the short
  ID tells credentials apart. Active uses the emerald ● badge, Revoked the rose ✕
  badge and Expired the neutral ◼ badge; Expired and Revoked rows have no actions. Rows are listed by creation time,
  oldest first.
- The token is shown once in "CLI token for <name>", with Copy and Done. Copy
  reports "Copied to the clipboard." or "Copy failed. Select the token and copy it
  manually." Outside clicks do not close the dialog; Escape and Done discard the
  token.
- Rotate has no confirmation. It issues a replacement with the same name and scope
  and a 90-day lifetime, reveals its token in the same dialog and leaves the old
  credential Active until it is revoked. Only the replacement row says Replaces.
- Revoke asks first ("Revoke <name>?") and is irreversible by design. A lost or
  leaked active token is rotated (then the old credential revoked) or replaced by
  a new credential; a revoked or expired credential can only be replaced by
  issuing a new one.
- A refused request names the cause in plain words and says the list below is
  reloading ("Couldn't create the credential: you don't have permission. Your
  entries are still here; we're reloading the list below."), with the code in
  Details. An unconfirmed create or rotate is one warning, "We couldn't confirm the
  credential was created.", with **Check the list** (`136-settings-cli-credentials-unconfirmed`). Create and rotate
  have no request key, so that action only re-reads the credentials and never
  resubmits. Revoke is by id: a failed or unconfirmed revoke stays inside the
  dialog as text without a button (`139-settings-cli-credentials-revoke-failed`, `142-phone-cli-credentials-revoke`).
- Rotate and Revoke each leave one success line: "Rotated <name>. The old
  credential stays active until you revoke it." and "Revoked <name>." (`165-cli-credential-revoked`
  draws it in the credential row; the build shows it above the list). Create's
  confirmation is the one-time token dialog.
- Settings (account menu → `/app/settings`) is the only entry point, and the
  page-title Refresh re-reads the list (the phone frames draw only the top-level
  header). No deep link, context menu, extension or notification surface
  applies to credentials (browser notifications are the separate Notifications
  section below), and the legacy HTML UI has no credential controls.
- Phone inputs, selects and buttons, dialog actions included, are 44 px tall. Token
  values are fictional fixtures. Loading, a busy create button and an
  expiring-soon cue are not drawn.

### Notifications

Artboards 181–185 show Settings with Notifications selected in the section
navigation, between CLI credentials and Readiness; the four index frames (`114`,
`114c`, `179a`, `180a`) draw that entry. On phone, 185 shows the panel under the phone
header; phone states without an artboard use the desktop copy.

| State | Desktop | Phone |
| --- | --- | --- |
| Off in this browser, permission not asked, no browsers listed | `181-settings-notifications-off` | — |
| On, with a test result, Turn off for this browser and the browsers list | `182-settings-notifications-on` | `185-phone-settings-notifications` |
| This browser's other states in place of Turn on: blocked, unsupported or insecure address, unavailable on the service, removed from the list, set up with an old key | `183-settings-notifications-blocked` (text specimen) | — |
| Revoke confirmation with a failed or unknown request | `184-settings-notifications-revoke` | — |

- The section opens with three plain lines. **What it says:** "Kind, project and
  waiting count, or which runtime is unavailable, with a link. No question text, task
  content or error details." **What triggers one:** "A new question, approval, problem
  or runtime whose restarts ran out." **What it opens:** that request in the Inbox,
  after sign-in; a notification never answers or approves anything.
- Notifications are off until the operator turns them on in a browser. **Turn on
  notifications** is the only place the browser's permission prompt can come from;
  nothing is requested on page load. Each browser is turned on separately.
- Two forms of notification exist and no others. A task item reads "Question in
  <project>: <n> waiting" (Question, Approval or Intervention, the Inbox's own kind
  label; <n> counts task items of that project and never a runtime). A runtime item
  reads "Codex runtime unavailable" (or Claude), names no project or error, and opens
  `/app/inbox?request=runtime%3Acodex`. A runtime notifies once per exhaustion episode.
- On: the status reads "● On", **Send test notification** reports "Test notification
  sent." or the failure in plain words, and **Turn off for this browser** stops this
  browser and revokes its row. Turning on again restores it.
- The list is "Browsers", active first, oldest first, then revoked rows. A row shows the
  label, a badge, Push service (the host only), Added and Last delivered (or Revoked).
  Active is the emerald ● badge and **This browser** marks the row of the browser being
  used; that row has no Revoke because Turn off is its control. A failed delivery adds
  one attention line ("▲ Last delivery failed: push service unavailable", "…push service
  rejected it" or "…push service timed out") and leaves the row Active. Another active
  browser has **Revoke**, which asks first ("Revoke <label>?", `184`) and can be undone
  by that browser turning notifications on again. The service allows 20 active browsers.
- Revoked rows keep their reason: rose ✕ "Revoked" (the operator revoked it), neutral ◼
  "Removed by the push service" (the push service reported the subscription gone) and
  neutral ◼ "Key changed — turn on again" (the service's notification key was replaced).
  Revoked rows have no actions, and the newest 20 are kept.
- A failed or unconfirmed revoke stays inside the dialog as text without a button, as
  CLI credentials do, and the list reloads below.
- This browser's state replaces the Turn on area (`183`): blocked in the browser's
  settings (with **Check again**), unsupported or not a secure address, unavailable on
  the service (the rest of Settings keeps working), removed from the list (revoked
  elsewhere or removed by the push service; **Turn on again**) and set up with an old key
  (**Turn on again**). Turning on again replaces the old subscription. Permission
  withdrawn after turning on shows the blocked state.
- Settings (account menu → `/app/settings`) is the only control surface. A notification
  click opens or focuses Ensemble at the exact Inbox selection, signing in first at the
  same address if the session has ended. Where the platform allows, the page closes a
  notification once its request is no longer in a complete Inbox read; notifications are
  never sent to close one.
- No Readiness check or Home checklist item is designed: notifications are optional,
  and an operator who leaves them off has nothing to fix. Loading and busy states are not
  drawn. Phone buttons and selects are 44 px tall. Names, hosts and times are fictional
  fixtures.

### First run and onboarding

Frames 143–152b draw the flows in [docs/user-flows](../docs/user-flows/); each flow
document states what is implemented. Fixtures are fixture-app, `fixture-org/fixture-app`,
@fixture-user, lead Ada and task FA-1.

- **Getting started (143, 143b, 144):** Home shows only the "Get Ensemble running"
  card below the page heading until a task starts a turn (no board, stat strip or
  filters), then returns to the board of 18. The card has five rows (Runtime, GitHub,
  Project, First task, Claude optional). Each row has a status icon, title,
  explanation, badge (✓ Done emerald, → Next amber, Needs attention rose, ○ Not
  started and Optional neutral) and one action. Only the first incomplete required row
  has the primary button; Done and optional rows use a ghost button, the rest
  secondary. On phone the action moves below the explanation. The summary counts the
  three required rows ("1 of 3 required steps done") over a three-segment progress
  strip; GitHub and Claude are optional. The Project row covers the lead: it is Done
  only when an enabled project has a lead profile, and otherwise offers Create
  project, Choose a lead or Resume. First task is unavailable with "Needs a project
  first." until a project exists. The GitHub row is informational (no one-click
  login; it links to the GitHub discovery section, and the offers are in project setup
  and Readiness). In 143b the paused fixture-app is not Done:
  the Project row reads Not started with Resume, which confirms as in 149b. After the
  first turn Home keeps only rows that need attention. The account menu's Getting
  started (`113-account-menu`) opens `/app/getting-started`, the same card with a
  secondary Dismiss; once dismissed the menu item reads Show getting started, which
  undoes it.
- **Project setup (145, 145b):** with no profiles, step 1 replaces the Lead profile
  select with an inline profile form: a help line ("No lead profiles yet. Create one
  here, or leave this blank and choose a lead later; tasks wait for a lead before
  starting."), Profile name, Runtime (Codex preselected), the line "Add a summary
  and instructions later in Settings → Profiles." and a secondary Create profile;
  the page's Create paused project stays primary. The profile and the project stay
  two submissions. In 145b the lead select is back beside Project name with the
  new profile chosen, and the success line "Profile created. Other setup values kept."
  (the success line in `ds-action-feedback`) sits below the row.
- **Ready check (146, 146b, 147):** replaces the "Recorded … as a paused project"
  alert. The frames show the region that replaces the setup form after Create and
  receives focus; the first-project heading stays "Set up your first project" (146
  and 146b draw no subtitle).
  - Drawn: the success line "Created fixture-app. It's paused."; plain lines
    "Nothing has run.", "Instructions saved." (or "No instructions yet."),
    "Repository access: fixture-org/fixture-app (main), checked on this Mac." (or
    "none · repository-free"), when linked, the GitHub Project, and the recorded
    source credential, "GitHub source credential: GitHub CLI · @fixture-user" (only
    when the project has a repository); the Details toggle; the actions, primary Resume and create first task and secondary
    Keep paused. On phone (147) the actions stack at full width.
  - Drawn in 146b: a source without a credential reads "GitHub source credential:
    not set. The source won't sync until one is set." with a GitHub source settings
    link that opens in a new tab; the hint and Check again below also appear for
    it. The line is informational and never disables Resume. While anything would make work wait, the primary is disabled (50%)
    and the reasons sit beneath it, one item each: the readiness reason with its fix
    line in Geist Mono, and a secondary link that opens in a new tab when the fix is
    elsewhere (Add Claude for the Claude token, Edit profile when the Claude lead's
    model or reasoning effort is not accepted). Under the items, a hint ("Links open
    in a new tab. Fix the item, then check again here. If you leave this page, resume
    later with the Pause project switch in project configuration.") and a secondary
    Check again, which re-reads readiness, the workspace, capacity and the source
    credential. The hint's
    first sentence appears only when an item has a link.
  - Not drawn, same layout: the items no lead profile, the lead's runtime unavailable
    or not enabled, and an unreadable readiness check ("Readiness couldn't be
    checked."); and, never blocking, the line "Capacity is full now, so the first
    task will wait for capacity." While reads are pending the check shows
    "Checking readiness…" and keeps the primary disabled; with no item yet it shows
    no hint or Check again.
- **First task (148–150):** the composer's "If you create it now" panel says
  "Starts now" or "Will wait" with its reasons for the project and the chosen
  dependencies (148); the bar beside Create and start only explains Save draft.
  Task detail shows "Waiting · <reason>" with its Fix; any further reasons are listed
  beneath it in the flow's order, each with its own Fix or link. Fix: Resume project
  confirms first (149b). A dependency wait has no Fix, only a link to the blocking
  task (149c). Inbox notices and the CLI use the same order. A paused project keeps
  Fix: Resume project while stop, task or writer holds remain; those holds are
  listed under it as "Also held · Resume project doesn't clear these", each with
  what clears it ("Clears when the task's Stop is resumed.", "Clears when we know
  the execution ended.") or, for a task hold, which no operator action clears, its
  recorded reason and "Recovery stays blocked while it remains." Each line also
  links to the task's Execution view (Execution details); none is a Fix (149c). These
  holds are task-wide and name no assignment; only a wait that names its assignment
  links to that assignment's recovery page.
  The Fix confirmation then names the holds that stay.
- **Readiness and Add Claude (151, 152, 152b):** Readiness is the first Settings
  section until a task starts a turn and the last afterwards (114c, 151), with Pass,
  Fail and Not configured badges, a Geist Mono fix line under each failure, and Run
  again, which only re-reads. When discovery is unconfigured and a gh login is
  detected, the GitHub discovery row offers **Use GitHub CLI login (@account)** in
  place of its fix line (114c). Add Claude sits at the
  top of the runtime page's left column: copyable token-file commands, a Token
  reference field (`file:` or `env:`), Save, and a live Token readable row. Set opens
  the field with the suggested `file:` path when no reference is configured; `~` and
  `$HOME` are refused with the full path offered. A failure names neither the path
  nor the value and offers Clear.
- **Execution runtimes (126, 126b, 126c, 151b):** the runtime page opens with an
  Execution runtimes section above Capacity (126). Each runtime row shows its
  status, the first two lines of its effective policy and a "Limits and untested
  surfaces · N" disclosure, closed by default, holding the remaining policy lines
  and the runtime's disclosed limits; its open state is a per-viewer convenience.
  The row's "<Runtime> enabled" switch sits beside its status badge, in five states: enabled
  and Available; enabled and Unavailable while Ensemble restarts it, with the Fix
  "Restarting · attempt N of 3 · next at HH:MM" (126 draws attempt 2 with the shell
  alert "Codex runtime unavailable — Restarting · attempt 2 of 3 · next at 14:32");
  enabled and Unavailable once retries are exhausted, with the Fix "Retries exhausted ·
  turn it off and on, or restart the service" (the alert reads "… — Retries exhausted;
  turn it off and on in Settings → Runtime, or restart the service" and the Inbox
  carries the runtime item); disabled, "Not enabled · Disabled in Settings", with no
  shell alert; and refused because the binary is missing, an inline error naming it
  while the switch stays off (126b). The retries run after 30 s, 2 min and 10 min; a
  disabled runtime is never restarted. Turning off a runtime that bound tasks use asks first:
  "N tasks use Claude. Running turns finish; their next turns wait until Claude is
  enabled again." with Cancel and Turn off (126c); without bound tasks it saves at
  once. With no runtime enabled, Readiness fails "An execution runtime is enabled"
  with the Fix "Enable a runtime in Settings → Runtime", and each disabled runtime's
  checks read Not configured, "Disabled in Settings" (151b). Composer and task waits
  reuse the existing Not enabled copy.

### Action feedback

Artboards 154–166c set one message per action, sized to the outcome. Every other
screen follows the same rules.

- **In progress:** the button label only ("Saving…", "Sending…"). An action with no
  button shows one status line instead ("Sending review to Mira…", `94-phone-review-sending`).
- **Success:** one quiet inline line beside the action: muted check, muted text,
  no Alert (the success line in `ds-action-feedback`).
- **Rejected:** one destructive Alert naming the cause, plus any field
  error.
- **Changed elsewhere or unknown outcome:** one warning Alert with a single button
  An unknown outcome locks the other fields. The button is **Check
  whether it saved** and resends the exact original request; CLI credential create
  and rotate have no request key, so theirs is **Check the list**, a re-read (136).
  A replaced, withdrawn or already answered question is a changed-elsewhere
  warning, "This question was already answered, changed or withdrawn. Your answer
  is still here.", with **Review current request** (the Stale request card of 22
  `22-question-states-specimen`).
- **Copy:** at most two short sentences. Message text never uses recorded,
  receipt, observation, admission, reconcile, submission or revision, and never
  shows command names, IDs, versions, hashes or raw codes. Every failure says the
  input is safe ("Your changes are still here.").
- **Details:** every outcome has a collapsed Details disclosure.
  Expanded, it shows a Geist Mono key/value list (Command, Resource, Version,
  Request key, Code, and Kind where a receipt carries one) with Copy.
  Sign-out has no receipt and no Details.
- **Consequences** go in the Changes to save list before Save (159), never in the
  success line.
- **Task-side copy as built:** a created task reads "Task created." and a draft
  "Draft saved."; an answer "Answer sent. It reaches the requester on its next
  turn." (`162-grouped-questions-answered`, `30-phone-question-answer-sent`) and, on failure, "Couldn't send the answer: the
  service is unavailable. Your answer is still here." with the code in Details (162b
  `162b-grouped-questions-send-failed`, `28-phone-question-failed-answer`); a reply "Sent to Ada." (`163-task-reply-sent`, `61-phone-message-sent`); a review
  "Review sent to Mira." (`97-phone-review-sent`, `104-review-sent-original-comments`), or "We couldn't confirm the
  review reached Mira." with **Check whether it saved** (`96-phone-review-unknown-outcome`), or, when
  refused, one error Alert "The review wasn't sent: …" with **Return to draft** (95
  `95-phone-review-confirmed-failure`). Stop confirmation is the affected-assignments sentence plus one
  sentence on what Stop does, with Stop task and Keep running (`132-task-stop-confirmation`, 164
  `164-stop-confirmation`). An unconfirmed sign-out re-reads the session: signed out is success and
  shows nothing; a session that survived shows one warning, "We couldn't sign you
  out. You're still signed in.", in the shell only (see [Interaction notes](#interaction-notes)).
- **Created and waiting:** `161-composer-created-project-paused` and `166c-phone-task-created-project-paused` draw "It will wait: …"
  beside the Resume project Fix, and `39-phone-created-waiting-capacity` draws "It will wait for capacity."
  As built, "It will wait: <reason>" and its Fix sit below the "Task created." line,
  with any further reasons listed beneath.

Warnings use the attention tokens (`--attn`, `--attn-soft`, `--attn-border`).

### Settings, recovery and responsive states

Canvas page **11 Settings, recovery & responsive states** draws the settings,
recovery and layout states that the other pages leave out. They reuse the shared
Sidebar, TopBar, settings section navigation and the action-feedback rules above.

| State | Artboards |
| --- | --- |
| Field errors: profile, routing, capacity | `167-profile-field-error`, `168-routing-field-error`, `169-runtime-capacity-field-error` |
| Revoke an available profile, unsaved | `178-profile-revoke-available` |
| GitHub source changed elsewhere, then latest loaded | `170-source-config-changed-elsewhere`, `170b-source-config-latest-loaded` |
| GitHub source save outcome unknown | `171-source-config-unknown-outcome` |
| Routing with TypeSafe unavailable | `172-routing-typesafe-unavailable` |
| Recovery: evidence unavailable, no generation in use, before-turn and no-turn witnesses | `173-recovery-evidence-unavailable`, `174-recovery-no-admitted-generation`, `175-recovery-pre-turn-witness`, `176-recovery-no-turn-witness` |
| Repository ref list open in project setup | `177-project-setup-ref-open` |
| Tablet: settings index, setup, profile, routing, runtime | `180a-tablet-settings-index` – `180e-tablet-runtime` (1024 wide) |
| Phone: settings index, setup, profile, routing, runtime | `179a-phone-settings-index` – `179e-phone-runtime` (390 wide) |

- **Field errors:** each invalid field shows its own fix under the control ("Enter
  a profile name.", "Keep the summary to 120 characters or fewer. It has 128.",
  "Enter a whole number of 1 or more.", the `env:NAME` format), and the first takes
  focus. One destructive Alert below the form reads "Couldn’t save." above "Fix the
  highlighted field." (or "Fix the 3 highlighted fields.") and "Your changes are
  still here.", with Details. Fields stay
  editable and Save stays enabled; errors clear on the next save. A per-project
  capacity override is highlighted on its own field, like the global cap. A
  field with no drawn fix, or one the service rejects without a reason, reads
  "Check this field."
- **Revoke an available profile:** Revoke profile is a destructive button that
  marks the change; nothing is sent until Save profile. Marked, it becomes Undo
  revoke, Changes to save lists "Revoke Builder", and the helper says revoking
  does not stop, cancel or recover running work. Saving follows the shared
  outcomes and ends in `123-profile-revoked`, whose Restore profile is the
  counterpart. There is no confirmation dialog because the change is reversible
  and listed before saving.
- **GitHub source changed elsewhere:** the shared warning "A newer version was saved
  elsewhere." with Review changes; fields stay editable. Review changes loads the
  latest version, keeps your edits, and says which edited rows were removed
  elsewhere ("Loaded the latest version. S-3 was removed elsewhere, so your edits
  to it were discarded."). Rows added elsewhere appear as kept rows, not changes.
- **GitHub source outcome unknown:** the three source sections lock, Save and
  Discard changes are replaced by "We couldn’t confirm the save." with Check
  whether it saved, and Changes to save stays frozen to the draft.
- **TypeSafe unavailable:** the Routing section names the availability in words
  and, when routing can’t choose, a status notice says why and who allocates
  instead ("Routing has no credential reference, so it can’t choose assignees. New
  tasks without an assignee go to Jonas to allocate."). The form stays editable so
  the reference can be set. The other states read "No eligible candidates" and
  "Routing off". A TypeSafe failure during a task wakes the lead and is not shown
  in Settings. When a reference is configured but the service can’t use it, the
  notice reads "Routing can’t use its credential reference, so it can’t choose
  assignees." With no usable project lead (none set, or revoked), it says new
  tasks without an assignee wait until the project has an available lead.
- **Recovery variants:** all four reuse the `127-assignment-recovery-relay` layout
  and stay read-only with Inspect execution as the only action. Evidence
  unavailable reads "We can’t show recovery details for this assignment." and says
  that having no record doesn’t mean the execution ended or its holds were
  released. With no generation in use, the Generation in use row reads Unavailable
  and says this doesn’t mean the execution ended. A before-turn witness ("Before-turn
  refusal") and a no-turn witness ("No turn sent", with "An idle conversation may
  still exist") sit inside their generation’s record with their ID and source, and
  both say "Evidence only. It doesn’t recover the assignment or allow new work."
  Recovery is applied in the advanced recovery destination.
- **Ref list in project setup:** Ref is the platform select. Open, it lists the
  default branch first and checked, then the current ref if unlisted, then other
  branches in GitHub’s order. Loading, unavailable discovery and lists over 500
  branches use a typed Ref field with the reason in its caption. The local checkout
  is verified again for the chosen ref.
- **Tablet and phone settings:** tablet keeps the section navigation beside the
  content behind the drawer; side panels stack below the form. Phone replaces the
  section navigation with a section select, uses 44px controls, turns project rows
  into cards, and keeps one persistent save area at the bottom.

## Task overview

Shared brief, delegation, evidence and compact progress requirements are in the
[task overview specification](../docs/SPEC.md) and
[design-review criteria](../docs/acceptance.md). #742 owns task review, search and
its shared navigation; #745 owns integrated qualification. These frames are
reviewed design, not an implemented UI.

The task header establishes project, source, accountable lead and current wait.
Actionable requests sit above disclosure. Desktop places the shared brief beside
the latest result, its evidence and compact delegation rows; phone discloses the
brief, result detail and assignment history from a single task summary. The shared
controls, state colours, identifier roles and compact progress
(`54-compact-progress-entry-points`) remain the foundation.

Fixture: criterion labels C1/C2, validation V-22, revisions and results illustrate
recorded relationships. AT-142 retains the existing AP-17 v2 exact-material
approval and independent GitHub dependency. A-105 and A-106 have parallel
responsibilities using the same Builder profile; their IDs, requesters and result
destinations distinguish them. At the illustrated snapshot, A-105 has reported R2
and A-106 has recorded a failed focus check before waiting on the dependency.
FN-58's empty and expanded views are different moments in the same local-task
journey.

| Review surface | Artboard |
| --- | --- |
| Desktop task, 1366 × 900 | `46a-task-overview-laptop` |
| Full-content task inventory | `03-task-detail` |
| Phone task, 390 × 844 | `47-phone-task-overview` |
| Phone Task actions open | `47b-phone-task-actions-open` |
| Phone evidence and earlier results | `48-phone-evidence-earlier-results` |
| Empty, dependency, refresh and uncertainty specimens | `49-state-comparisons` |
| Expanded local brief, question, history and retained draft | `50-local-task-brief-history-expanded` |
| Phone long brief and retained draft | `51-phone-expanded-brief-reply` |
| Phone empty local task | `52-phone-empty-local-task` |
| Phone failed refresh and uncertain execution | `53-phone-failed-refresh-uncertain` |
| Shared compact progress and entry-point specimens | `54-compact-progress-entry-points` |
| Phone delegation and history access | `55-phone-parallel-delegation` |

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
- **Attention and controls:** AP-17 links to existing desktop `02-inbox-approval` / phone
  `33-phone-exact-approval-source-hold` exact-material review, preserving action, target, patch and description
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

| Review surface | Artboard |
| --- | --- |
| Reusable criterion and feedback context | `56-review-components` |
| Revised result and criteria needing another look | `57-task-revised-result` |
| Labelled before/after comparison | `58-compare-evidence` |
| Inspect evidence and edit contextual feedback | `59-inspect-criterion-feedback` |
| Confirmed send failure with editable draft | `60-phone-feedback-failed` |
| Sent local message | `61-phone-message-sent` |
| Phone before/after comparison | `62-phone-before-after` |
| Missing before and unavailable after material | `63-phone-comparison-unavailable` |
| Revision changes, no baseline and failed-source alternatives | `64-changes-since-viewed` |
| Revised phone task summary | `65-phone-revised-result` |
| Phone changes disclosure | `66-phone-changes-since-viewed` |

The comparison uses fictional captures drawn as labelled mock UI
(`fixture-before-r2`, `fixture-after-r3`); the images in `design/assets/` are
browser-test fixtures for the same comparison. The captures illustrate evidence presentation; they are not screenshots of implemented
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
- **Entry points:** compact progress (`54-compact-progress-entry-points`) reaches the same result/criteria view and
  restore the origin's filters, selected task, column and position on return.
  Inbox still opens the exact actionable request; Open task reaches review tools
  without converting new results into attention.

## Assignment context, delivery and search

These are fictional design fixtures, not provider observations. They reuse the
sidebar, buttons, input, result criteria and feedback journeys.

| Surface | Artboard |
| --- | --- |
| Desktop captured assignment and current requirements | `67-assignment-context` |
| Phone captured assignment and references | `68-phone-assignment-context` |
| Desktop recorded changes, evidence and delivery | `69-changes-delivery` |
| Phone changes and delivery | `70-phone-changes-delivery` |
| Desktop PR, repair, head and delivery alternatives | `71-delivery-alternatives` |
| Phone delivery alternatives | `72-phone-delivery-alternatives` |
| Desktop search with attributed excerpts | `73-search` |
| Phone search and restored selected match | `74-phone-search` |
| Desktop search coverage, recovery and historical result | `75-search-states` |
| Phone search recovery and historical result | `76-phone-search-states` |

### Connected journey and hierarchy

Desktop: `73-search` → matching result in `57-task-revised-result` → assignment context `67-assignment-context`
→ changes/delivery `69-changes-delivery` → selected match in `73-search`.
Phone: `74-phone-search` → matching result in `65-phone-revised-result` → context `68-phone-assignment-context`
→ delivery `70-phone-changes-delivery` → selected match in `74-phone-search`.
The canvas does not wire these as prototype links; the sequence is the contract,
not a prescribed application route.

The desktop result leads with “Focus correction reported; toolbar needs another
look”. Work revision and evidence gaps remain immediately visible. Assignment,
result, instruction/profile, source-snapshot, commit and validation identities sit
beneath the outcome or in the context/provenance disclosure. The parallel-assignment
rows remain in the document behind disclosure; the initial result view uses a
compact summary. Attribution remains available without competing with the outcome.
`65-phone-revised-result` retains phone criterion summaries and links into assignment context and
delivery.

The C1/C2 summary, comparison `58-compare-evidence` / `62-phone-before-after`, contextual feedback `59-inspect-criterion-feedback`,
send-failure recovery `60-phone-feedback-failed`, confirmation `61-phone-message-sent`, and since-viewed `64-changes-since-viewed` /
`66-phone-changes-since-viewed` remain. Contextual feedback keeps its exact result/material reference when
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

- **Discoverable entry:** on desktop the sidebar's Search work field above Overview,
  Inbox and Tasks is the one entry and shows the active treatment on Search; the
  navigation drawer keeps a Search row. Phone Inbox exposes a labelled 44px Search
  action in its reusable header; the phone Board uses the same labelled action.
  The phone search header identifies the current Search view and offers Workspace
  return only from a task or Inbox item. No keyboard shortcut is required to discover it.
- **Connected journey:** desktop `01-attention-overview` → Search `73-search` → selected AT-142
  result `57-task-revised-result` → Back to `73-search`; phone `09-phone-inbox-queue` or `25-phone-board-waiting` → `74-phone-search` →
  `65-phone-revised-result` → Back to `74-phone-search`. Opening selects the exact matching requirement,
  decision or result section. Returning restores `focus`, All projects, All types,
  Any date, history included, match 2 of 4 and its reading position. Return to
  Workspace is offered only when Search was opened from a task or an Inbox item and
  returns to that exact item, including after filter changes and an opened match. From
  Overview, a list, the board, a project, the Inbox list or a direct visit there is no
  such control; the browser's Back or the navigation returns.
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
- **States belong to flows:** search filters edit the current query scope. They sit in
  the results header beside the count once there is a query, and apply on change
  (From and Through with Enter or any other control); Refresh
  provider status retries the read in the current delivery view. Existing checks,
  findings, comparison and recovery controls remain. `75-search-states`, `76-phone-search-states`, `71-delivery-alternatives`
  and `72-phone-delivery-alternatives` are canvas review specimens with no product navigation into them.
  Their loading, no-match, failure with retained earlier matches, partial-coverage,
  historical-result, unavailable-destination and changed-head snapshots replace
  content within the owning flow. Retry retains previous observations with their
  age, selected material, drafts and all holds.

| Updated entry reference | Artboard |
| --- | --- |
| Desktop shared navigation | `ds-domain-components` |
| Desktop Overview → Search | `01-attention-overview` |
| Phone Inbox → Search | `09-phone-inbox-queue` |
| Phone Board → Search | `25-phone-board-waiting` |

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

### Visual source and artboards

The artboards are on the canvas page **06 Workspace inspection**; screen 80 is the
core Changes view `06-workspace-changes-review`. Desktop artboards are 1366 wide;
phone artboards are 390 × 844. Read the desktop rows left to right, then the phone
rows below. The state specimens are review aids, not destinations in the product.

The work reuses the shared sidebar, top bar and buttons, the phone detail header,
the local-feedback context (`56-review-components`) and the existing task/result
compositions. Inspection editors use edge-to-edge
panes and compact toolbars; other desktop content retains 20px padding. Phone
reading content uses 16–20px padding and phone action targets are at least
44 × 44px.

| Composition / render reference | Artboard |
| --- | --- |
| 77 · Shared inspection components and section introduction | `77-workspace-inspection-specimen` |
| 78 · Current Files, code preview and single-line selection | `78-files-current-observation` |
| 79 · Repository-free generated Markdown output | `79-files-generated-markdown` |
| 80 · Branch diff, both sides and deleted-range comment composer | `06-workspace-changes-review` |
| 81 · Repository/base selection, comparison menu and Uncommitted | `81-changes-comparison-alternatives` |
| 82 · Original retained R3 file after workspace removal | `82-result-r3-retained-files` |
| 83 · Complete editable two-file review and summary | `83-review-complete-draft` |
| 84 · Actual latest-turn identity and complete/partial/unavailable alternatives | `84-last-turn-capture-states` |
| 85 · Raster and PDF output preview alternatives | `85-generated-output-previews` |
| 86 · Inspection, capture, ignored-reveal and workspace states | `86-inspection-capture-states` |
| 87 · Current/outdated/unknown/unavailable anchors and Refresh | `87-review-anchor-states` |
| 88 · Phone file list and current observation | `88-phone-task-files-list` |
| 89 · Phone Before-side deleted-line range selection | `89-phone-deleted-side-range-selection` |
| 90 · Phone add/edit/remove anchored comment | `90-phone-edit-anchored-draft-comment` |
| 91 · Phone complete review, first reading position | `91-phone-complete-review-first-scroll` |
| 92 · Same complete review, second comment and summary position | `92-phone-complete-review-summary-scroll` |
| 93 · Phone repository-free Markdown output | `93-phone-generated-markdown-preview` |
| 94 · Phone sending / original payload locked | `94-phone-review-sending` |
| 95 · Phone confirmed failure / editable draft / retry | `95-phone-review-confirmed-failure` |
| 96 · Phone unknown outcome / check whether it was sent | `96-phone-review-unknown-outcome` |
| 97 · Phone sent and sent-review access | `97-phone-review-sent` |
| 98 · Phone retained result bytes after workspace removal | `98-phone-retained-result-bytes` |
| 99 · Phone PDF page and zoom controls | `99-phone-generated-pdf-preview` |
| 100 · Phone raster fit/zoom/pan | `100-phone-generated-raster-preview` |
| 101 · Phone comparison/base selection and staged/unstaged filters | `101-phone-local-base-selection` |
| 102 · Phone unsettled turn, deletion and read recovery | `102-phone-unsettled-turn-missing-file` |
| 103 · Phone authentication expiry and private-state purge | `103-phone-auth-expired-private-state-cleared` |
| 104 · Desktop sent review with original comments and summary | `104-review-sent-original-comments` |
| 105 · Retained original R3 diff after later workspace changes | `105-result-r3-retained-diff` |
| 106 · Keyboard range selection, editing and focus return | `106-keyboard-review-journey` |

Existing desktop task `57-task-revised-result`, phone task `65-phone-revised-result`, and result/delivery view
`69-changes-delivery` are extended in place; their contextual feedback, criteria, approval,
assignments, execution and source-owned dependency controls remain. Desktop task
entry points are the Files, Changes and Review tabs and the retained R3 link; the
phone task and the result/delivery view have matching entry rows.

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
the sent line keeps LR-42 and the time in Details. Sending/failure/unknown/sent
frames are alternative outcomes of that operation, not simultaneous states.

Repository-free **Fieldnotes / FN-58**, Research brief, also has Mira as lead,
with root `/tasks/FN-58/outputs`, no Git repository and no holds. Its Markdown
journey is separate from AT-142's draft; drafts never cross tasks. The fictional
command-menu PNG is reused as an image preview. PDF pages are drawn content
fixtures, not an implemented PDF renderer or passing keyboard evidence. Displayed
file sizes/page counts illustrate metadata, not configured limits.

### Connected journey and entry/return map

1. Task → Files opens `78-files-current-observation` / phone `88-phone-task-files-list` at a current observation. Generated
   output has the same prominence and controls as code. FN-58 opens `79-files-generated-markdown` /
   `93-phone-generated-markdown-preview`; raster/PDF open `85-generated-output-previews`, `100-phone-generated-raster-preview` or `99-phone-generated-pdf-preview`.
2. Changes opens the same task's selected repository and comparison. Branch
   uses `06-workspace-changes-review`; dropdown/base states use `81-changes-comparison-alternatives` / `101-phone-local-base-selection`; actual-turn views
   use `84-last-turn-capture-states` / `102-phone-unsettled-turn-missing-file`. Selecting a repository restores its own comparison
   and baseline, not another repository's main branch.
3. Select one text line or a range, including either diff side and deleted
   lines. Add/Edit opens the anchored composer (`06-workspace-changes-review` / `90-phone-edit-anchored-draft-comment`) using the
   originating selection, as specified under parameterised composer entry. Save
   adds to the task's local draft and returns to that selection. It does not send.
4. Move to another file and add another comment. Review opens the **complete**
   draft (`83-review-complete-draft`; phone `91-phone-complete-review-first-scroll` → scroll → `92-phone-complete-review-summary-scroll`). Every comment, original
   excerpt, comparison and status can be inspected. Edit/remove and optional
   summary stay here. The destination is visibly Mira before Send review.
5. Send freezes that exact logical submission. `94-phone-review-sending` → confirmed failure
   `95-phone-review-confirmed-failure`, unknown `96-phone-review-unknown-outcome`, or confirmed `97-phone-review-sent`. Inspect sent review opens
   the read-only equivalent of `104-review-sent-original-comments`; original context remains accessible.
6. From R3 evidence or result delivery, open `82-result-r3-retained-files` / `98-phone-retained-result-bytes` (original file)
   or `105-result-r3-retained-diff` (original diff), retaining R3/A-105/b72e910. Opening current
   contents is a separate explicit navigation; a missing historical capture
   never redirects there. Returning restores the exact result/evidence anchor.

| Origin | Inspection entry and return contract |
| --- | --- |
| Overview `01-attention-overview` | Open shared task `57-task-revised-result`, then current Files/Changes; return to the same task row, filters and position. |
| Project/cross-project List `24-all-projects-list` and Board `04-tasks-board` / `23-atlas-project-board`; phone `25-phone-board-waiting` | Same task entry; return restores project/task filters, selected task, view, board column and scroll. |
| Inbox `06-inbox-question-audience` / phone `09-phone-inbox-queue` | Retain originating request AP-17, queue filters, selected item and position. Task → inspection does not answer the request. Back returns to that request, not a generic task list. |
| Result, criterion and evidence | Preserve selected result, assignment/work revision, criterion/source reference and evidence identity, including older results. Existing single-message Ask lead for changes remains distinct from batched review. |
| Search `73-search` / `74-phone-search` | Retain query, scope, filters, match and exact historical section through task → inspection → return. |
| Assignment context `67-assignment-context` / `68-phone-assignment-context`, delivery `69-changes-delivery` / `70-phone-changes-delivery` | Carry the selected assignment/result into retained evidence; return to the same expanded disclosure and reading position. Current inspection is explicitly labelled. |
| Direct task/file/comparison/result/review links | Resolve authorised task and exact requested context. Direct historical links stay historical. If missing or forbidden, explain the unavailable destination; never substitute current bytes. Without an in-session origin, offer the task/project as fallback. Exact URL syntax is an implementation choice. |
| Retained advanced execution, approval and recovery routes | Reachable through task controls / Holds on phone. Keep the original task/request/result return anchor. Inspection never resolves ownership or execution uncertainty. |
| Context menus and extensions | No applicable entry points are established by the current design. Native Codex/ChatGPT work is outside this design. |
| Browser notifications (opt-in, Settings → Notifications `181`–`185`) | A click opens or focuses Ensemble at the exact Inbox selection (`/app/inbox?task=<task>&request=<request>` for a task item, `/app/inbox?request=runtime%3Acodex` for a runtime) after sign-in, and keeps that address through sign-in. It answers, approves and mutates nothing. A resolved request shows its existing state, as a resolved question does. |

### Desktop, phone and keyboard behaviour

#### Parameterised composer entry

Composer references in canvas actions are layout templates, not navigation to
the fixture's prefilled anchor. In particular, screen 78's Add comment reference
to `90-phone-edit-anchored-draft-comment` must instantiate a **current-file** composer for the selected current
line 42; it must not copy that specimen's Branch / Before / deleted lines 41–43.
The same parameterised contract applies on desktop and phone, in code and
Markdown Source, and when editing an existing draft comment.

| Origin | Composer context that must remain unchanged |
| --- | --- |
| Files screen 78 (`78-files-current-observation`), current line 42 | AT-142 / `acme/atlas` / `src/components/CommandMenu.tsx`; Current workspace, observation 12:06, exact observed content identity and excerpt, line 42 only; no diff side or Branch comparison. |
| Changes screen 80 (`06-workspace-changes-review`) or phone 89 (`89-phone-deleted-side-range-selection`), deleted range | Same task/repository/path; Branch comparison and exact merge base; Before side, deleted lines 41–43, original compared content identity and excerpt. This is the fixture drawn in `90-phone-edit-anchored-draft-comment`. |
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
anchor. `89-phone-deleted-side-range-selection` shows deleted Before lines 41–43 with visible focus/selection.
Use the same selection controls in source text/Markdown. Rendered Markdown
offers Source lines; images and PDFs keep ordinary exact-context feedback rather
than inventing image coordinates or PDF text-line anchors.

`91-phone-complete-review-first-scroll` and `92-phone-complete-review-summary-scroll` are two scroll positions of **one complete-review page**, not
a pagination gate or separate batches. Every comment is reachable before Send;
no arbitrary checkbox or forced reading confirmation is introduced. Content and
action areas scroll above keyboard/safe-area insets. A pinned action bar, if used,
must reserve content space. Root `clip:true` defines the viewport; the fixtures
show bounded excerpts and separate reading positions, not an unscrollable app.

#### Keyboard

Keyboard path (drawn in `106-keyboard-review-journey`): Tab into the named file tree, arrows move the
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

Three contexts remain unmistakable: **Current workspace** (the Files tab, whose file header ends with the time the bytes were read), 
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
- Show ignored files (an explorer-footer checkbox) is reversible and initially off. Sensitive
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
`acceptSession`, and `web/src/task-workspace-state.ts`, `purge`). `103-phone-auth-expired-private-state-cleared`
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

| Composition | Artboards |
| --- | --- |
| Files: explorer, source and single-line selection | `78-files-current-observation` |
| Generated Markdown with an output explorer and rendered/source modes | `79-files-generated-markdown` |
| Branch: changed-file rail, split diff and inline deleted-range draft | `06-workspace-changes-review` |
| Repository, comparison and local-base menus; Uncommitted alternatives | `81-changes-comparison-alternatives` |
| Original R3 file and diff in the same editor language | `82-result-r3-retained-files`, `105-result-r3-retained-diff` |
| Phone explorer and unified deleted-range selection | `88-phone-task-files-list`, `89-phone-deleted-side-range-selection` |
| Phone generated Markdown and retained original source | `93-phone-generated-markdown-preview`, `98-phone-retained-result-bytes` |
| Shared editor row: number, marker and source | `107-editor-inspection-specimen` |

Desktop uses a 238px file rail beside the 224px application sidebar. The top task
controls, Files/Changes navigation and observation strip together occupy 132px.
File tabs, breadcrumbs and metadata sit immediately above the reading area. The
explorer uses 32px rows with folder indentation and file-type icons. Changed-file
rows pair the filename with its parent path and explicit M/U/D/R/B status; colour
is supplemental. Generated outputs have the same visual priority and reading space
as source files.

A selected line has a blue selection fill; diff additions/deletions use restrained
green/red fills plus explicit +/− markers and Before/After labels.

`06-workspace-changes-review` places the draft composer below the selected hunk, with its exact
Before 41–43 deleted-range anchor visible. Save comment adds to the local draft;
it does not send. Review opens the complete-review screen `83-review-complete-draft`. Cancel restores
focus to the originating range without changing other comments. Split/Unified
changes presentation only, and hunk arrows move within the same comparison.
Baseline selection uses only local branches and retains the per-repository
baseline. `81-changes-comparison-alternatives` deliberately draws mutually exclusive menus and states together
as labelled specimens, not as one product screen state.

On phone, the explorer is a full-width destination with 44px file rows. Opening a
change leads to `89-phone-deleted-side-range-selection`'s unified diff, with distinct old/new gutter columns.
Deleted rows remain selectable. Start/End controls choose the range without
requiring a precise drag; Clear removes only the selection. Add comment uses the
`90-phone-edit-anchored-draft-comment` template with that origin's exact anchor, then the complete-review
journey is `91-phone-complete-review-first-scroll` → `92-phone-complete-review-summary-scroll`. Both phone range controls and comment actions are
44px high. Files, Markdown and retained evidence use the same compact navigation,
without squeezing a desktop rail onto the phone. `89-phone-deleted-side-range-selection` and `98-phone-retained-result-bytes` use compact
24px editor rows (13 mobile editor rows at 24px); the desktop row component and
instances are unchanged.

Keyboard traversal is task controls → Files/Changes → observation/Refresh →
explorer → open tabs → preview controls → source selection → comment action.
Arrow keys navigate the tree; Right/Left expand/collapse; Enter opens a file and
preserves explorer focus context. Tab enters the line-selection surface. Up/Down
moves a single-line anchor and Shift+Up/Down extends it on the selected diff
side. Enter on Add comment focuses the composer. Tab reaches Cancel/Save;
Escape cancels the composer and restores the original line/range. Saving returns
focus to its comment marker. `106-keyboard-review-journey` continues to specify comment editing and
return from the complete review.

Long filenames elide in the narrow rail; hover/focus discloses the exact path,
and the selected file's breadcrumb/provenance exposes it without ambiguity.
Screen 78 (`78-files-current-observation`) is drawn with the explorer labels `CommandMenu.tsx` and
`CommandMenu.test…` wrapped onto two lines; the implementation uses single-line
elision with exact-path disclosure as specified here. The implemented explorer opens at a
repository root and is one level deep rather than the drawn tree (Right and Left enter and
leave a folder); it marks changed files A, M, D, R or T from the Branch comparison the Changes
tab has already read, gives folders that hold changes a muted dot and lists deleted files as
inert D rows, keeps one toolbar Refresh, puts Show ignored files in the explorer footer as a
checkbox beside "Sensitive exclusions still apply.", and moves the file's hash and read times
under a collapsed Provenance & limits disclosure. Tabs open bounded read-only
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

The canvas page **07 Tasks, composer & tablet** holds eight static compositions
(800A–800H). They use the shared design system, Geist Mono where identifiers
appear, and a 12px minimum supporting-text size. They
add no reusable components, theme, entry point or product behaviour. [#800](https://github.com/chrisbanes/ensemble/issues/800)
owns this design; its
[implementation plan](https://github.com/chrisbanes/ensemble/issues/800#issuecomment-6047644893)
is the exact scope. Existing product contracts and #793 source, return and task
anchors are unchanged.

| Composition | Artboard | Size | Review purpose |
| --- | --- | --- | --- |
| Tablet Overview / List | `800a-tablet-overview-list` | 1024 × 768 | Existing drawer, attention summary, compact task rows, and List/Board switch. |
| Compact tablet Inbox / question | `800b-tablet-inbox-question` | 800 × 768 | Fieldnotes Q-204/r2 is one three-question form with one disabled Submit answers action while Q2 exceeds its limit; the task remains Paused. |
| Tablet task detail / evidence | `800c-tablet-task-evidence` | 1024 × 768 | Task situation and next actor stay distinct from the evidence rail. |
| Tablet Search / selected result | `800d-tablet-search-result` | 1024 × 768 | Canonical Atlas AT-142 identity, source, next actor and return anchor; AT-155 is the separate running cold-start task and A-108 its recorded Eli repair assignment. |
| Tablet composer / validation disclosure | `800e-tablet-composer-validation` | 1024 × 768 | Optional summaries, expanded dependency error, focus treatment, and both actions. |
| Tablet all-projects Board | `800f-tablet-all-projects-board` | 1024 × 768 | Ready 0, Running 2, Waiting 3 and Paused 1; Stopping and Uncertain remain reachable. Held Ready work remains Ready and is grouped in Waiting. |
| Phone question / short viewport | `800g-phone-grouped-question-short` | 390 × 480 | Q-204/r2 Q2–Q3 scroll position, retained Q1 selection, over-limit Q2 error, Q3 draft, and one disabled Submit answers action. |
| Phone composer / short viewport | `800h-phone-composer-short` | 390 × 480 | Long fields and optional summaries; unavailable dependency shows its error before submit while Save draft and Create and start stay enabled. |

The desktop baseline is `01-attention-overview` (Overview), `24-all-projects-list` (List), `04-tasks-board` / `23-atlas-project-board`
(Board), `06-inbox-question-audience` (Inbox), `03-task-detail` (task detail), `73-search` (Search), and `05-composer` /
`02-composer-optional-expanded` (collapsed/full composer). Phone references are `10-phone-question` / `21-phone-grouped-questions` /
`21b-phone-grouped-questions-scrolled` (question), `34-phone-composer-collapsed` (composer), and `35-phone-optional-settings-error` / `35b-phone-collapsed-validation` (expanded/collapsed
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
  holds. The Q2 limit error uses the destructive colour in `800g-phone-grouped-question-short` and `800b-tablet-inbox-question`.
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
  focuses the error and sends no command. The phone composer `800h-phone-composer-short` shows the
  same four Context / References / Assignee / Dependencies rows as `800e-tablet-composer-validation` and the
  production composer, scrolled to its end so the unavailable dependency and its
  error sit above the enabled actions. The supplied-values panel keeps its
  unfinished-input notice concise and omits creation-receipt/admission explanation
  before submission.
- Screen titles are 18/600, task titles 20/600 and section headings 15/600. The tablet
  Overview header has no extra product label.

Implementation notes: measure navigation and textarea behaviour, verify scroll
ownership and caret retention, and validate focus before submission.

The entry and recovery inventory is limited to existing references: desktop
`Sidebar`; phone headers (`ds-domain-components`); authentication expiry and private-state
purge `103-phone-auth-expired-private-state-cleared`; interrupted-read recovery `102-phone-unsettled-turn-missing-file`; retained original file
`82-result-r3-retained-files` / `98-phone-retained-result-bytes` and diff `105-result-r3-retained-diff`; Markdown `79-files-generated-markdown` / `93-phone-generated-markdown-preview`; and raster/PDF
specimens `85-generated-output-previews`, `100-phone-generated-raster-preview` and `99-phone-generated-pdf-preview`. The design has no dedicated
account-settings, guided-login, or retained-HTML viewer composition in this
section. Their route and recovery obligations remain in the specification; this
canvas does not show a browser renderer for retained HTML.

The short phone question frame intentionally clips the long answer body inside the
390 × 480 scroll viewport; the Q2–Q3 view ends at the pinned action area.
The scroll owner is the named body or queue region, not the page. Board columns may
scroll horizontally. A client still needs to apply real bottom safe-area insets,
and must preserve the selected answer, draft, text selection and caret while these
regions scroll or resize.

## Interaction notes

Presentation and interaction rules that the canvas does not show on its own.

### Presentation

- No placeholders or raw tokens as content. Missing optional metadata (a time, an
  age, a requester, an empty evidence line) is omitted, never printed as "Age
  unknown" or "Responsibility unknown". Material a read could not supply, withheld
  or unavailable evidence and unknown execution or ownership state stay explicit,
  as a sentence that says so rather than "unavailable" as a value. A reason or state
  code reads as a sentence in the web UI, with the code in Details. Where an unknown
  is the message itself (ownership uncertain), the headline states it once.
- A label written to start a sentence ("GitHub dependencies unconfirmed") keeps its
  proper nouns (GitHub, Claude, Ensemble) when it is composed mid-sentence
  ("Ready · GitHub dependencies unconfirmed"); every other label lowercases its first
  letter ("Ready · project paused"). One helper, `midSentence`, does this
  (`12b-imported-task-comment-unavailable` shows the examples).
- Identifiers are short mono metadata (R1, A-9bd4, an 8-character SHA), never part
  of a sentence. The full value is on hover, copy or in Details.
- One refresh per page. Read views keep the page-level Refresh, which only
  re-reads; create forms and sub-panels have none. Asking a provider for a new
  observation is not a re-read: an imported task keeps its source refresh (Refresh
  source) as a separate action beside the source.
- Times use the app's clock label ("synced 17:50", "Updated 16:48"). A range
  appears only when two reads differ.

### Composer

- Submitting with an error in a collapsed optional group opens that group and
  focuses its first invalid control (`05-composer`, `35b-phone-collapsed-validation`).
- While a save or create is pending, and after it fails, the entered input stays
  in place. No success state appears before the service confirms it.

### Task detail and updates

- No raw output is needed to understand the task. Assignments and captured
  conversations open through disclosure (`03-task-detail`).
- The Overview tab reads in this order: pending decisions, holds and wait reasons;
  the latest result with its criterion evidence; the reply to the lead; then the
  shared brief, evidence and assignments as collapsed disclosures with a one-line
  summary (`46a-task-overview-laptop`; `03-task-detail` shows them open). Captured
  conversations, earlier results and delivery evidence live in History, Changes and
  Review, and the Overview tab does not repeat those tabs as sections.
- A link to a section or record inside a closed disclosure opens it; polls,
  refreshes and a returning Back never open or close one.
- The task header keeps Execution and Stop… only. On a phone (`47-phone-task-overview`)
  the detail header has Back, the task title, a mono subtitle (the source, such as
  `acme/atlas#142`, or Local task) and one outline "Task actions" disclosure holding
  Execution and Stop… (open in `47b-phone-task-actions-open`); the decision card sits
  in the first viewport, and the reply follows the latest result.
- A task's legacy page (`/coordination/task/:id`) is linked once, as Approval and
  delivery forms, from its History tab; that page links `/task/:id` (Edit task and
  review source). The project page keeps Project settings and links to no legacy
  page.
- The reading anchor is the top visible message and its pixel offset. Updates keep
  that anchor, open groups, expanded message previews and the unfinished reply.
- Auto-follow is on only while the reader is at the bottom. Scrolling away turns it
  off, and Jump to latest turns it back on.
- Requests and failures pinned above history each link to their assignment.
- History controls (`05-task-history-grouped`): Show earlier reveals the rest of
  that group's messages, and Expand all opens every group. The chronological view
  keeps each message's assignment label.
- Artifact links open a preview. Back restores the reading position.
- Execution state lines say what is still possible and give one route to inspect
  it:
  - Stopping: running work may still finish or have side effects, and the line
    says it is waiting for runner confirmation (View execution).
  - Stopped: the runner confirmed nothing is active, and queued replies remain
    saved (View final activity).
  - Execution uncertain: the process may still be active, so check its state
    before attempting new work (Inspect execution).
  - Project paused: the project holds new turns, messages queue for the lead, and
    sending does not resume work. Resume project, in project configuration, the
    project page's paused banner (`23b-atlas-project-paused`) or the wait's Fix,
    releases it. The banner's Resume project confirms as in 149b and shows the
    shared save outcomes (recorded, failed, or unknown with Check again); Pause
    project stays in project configuration.

### Approval review

- The review panel (`02-inbox-approval`, `33-phone-exact-approval-source-hold`) has
  labelled sections for Exact action, Target and Material to approve. Each material
  item shows its version, and the panel offers Open full description and Inspect
  patch. A line states that the decision applies only to these material versions,
  and that a change cancels it and needs a new review.
- Accepted states that the action is allowed but has not started yet.
- Denied states that nothing was approved, and offers to add feedback for the
  requester or close the review.
- Stale names the version change, says the earlier acceptance no longer applies,
  and asks the operator to inspect the new material before deciding.

### Inbox and filters

- The filters are Projects and Request type. Each has an All option, and every
  option shows a count. Filters combine.
- A runtime item (an exhausted execution runtime) shows under All projects only: it
  counts in the total and under the "Runtime" request type, never under a project,
  and any project filter hides it.
- The sidebar Inbox count is always the total of unresolved items. The queue
  heading shows the filtered count. Count changes never move the visible row.
- Only the queue and the reading pane scroll. Native scrollbars appear only when
  content overflows.
- Open task carries a return-to-Inbox route. The route saves the project and type
  filters, sort order, selected request, the top visible request with its pixel
  offset, the detail pane's scroll offset and the draft. Back restores that exact
  state, even after new requests have arrived.
- After a confirmed reply or decision, the item leaves the queue and the
  unresolved count drops. The nearest surviving visible row keeps its pixel
  offset, and the queue does not jump to the top.
- When new items arrive while the reader is away from the top, a "N new items"
  control appears. Applying it restores priority order and keeps the selected
  request and the unfinished reply.
- A filtered empty queue reads "No matching requests". It shows each active filter
  as a removable chip, gives the unresolved total across all projects, and offers
  Clear filters. The unfiltered empty state reads "Nothing needs you."
  (`08-inbox-empty`).
- On phone, Back to Inbox restores the queue anchor, the filters and focus on the
  selected row (`31-phone-inbox-anchored-return`). The body scrolls under the fixed
  header.

### Structured questions

- Tab reaches each question in turn, then the submit control. Space selects a
  checkbox as well as a radio option.
- Focus and selection look different. Focus is a 2px primary outline, and
  selection is a filled radio dot or a checked box. Each is visible without the
  other.
- A selection-limit error names the limit, for example "Select no more than 2
  sections.", and sits beside its question.
- Returning from evidence puts focus back on the control that opened it
  (`27-phone-question-evidence`).

### Board

- Switching between List and Board keeps the selected task. Each view restores its
  own scroll position.
- Enter on a focused card opens the task detail. Returning restores the filters,
  the column and the scroll position.
- The Board keeps the attention summary and the Inbox link. Stopping and Uncertain
  remain named columns with counts (tabs below 1121px).
- Empty columns collapse to a narrow strip. Below the shell breakpoint (1120px and
  narrower) the column link bar is the reach path and keyboard route to a column and
  keeps every column and its count, including empty ones. From 1121px it is not
  rendered: the column headings carry each state and count, and Tab reaches every
  card, scrolling only the board (`04-tasks-board` draws no bar).

### Settings and sign-in

- Phone settings stay usable forms. Project settings lead with Current state and
  Next step cards, and recovery with Current holds and Next step
  (`121-phone-atlas-configuration`, `128-phone-assignment-recovery`).
- Readiness Project-field conditions choose the GitHub Project, field and option by
  name from discovery, falling back to typed node IDs when discovery is unavailable.
- Settings section links (`114-settings-index`) are real `/app/settings#section` links:
  each jump adds one history entry, scrolls to the section and focuses its heading. Back
  and Forward to an entry with a saved position restore it instead; a reload keeps the
  fragment. An unknown fragment does nothing: Back or Forward into one restores the top
  like any other entry, and only a fragment the page has a target for skips that
  restore. The current section follows the fragment (the first section when none; a
  check anchor marks Readiness). Readiness checks have their own anchors
  (`#readiness-claude-executable`) and the Runtime page has
  `/app/settings/runtime#add-claude`; Home checklist Settings actions use them. A
  purpose-specific link into Settings (a task's readiness or Add Claude Fix, a Claude
  token failure route, a setup or checklist action, a form's Cancel) opens its section
  or anchor and never bare Settings; only the generic Settings entries (sidebar, account
  menu, breadcrumbs) stay bare.
- On settings pages no primary navigation item is selected. Project configuration
  selects its own project in the sidebar.
- The account menu (`113-account-menu`) lists Settings (`/app/settings`), Getting
  started (Show getting started once the card is dismissed, which restores it),
  Approval and delivery forms and Sign out. Runtime is reached from Settings.
  Approval and delivery forms opens the legacy coordination index (`/coordination`)
  as a document load, for approval decisions, delivery settlement, result
  destinations and assignment messages that the app does not offer.
- Project names are unique ignoring case. Project setup and project configuration
  refuse a matching name as a field error on the 116 pattern: "Another project is
  named Atlas. Choose a different name." (`116b-project-setup-duplicate-name`).
  Saving a project under its own current name is allowed. Where projects created
  before this rule share a name, the sidebar, project lists (Overview Projects,
  Settings → Projects, Runtime), filters and selects add the lead's
  name ("Atlas · Mira"), or the project ID's first eight characters in mono when
  the leads match or a project has no lead, widened only when two IDs start alike;
  no two projects show the same label, and a unique name stays plain unless it
  equals another project's full-ID label; IDs that differ only in letter case are
  numbered "#1", "#2" after the full ID (`116c-project-name-suffix-specimen`).
- GitHub sources are named by what they read (acme/atlas issues, a search, the
  Atlas roadmap GitHub Project), with the S-n id in Details. A GitHub Project has
  no stored title, so its name is the title discovery lists for it and otherwise
  "GitHub Project"; its filter is never part of a name. The GitHub source tab
  numbers its sections 1–3 in reading order (`119-project-config-github-source`).
  After a save, the same screen offers Preview and import now, which runs the
  preview-and-activate command for each saved inactive source and then one
  refresh. It shows the activation receipts, then the refresh's observation state
  (complete, partial, never or unavailable). The refresh creates no receipt, and a
  partial or unavailable read says so and claims no import
  (`119d-github-source-import-ready`, `119e-github-source-imported`). Sync &
  placement remains for later refreshes and placement.
- Source status lines are sentences with the clock label: "Synced 10:47 · 4 issues
  observed, 2 match the readiness rule" or "Not synced yet" (`120-project-config-sync-placement`). A
  panel's caveat is one line under its primary action, not in its intro.
- In Settings → Projects (`114-settings-index`), each project shows its lead, state,
  repository access and discovery sources. Access and sources are labelled
  separately so that discovery never reads as access. Routing has its own
  per-project summary.
- Project configuration has General, Routing, GitHub source, and Sync & placement
  tabs. Each section saves separately against its own version.
- Settings edit values in place. Instructions and routing guidance open as "Kept ·
  Reveal" in the project General, profile and Routing forms
  (`118-project-config-general`, `123-profile-revoked`,
  `124-routing-relay-unsaved`). Reveal loads the exact text into the same multiline
  field for the signed-in operator only, and Reveal itself is not recorded
  (`118b-project-instructions-revealed`, `123b-profile-instructions-revealed`). An
  edit shows one value-free line under "Changes to save" ("Instructions edited",
  "Instructions cleared", "Routing guidance edited", "Routing guidance cleared") and
  saves as an ordinary versioned change. Leaving the page, signing out or a newer
  saved version returns an unedited reveal to "Kept · Reveal"; an edit stays like any
  other unsaved input. On the GitHub source tab, local paths and saved search queries
  show plainly and edit in place ("Search query edited for S-2", "Local path changed
  for acme/atlas"); GitHub Project filters stay "Filter kept · private".
- After routing saves, the form reloads the saved version. Guidance returns to
  "Kept · Reveal", and Save stays disabled until something changes
  (`125-routing-relay-saved`).
- Sign-in has two bootstrap states: "Loading sign-in…" and "Sign-in service
  unavailable." with Try again.
- While a sign-in request is pending, the password field and the button stay
  disabled (`111-phone-signin-pending`). A failure clears the password, returns
  focus to the field and shows no account or lockout detail (`109-signin-failed`,
  `112-phone-signin-failed`).
- Sign out shows "Signing out…" while it is pending, then clears private local
  state.

### Recovery

- Every Inspect execution or Recovery details control opens the same assignment
  recovery destination (`127-assignment-recovery-relay`). These controls are in
  `01-attention-overview`, `49-state-comparisons`,
  `53-phone-failed-refresh-uncertain`, `25b-phone-board-uncertain`, a task wait that
  names its assignment, and Runtime → Task recovery destinations
  (`126-runtime-capacity-recovery`), which stays. A task's Stop, task and writer
  hold lines are task-wide, so they link to the task's Execution view instead
  (`149c-wait-reasons-specimen`).

### First run

- Before any project exists, the getting-started First task row reads "Needs a
  project first." Its Create task action is unavailable (aria-disabled, focusable,
  reason announced) until a project exists.
- The header New task button stays next to the getting-started card.
- Before a project is created, the sidebar Projects group shows only New project.
- The Fix confirmation (`149b-task-fix-resume-confirm`) states that holds and
  access are unchanged. When stop, task or writer holds remain, it names them
  ("The Operator Stop and writer ownership stay."); the task lists them under the
  Fix with an Execution details link (`149c-wait-reasons-specimen`).

### Action feedback

- When saving changes, a changed-elsewhere warning keeps the edited values and
  offers Review changes (`157-project-configuration-changed-elsewhere`).
- When a form closes on save, its row shows an inline "Saved." that fades after a
  few seconds (`160-discovery-credential-saved`).
- After a saved outcome, the aside heading does not repeat the save time
  (`155-routing-saved`).
- After a failed answer, the submit button reads Retry answer, and no second
  action appears (`162b-grouped-questions-send-failed`).
- Unknown outcomes say "not confirmed" or "We couldn't confirm…". Unsettled
  execution or delivery reads "until we know it ended" or "until we know it
  posted", never "reconcile".
- The ban on IDs applies only to action-outcome messages. Task, assignment and
  check IDs in ordinary task content stay.

### Accessibility and keyboard

- Iconography uses muted 14–16px glyphs beside agent initials and names, and
  12–14px status symbols beside visible state labels.
- Running uses an activity symbol, never a success or repair symbol. Questions,
  approvals, pause, waiting and completed results each have a distinct symbol.

## Implementation status

The production web UI implements the reviewed behaviour on its own shadcn-based
foundation (`web/src/tokens.css` and `web/src/ui/`). Where the production UI
intentionally differs from the canvas in behaviour, the differences are below.
The web app is the ground truth for these items.

### Visual direction

- **Implemented:** the canvas tokens are defined in `web/src/tokens.css` and the
  shadcn names map onto them (surfaces, hairlines, indigo primary, focus, radii,
  13px controls and body). State badges use the soft fill, border and text of their
  state colour; every state badge pairs a symbol with its word (idle states use
  `Circle`, `CirclePause`, `CircleCheck`, `CircleSlash`, `CircleDashed` or
  `CircleQuestionMark`), while count and label badges carry none. Task state marks
  show their icon and word in the state colour (Running indigo, Uncertain rose, Done
  emerald, the rest slate). Buttons use the primary, secondary and destructive treatments.
- **Implemented shell:** the 232px sidebar with the mark, installation name, Search
  work field (⌘K or Ctrl+K focuses it; submitting opens Search with the query),
  navigation, projects with their active-task count, a running-turns capacity meter
  and the account menu; and the 48px desktop top bar with the breadcrumb, connection
  status (Connected, Updates delayed or Disconnected from the shell's workspace
  read; nothing before the first read completes) and New task. On desktop the top bar owns New task and the breadcrumb; the
  drawer shell keeps New task in the page header. The field is the one desktop Search
  entry (it takes the current-page treatment on Search); the drawer hides it and keeps
  a Search row. The capacity meter reads global turn usage from the
  task list, so it is absent while there are no tasks. Not found shows no
  breadcrumb or New task.
- **Implemented Inbox (`02-inbox-approval`):** from 1280px three panes edge to
  edge under the top bar: the 340px queue, the flexible request pane and the 280px
  task-context inspector; from 761px to 1279px the queue (300px) and the request
  pane (`800b-tablet-inbox-question`); at or below 760px the single-column queue →
  request → queue. At the sidebar shell (1121px and wider) the queue header holds the
  page's one heading "Inbox", the unresolved summary and Refresh; below it the page
  header keeps them, except at or below 760px, where the header holds the menu,
  "Inbox" and the count badge and Refresh ends the one-line filter row (the two
  selects share the width and truncate long names; there is no pull-to-refresh). The queue groups Intervention, then Questions & approvals
  oldest first, under compact Project and Request kind filters; the selected row is
  the `--overlay` fill with a 2px indigo left edge. The request pane shows the kind
  badge, position, Open task and Previous/Next request, then "Project / Task title"
  in small type, the question or exact action as the heading (the task title when
  the read withholds it), an intervention's or delivery row's reason, the request's
  own material and a sticky response bar. The "requester · version N · HH:MM" line
  follows a question's form, with its conversation revision, evidence links and
  drafts note; an approval or intervention keeps the line under the heading. The
  inspector lists the task with its source and, while the request is still open in
  the queue, the next action; Lead (or "No lead configured"), Requester, the assignment Chain, Holds and Evidence. A field
  the task read cannot supply reads unavailable. A deep link to a request that is
  no longer in the queue shows no inspector. One
  task read per selection serves the holds, the approval facts and the inspector.
  The page itself never scrolls at 761px and wider.

### Question actions, composer and test matrix

- Question actions on the task page sit in flow directly below the bounded
  question body rather than sticking to the page; a page-sticky footer covered the
  last field after it scrolled into view. At 390 × 480 the actions are reached by
  scrolling the task page. They are not always on screen as in `800g-phone-grouped-question-short`.
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
  than a separate screen. It keeps frame `103-phone-auth-expired-private-state-cleared`'s headline and "Private state
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
- Approvals show the exact action, target, revision, requester, the independent holds (frames 07 and 33) and the bound-decision statement, with one "Review material & decide" link to the retained `/coordination/task/:id#<interaction>` destination. The Inbox never approves or denies; an in-app decision would be a new authority surface.
- Evidence stays the existing "Question evidence" and "Task evidence" links; the read has no excerpt field, so frame 27's in-pane excerpt is not drawn. Returning from the task restores the selection, scroll position and the link's focus.
- A single question's choice cards stay in the reading flow (frame 06 pins them); only the submit area is sticky, inside the one scroll owner `.inbox-detail`, so a pinned option list cannot trap scrolling or cover a field.
- Queue rows use read-model facts only: the kind, the title (the first question's label or the approval's exact action from the item's `headline`, which is null, and the row falls back to the task title, whenever the exact read would withhold it; two lines at most, the full text on hover), "Project / Task title" as the subtitle (the project alone under a task-title fallback), the action ("Answer question", "Review material & decide", "Inspect execution"; an intervention's reason and action come from its attention code, and only operator-owned codes raise one, so a routing fallback has no Inbox item; a recorded native answer whose delivery is unresolved keeps its question row, "Answer recorded; native delivery remains unresolved", with "View task" rather than an answer action; the generic "Operator answer requested" and "Review exact approval material" reasons are not shown, and only an intervention's or delivery row's reason is) and "Requester · HH:MM · age". Frame 02 draws "Review material & decide" as an approval row title; the row leads with the exact action instead, as the issue's acceptance criterion requires. There are no short identifiers (Q-204, A-201: U3 #837), no "Execution uncertain" versus "Intervention problems" subtype (one "Interventions" option), and no grouped-question title on a phone.
- Kept or omitted on purpose: Refresh stays on the Inbox (in the queue header at the sidebar shell, in the page header from 761px, and at the end of the phone filter row at 760px and below, where the frame's single header slot holds the unbuilt Search icon); the frame's "Today · 11:00" clock and the phone "Search" header action are not built; the header title is 18/600, not the older large title of frames 07 and 08. Frame 29's "Refresh request" button is not built: the request has no refresh control of its own (one refresh per page, Presentation), so the host page's Refresh and polls reread it, and a failed read recovers with the read status's "Try again".
- Three-pane workbench against frame 02 (composed from the read model, with no new contract): there are no short identifiers (AP-17, A-104, C-104), so the identity line reads "requester · version N · HH:MM" and the Chain row uses assignment names ("Operator → Mira → Jonas"). The request headline is the question's first label or the approval's exact action (`headline` on the Inbox read, withheld exactly when the exact read is), not the task title; the task title and project sit above it. A pending request shows no "Awaiting answer" badge, and the version line, "Conversation revision N.", "Question evidence" and the drafts note sit below the form (on the task page and Overview cards too); below 1280px the "Task evidence" and "Requesting conversation" links follow them, so a phone shows the options on first view. There is no reviewed-material excerpt, tabs or file counts, no "Version N is out of date" note and no approved state: the exact action, target and version facts and the one Review link stand in for them. The kind badge reads "Approval", "Question" or "Intervention" (no "Pending approval" or execution-uncertain subtype in the Inbox read). The breadcrumb stays "Inbox"; the bar statement keeps the existing bound-decision sentence. Grouped questions read in two columns only where the request pane is at least 640px wide (1121–1279px, and from about 1530px with the inspector); at 1366 beside the inspector they are one column. The inspector shows no task state badge or synced-at time, and its Evidence section has the request's "Task evidence" and "Requesting conversation" links, which appear there instead of in the request pane from 1280px.
- "Recommended by <requester>" appears in the Inbox and on the task page (`/app/tasks/:id?request=`), which passes the requesting assignment's name.
- Choice labels use the focus ring on `:focus-within`, because WebKit drops `:focus-visible` on a radio after arrow keys.
- Entry points that apply: Inbox desktop three-pane, tablet two-pane and phone, and the `/app/inbox?task=&request=` deep link (it opens the request pane and the inspector); the shared `QuestionResponse` at `/app/tasks/:id?request=` (it shows the holds an answer does not clear, in the answering wording); Overview question cards, which answer a pending single-choice question through the same shared `QuestionResponse` (other forms link to the Inbox), and task-row attention links (unchanged); the retained HTML coordination page (unchanged). Counterparts: failed answer, Retry answer; stale read, Try again (or the page Refresh); conflict, Review current request; recorded, Back to Inbox; filter, Clear filters; approval, decision at the retained destination.
- Runtime item (`02b-inbox-runtime-exhausted`): selected by `/app/inbox?request=runtime%3Acodex` with no `task` parameter, from the "Runtime" request type, the queue or a browser notification (`181`); the Overview card and the phone queue open the same item. Not drawn, same layout: the phone runtime detail (header Back to Inbox, "Runtime · N of M", no Open task), the compact tablet Inbox (`800b-tablet-inbox-question`) and the runtime rows of `179e-phone-runtime` and `180e-tablet-runtime`, which carry the Fix text of `126`. Previous and Next request stay wide-layout tools. The detail has no task-context inspector at any width.
- Open approvals as holds: every hold surface passes the approval in view and omits only that one. Any other open approval on the task is listed as "Execution held (approval needs a decision)" in the surface's wording. The task-page decision card and inspector already list every open approval as its own row ("Your decision · approval pending", "Approval pending"), so they list that hold only for the other open approvals when `?request=` selects an approval, and none when no approval is selected, rather than repeating every approval as a hold. The Overview approval card and the Inbox approval pane omit their own approval; the Inbox and Overview question footers list every open approval as a hold, since no approval is in view.
- Hold copy in the approval pane, from the task read's `admission.reasons`; each reads "Approval does not clear it" or "Approving does not clear it":
  - Blocked GitHub dependencies: "Execution blocked by dependency", the open blockers as `owner/repo#n`, and "Source-owned hold … execution still waits for the GitHub blocker."
  - Unconfirmed dependencies (`imported-blockers-unknown`): "Execution held: dependencies unconfirmed", "GitHub blockers could not be confirmed." It never claims a blocker that was not found.
  - A source review or hold (`source-held`, which the read folds `source-hold`, `source-unknown` and `source-review-required` into): "Execution held by the source".
  - Local dependencies: "Execution blocked by dependency" with the unfinished tasks. Project paused: "Project paused. Approval does not resume work."
  - Any other reason (`task-unready`, `task-not-open`, `project-lead-unconfigured`, `project-lead-revoked`, `admission-blocked`): "Execution held (<reason label>)". An ineligible task with no known reason reads "Execution held".
- Hold copy in the Inbox question footer (frames 06, 19, 10 and 21), from the same notices with the same titles and items as the approval pane, shown as compact lines above the Submit action and kept on the "Answer recorded" card. Answering details: blocked GitHub dependencies "Source-owned hold. Answering does not clear it; execution still waits for the GitHub blocker."; unconfirmed dependencies "GitHub blockers could not be confirmed. Answering does not clear this hold."; source hold "Source review or hold is unresolved. Answering does not clear it."; local dependencies "Dependency hold. Answering does not clear it."; project paused "Task paused. Recording answers does not resume execution."; any other reason, and an ineligible task with no known reason, "Answering does not clear it." A pending approval beside the question is a hold, "Execution held (approval needs a decision)" with "Answering does not clear it." A loading or failed task read shows no hold and never blocks answering; the next Inbox poll or Refresh rereads it.
- "· confirmation retained" in the Inbox subtitle appears only when this session recorded the answer; a request answered elsewhere that has left the queue keeps the neutral count.

### Overview, task list and Board

Production Overview, List and Board
([#837](https://github.com/chrisbanes/ensemble/issues/837)) differ from the frames as follows:

- Route titles stay "Overview", "All tasks" and the project name. Frames 01, 24,
  18 and 18b title these screens "Your workspace"; the frame's second line is
  the subtitle ("Decisions first. Work and completed results stay separate.",
  "8 active tasks · 3 projects", "5 active tasks · accountable lead Mira Chen").
  The phone Tasks header keeps one New task action, not the drawn Search.
- Overview (`01-attention-overview`): the stat strip sits under the page title
  (right-aligned; a 2 × 2 grid on a phone). Needs you shows at most three cards in
  Inbox order with interventions on an uncertain execution first; the rest collapse
  into a dashed "N more · Project / Task, … · Inbox" row. Each card shows recorded
  facts only: kind badge, "HH:MM · age", project / task, the headline (the question
  label, the approval's exact action, else the request reason), the requester,
  evidence and one response. A missing time, age, requester or evidence line is
  omitted ([Presentation](#presentation)).
  Approval cards show the exact action, target, version and holds ("Approval does
  not clear it", including any other open approval on the task but not the card's
  own) and link to the retained destination; they never decide in place.
  Intervention cards show the lead, recorded reasons and "Ownership stays held"
  rather than the frame's "Last observation", which no read carries.
- A pending request with one single-choice question is answered in its card
  through the Inbox's `QuestionResponse`, so the command, validation, shared draft
  and outcomes are the Inbox's: failed answer, Retry answer; stale read, Try again
  or the page Refresh; conflict, Review current request; unknown, Check whether it saved. A
  recorded answer is not reversible, as in the Inbox; its confirmation stays on
  the card until Overview is left. Grouped, multiple-choice and free-text forms,
  and a failed question read, link to the Inbox. Overview has no notification,
  deep-link or context-menu entry for answering (a browser notification opens the
  Inbox instead).
- "Next: you" reads in the attention colour on every task row and card (Overview,
  List and Board), as the token table assigns it.
- The work table has no Updated column and the Projects panel no sync time: the
  task list carries no update time and no endpoint reports per-project sync. The
  Projects panel shows lead, active work by state (uncertain first), "Project
  paused" and "N from GitHub" or "No imported tasks". Column labels show where the
  row grid has those columns (1121px and wider); the side panels sit beside the
  work panel from 1280px and below it otherwise.
- There is no Recent results strip. A result excerpt, time and counter are not in
  the task-list read model and no endpoint lists results across tasks. Overview
  has a "Completed work" panel (count, up to three completed tasks, no recency
  claim) linking to `/app/tasks?state=Done`. A real strip needs a read-model slice.
- No short identifiers (AT-142, A-104, Q-204, R2) are shown: no read model
  carries them. Imported tasks show `repository#number`, local tasks "Local task",
  and no raw UUID appears on Overview, List or Board.
- Task titles stay underlined links (an established shared-foundation contract);
  the frames draw them plain. The Project dropdown is not drawn on project routes,
  where the project is already the route.
- Active tasks is the default State, so Done and Cancelled are reached through
  "All tasks", a column name or the Completed work link.
- Board (`04-tasks-board`, `23-atlas-project-board`, `800f-tablet-all-projects-board`,
  `25-phone-board-waiting`, `25b-phone-board-uncertain`): columns are equal width
  with a 140px floor, so the seven Active columns share one screen at 1366; a
  narrower viewport, the Overview work panel or State "All tasks" scrolls inside
  the board only, never the page. Every empty column is a 44px rail (count, then
  the name and its empty sentence read vertically). The column heading is the
  state symbol and word with a mono count (Running indigo and Uncertain rose while
  populated; a populated Uncertain column has a rose border). Cards show the title,
  project and identity (`repository#number` in mono linking to GitHub, else "Local
  task"), recorded reasons, the next actor only when an attention code names one,
  then the lead and the request response. A card nobody must act on, such as a
  Running, Done or Cancelled one, has no Next line; the task strip keeps "No
  operator decision". Capacity is stated once for the whole view, in a line under
  the toolbar on Overview, List and Board ("Capacity is full; it rechecks as turns
  finish." for the global limit, else "Capacity is full for <projects>; it rechecks
  as turns finish."), and appears only while a visible open task waits on it.
  The card border is rose for uncertain ownership, amber when the next actor is
  you, otherwise the control hairline. The column names the state, so cards carry
  no state badge, except a "Ready" chip on Ready work that admission holds in
  Waiting and an "Uncertain" chip on a phone, where one column shows. Through 1120px
  the segmented link bar is the reach path and keyboard route to a column; from
  1121px it is not rendered, because the headings carry each name and count and the
  board scrolls to a focused card. Uncertain reads rose with its symbol while it has
  tasks. The phone puts the Project and State selects and the column tabs (selected
  tab on the overlay with an indigo border) in one row that scrolls sideways and
  keeps the selected tab fully visible, with List/Board and Refresh tasks on the
  line below, More filters under them and in-flow Previous/Next under the column;
  the total count is read aloud only, as the tabs carry each count. At 759px and
  below the tabs render in that row, from 760px above the board, one set at any
  width. The footer reads "Columns describe
  Ensemble work, not GitHub issue state. Cards open the task; nothing here changes
  state, and there is no drag and drop."
- Board differences from the frames: a Draft column follows Uncertain (not drawn);
  the column floor is 140px rather than 176px so seven populated columns fit; cards
  keep the Card primitive's 8px radius; the lead reads "<name> · accountable lead"
  rather than "Lead · <name>", with no "No decision"/"No request" footer text; only
  the selected tab is emphasised; the grouping sentence is in the footer rather than
  the page header; Previous/Next are not a sticky bottom bar; the phone row of
  selects and tabs replaces frame 25's tab grid. Not built, because no
  read carries them: "task 1 of 3", "N more waiting tasks", the per-card phone
  readiness note, relative age ("1h 46m ago"), times, short identifiers, "Check
  failed", "repair assigned" or "Repair owner unknown". The phone attention summary
  reflows the desktop bar instead of the shorter two-line variant.
- One Board serves `/app/tasks`, project routes and Overview (`?view=board`, in the
  work panel). List/Board is a reversible presentation switch: no status mutation
  and no drag and drop. Search results, task Back and Inbox "Open task" return to it
  with filters, column and scroll restored. It has no notification, deep-link or
  context-menu surface of its own (a browser notification opens the Inbox).
- "Refresh tasks" and "More filters" (Filter tasks, Source, Readiness) are existing
  capabilities the frames do not draw.
- There is no phone Overview or phone List frame; both phone layouts are
  composed from the shell and desktop frames (Overview: one column, stat strip
  2 × 2, cards and panels stacked, 44px responses).

### Search

Production Search (`web/src/search.tsx`, `web/src/search.css`) follows `73-search`
and `75-search-states`: the query field with its search icon leads the page, one
coverage line sits under it, then one bordered results panel whose header carries the
count, Refresh results and the filters. Each
match shows its type chip, task title, Selected and Historical badges, the quoted
excerpt with the query marked, a 12px mono provenance line and an "Open task →
matching requirement / decision / result" link; the restored selection is the
`--overlay` fill with a 2px indigo left edge. Body copy is 13px. The page has no
primary of its own; the top bar's New task stays the one primary. It differs from
the frames as follows:

- The route title stays "Search" in the page header rather than the frame's
  "Search work" heading.
- "Refresh results" and "Search records" are secondary buttons the frames do not
  draw; Enter in the field also searches. "Back to originating workspace" is a
  secondary button shown only when Search was reached from a task or an Inbox item;
  from any other origin, or a direct visit, there is no Back control and the
  browser's Back or the navigation returns.
- The filters (Project, Type, From and Through, Include historical records) are not
  in a row under the field as in `73-search`. They sit in the results header with
  the count, Refresh results on the count's row and the filters on the row beneath,
  and show only once there is a query, including while the first read loads or has
  failed. Project, Type and the history checkbox apply on change. From and Through
  never apply on blur, because replacing the page then would detach the control being
  clicked; they apply with Enter in either field or together with whichever other
  control commits next (Project, Type, the checkbox, Search records, Enter in the
  field, or Refresh results, which applies them as a new search instead of re-reading).
  Typed dates stay visible in their fields with the line "Dates not applied yet. Press
  Enter or Refresh results to apply them." until then (a phone date picker has no Enter). A From after Through is applied as typed and reads
  as no match. Every commit is one new Search entry that drops the cursor and reads
  the whole form (repeating the same search re-reads instead of adding an entry); Back/Forward restores each entry's values. Clicking a result link
  with a date pending opens the task and commits nothing. Focus stays on the control
  that committed, and Tab order is the reading order: field, Search records, Refresh
  results, then Project, Type, From, Through and the history checkbox.
- Date is From and Through date fields rather than one "Any date" select, and
  history is the "Include historical records" checkbox.
- Provenance is "project · current/historical · time". The search read model
  carries no task short ID (AT-142), source revision, assignment, result revision
  or commit, so those are not shown; record, source and result UUIDs are not shown.
- Excerpts drop Markdown list, checklist and heading markers, join lines with
  " · " and show about 240 characters around the first literal match.
- The header reads "N matches · retained records only · N omitted or
  inaccessible", rather than "across Atlas and Relay". The coverage note is one line,
  "Searches saved excerpts, not full agent transcripts.", under the field; its
  tooltip carries the limits (permitted retained excerpts up to 16,000 characters
  each, partial long-source coverage, no generated summaries).
- Loading, refresh failure with retained matches and no matches use the shared
  `ResourceStatus` alert and plain notes, not the `75-search-states` panels; there
  is no partial-coverage or destination-unavailable panel, Edit query or Clear
  filters action. There is no "Returned to match N of M" note; the restored
  selection is the Selected badge, the row highlight and focus on its link.
- Phone (`74-phone-search`) places Search records beside the field and shows the
  filters in the results header as a two-column grid with 44px controls instead of
  the one summary filter button, with Refresh results full width above them;
  results stay in the bordered panel.

### Task detail, composer and Stop

Production task detail, composer and Stop confirmation
([#839](https://github.com/chrisbanes/ensemble/issues/839)) differ from the frames
as follows:

- `03-task-detail` governs every task, local or imported, with
  `12-imported-task-source-execution` for the imported inspector (its sync line reads
  "Issue open · synced 10:54"), `12b-imported-task-comment-unavailable` for the
  unavailable-commenting inspector line, the reply tab and the four reason sentences,
  and
  `47-phone-task-overview`, `53-phone-failed-refresh-uncertain` and
  `55-phone-parallel-delegation` for the phone composition. The shell page header
  keeps Back, the title, the first line of the recorded desired outcome as its
  subtitle (plain text with heading, list and checklist markers removed, clamped to
  three lines; when more follows, a closed "Full desired outcome" disclosure in the
  status strip renders the whole outcome as Markdown and stays open across a
  refresh; a redacted outcome shows neither; the brief keeps the full text) and,
  from 760px, Execution plus, while the task is open, Stop…. Below 760px
  (`47-phone-task-overview`) the header is one row: an icon-only Back (named as
  below), the one-line title over a mono subtitle (`repository#N`, or "Local task"),
  and one outline "Task actions" control holding Execution and Stop… (open in
  `47b-phone-task-actions-open`). The control is a native disclosure with a 44px
  summary, not an ARIA menu:
  it is the same element at every width and held open from 760px, so resizing never
  remounts the Stop confirmation; Escape closes the confirmation first, then the
  disclosure, and a tap outside closes it. The phone drops the outcome line and the
  strip's ID slot (the subtitle carries the identity), so the strip's "Full desired
  outcome" disclosure also shows a one-line outcome there. A finished task offers no
  Stop…; an
  existing Stop stays as a disabled "Stop requested". Back is the only back
  control: with an in-session origin it reads the origin view ("Board",
  "Overview", "Inbox", "Search", "Tasks"; named "Back to originating view") and
  returns to that entry; otherwise it is "Back to <project>". The breadcrumb
  ("Atlas / List · Waiting · AT-142") is not built.
- The status strip under the header carries the ID slot, the source chip, the
  state badge (the Board's column for this task, symbol and word), readiness (the
  recorded state and first wait, "Ready · waiting on acme/design-system#87"), the
  next actor and "Accountable lead · Mira". Because the shell header is shared,
  the ID slot and chip sit in this row under the title rather than above it. The
  ID slot reads `repository#number` for an imported task, whose chip repeats it as
  "Imported · repository#N ↗" linking the source, and "Local task" otherwise.
  The next actor comes from the task read's attention codes, the List's own
  codes and precedence (`src/operator/attention.ts`), so the strip, the List row
  and the Inbox always agree: "Next: you · inspect execution" (the
  `execution-uncertain` code or the Uncertain column), "review material &
  decide", "answer question", "resolve result destination" or "review rejected
  completion". Two codes name Ensemble, as plain text: an answer recorded for a
  native question whose delivery is not yet confirmed (`question-delivery`)
  reads "Next: Ensemble · delivering answer", and a routing fallback
  (`lead-review`) reads "Next: Ensemble · recording routing fallback", because
  Ensemble assigns the project lead or retires the fallback on its next
  coordination pass. Otherwise
  "No operator decision", and a finished task reads "Next: none". There is no
  "Updated" time. The persistent tools row follows ("Open
  GitHub to edit source" and "Refresh source" for an imported task,
  "Refresh task").
- Tabs: Overview, Files, Changes, Review and History, with no counts (History is
  read per assignment; Review's count lives in the local draft). Every panel stays
  mounted and only the selected one shows, so drafts, expansions, selections and
  unconfirmed checks survive a switch; each tab keeps its own scroll. A switch
  sends nothing and adds no history entry; Back and Forward restore the tab with
  the reading position. Links choose the first tab: `?section=` (decisions, brief,
  review, result-evidence, assignments, reply → Overview; files; changes;
  local-review → Review; context, history → History), then the fragment, then `path` (Files), `target`/`base` (Changes),
  `review` (Review), `result`/`source` (Overview) and `assignment` (History); a
  `record` or `request` target opens the tab that holds it unless the link names a
  section or fragment (`?request=…#history` opens History). A link followed in
  place maps the same way. A link to a section or record inside a closed Overview
  disclosure opens it first (`?section=brief`, `?source=`, `?evidence=` and a Search
  hit for the brief or a recorded decision). The full header shows
  on every tab, not `06-workspace-changes-review`'s compact header. The tabs scroll
  with the page.
- A request is never hidden by a tab: the strip's "Next: you · …" is a button that
  opens Overview at the decision card, and a request that arrives while another
  tab is open updates the strip without moving the tab or the focus. A Local
  review check that takes the focus opens the Review tab, which carries an amber
  mark while a review write waits for its check; a delivery refresh's outcome
  shows on Changes beside its control. "New updates — jump to latest" opens
  History at its end.
- Overview is one column of cards beside the inspector (280–320px, from 1024px;
  below the last card on narrower screens): the decision card, the latest result,
  the reply, then Shared brief, Evidence and Assignments · N as closed native
  disclosures (`46a-task-overview-laptop`, `03-task-detail` open, and
  `47-phone-task-overview` draw all three; the "Earlier results" and "Changes since
  viewed" links beside them stay unbuilt). Each summary is one clamped line of recorded
  facts: "Requirements · GitHub · 2 supplied criteria", "R2 · 1 validation record ·
  2 artifacts", and each assignment's short id and known state. A pointer line
  closes the tab: "Captured conversations, earlier results and delivery evidence
  are in History, Changes and Review." The latest-result card keeps its summary,
  criterion rows, the viewing reference and the Result revision select visible; the
  disclosures hold their content mounted, so closing one loses no read, selection or
  focus target. Open cards belong to the history entry, are written only by their
  own toggles and links, and a task opened fresh starts with all three closed. The decision card leads
  with any request ("Your decision · approval pending", exact action, target,
  revision and material hash, and "Review material & decide" to the coordination
  view; the page never approves), then pending completion and unresolved result
  links, a "Review rejected completion" link for a completion rejected at the
  current task version and "Inspect uncertain execution" for an uncertain execution
  without its hold line, then, once and only while a request is open, the holds it does not clear
  in the Inbox's wording (the other open approvals when one is selected, none when no
  approval is selected), then the waits, except the merged approval wait that the
  request rows and that hold line already cover, and the execution hold lines. Its amber edge
  shows only while a request is open. The assignments table has Assignment (short
  id and the history button), Requested by → result to and Known state columns,
  and reflows to stacked rows on a phone.
- The inspector shows, for an imported task, a "GitHub source · read-only" group
  (identity link, issue state, latest successful sync as the app's clock label
  — "synced 17:50" — and any sync failure or
  incomplete observation — "sync unavailable", "partial sync" or "sync
  incomplete" — "GitHub owns the issue.
  Ensemble coordinates the work.", the native blockers as "Dependencies · managed
  in GitHub" and whether GitHub commenting is permitted; when it is unavailable, the
  one sentence for the reason follows as a muted line), then "Ensemble
  execution"; then for every task Holds (each open request and each hold title,
  counted; the other open approvals when one is selected, none when no
  approval is selected), Dependencies (local dependencies as links, or "None", for a
  task without a GitHub source; an imported task has only the GitHub-managed block above, since
  GitHub owns its dependencies), Execution
  (state, running assignments, the lead's runtime and, only for a task with a
  GitHub source, a linked repository or a bound pull request, the delivery mode
  and bound pull request) and Results & artifacts (each recorded result, newest first, opening
  it in the latest-result card, and the bound pull request). The per-selection
  sync lines and dependency blocks have left the brief. There is no GitHub
  Project status (memberships carry node ids only), "Unblocks" list, "Last turn"
  time, workspace path or per-task artifact list; artifacts stay in the latest
  result's evidence. The inspector is Overview's alone.
- The reply offers "Message task lead" for every task and "Post GitHub comment"
  only for an imported task; the Changes tab's delivery block (heading "Changes and
  delivery", bound pull request, checks, feedback, blockers, actions and "Refresh
  delivery status") shows only for a task with a GitHub source, a linked project
  repository (`repositoryLinked` on the task read) or a bound pull request, and the
  heading is "Changes" otherwise. A settled refresh result leaves with the
  controls; the "Check whether it saved" for a refresh whose response was lost
  stays until it is resolved, then goes. Exactly one sentence sits above the reply box,
  for the selected destination: the lead's resume, receive or unavailable line, "This
  project has no lead to message yet.", or the comment policy (the reason sentence for
  the task read's `commentPolicy.reasonCode`, or what posting does). The reasons are no GitHub
  issue, no comment grant, a hold, and no delivery credential; each has one sentence in
  `src/operator/github-reasons.ts`, shown identically in the inspector, above the box and
  on the tab. A read without `reasonCode` falls back to its `reason` text. While comments
  are unavailable (`12b-imported-task-comment-unavailable`) the "Post GitHub comment" tab stays focusable with `aria-disabled`,
  does nothing on click, Enter or Space, and is described by that sentence; the draft and
  destination are kept, and the tab works again when the reason clears. The "Immutable
  reference" line sits below the box.
  A task without a GitHub source always sends a lead message: its reply moves to the
  lead with the lead's own draft and reference, and the GitHub draft and its approval are
  kept apart (editing that draft withdraws the approval) for when the source returns.
- The delivery block's bound-PR lines read as follows. The PR line is a link
  "<repository>#<number>" (new tab, `noopener noreferrer`) followed by a state badge
  (Open, Draft, Closed or Merged, each with its symbol) and "head" with the 8-character
  head, the full SHA on hover. The link is the delivery read's `binding.url`, which the
  server builds only when the imported source is the PR's own repository and its name is
  a verified `owner/name`; the web renders an anchor only for an `https://github.com/`
  URL, and a read carrying any other URL fails as an invalid response. Without a link
  the line reads "PR #<number>" and the sentence "No GitHub link: this PR's repository
  name was not observed." (no repository id is shown). The provider line is "GitHub
  read HH:MM", or "Last GitHub read failed; showing the read from HH:MM." with the
  error in Details. Checks read "<name>: Passed | Pending | Failed", with
  "· on an earlier head <id>" for a check of another head; with no checks observed one
  line says "No checks or repair owner were observed on this head.", and otherwise
  "No repair owner is recorded for this pull request." follows the checks. Each blocker
  is a sentence ("Waiting for the current PR head to be settled."; an unmapped code
  reads "Delivery is waiting on a condition this version can't describe.") with its code
  only in Details. Difference from `71-delivery-alternatives`: the delivery read carries
  no repair owner, so alternative A's recorded repair assignment is not built; the block
  says none is recorded. Settlement controls stay on the legacy page.
- Stop task submits the retained `/runtime/control/stop` form and lands on the
  Execution page, where the Stop observation and Resume live. Unsent reply text on
  the task page is not carried across that navigation; Keep running, Escape and
  the overlay keep it. While Stop is recorded the header shows a disabled "Stop
  requested" and the status line "Stopping; effects may continue". There is no
  in-app Resume (a new write path).
- No drawn short identifiers (AT-142, A-104, V-22, C-104): no read carries them.
  Recorded ids show as the first eight characters in mono metadata (a shared
  `ShortId`, never inside a sentence), with the full value as its title and
  focusable; no full id is visible on Overview. Assignment rows show the profile
  name, a brief excerpt and the short assignment id. Results are labelled `R<n>`,
  oldest first (the number the Result revision select and the inspector use), with
  the short result id beside it. Token wording: a criterion's metadata reads
  "Source revision 1 · scope · provenance" and omits what was not supplied; a
  validation row shows the checked head short and reads "Matches the current pull
  request head", "Checked an earlier head than the current pull request head" or
  "Head comparison unknown"; an unavailable retained-evidence result reads "Evidence
  was not retained for this result.", "Evidence for this result is excluded from
  view." or "Retained evidence for this result can't be shown right now." (anything
  else: "…can't be shown."), with the code inside a closed Details. There is no
  "Approach" block (no recorded approach field), no "Compare screenshots" control
  (recorded pairs render in the Evidence card), no clock times, and no
  "Earlier results (2)" button (the Result revision select and the inspector keep
  earlier results).
- Overview has no in-page entries to other tabs: the tab list, the inspector's
  result links and the assignment buttons ("Assignment history" in place, without a
  history entry) are the ways in; frame 57's Files, Changes, Review and context
  entries are not built.
- The viewing-reference block under the latest result (the "No viewing baseline …"
  or changes line, "Set viewing reference" and its disclaimer) shows only once the
  task has a result. A check for a viewing write whose response was lost stays
  visible regardless.
- Criteria read C1, C2… in the brief and in the result's rows with the recorded
  outcome ("Supported by recorded evidence", "Failed recorded check",
  "Unverified"); no overall pass is derived. The literal brief, checklist syntax
  included, stays in the "read supplied text" disclosure. "Ask lead about
  criterion" keeps its exact-reference draft, which names the criterion by its
  line in the brief ("criterion 3 in source revision 1"), not by its C label.
- The phone keeps one reading column with the same tabs; the drill-in screens of
  frames 48, 51 and 55, a sticky bottom bar and the GitHub source / Ensemble
  tab pair of phone frames 14 and 15 are not built, so reading position,
  expansions and unsent replies are not split across history entries. The tab
  list fits at 390px and scrolls inside itself only when narrower.
- The composer's h1 is "Create a task" with the drawn subtitle and the field
  label stays "Task title"; below 760px the header is Back (naming the project, or
  Tasks) and a centred "New task" with no subtitle and no mono project line, as
  frame 34 draws it, and the form carries no second "Create a task". Project (200px) and Task title share
  a row from 760px; Desired outcome follows, then Optional settings as one panel
  that, collapsed, shows a chip per supplied value (an invalid one marked "!" with
  a rose border) and "Open settings to fix …". Its count reads "N supplied" at
  every width, not "N values retained". Inside, it keeps the supported controls
  (one link per line, the searchable dependency checklist), not the drawn
  add/remove link rows and dependency chips.
- The right column (from 1121px) holds "If you create it now" and "Inherited from
  <project>". The prediction badge is "Starts now" (indigo, play symbol) or "Will
  wait" (slate, clock); the reasons are numbered in the flow's order, each with
  its Fix or link, and every Fix there is a secondary button, so Create and start
  is the one primary in view. There is no "Project X is enabled · lead is
  available" line: the read carries blockers, not satisfied conditions. The
  inherited panel shows the lead, the lead profile's public summary, routing,
  capacity and a "View project instructions" link; instruction text and
  repository access are not shown, as no read exposes them. At 1120px and below
  both panels follow the fields and precede the bar; the phone frames draw only a
  status line, but production keeps the full prediction there.
- The sticky bar reads "Unfinished input saved on this device · not yet an
  Ensemble draft" only after a successful on-device write, then the one hint "Save
  draft keeps it without starting." (otherwise the optional-settings error hint; the
  bar never states the verdict, with or without a prediction, which the panel
  does), Create and start and Save draft. Create and start comes before Save draft
  in DOM and visual order at every width, so focus order equals visual order (the
  desktop artboard right-aligns Save draft, then Create and start).
  There is no ⌘↵ shortcut and no "Markdown supported" note; the 16,000-character
  brief note appears only when the outcome, context and links together reach
  14,400 characters (within 10% of the limit) or exceed it. Refused and
  unconfirmed outcomes sit directly above the bar.
  After creation the receipt view (Task created or Draft saved, Open task, the
  execution state and "It will wait: …") replaces the form, rather than frames
  161/166c's locked form with an outcome line in the bar.

Entry points: Overview, List, Board, Inbox "Open task" and "Task evidence", Search
results, recovery and assignment links, `?request=` and `?section=` deep links and
the composer receipt open the same `/app/tasks/:id` with this header, strip and
Back; the
composer is reached from the top bar's New task on every route, Overview, List, a
project's New task, setup's ready check and Getting started, all opening the same `/app/tasks/new` (`?project=` is the
only deep link). The retained
`/task/:id`, `/runtime/task/:id` and `/coordination/task/:id` pages are unchanged
and linked from Execution (`/runtime/task/:id`) and the History tab's Approval and
delivery forms (`/coordination/task/:id`, which links `/task/:id`). No
context menu or extension surface applies, and a browser notification never opens the composer. Counterparts: Stop →
Execution → Resume (retained); Keep running and Escape send nothing; a tab switch
sends nothing and keeps drafts, and Refresh task only re-reads; Optional
settings collapse ↔ expand keeps values; a failed create keeps values and the
existing receipt reconciliation; Resume project in the prediction panel confirms
first and Pause project in project configuration reverses it; a saved draft is
not Ready.

### Settings, profiles, routing, runtime and recovery

Production Settings, project configuration, profiles, Runtime and assignment
recovery ([#840](https://github.com/chrisbanes/ensemble/issues/840)) differ from
frames 114 and 118–128 as follows:

- No configuration timestamp is stored, so a section header shows its version
  ("General version 3") and, only after a save in this browser session, "General
  saved 10:52" from that save's receipt. A reload shows the version again.
- Existing GitHub sources can be removed. A saved search query is edited in place
  under its own `S-<n>` id (`119-project-config-github-source`); any other changed
  definition is a removal plus a new source with a fresh id, added inactive. Local
  repository paths and search queries are loaded when the tab opens and show plainly;
  if that read fails the row says "Local path unavailable" or "Query unavailable" with
  Try again and saves without it. Project filters stay private: a Project row reads
  "Filter kept · private" instead of the drawn filter, with its node ID in Details.
  Readiness Project-field conditions pick the Project, field and option by name from
  discovery and fall back to typed node IDs when discovery is unavailable or truncated.
  A GitHub source save deletes the stored activation of each
  removed selection and keeps the stored activation of each kept one. The save
  raises the source version, and activation counts only at the version it was
  previewed, so every kept selection reads "Inactive" and is not synced until it
  is previewed again in Sync & placement.
- Frames `119d-github-source-import-ready` and `119e-github-source-imported` chain
  activation and import on the GitHub source tab after a save: Preview and import
  now sends one preview-and-activate command per saved inactive source, then one
  refresh, showing the activation receipts and then the refresh's observation
  state; activation and a successful import stay separate evidence. The panel is
  offered whenever a saved source is inactive or has never been read, so it returns
  after leaving the tab and offers only what is left to do. Production differs from
  the frames in three ways. A Project source has no stored title, so its name is the
  title discovery lists for it and otherwise "GitHub Project"; the Settings index
  always reads "GitHub Project". The frames' Project name carries the filter
  (", status:Next"), which production never shows. The Sync & placement select reads
  a saved search as "Saved search (S-2)", because an option cannot be masked in
  evidence and a saved query appears only in the signed-in view's rows and panels.
- Frames 119–121 draw a status sentence per source ("Synced 10:47 · 4 issues
  observed, 2 match the readiness rule"). Production keeps the selection's detailed
  stored counts ("9 observed · 9 open · 0 match label `ready`") in the row's
  Details. A complete read with no match adds a visible warning `StatusBadge` and a
  "Check readiness conditions" link under the Readiness panel, and the phone
  "Current state" card appends the counts. Task List and Board name an imported
  Draft task's unmet conditions instead of "Draft: not Ready".
- No frame draws the GitHub source Readiness panel without a rule. Production
  shows no condition row and the helper text "No readiness rule: open issues in
  active selections are not filtered by label or Project field"; "Add readiness
  condition" starts a rule and removing the last condition removes it. A withheld
  rule reads "Saved readiness is unavailable; add a condition to replace it." and
  Save stays disabled until a condition is added.
- Removing every linked repository shows a warning and a required "Remove all
  repository access" checkbox inside "Changes to save" (no frame draws it).
- Profile Revoke and Restore are one draft field saved by Save profile, so the
  button reads "Revoke profile", "Restore profile" or "Undo …" while unsaved.
- Routing guidance opens as "Kept · Reveal" and edits in place once revealed (frame
  124 draws the revealed, edited state). Revoked profiles are listed disabled and
  are dropped from the candidates by the next routing save.
- No short identifiers (RL-31, A-203, AT-151) are shown, and recovery omits "last
  observed" and "requested by", which the recovery read does not carry. Its
  breadcrumb is the static "Settings / Runtime / Assignment recovery".
- The header keeps Refresh on settings read views and re-reads the open page's own
  resources; the create forms (New project, Create profile) have none.
- Switches are native checkboxes drawn as switches.
- Execution runtimes ([#826](https://github.com/chrisbanes/ensemble/issues/826)),
  which frames 114, 118–125, 127 and 128 do not draw, use existing fields, rows and asides:
  profile pages add a Runtime select (Codex or Claude) with Model and Reasoning
  effort for Claude (selects once the runtime has read its supported values, else
  text), a not-enabled or unavailable note, a "Runtime change" aside (new
  conversations only) and an "Execution policy" aside for the selected runtime;
  each Settings profile row adds a "Runtime: …" line; the Runtime and recovery
  panel carries the Claude subscription token row (like the discovery row); Runtime
  adds an "Execution runtimes" panel above Capacity with each runtime's state and
  effective policy: the first two policy lines, then frame 126's closed "Limits and
  untested surfaces · N" disclosure (a native `<details>`; its open state is
  per-viewer and not stored) holding the other lines and the disclosed limits. The
  profile "Execution policy" aside and task history list them in full.
  Task rows, assignment history and recovery name the runtime, explain runtime
  waits and held Claude failures with route links, and history adds an "Effective
  execution policy" disclosure. The shell raises one alert per unavailable runtime; it
  says "Restarting · attempt N of 3 · next at HH:MM" while Ensemble retries and
  "Retries exhausted" once it stops, in the same words as the Runtime page, Settings,
  Readiness and the CLI.
- Frame `127-assignment-recovery-relay` draws "1 older recovery record omitted".
  Production also collapses each run of consecutive generations that show the same
  state under an expandable "N older records, same state", keeping the newest of the
  run, the held generation, witnesses and the latest receipt expanded.
- Project setup (115–117c, 131, 145–146b, 177, 179b) reads steps 1, 2 and 3 in one
  column, with "What creation does" as an aside beside them from 1121px and after
  them below it, as in the composer; DOM order is visual order and nothing reorders.
  The sticky bar holds a note, Cancel and then Create paused project at every width
  (179b draws Cancel then Create in one row). The rejection or unknown-outcome alert
  sits above step 1 (116, 116b). Create is `aria-disabled` and stays focusable with
  its reason while the project or the inline profile is being saved or its outcome is
  unknown, and while a typed profile name is not recorded. After Create the
  ready check replaces the form and takes focus, and reloading shows a blank form.
- Paused project badges are idle (slate) with a pause symbol in the sidebar, phone
  drawer and Settings; Enabled, Available and Configured stay slate with a check,
  and Revoked stays amber, rather than the canvas's emerald and rose. Project setup
  has no state badge. "Next" in the getting-started checklist is the one call-to-act
  badge without a symbol.

## Using this snapshot

Open the canvas to review or change the design. Each artboard is a self-contained
`.dc.html` page on the canvas; Claude sessions with the Artifact tool can read and
publish them, and the canvas editor edits them in place. Keep the shared
`Sidebar` and `TopBar` components as the single source for the shell, and copy
tokens from an existing artboard. After a design change, update this document in
the same change.

The canvas has no repository copy. Implementation work that cannot open the
canvas uses this document and SPEC.md.

This snapshot covers the screens listed above. It does not supply every
configuration/recovery screen; remaining product obligations stay in the spec and
issues. The design does not cover every fixture at every viewport and entry point;
the matrices name the representative coverage.

## Design limits

Canvas review is bounded and static: it checks hierarchy, spacing, contrast,
readable state labels and clipping on rendered frames, and is not an accessibility
audit. Intended clipping regions are the scroll viewports named above.

Static design does not establish responsive implementation, font availability,
real resizing/zoom, text scale, keyboard/focus restoration, screen-reader or
forced-colour behaviour, virtual-keyboard and safe-area behaviour, scrolling and
scrollbar ownership, textarea growth and caret retention, scroll/query/filter and
draft persistence, live updates, provider reconciliation, runtime question
support, message delivery, source comparison, permissions or command
reconciliation. These need browser and physical-device evidence against the
acceptance plan. Comparison captures are drawn as labelled mock UI, so image
loading is not exercised. Static artboards are not working navigation.

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
