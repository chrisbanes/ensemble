# Control Room Transcript Design

Date: 2026-04-14  
Status: Draft for review

## Goal

Redesign Ensemble's issue/control-room detail UI so that agent conversation, human intervention, and workflow execution read as one coherent run transcript instead of three disconnected surfaces.

## Context

Today the issue detail experience is split across:
- `ConversationViewer.tsx` for raw chat messages
- `EventTimeline.tsx` for execution events
- `InteractionPanel.tsx` for blocked questions and replies

That split is functional, but it makes the user reconstruct the run mentally:
- the agent's question is in one card
- the surrounding execution state is in another panel
- the related chat is elsewhere

Vibe Kanban demonstrates two patterns worth borrowing:
1. chat is rendered as a typed activity stream rather than a generic list of bubbles
2. noisy low-level activity is summarized and expanded on demand instead of dominating the primary view

The redesign should borrow those patterns without losing Ensemble's ticket/workflow-first control-room identity.

## Requirements

1. The primary detail view must present a merged activity stream combining chat, workflow events, and human Q/A.
2. The design must remain broader than a chat-pane rewrite where broader shell changes materially improve the intervention workflow.
3. Low-level tool calls, stdout chunks, and progress spam should be collapsed by default.
4. The UI should stay question-first when an agent is blocked.
5. Workflow context, logs, artifacts, and raw details should remain accessible as supporting context.
6. The first implementation should be incremental and prefer a frontend normalization layer over immediate backend model churn.

## Proposed Product Model

The issue detail page should become a **run transcript shell** with four regions:

1. **Header summary**
   - issue identifier
   - run status
   - active step
   - retry/run metadata

2. **Primary transcript pane**
   - a single ordered stream of typed activity entries

3. **Pinned composer**
   - reply/follow-up surface at the bottom of the page
   - question-first mode when blocked

4. **Supporting context panel**
   - workflow
   - logs
   - artifacts/files
   - raw event details

This shifts the page from “three separate widgets” to “one narrative plus supporting inspection tools.”

## Primary Transcript Model

The center pane should render a normalized `TranscriptEntry[]` rather than separate raw message and timeline models.

### Entry families

The transcript should support these entry kinds:
- `agent_message`
- `human_message`
- `agent_question`
- `human_reply`
- `step_event`
- `workflow_event`
- `verdict`
- `tool_activity`
- `artifact_summary`
- `warning`
- `error`
- `system_note`

These are presentation-layer entry types, not necessarily new backend API types.

### Ordering

Entries should be merged using the best available chronology from:
- timeline sequence when available
- timestamps otherwise
- conversation indices where needed to preserve local message order

The important property is that the user sees one readable story:
- agent works
- agent asks
- human replies
- step resumes
- verdict arrives

## Presentation Rules

The transcript should optimize for signal first.

### Expanded by default
- `agent_question`
- `human_reply`
- `verdict`
- `error`
- blocked/failed step events
- currently active step banner/event

### Compact but visible
- `agent_message`
- `human_message`
- step completion rows
- retry/resume notices
- artifact summaries

### Collapsed by default
- tool calls
- stdout/output chunks
- repetitive progress updates
- verbose system chatter

Collapsed groups should render as concise summaries such as:
- “Ran 4 tools”
- “Build output (12 chunks)”
- “Progress updates (8)”

Each summary row should support expand/collapse inline.

## Layout Design

### Header

The top of the page should provide stable orientation without consuming too much vertical space:
- issue identifier
- status badge
- active step
- attempt/retry state
- live connection/run indicator
- key actions such as stop/retry

### Transcript pane

The transcript is the dominant surface.

Key behaviors:
- scroll to latest important activity
- highlight entries opened from context panel links
- jump to latest question
- jump to current step
- expand all activity for a step
- sticky “scroll to latest” affordance when the user is reading older items

### Composer

The composer should replace the feeling of “a separate reply card under the page.”

Modes:
- **Question mode** — answer the current agent question
- **Follow-up mode** — send a human note/instruction
- **Read-only/resolved mode** — interaction already answered
- **Error/retry mode** — contextual recovery actions

When blocked, the composer should display a pinned question banner with:
- question
- why blocked
- suggested answer
- step name
- link to the related transcript entry

This keeps the ask visible while preserving one unified activity surface.

### Supporting context panel

The right-side panel should support inspection without competing with the main transcript.

Recommended tabs:
- **Workflow**
- **Logs**
- **Artifacts**
- **Raw events**

The transcript stays primary; the panel is for deep inspection and orientation.

## Frontend Architecture

### Proposed component structure

The current split between `ConversationViewer`, `EventTimeline`, and `InteractionPanel` should evolve toward:

- `IssueDetailShell`
  - page layout, header, panel state, jump actions
- `RunTranscript`
  - renders the merged stream
- `transcript-model.ts`
  - merges and normalizes conversation, interaction, and timeline sources
- `TranscriptEntryRenderer`
  - dispatches by entry kind
- typed entry components such as:
  - `AgentMessageEntry`
  - `HumanMessageEntry`
  - `AgentQuestionEntry`
  - `HumanReplyEntry`
  - `StepEventEntry`
  - `VerdictEntry`
  - `ToolActivityGroupEntry`
  - `ArtifactSummaryEntry`
  - `ErrorEntry`
- `IssueComposer`
  - pinned bottom input and question handling
- `IssueContextPanel`
  - workflow/log/artifact/raw-event tabs

### Architectural rule

Normalization should happen before rendering.

That gives the UI one place to define:
- chronology
- grouping rules
- importance/weight
- entry-to-component mapping

This is the main structural lesson to borrow from Vibe Kanban.

## Data Flow

1. Fetch current sources:
   - conversation messages
   - pending/current interaction
   - persisted timeline events
   - live websocket events
2. Normalize into one ordered transcript model
3. Group adjacent low-level activity into collapsible summary entries
4. Render the transcript
5. Update the transcript as new replies, resumes, verdicts, and live events arrive

## Incremental Rollout Plan

The first version should not require an immediate backend redesign.

### Phase 1
- introduce `TranscriptEntry` normalization in the frontend
- replace the current conversation pane with typed transcript rendering

### Phase 2
- merge interaction UI into the transcript + pinned composer
- keep timeline accessible as supporting context rather than a co-equal primary section

### Phase 3
- improve grouping/collapse behavior
- add jump/highlight interactions between context panel and transcript

### Phase 4
- add virtualization and richer artifact/log summaries if transcript size makes it necessary

## Non-Goals

This design does not aim to:
- turn Ensemble into a generic workspace chat product
- remove workflow visibility in favor of chat-only interaction
- force a backend domain rewrite before the UI proves its value
- expose all low-level agent output by default in the main reading flow

## Testing Strategy

Tests should cover:
- transcript merge ordering
- grouping/collapse of noisy activity
- question/reply rendering
- highlight/jump behavior
- composer mode switching
- graceful fallback when one source is unavailable or delayed

## File Impact

Likely affected files/modules for implementation:
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- `crates/ensemble-ui/src-ui/src/components/ConversationViewer.tsx`
- `crates/ensemble-ui/src-ui/src/components/EventTimeline.tsx`
- `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx`
- new transcript normalization/rendering modules under `crates/ensemble-ui/src-ui/src/components/` and/or `lib/`

## Recommendation

Adopt a merged typed run transcript as the primary detail-view model.

Borrow from Vibe Kanban:
- typed activity presentation
- grouped noisy output
- stronger hierarchy in the transcript
- shell-level support for a stable, workspace-like reading experience

Keep Ensemble-specific identity by staying:
- ticket-first
- workflow-first
- question-first when blocked
- control-room oriented rather than generic-chat oriented
