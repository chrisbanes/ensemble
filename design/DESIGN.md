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

## Reviewed task overview design — 3 October 2026

The [task overview specification amendment](../docs/SPEC.md#task-overview-and-evidence--design-direction-3-october-2026)
and [design-review criteria](../docs/acceptance.md#task-overview-and-evidence-design-review--3-october-2026)
add shared brief, delegation, evidence and compact progress requirements. This is
the separate amendment from PR #763, retained when rebasing; the approved
operator refinements below do not qualify it. The proposal below is designed
in the existing canvas. Chris agreed to carry the reviewed extensions into the
specification, acceptance checks and issue briefs on 3 October 2026. Status:
**design reviewed; implementation deferred**. This records design review and
scope agreement, not final acceptance of an implemented UI. #742 owns task review,
search and its shared navigation; #745 owns integrated qualification and #736
retains Chris's final human acceptance. The preview-removal note at the end records
the remaining comparison-image loading gap. Earlier save/review notes describe
their individual review passes.

### Task overview proposal — reviewed design

The task header establishes project, source, accountable lead and current wait.
Actionable requests sit above disclosure. Desktop places the shared brief beside
the latest result, its evidence and compact delegation rows; phone discloses the
brief, result detail and assignment history from a single task summary. Existing
shadcn controls, semantic colours, Inter and identifier roles remain the foundation.
The reusable compact progress component is `cIimt`. The review-interaction
extension below adds criterion rows `GA7Ra` and local-feedback context `xljAv`.

These are fictional design fixtures. Criterion labels C1/C2, validation V-22,
revisions and results illustrate recorded relationships; they are not observations
of Ensemble's backend or proof of a passed check. AT-142 retains the existing
AP-17 v2 exact-material approval and independent GitHub dependency. A-105 and
A-106 have parallel responsibilities using the same Builder profile; their IDs,
requesters and result destinations distinguish them. At the illustrated snapshot,
A-105 has reported R2 and A-106 has recorded a failed focus check before waiting
on the dependency. FN-58's empty and
expanded views are different moments in the same local-task journey.

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

### Interaction and state handoff

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
- **Entry points:** Overview, project/cross-project List and Board share the
  compact facts and task detail. Back restores filters, selection and position;
  Board also restores its column. Inbox enters at the relevant request and
  returns to that queue item. Direct task entry retains project/source context
  with project return as fallback. No new context-menu, extension or notification
  surface is proposed. Existing screens remain as prior references; frame 54
  specifies the shared change rather than duplicating every screen.
- **Phone:** use 44px controls and one reading column. Detail subviews retain the
  pending-request shortcut and return anchor. In implementation, keep request
  access and response actions reachable while scrolling and with the keyboard
  open. The full-content desktop frame is an inventory, not a screen to shrink.

### Open design and data-contract questions

The proposal needs review of the desktop brief/result balance and the depth of
phone disclosure. It also requires confirmation of the following data support
before implementation; no API fields, routes, storage or renderer are prescribed:

- Explicit evidence-to-result/criterion relationships, revision identity,
  validation provenance and freshness. Without records, show unlinked artifacts
  or an agent report; never infer a verified criterion.
- Durable responsibility, requester, destination and waiting observations for
  assignment summaries, including explicit unknown values.
- Attribution for approach/decisions, ordering of current versus earlier results,
  and stable history identities for reading-position restoration.
- Artifact availability/redaction and preview support. The proposal supplies an
  unavailable-preview state and open-material controls, not an attachment service.

### Review checklist and limits

- [x] Inspected renders for hierarchy, spacing, contrast and readable state labels.
- [x] Checked all 11 new frames, including resolved component instances: zero
  visible clipping problems. Checked new root placements for overlap: none.
- [x] Cleared completed placeholders; review the referenced frames in Pen.
- [x] Preserved source ownership, exact approval, independent holds and recovery
  access; represented all requested state categories on desktop and phone.
- [ ] Chris's final visual/interaction acceptance of the integrated UI.
- [ ] Real resizing, keyboard/focus, scroll restoration, drafts and runtime data
  behaviour. Static canvas checks do not verify these implementation properties.

At this review pass, Pen MCP showed the 11 new frames and reusable component; the
on-disk `design.pen` changed during the session. Native UI access was denied, so
the Save indicator and reopening the saved document were not verified. Wiki
access was also denied; current SPEC, acceptance, PR #763 and the existing canvas
supplied the requirements. No application code, policy, delivery status or
integration changed. Earlier save/review statements below describe prior work.

### Review interactions extension — reviewed design

Implementation remains deferred. The existing desktop and phone task summaries
now prioritise supplied criterion outcomes and contextual feedback. Comparison
and revision changes disclose from the result; they are not four new dashboard
panels. Shared brief, delegation, attention and execution/recovery access remain.

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
assets are retained in `design/assets/` because the comparison frames reference
them; screen preview exports are omitted. These images illustrate
the evidence presentation; they are not screenshots of implemented Ensemble
behaviour or real validation. Earlier unavailable/unverified fixtures remain
alternative or earlier states, not simultaneous claims about the latest result.

#### Correction journey and outcome semantics

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

#### Interaction details

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
- **Entry points:** updated shared progress `cIimt` and frame `L2aXf` cover Overview,
  project/cross-project List and Board. They reach the same result/criteria view
  and restore the origin's filters, selected task, column and position on return.
  Inbox still opens the exact actionable request; Open task reaches review tools
  without converting new results into attention. No additional notification,
  context-menu, extension or integration surface is introduced.

#### Unresolved data requirements

These are questions to settle against available records after design review,
not prescribed fields, API or storage contracts:

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

#### Extension validation and save boundary

All 17 affected canvas frames, including the two fixture assets, passed resolved
visible-node clipping checks; affected root placements had no overlaps. Renders
were inspected. Two laptop overflows were repaired
by tightening existing result spacing. This is static design validation, not
testing of message delivery, source comparison, permissions or draft persistence.

At this review pass, the extension was present in the active Pen canvas.
**Saved-file verification was pending:** native Pen access was rejected (“Computer Use was not approved
to use Pen”), and the available MCP tools expose no Save/reopen operation. The
file timestamp predates the latest edits, so a changed file alone is not evidence
that the complete extension was saved. The preview-removal note below records
subsequent Save/reopen checks and their remaining gap. No implementation, runtime policy, delivery status
or integration was changed.

## Assignment context, delivery and search — reviewed design

The latest review additions are represented in the existing Pen proposal.
Implementation remains deferred. Document-wide discovery inspected all 92
existing top-level objects before adding these ten surfaces; existing review
work was reused, including the sidebar, buttons, input, result criteria and
feedback journeys. These are fictional design fixtures, not provider observations.

| New surface | Pen node |
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

The desktop result now leads with “Focus correction reported; toolbar needs
another look”. Work revision and evidence gaps remain immediately visible.
Assignment, result, instruction/profile, source-snapshot, commit and validation
identities sit beneath the outcome or in the context/provenance disclosure.
The existing parallel-assignment rows remain in the document behind disclosure;
the initial result view uses a compact summary. Attribution remains available
without competing with the outcome. `IuukL` retains phone criterion summaries
and links into assignment context and delivery.

The existing C1/C2 summary, comparison `dKc4O` / `mrRXI`, contextual feedback
`WEBvT`, send-failure recovery `uqbVh`, confirmation `AVuFr`, and since-viewed
`ge1Mm` / `cP92Q` remain. Contextual feedback keeps its exact result/material
reference when newer work appears; it does not silently retarget.

### Entry points, return behaviour and state coverage

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
- **Search:** a shared search destination for tasks, recorded decisions and
  results. Project, record type, date and inclusion of historical records are
  the proposed filters. Each match has an attributed excerpt; opening it selects
  the matching requirement, decision or result section, including historical R2
  rather than silently opening current R3. The coverage/recovery surfaces include
  loading, no matches, failure with retained earlier matches, partial coverage,
  historical results and unavailable destinations. Search makes no complete
  transcript claim. Unavailable destinations retain attribution and offer retry
  or return; absence of matches does not establish absence from omitted records.
- **Returning:** Back through the journey restores the previous section and
  reading anchor. Return to search restores the query, every filter, selected
  match and position. External evidence opens with task context retained; returning
  restores that exact material. Preserve expansion, comparison selection, focus
  and drafts while updates arrive. If the selected item is unavailable, keep its
  unavailable state rather than substituting a newer record. Direct entry without
  search context falls back to the task’s project.
- **Existing entry points and boundaries:** Overview, project/cross-project
  List/Board and Inbox still open the shared task experience. Inbox keeps its
  request anchor and queue return. Context, delivery and evidence retain access
  to pending requests and the existing exact-material approval, Deny and Leave
  pending flow. Execution, Stop and recovery remain reachable via task navigation.
  Independent source and execution holds remain independent of approval, checks
  and merge. No new context-menu, extension, notification or integration surface
  is proposed. Search is now placed in the shared desktop sidebar and phone header;
  see the review refinement below for entry, active state and return behaviour.

### Unresolved data needs

These are discovery questions for implementation after review, not API or storage
contracts. Confirm availability of captured brief/instruction/profile revisions,
reference attribution and unavailable/missing distinctions; current requirements
and explicit revision comparisons; recorded file/commit/result relationships;
PR-head and check provenance, observation age, findings and recorded repair
ownership; and independently reported task/delivery holds. Do not infer a record
from an agent claim. Establish which record types and historical excerpts search
can cover and how unavailable destinations are identified. Confirm support for
stable matching-section anchors and retained query/filter/draft/reading context.
The proposal does not add transcript ingestion, source writes or runtime powers.

### Validation and persistence boundary

- [x] Inspected all ten new desktop/phone renders and the refined result hierarchy
  for readable type, contrast, spacing, alignment and content fit.
- [x] Resolved visible-node clipping checks passed on the ten new surfaces and
  two modified task frames. New root frames are arranged in paired desktop/phone
  rows below the prior proposal without overlap.
- [x] Completed placeholders cleared. Screen references identify the Pen frames.
- [ ] Chris’s final visual/usability acceptance of the integrated UI.
- [ ] Interactive navigation, keyboard/focus and safe-area behaviour; scroll,
  query/filter and draft persistence; live updates and provider reconciliation.
  Static renders and destination annotations cannot verify these behaviours.
- [ ] **At this pass, Save/reopen persistence was unverified.** Native access was
  attempted again and returned “Computer Use was not approved to use Pen”. The
  available Pen MCP tools expose no Save/reopen operation. Live canvas readback
  is verified separately; it does not prove the latest canvas
  was persisted in `design.pen`. See the preview-removal note for later checks.

The personal wiki could not be searched: filesystem access returned “Operation
not permitted”. The supplied review, current SPEC/acceptance and existing canvas
provided this design’s requirements. No application code, runtime policy,
permissions, delivery status or integration was changed.

## Search and state-navigation refinement — reviewed design

Design only, 3 October 2026. Implementation remains deferred. This refinement
updates existing screens and navigation; the agreed behaviours are now reflected
in SPEC and acceptance.
It supersedes the earlier deferred search-placement note.

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
  their anchors, disclosure choices and drafts. Direct entry still falls back to
  the task project. These are static interaction annotations, not working routes.
- **Independent attribution:** four fictional matches span Atlas AT-142 (Command
  menu) and Relay RL-88 (Connection dialog). Both result matches have the similar
  title “Focus correction”; each identifies its own project, task ID/title,
  reporting assignment, result and work revision, and current/historical status.
  Task requirements identify their GitHub source and source revision. The decision
  identifies Mira/A-104, D1/S1 and historical status. Matching excerpts lead;
  metadata is compact and remains within the owning row, even with All projects
  selected. Historical R2 in the state specimens has the same complete ownership.
- **States belong to flows:** Search states & coverage and Provider/head/repair
  destination controls are removed. Search filters edit the current query scope;
  Refresh provider status retries the read in the current delivery view. Existing
  checks, findings, comparison and recovery controls remain. `qYS87`, `IzE97`,
  `ExcLV` and `c3utBY` are explicitly labelled canvas review specimens with no
  product navigation into them. Their loading, failure, partial-coverage and
  changed-head snapshots replace content within the owning flow. Retry retains
  previous observations with their age, selected material, drafts and all holds.
- **Entry-point coverage:** shared desktop navigation and representative phone
  Inbox/Board are updated. Overview/List/Board still enter the shared task;
  Inbox still targets the actionable request. No context-menu, notification,
  extension or deep-link behaviour is added. Older reference screens remain
  historical examples; apply the shared navigation treatment during implementation.

| Updated entry reference | Pen node |
| --- | --- |
| Desktop shared navigation | `m0d2bc` |
| Desktop Overview → Search | `N9G11A` |
| Phone Inbox → Search | `U3RAH` |
| Phone Board → Search | `GWXOi` |

The search, matching task, context, delivery and specimen frames are referenced
in the existing tables above. The criteria summary, screenshot comparison,
contextual feedback, assignment context, exact-material approvals, independent
holds, Stop and recovery controls are preserved.

Validation checklist:

- [x] Inspected affected search, navigation, task and delivery/specimen renders
  for hierarchy, readable ownership, contrast, clipping and overlap.
- [x] Updated existing frames; no duplicate screen designs or root placement changes.
- [x] Retained Pen node references for review; screen preview exports are omitted.
- [ ] Chris’s final visual/usability acceptance of the integrated UI.
- [ ] Interactive focus, scroll, query/filter and draft persistence: static design
  only, not implementation evidence.
- [ ] **At this pass, Save/reopen persistence was unverified.** Native Pen access returned
  “Computer Use was not approved to use Pen”. The available Pen MCP tools expose
  no Save/reopen operation. Active-canvas readback does not
  prove the latest edits survive reopening `design.pen`. See the preview-removal
  note for later checks.

The personal wiki search was denied by filesystem access. This review used the
supplied findings, current repository contracts and live canvas. No application
code, API/storage contract, policy, permissions, delivery status or integration
was changed.

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
- **Task detail:** prioritise outcome, current situation/next actor, unresolved
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
| Failed submission, stale read, confirmation and return | Existing lifecycle reference `jKzRk`, shared receipt `w5VRs`, interaction contract `BvX5O` | Failed `uJVe2`; stale `e1kkI`; recorded `o6O3M`; anchored return `q2vYE` |
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
| Repair, completed and unknown-responsibility task details | 36 `oipj4`, 37 `Q24BPH`, 45 `kiPK9` |
| Phone repair, capacity, completion, cancellation and closure | 38 `zs53F`, 39 `Z6U3T4`, 40 `Thy1i`, 41 `rn49D`, 42 `ALMfc` |
| Desktop lifecycle comparison and interaction checklist | 43 `zeoGi`, 44 `BvX5O` |

## Worktree handoff and limits

Keep the editable Pen document in the main design checkout. Worktrees can use this
Markdown reference without opening or creating competing copies of the canvas.
When the design changes, refresh this snapshot through MCP; do not parse the `.pen`
file directly. Review the proposal in Pen using the node references above.
Screen preview exports are omitted; comparison image assets remain in
`design/assets/` for use by the canvas.

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
task detail `RyH7J`, Inbox `cGjau`, approval `DAeiN`, List `nD0nh`, boards
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
the 10:52 approval, matching Inbox. Task detail `RyH7J` and full-content reference
`QGdAx` identify AT-142 as imported from `acme/atlas#142` and retain the open
`acme/design-system#87` dependency independently of AP-17 approval, consistent with
the board, imported detail and approval screens. Composer `Z315o` now uses 12px
for the shared sidebar workspace label. The four affected renders were inspected;
resolved-node checks found no clipping. These are canvas checks, not application
or runtime validation.

### Preview export removal — 3 October 2026

Screen preview exports and their handoff links are removed. The two fictional
comparison captures remain as source assets in `design/assets/`; five canvas
image references now use those paths. Native Save cleared the Edited indicator.
The design was reopened during this cleanup and the review/search frames were
read back. The relocated image references were saved subsequently, but Pen MCP
renders still show image placeholders, so comparison-image loading remains
unverified. Source asset files were checked as valid PNGs. Earlier export and
persistence statements above describe prior review passes.
