# Control Room Transcript Cheap Wins Design

**Date:** 2026-04-14  
**Status:** Approved for planning  
**Scope:** Frontend-only follow-up to improve issue-detail transcript performance without full virtualization.

## Goal

Improve the control-room transcript's perceived performance by reducing initial render cost and lowering rerender churn during live updates, while preserving the current merged transcript UX and avoiding virtualization.

## Non-Goals

- No transcript virtualization
- No backend or API changes
- No changes to transcript ordering, grouping, or entry semantics
- No redesign of transcript entry components or issue-detail shell

## Recommended Approach

Use a hybrid strategy:

1. **Initial transcript windowing** to render only the most recent batch on first paint
2. **Incremental reveal of older entries** via a "Load older activity" control
3. **Memoized transcript rows and visible slices** so live updates mostly append to the tail instead of rerendering the entire transcript list

This gives most of the practical performance benefit of virtualization without the complexity of measuring variable-height rows, coordinating expansion state with virtualized lists, or reworking active-entry jump behavior.

## Architecture

### 1. Windowed transcript rendering

`RunTranscript` becomes responsible for rendering a visible tail window of `GroupedTranscriptEntry[]`.

Behavior:
- On first render, show only the newest batch (default target: 50 entries)
- If older entries exist, show a `Load older activity` button above the list
- Each click reveals another fixed-size batch from the hidden history
- New incoming entries remain visible immediately in the tail window

This keeps first paint bounded even when a run has accumulated a large transcript.

### 2. Active-entry visibility rules

The active-entry/highlight system must continue working even when an entry would otherwise be hidden by the window.

Rules:
- If `activeEntryId` targets an entry already visible, behave as today
- If it targets an entry in the hidden portion, automatically expand the window enough to include that entry
- This applies to transcript jumps triggered from transcript controls or raw-event conversation jumps

This avoids a broken state where the app tries to highlight an entry that is not actually mounted.

### 3. Memoized rendering

Transcript row rendering should avoid unnecessary churn during live updates.

Changes:
- Wrap row-level rendering so unchanged entries do not rerender when newer entries append
- Memoize the visible slice derived from the full transcript entry list and the current visible count
- Preserve existing expand/collapse local state for grouped tool activity entries

The goal is not perfect zero-rerender behavior; the goal is to prevent full-list repaint cost on every live append.

## UX Details

- Default batch size should be conservative and predictable; use a constant rather than an inline magic number
- `Load older activity` should appear only when hidden entries remain
- The button label may optionally include a count, but that is not required for this pass
- Empty state remains unchanged
- Composer, question banner, context panel, and raw events panel remain unchanged

## Data Flow

1. `IssueDetail` continues building the full grouped transcript model from conversation, interactions, and events
2. `RunTranscript` receives the full grouped entry array
3. `RunTranscript` computes the currently visible tail slice
4. `TranscriptEntryRenderer` renders only the visible slice
5. When `activeEntryId` changes, `RunTranscript` ensures the targeted entry becomes visible before rendering/highlighting it

This keeps normalization and ordering logic out of the UI windowing behavior.

## Error Handling

- If `activeEntryId` does not exist in the entry list, do nothing special
- If the transcript length is below the initial batch size, render everything and omit the load-more control
- If live updates arrive while older history is partially hidden, retain the user's current revealed amount and append new tail entries naturally

## Testing Strategy

Add/extend frontend tests for:

1. **Initial batch render**
   - Large transcript renders only the newest batch initially
   - Hidden older entries are not mounted
   - Load-more control is visible

2. **Incremental reveal**
   - Clicking `Load older activity` reveals one more batch
   - Control disappears once all entries are visible

3. **Active-entry visibility**
   - Setting `activeEntryId` to a hidden entry expands visibility enough for highlight to work

4. **Live-update behavior**
   - Appending a new entry preserves visible-window behavior and does not regress the visible transcript tail

5. **Regression coverage**
   - Empty state still works
   - Existing grouped activity expand/collapse behavior still works

## Risks and Tradeoffs

### Benefits
- Much lower implementation complexity than virtualization
- Good near-term performance win for large transcripts
- Preserves current architecture and UI behavior

### Tradeoffs
- Older history remains mounted only after explicit reveal, so extremely large transcripts can still grow expensive if the operator expands everything
- This is a pragmatic optimization, not a permanent solution for arbitrarily huge transcripts

## Follow-up Trigger

If real-world usage shows that users routinely expand very large histories or that tail windowing is still insufficient, the next step should be a separate virtualization spec and plan rather than extending this lightweight pass ad hoc.
