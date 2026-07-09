# Mission Control Phase 1 Design

Date: 2026-07-09  
Status: Draft for review

## Goal

Redesign Ensemble's web UI around a Mission Control workspace: a single operator surface for seeing all active agent work, spotting required intervention, selecting any issue, and safely stepping in without navigating away from the operating context.

The Phase 1 goal is product feel and operator flow, not deep new backend inspection capabilities. The UI should reuse existing dashboard, issue detail, transcript, workflow, timeline, artifact, and interaction components where possible.

## Product Intent

Ensemble should feel less like a dashboard plus detail pages and more like a control center for autonomous issue pipelines.

The operator should be able to answer these questions quickly:

- What is running?
- What needs me?
- What is stuck, failed, or waiting?
- What can I do right now?
- What changed while I was away?

The UI should avoid becoming primarily a chat app. Chat/transcript remains available for context, but the primary product object is the orchestrated issue pipeline: issue, step, agent, attempt, verdict, interaction, and artifact.

## Scope

In scope for Phase 1:

- Replace the current dashboard experience with a Mission Control shell.
- Add a compact system status strip with current orchestration health signals.
- Promote the attention queue to a first-class region.
- Add board/list view modes over the same active issue data.
- Add basic search and filters for active work.
- Add a selected issue command panel on the right side of the Mission Control screen.
- Reuse existing issue detail components inside the command panel.
- Keep Respond available but secondary unless a selected issue needs human input.
- Persist basic view preferences in local storage.
- Continue using existing polling and per-issue WebSocket behavior; do not require a new global stream for Phase 1.

Out of scope for Phase 1:

- Backend action/capability DTOs.
- Global live dashboard event streams.
- Workspace file browsing.
- Workspace diff review.
- Rich finalization/review gate redesign.
- Keyboard shortcut system.
- Operator notes/annotations.
- Multi-user routing, assignment, or ownership.

Phase 2 follow-up issues exist for the out-of-scope items:

- #299 Mission Control Phase 2: backend action capabilities
- #300 Mission Control Phase 2: global live dashboard stream
- #301 Mission Control Phase 2: workspace file browser
- #302 Mission Control Phase 2: workspace diff review
- #303 Mission Control Phase 2: richer finalization and review gate
- #304 Mission Control Phase 2: operator productivity features

## Existing Starting Point

Relevant current UI files:

- `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- `crates/ensemble-ui/src-ui/src/components/KanbanBoard.tsx`
- `crates/ensemble-ui/src-ui/src/components/KanbanColumn.tsx`
- `crates/ensemble-ui/src-ui/src/components/IssueCard.tsx`
- `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx`
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueQuestionBanner.tsx`
- `crates/ensemble-ui/src-ui/src/components/issue-detail/IssueComposer.tsx`
- `crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx`
- `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx`
- `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
- `crates/ensemble-ui/src-ui/src/components/ArtifactsPanel.tsx`

Relevant current backend/API files:

- `crates/ensemble-core/src/api/router.rs`
- `crates/ensemble-core/src/api/handlers.rs`
- `crates/ensemble-core/src/api/ws.rs`
- `crates/ensemble-core/src/api/openapi.rs`

The current dashboard already has a useful Control Room foundation: running/retry/waiting/completed columns and an interaction queue. The current issue detail page already has the strongest building blocks for the command panel: question banner, composer, metrics, transcript, workflow sidebar, logs, raw events, and artifacts.

## UX Model

### Mission Control Shell

The primary web route should become a persistent Mission Control workspace with four regions:

1. Left navigation rail.
2. Top command and system status bar.
3. Center operations surface.
4. Right selected issue command panel.

Selecting an issue should not require leaving Mission Control. The right panel opens inline on desktop and can collapse or stack on smaller screens. Existing detail pages may remain as deep links, but the primary operator flow should happen in the shell.

### Top System Strip

The top strip should surface high-signal operational state from the existing dashboard snapshot when available:

- live/stale or loading/error state
- last tick time
- active/running issue count
- waiting-on-human count
- retrying count
- failed or retry-exhausted count
- rate-limit warning if present

The strip should also contain the main controls:

- refresh
- search
- basic filters
- board/list toggle
- attention-only toggle when the current snapshot can derive attention state without new backend fields; otherwise omit the toggle from Phase 1

The visual direction should be compact and operational: closer to an operations console than a marketing dashboard.

### Attention Queue

The attention queue is the highest-priority region because it answers "what needs me?".

It should include, using currently available data:

- active human questions
- failed or blocked issue states
- retry-exhausted issues
- finalization or artifact review needs if already represented in current state
- stale-running warnings if already derivable

Each attention item should show:

- issue identifier/title
- why it needs attention
- current step/agent if available
- age or last update if available
- a primary action such as Reply, Inspect, Retry, or Open

Phase 1 can keep action availability based on existing UI conditions. Backend-owned capability flags are Phase 2.

### Operations Surface

Mission Control should support two views over the same active issue collection.

Board view groups issues by operational state. Initial columns should map to existing states rather than inventing backend concepts:

- Running
- Retrying
- Waiting on Human
- Failed or Blocked
- Completed Recently

If existing data supports more precise groups, the implementation can split or rename columns, but it should avoid introducing states that are not actually backed by runtime data.

List view should support dense scanning of the same issues. It should show the same metadata as cards but in rows, with compact status, issue identity, current step, agent, updated time, and attention indicators.

Cards and rows should show:

- issue identifier and title/summary
- lifecycle/status badge
- current step
- current agent if available
- active task or current activity if available
- retry/attempt count if available
- turns/tokens if already available
- waiting/question indicator
- selected state

### Selected Issue Command Panel

The command panel should open when an issue is selected. It is the main place where the operator steps in.

Panel behavior:

- uses a fixed desktop width for Phase 1
- closable without losing dashboard state
- remembers active tab in local storage
- owns selected issue state inside Mission Control for Phase 1
- degrades to a full-width stacked panel or route-like view on mobile

The existing issue detail route should remain available for direct links. Phase 1 does not need to deep-link a selected panel state from the Mission Control route.

Initial tabs:

- Overview
- Respond
- Steps
- Transcript
- Logs
- Artifacts

Workspace and Diff are intentionally Phase 2.

#### Overview Tab

Overview should answer "what is happening and what can I do?".

It should show:

- issue identity
- current status
- current step and agent
- retry/attempt summary
- latest activity or timeline summary
- pending question summary if present
- primary intervention controls using existing action logic
- compact links/buttons to the deeper tabs

#### Respond Tab

Respond should not be the default mental model, but it should become visually prominent when the issue needs human input.

It should reuse `IssueQuestionBanner` and `IssueComposer` where possible.

States:

- If a human question is pending, show the question, context, and focused reply composer.
- If guidance can currently be sent through existing flows, allow guidance from this tab.
- If no response is possible, show a clear passive state and route the operator to Transcript or Steps for inspection.

#### Steps Tab

Steps should be pipeline-native. It should reuse or adapt `WorkflowStepsSidebar` and show the step DAG/statuses, current step, dependency state, retries, and verdicts where current data supports them.

This tab is more important than transcript for Ensemble's identity because Ensemble orchestrates issue pipelines rather than single chat sessions.

#### Transcript Tab

Transcript should reuse `RunTranscript` and remain the full conversational/activity context. It should be available for investigation but should not dominate the default UI.

#### Logs Tab

Logs should reuse `EventTimeline` and existing raw event views. It is for debugging and postmortems, not the primary operator path.

#### Artifacts Tab

Artifacts should reuse `ArtifactsPanel` and expose existing finalization output. A richer review gate is Phase 2.

## Data Flow

Phase 1 should prefer existing data contracts:

- dashboard snapshot/query for top-level issue collections and health metadata
- existing refresh mutation/control for manual refresh
- per-issue fetches for selected panel detail data
- existing per-issue WebSocket for live transcript/detail updates where available

The command panel may fetch detail data lazily when an issue is selected. It should avoid subscribing to every issue's detailed stream from the dashboard.

State ownership:

- URL or component state owns selected issue id.
- Local storage owns view mode and selected panel tab.
- Local storage owns attention-only preference only if the attention-only toggle is implemented in Phase 1.
- React Query remains the source for API-backed snapshots and selected issue detail.

Global streaming is explicitly Phase 2. Phase 1 can still feel substantially more live by preserving current polling and WebSocket behavior.

## Error Handling

Mission Control should make operational state failures obvious but non-destructive.

- If the dashboard snapshot fails, show an error panel with retry.
- If selected issue details fail, keep the board usable and show an error state in the command panel.
- If WebSocket disconnects for the selected issue, show stale/disconnected state near the panel header or transcript tab.
- If a reply/retry/stop action fails, keep the operator's input visible and show the backend error inline.
- Empty states should distinguish "nothing running" from "data failed to load".

## Visual Direction

The UI should feel like Mission Control:

- compact density
- neutral/dark-mode-friendly surfaces
- strong status hierarchy
- restrained color used for state and attention
- tabular numeric metadata
- clear selected states
- fewer large marketing-style cards
- more command-console structure

This should adapt Ensemble's existing Tailwind/shadcn-style primitives rather than introduce a full new design system.

Specific visual improvements:

- use a compact navigation rail
- align `Layout.tsx` styling with existing theme tokens instead of hard-coded grays where practical
- centralize status badge colors if touching related components
- reduce repeated whitespace in board cards
- make attention items more visually urgent than ordinary running cards

## Testing

Phase 1 should include tests appropriate to the UI changes:

- component tests for filtering/search/view-mode behavior if the current frontend test setup supports them
- tests for attention queue derivation if that logic is extracted into pure functions
- tests for local-storage preference parsing/fallbacks if non-trivial
- existing Rust/API tests should continue to pass because Phase 1 should not require backend contract changes

If the current frontend test harness cannot cover a behavior without significant new setup, the implementation should prefer pure helper tests plus the manual verification checklist rather than introduce a large testing framework change in this UI redesign.

Manual verification should include:

- empty dashboard state
- active running issue state
- waiting-on-human issue state
- selected issue panel tab switching
- reply flow from the command panel
- retry/stop controls where currently supported
- mobile/narrow layout behavior
- light and dark theme if both are supported by the current app

## Implementation Boundaries

The Phase 1 implementation should keep boundaries small:

- `MissionControl` page owns the shell layout and selection state.
- `MissionControlToolbar` owns top controls and view-mode changes.
- `AttentionQueue` owns prioritized attention items.
- `OperationsBoard` and `OperationsList` render the same normalized issue summaries.
- `IssueCommandPanel` owns selected issue tabs and detail fetches.
- Pure helpers normalize dashboard snapshot data into operational groups and attention items.

Existing components should be reused before rewriting:

- Keep `RunTranscript` as the transcript implementation.
- Keep `IssueComposer` as the reply/guidance implementation.
- Keep `WorkflowStepsSidebar` as the first Steps surface.
- Keep `EventTimeline` as the first Logs surface.
- Keep `ArtifactsPanel` as the first Artifacts surface.

## Acceptance Criteria

Phase 1 is complete when:

1. The dashboard route presents a Mission Control workspace instead of the current simple Control Room layout.
2. Operators can see active work, attention items, and system health from one screen.
3. Operators can switch between board and list views over active issues.
4. Operators can search/filter active issues using basic controls.
5. Selecting an issue opens an inline command panel without losing the operations overview.
6. The command panel exposes Overview, Respond, Steps, Transcript, Logs, and Artifacts tabs.
7. Pending human questions are visible from both the attention queue and selected issue panel.
8. Responding to an agent from the command panel uses the existing interaction flow.
9. Existing issue detail deep links still work or have a clear replacement path.
10. The implementation does not require Phase 2 backend APIs.

## Open Decisions Resolved For Phase 1

- Chat/transcript is secondary, not primary.
- Workspace and diff inspection are Phase 2.
- Backend action capabilities are Phase 2; Phase 1 can use existing action checks.
- Global dashboard streaming is Phase 2; Phase 1 can use current snapshot/polling behavior.
- Mission Control should borrow agent-runner's shell pattern but use Ensemble's pipeline-native ontology.
