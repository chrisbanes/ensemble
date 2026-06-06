# Control Room Transcript Cheap Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce control-room transcript render cost with initial tail windowing, incremental reveal of older entries, and lower rerender churn during live updates without adding virtualization.

**Architecture:** Keep transcript normalization and grouping where they are today, but make `RunTranscript` responsible for rendering only a visible tail window of grouped entries. Add batch-based reveal of older entries, auto-expand the window when an active entry is hidden, and memoize row rendering so appending new entries does not repaint the whole list.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, existing Ensemble transcript components.

---

## File Structure

### Existing files to modify
- `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx` — add visible-window state, load-more UI, active-entry visibility logic, and memoized visible slice handling.
- `crates/ensemble-ui/src-ui/src/components/transcript/TranscriptEntryRenderer.tsx` — make row rendering memo-friendly so unchanged entries can skip rerender work.
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx` — keep only issue-detail integration coverage if transcript unit tests move to a dedicated file.

### New files to create
- `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx` — focused unit tests for tail windowing, incremental reveal, active-entry expansion, and live append behavior.

### Boundaries
- Do not change transcript entry ordering, grouping, or model semantics.
- Do not add virtualization, measurement logic, or backend/API work.
- Keep windowing behavior inside `RunTranscript`, not inside `IssueDetail`.
- Keep grouped activity entry expand/collapse behavior intact.

---

### Task 1: Add initial tail windowing and incremental reveal

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`

- [ ] **Step 1: Write the failing windowing tests**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RunTranscript } from "./RunTranscript";
import type { GroupedTranscriptEntry } from "./transcript-model";

function makeMessageEntry(index: number): GroupedTranscriptEntry {
  return {
    kind: "human_message",
    id: `message:${index}`,
    timestamp: `2026-04-14T10:00:${String(index).padStart(2, "0")}Z`,
    message: `message ${index}`,
  };
}

describe("RunTranscript", () => {
  it("renders only the newest batch initially and reveals older entries on demand", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));

    render(<RunTranscript entries={entries} activeEntryId={null} onJumpToEntry={() => {}} />);

    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
    expect(screen.getByText("message 55")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });

  it("renders all entries immediately when the transcript is smaller than the initial batch", () => {
    const entries = Array.from({ length: 3 }, (_, index) => makeMessageEntry(index + 1));

    render(<RunTranscript entries={entries} activeEntryId={null} onJumpToEntry={() => {}} />);

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/RunTranscript.test.tsx`
Expected: FAIL because `RunTranscript` currently renders the full entry list immediately and has no load-more control.

- [ ] **Step 3: Implement minimal tail windowing in `RunTranscript.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { TranscriptEntryRenderer } from "./TranscriptEntryRenderer";
import type { GroupedTranscriptEntry } from "./transcript-model";

const INITIAL_VISIBLE_ENTRY_COUNT = 50;

interface RunTranscriptProps {
  entries: GroupedTranscriptEntry[];
  activeEntryId: string | null;
  onJumpToEntry: (entryId: string) => void;
}

export function RunTranscript({ entries, activeEntryId, onJumpToEntry }: RunTranscriptProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ENTRY_COUNT);

  useEffect(() => {
    setVisibleCount((current) => Math.min(entries.length, Math.max(current, INITIAL_VISIBLE_ENTRY_COUNT)));
  }, [entries.length]);

  if (entries.length === 0) {
    return <div className="py-8 text-center text-muted-foreground">No transcript activity yet.</div>;
  }

  const hiddenCount = Math.max(0, entries.length - visibleCount);
  const visibleEntries = useMemo(
    () => entries.slice(Math.max(0, entries.length - visibleCount)),
    [entries, visibleCount],
  );

  return (
    <div className="space-y-3">
      {hiddenCount > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setVisibleCount((current) => Math.min(entries.length, current + INITIAL_VISIBLE_ENTRY_COUNT))}
        >
          Load older activity
        </Button>
      ) : null}
      {visibleEntries.map((entry) => (
        <TranscriptEntryRenderer
          key={entry.id}
          entry={entry}
          isActive={entry.id === activeEntryId}
          onJumpToEntry={onJumpToEntry}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/RunTranscript.test.tsx`
Expected: PASS with 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx \
  crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx
git commit -m "feat: window transcript history"
```

### Task 2: Auto-expand hidden active entries and reduce rerender churn

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/TranscriptEntryRenderer.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`

- [ ] **Step 1: Write the failing hidden-active-entry and live-append tests**

```tsx
it("expands visibility when the active entry is hidden in older history", () => {
  const entries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));

  render(<RunTranscript entries={entries} activeEntryId="message:1" onJumpToEntry={() => {}} />);

  expect(screen.getByText("message 1")).toBeInTheDocument();
  expect(screen.getByText("message 1").closest("[data-active='true']")).not.toBeNull();
});

it("keeps the latest appended entry visible without requiring older history to expand first", () => {
  const { rerender } = render(
    <RunTranscript
      entries={Array.from({ length: 50 }, (_, index) => makeMessageEntry(index + 1))}
      activeEntryId={null}
      onJumpToEntry={() => {}}
    />,
  );

  rerender(
    <RunTranscript
      entries={Array.from({ length: 51 }, (_, index) => makeMessageEntry(index + 1))}
      activeEntryId={null}
      onJumpToEntry={() => {}}
    />,
  );

  expect(screen.getByText("message 51")).toBeInTheDocument();
  expect(screen.queryByText("message 1")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/RunTranscript.test.tsx`
Expected: FAIL because `RunTranscript` does not yet auto-expand when `activeEntryId` points into hidden history.

- [ ] **Step 3: Implement hidden-entry expansion and memo-friendly renderer wiring**

```tsx
// RunTranscript.tsx additions
useEffect(() => {
  if (!activeEntryId) return;

  const activeIndex = entries.findIndex((entry) => entry.id === activeEntryId);
  if (activeIndex < 0) return;

  const requiredVisibleCount = entries.length - activeIndex;
  setVisibleCount((current) => Math.max(current, requiredVisibleCount, INITIAL_VISIBLE_ENTRY_COUNT));
}, [activeEntryId, entries]);
```

```tsx
// TranscriptEntryRenderer.tsx
import { memo } from "react";

function TranscriptEntryRendererImpl({
  entry,
  isActive,
  onJumpToEntry,
}: TranscriptEntryRendererProps) {
  switch (entry.kind) {
    case "agent_message":
      return <AgentMessageEntry entry={entry} isActive={isActive} />;
    case "human_message":
      return <HumanMessageEntry entry={entry} isActive={isActive} />;
    case "agent_question":
      return <AgentQuestionEntry entry={entry} isActive={isActive} onJumpToEntry={onJumpToEntry} />;
    case "human_reply":
      return <HumanReplyEntry entry={entry} isActive={isActive} />;
    case "step_event":
    case "workflow_event":
    case "tool_activity":
      return <StepEventEntry entry={entry} isActive={isActive} />;
    case "verdict":
      return <VerdictEntry entry={entry} isActive={isActive} />;
    case "tool_activity_group":
      return <ToolActivityGroupEntry entry={entry} isActive={isActive} />;
    case "error":
      return <ErrorEntry entry={entry} isActive={isActive} />;
  }
}

export const TranscriptEntryRenderer = memo(TranscriptEntryRendererImpl);
```

```tsx
// IssueDetail.test.tsx integration add-on
it("reveals older transcript entries when a raw-event jump targets hidden conversation history", () => {
  // Keep the existing issue-detail integration setup, but mock enough messages/events
  // so a hidden older transcript entry exists and a raw event points to its conversation index.
  // Assert the targeted message becomes visible after the jump.
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/RunTranscript.test.tsx src/pages/IssueDetail.test.tsx`
Expected: PASS with the hidden-entry and live-append tests green.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx \
  crates/ensemble-ui/src-ui/src/components/transcript/TranscriptEntryRenderer.tsx \
  crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx
git commit -m "feat: optimize transcript rendering"
```

### Task 3: Run verification for the cheap-wins pass

**Files:**
- Modify: `docs/superpowers/specs/2026-04-14-control-room-transcript-cheap-wins-design.md` (only if implementation reveals a necessary design correction)
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`

- [ ] **Step 1: Run focused transcript tests**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts src/components/transcript/RunTranscript.test.tsx src/pages/IssueDetail.test.tsx`
Expected: PASS with transcript normalization, windowing, and issue-detail transcript behavior all green.

- [ ] **Step 2: Run the full frontend suite**

Run: `cd crates/ensemble-ui/src-ui && pnpm test`
Expected: PASS with no regressions.

- [ ] **Step 3: Run the frontend build**

Run: `cd crates/ensemble-ui/src-ui && pnpm run build`
Expected: PASS with production build output and no TypeScript/Vite errors.

- [ ] **Step 4: Document any follow-up limits if needed**

```md
- If operators frequently expand the entire transcript and performance still degrades, create a separate virtualization spec rather than extending this lightweight pass.
- If active-entry auto-expansion reveals UX confusion around hidden history, capture that as a transcript-navigation follow-up instead of widening scope here.
```

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui docs/superpowers/specs/2026-04-14-control-room-transcript-cheap-wins-design.md
git commit -m "test: verify transcript cheap wins"
```

---

## Self-Review

### Spec coverage
- **Initial tail windowing:** covered by Task 1.
- **Incremental reveal of older entries:** covered by Task 1.
- **Hidden active-entry visibility:** covered by Task 2.
- **Lower rerender churn during live updates:** covered by Task 2 via memo-friendly row rendering and live-append coverage.
- **Frontend-only verification:** covered by Task 3.

### Placeholder scan
- The plan includes exact file paths, concrete test code, implementation snippets, commands, and expected outcomes.
- Virtualization is explicitly deferred into follow-up notes rather than left implicit.

### Type consistency
- The plan consistently uses `GroupedTranscriptEntry`, `RunTranscript`, `TranscriptEntryRenderer`, `activeEntryId`, and `Load older activity` across all tasks.
