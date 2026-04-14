# Transcript Identity Reuse and Window Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix transcript performance regressions by resetting window state when the issue/run changes and preserving grouped transcript entry identity for unchanged rows during live updates.

**Architecture:** Keep the existing transcript pipeline (`buildTranscriptEntries` -> `groupTranscriptEntries`) but add a reuse-aware reconciliation layer in `transcript-model.ts` that returns previous entry objects when their semantic content is unchanged. In `IssueDetail`, compute a stable transcript session key from issue + effective run, feed it into `RunTranscript`, and hold the previous grouped transcript entries in a ref so append-only updates can reuse row props across renders.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, existing Ensemble transcript components.

---

## File Structure

### Existing files to modify
- `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx` — add a `transcriptSessionKey` prop and reset the visible window when the viewed issue/run changes.
- `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx` — add regression coverage for session-key resets.
- `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts` — add reuse-aware transcript reconciliation helpers for single entries and grouped tool-activity entries.
- `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts` — verify unchanged entries retain object identity across append-only updates and that changed entries are replaced.
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` — compute `transcriptSessionKey`, store previous grouped entries in a ref, and call the reuse-aware transcript-model helper instead of blindly rebuilding props each render.

### Boundaries
- Do not add virtualization or a new dependency in this plan.
- Do not change transcript ordering, grouping rules, or entry rendering semantics.
- Do not change websocket/timeline fetch behavior beyond passing a stable transcript session key.
- Keep the fix local to transcript UI/model code.

---

### Task 1: Reset visible transcript history when the viewed session changes

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`

- [ ] **Step 1: Add the failing regression test for session resets**

```tsx
it("resets the visible history window when the transcript session changes", async () => {
  const user = userEvent.setup();
  const firstSessionEntries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));
  const secondSessionEntries = Array.from({ length: 55 }, (_, index) => ({
    ...makeMessageEntry(index + 1),
    id: `other:${index + 1}`,
    message: `other message ${index + 1}`,
  }));

  const { rerender } = render(
    <RunTranscript
      entries={firstSessionEntries}
      activeEntryId={null}
      onJumpToEntry={() => {}}
      transcriptSessionKey="todo-1:run-1"
    />,
  );

  await user.click(screen.getByRole("button", { name: "Load older activity" }));
  expect(screen.getByText("message 1")).toBeInTheDocument();

  rerender(
    <RunTranscript
      entries={secondSessionEntries}
      activeEntryId={null}
      onJumpToEntry={() => {}}
      transcriptSessionKey="todo-2:run-9"
    />,
  );

  expect(screen.queryByText("other message 1")).not.toBeInTheDocument();
  expect(screen.getByText("other message 55")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/RunTranscript.test.tsx`
Expected: FAIL because `RunTranscript` currently keeps the previously expanded `visibleCount` after rerendering with a different transcript source.

- [ ] **Step 3: Implement `transcriptSessionKey`-based reset in `RunTranscript.tsx`**

```tsx
interface RunTranscriptProps {
  entries: GroupedTranscriptEntry[];
  activeEntryId: string | null;
  onJumpToEntry: (entryId: string) => void;
  transcriptSessionKey: string;
}

export function RunTranscript({
  entries,
  activeEntryId,
  onJumpToEntry,
  transcriptSessionKey,
}: RunTranscriptProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ENTRY_COUNT);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_ENTRY_COUNT);
  }, [transcriptSessionKey]);

  useEffect(() => {
    if (!activeEntryId) {
      return;
    }

    const activeIndex = entries.findIndex((entry) => entry.id === activeEntryId);
    if (activeIndex < 0) {
      return;
    }

    const requiredVisibleCount = entries.length - activeIndex;
    setVisibleCount((current) => Math.max(current, requiredVisibleCount, INITIAL_VISIBLE_ENTRY_COUNT));
  }, [activeEntryId, entries]);

  const visibleEntryCount = Math.min(entries.length, visibleCount);
  const visibleEntries = useMemo(
    () => entries.slice(entries.length - visibleEntryCount),
    [entries, visibleEntryCount],
  );

  // existing empty-state and render body unchanged
}
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/RunTranscript.test.tsx`
Expected: PASS with the new session-reset regression covered.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.tsx \
  crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx
git commit -m "fix: reset transcript window per session"
```

### Task 2: Reuse transcript entry objects when semantic content is unchanged

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts`
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts`

- [ ] **Step 1: Add failing identity-reuse tests**

```ts
it("reuses unchanged grouped entries across append-only updates", () => {
  const first = reconcileGroupedTranscriptEntries(undefined, {
    conversation: [{ index: 1, role: "assistant", content: "hello", tool_calls: null }],
    interactions: [],
    events: [],
  });

  const second = reconcileGroupedTranscriptEntries(first, {
    conversation: [
      { index: 1, role: "assistant", content: "hello", tool_calls: null },
      { index: 2, role: "assistant", content: "new tail", tool_calls: null },
    ],
    interactions: [],
    events: [],
  });

  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[0]);
});

it("replaces an entry when its semantic payload changes", () => {
  const first = reconcileGroupedTranscriptEntries(undefined, {
    conversation: [{ index: 1, role: "user", content: "before", tool_calls: null }],
    interactions: [],
    events: [],
  });

  const second = reconcileGroupedTranscriptEntries(first, {
    conversation: [{ index: 1, role: "user", content: "after", tool_calls: null }],
    interactions: [],
    events: [],
  });

  expect(second[0]).not.toBe(first[0]);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts`
Expected: FAIL because the current model code rebuilds every entry and group object from scratch on each call.

- [ ] **Step 3: Implement reconciliation helpers in `transcript-model.ts`**

```ts
function sameTranscriptEntry(a: TranscriptEntry, b: TranscriptEntry): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.timestamp !== b.timestamp) {
    return false;
  }

  switch (a.kind) {
    case "agent_message":
      return a.message === (b as AgentMessageEntry).message;
    case "agent_question":
      return a.interaction === (b as AgentQuestionEntry).interaction;
    case "human_message":
      return a.message === (b as HumanMessageEntry).message;
    case "human_reply":
      return a.reply === (b as HumanReplyEntry).reply;
    case "error":
      return a.message === (b as ErrorEntry).message;
    case "step_event":
    case "workflow_event":
    case "verdict":
    case "tool_activity":
      return a.event === (b as typeof a).event;
  }
}

function sameGroupedEntry(a: GroupedTranscriptEntry, b: GroupedTranscriptEntry): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.timestamp !== b.timestamp) {
    return false;
  }

  if (a.kind !== "tool_activity_group" || b.kind !== "tool_activity_group") {
    return sameTranscriptEntry(a as TranscriptEntry, b as TranscriptEntry);
  }

  if (a.count !== b.count || a.defaultExpanded !== b.defaultExpanded || a.entries.length !== b.entries.length) {
    return false;
  }

  return a.entries.every((entry, index) => sameTranscriptEntry(entry, b.entries[index]!));
}

function reuseTranscriptEntries(
  previousEntries: TranscriptEntry[] | undefined,
  nextEntries: TranscriptEntry[],
): TranscriptEntry[] {
  const previousById = new Map(previousEntries?.map((entry) => [entry.id, entry]));

  return nextEntries.map((entry) => {
    const previous = previousById.get(entry.id);
    return previous && sameTranscriptEntry(previous, entry) ? previous : entry;
  });
}

function reuseGroupedEntries(
  previousEntries: GroupedTranscriptEntry[] | undefined,
  nextEntries: GroupedTranscriptEntry[],
): GroupedTranscriptEntry[] {
  const previousById = new Map(previousEntries?.map((entry) => [entry.id, entry]));

  return nextEntries.map((entry) => {
    const previous = previousById.get(entry.id);
    return previous && sameGroupedEntry(previous, entry) ? previous : entry;
  });
}

export function reconcileGroupedTranscriptEntries(
  previousEntries: GroupedTranscriptEntry[] | undefined,
  source: TranscriptSource,
): GroupedTranscriptEntry[] {
  const nextTranscriptEntries = buildTranscriptEntries(source);
  const stableTranscriptEntries = reuseTranscriptEntries(
    previousEntries?.flatMap((entry) => (entry.kind === "tool_activity_group" ? entry.entries : [entry])) as
      | TranscriptEntry[]
      | undefined,
    nextTranscriptEntries,
  );

  const nextGroupedEntries = groupTranscriptEntries(stableTranscriptEntries);
  return reuseGroupedEntries(previousEntries, nextGroupedEntries);
}
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts`
Expected: PASS with object-identity reuse covered for unchanged rows and replacement covered for changed rows.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts \
  crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.test.ts
git commit -m "refactor: reuse transcript entry identity"
```

### Task 3: Wire reconciliation into `IssueDetail` and verify the full transcript path

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx`

- [ ] **Step 1: Add the failing integration assertions for session-key wiring**

```tsx
it("resets transcript history after rerendering IssueDetail with a different run", async () => {
  const user = userEvent.setup();

  hooksMock.useConversationQuery.mockImplementation(() => ({
    data: {
      messages: Array.from({ length: 55 }, (_, index) => ({
        index: index + 1,
        role: "user",
        content: `history message ${index + 1}`,
        tool_calls: null,
      })),
    },
    isLoading: false,
    isError: false,
  }));

  const { rerender } = renderWithProviders(
    <Routes>
      <Route path="/issue/:identifier" element={<IssueDetail />} />
    </Routes>,
    { route: "/issue/todo-1" },
  );

  await user.click(screen.getByRole("button", { name: "Load older activity" }));
  expect(screen.getByText("history message 1")).toBeInTheDocument();

  hooksMock.useIssueDetailQuery.mockImplementation(() => ({
    data: {
      issue_identifier: "todo-1",
      status: "running",
      running: { step_name: "deploy", turn_count: 2, tokens: { total_tokens: 100 }, run_id: "run-2" },
      attempts: { restart_count: 0 },
      retry: null,
      last_error: null,
      issue: { title: "Deploy feature", labels: [] },
      workspace: { path: "/tmp/workspace" },
      workflow_steps: [],
      pending_input: null,
      current_interaction: null,
    },
    isLoading: false,
    isError: false,
    error: null,
  }));

  rerender(
    <Routes>
      <Route path="/issue/:identifier" element={<IssueDetail />} />
    </Routes>,
  );

  expect(screen.queryByText("history message 1")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the targeted integration tests to verify they fail**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/pages/IssueDetail.test.tsx src/components/transcript/RunTranscript.test.tsx`
Expected: FAIL because `IssueDetail` does not yet pass any session key into `RunTranscript` and still rebuilds transcript props from scratch.

- [ ] **Step 3: Update `IssueDetail.tsx` to use reconciliation and pass `transcriptSessionKey`**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildTranscriptEntries,
  groupTranscriptEntries,
  reconcileGroupedTranscriptEntries,
  type GroupedTranscriptEntry,
} from "@/components/transcript/transcript-model";

const transcriptSessionKey = `${identifier}:${effectiveRunId || "no-run"}`;
const previousTranscriptEntriesRef = useRef<GroupedTranscriptEntry[]>();

const transcriptEntries = useMemo(() => {
  const nextEntries = reconcileGroupedTranscriptEntries(previousTranscriptEntriesRef.current, {
    conversation: conversationQuery.data?.messages ?? [],
    interactions: interaction ? [interaction] : [],
    events,
  });

  previousTranscriptEntriesRef.current = nextEntries;
  return nextEntries;
}, [conversationQuery.data?.messages, interaction, events]);

<RunTranscript
  entries={transcriptEntries}
  activeEntryId={activeEntryId}
  onJumpToEntry={setActiveEntryId}
  transcriptSessionKey={transcriptSessionKey}
/>
```

Add a reset guard so old refs do not leak across sessions:

```tsx
useEffect(() => {
  previousTranscriptEntriesRef.current = undefined;
}, [transcriptSessionKey]);
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/transcript/transcript-model.test.ts src/components/transcript/RunTranscript.test.tsx src/pages/IssueDetail.test.tsx`
Expected: PASS with all transcript model, transcript windowing, and issue-detail integration regressions green.

- [ ] **Step 5: Run the broader frontend verification and commit**

Run: `cd crates/ensemble-ui/src-ui && pnpm test && pnpm run build`
Expected: PASS for the full frontend test suite and production build.

```bash
git add crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx \
  crates/ensemble-ui/src-ui/src/components/transcript/RunTranscript.test.tsx
git commit -m "fix: stabilize transcript rendering"
```

---

## Self-Review Checklist
- Spec coverage: includes the approved fixes for session-window reset and entry-identity reuse, and explicitly defers virtualization.
- Placeholder scan: no TODO/TBD markers remain.
- Type consistency: all new public names are consistent across tasks: `transcriptSessionKey` and `reconcileGroupedTranscriptEntries`.
