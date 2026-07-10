# Mission Control Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current simple dashboard with a Mission Control workspace that shows active work, attention items, board/list views, and an inline selected issue command panel, while first fixing MVP UI action blockers that Mission Control would otherwise inherit.

**Architecture:** Phase 1 does not require the new Phase 2 capability DTOs or global-stream APIs. It does add the required additive `InteractionDetail.kind` and `InteractionDetail.awaiting_resume` fields, with explicit interaction status typing, so the frontend can implement the corrected respond/resume flow. Regenerate the OpenAPI specification and generated client from these compatible additions rather than editing generated files. First fix frontend/API-client correctness for encoded issue identifiers, interaction respond/resume, and minimal finalize approve/retry controls. Then add pure frontend normalization helpers that turn `RuntimeSnapshot` into Mission Control summaries, reuse existing issue-detail queries/components inside a new command panel, and keep `/issue/:identifier` as a deep-link detail route.

**Tech Stack:** React 19, TypeScript, Vite, TanStack Query, React Router, Tailwind 4, shadcn-style local UI primitives, Vitest, Testing Library.

---

## File Structure

Create these files:

- `crates/ensemble-ui/src-ui/src/pages/mission-control/model.ts`  
  Pure helpers for normalizing `RuntimeSnapshot` into operational issue summaries, board groups, attention items, search/filter results, and system stats.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/model.test.ts`  
  Unit tests for helper behavior.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControl.tsx`  
  Main page shell and state owner for selected issue, view mode, search, filter, and selected panel tab.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControlToolbar.tsx`  
  Top status strip, search, filters, board/list toggle, and refresh button.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/AttentionQueue.tsx`  
  First-class attention queue for human questions and recovery items.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/OperationsBoard.tsx`  
  Board view over normalized issue groups.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/OperationsList.tsx`  
  Dense list view over normalized issue summaries.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/IssueCommandPanel.tsx`  
  Inline selected issue panel with Overview, Respond, Steps, Transcript, Logs, and Artifacts tabs.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/useIssueRuntime.ts`  
  Reusable hook containing the selected issue detail queries, interaction detail query, live WebSocket merge logic, transcript entries, timeline events, and mutations currently embedded in `IssueDetail.tsx`.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/index.ts`  
  Barrel export for the Mission Control page.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControl.test.tsx`  
  Integration-style tests for rendering the shell, switching views, filtering, selecting an issue, and showing pending human input.
- `crates/ensemble-ui/src-ui/src/pages/mission-control/IssueCommandPanel.test.tsx`  
  Focused tests for selected issue panel states and tab behavior.

Modify these files:

- `crates/ensemble-ui/src-ui/src/hooks.ts`  
  Replace stale issue input flow, add or fix encoded wrappers for issue-scoped generated clients, and expose finalize approve/retry mutations.
- `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`  
  Replace implementation with a wrapper that renders `MissionControl`.
- `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`  
  Replace stale reply behavior, add minimal finalize controls, then replace duplicated runtime/query/WebSocket logic with `useIssueRuntime`; preserve the existing route and layout.
- Existing hook/API tests under `crates/ensemble-ui/src-ui/src/`  
  Add focused coverage for encoded issue identifiers, interaction reply/resume, and finalize approve/retry actions.
- `crates/ensemble-ui/src-ui/src/components/Layout.tsx`  
  Update shell styling to better support the full-width Mission Control page and use theme tokens instead of hard-coded gray nav colors.
- `crates/ensemble-ui/src-ui/src/pages/Dashboard.test.tsx`  
  Replace old Control Room assertions with Mission Control route assertions, or remove duplicated coverage if `MissionControl.test.tsx` fully covers the route wrapper.

Do not modify generated files under `crates/ensemble-ui/src-ui/src/generated/` manually.

Do not commit during implementation unless the user explicitly asks for commits.

---

### Task 0: Fix MVP Issue Action Foundations

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify/Create: focused frontend tests for hooks and `IssueDetail`

This task folds in #305, #306, and the minimal UI portion of #307. It must be completed before extracting `useIssueRuntime`, otherwise Mission Control will share stale reply and action behavior.

- [ ] **Step 1: Add failing tests for encoded issue identifiers**

Add focused frontend tests around the hook/client layer that verify UI request dispatch URL-encodes issue identifiers and step names before calling issue-scoped endpoints.

Cover at least these examples:

- issue identifier `repo#42`
- issue identifier `org/repo#42`
- step name with a slash or space if the existing step-detail/conversation path accepts arbitrary step names

The tested paths must include the endpoints the UI uses for:

- issue detail
- stop
- retry
- resume
- finalize approve
- finalize retry
- timeline
- step detail
- step conversation/transcript

Expected before the fix: at least one generated or wrapped client call leaves `#` or `/` unencoded in a path segment.

- [ ] **Step 2: Fix encoded issue and step path handling without manually editing generated files**

Do not edit `crates/ensemble-ui/src-ui/src/generated/` manually.

Use one of these implementation routes, choosing the smallest one that survives codegen:

- configure/fix the OpenAPI/codegen input so generated path parameters are encoded, then regenerate; or
- add handwritten wrapper functions in `hooks.ts` or a small adjacent API helper that use `customFetch` with `encodeURIComponent` for issue-scoped routes, and route UI hooks through those wrappers.

The fix must ensure `repo#42` does not become a URL fragment and `org/repo#42` does not become multiple path segments.

- [ ] **Step 3: Add failing tests for interaction reply/resume**

Update `IssueDetail` tests to cover answering a blocked issue from the composer.

The expected behavior is:

- submit calls `respondToInteraction` or the hook wrapping `POST /api/v1/interactions/{id}/respond`
- question replies send the correct interaction response body for the current interaction type
- after a successful response, the UI queues/resumes the issue with `POST /api/v1/issues/{identifier}/resume` when the interaction flow requires resume
- the stale `/api/v1/issues/{identifier}/input` route is not called
- failed reply or resume keeps the composer context visible and exposes an inline error

Expected before the fix: the test observes `useIssueInputMutation` or the stale issue-scoped input path.

- [ ] **Step 4: Replace stale issue input flow with interaction respond/resume**

Remove `useIssueInputMutation` from `IssueDetail` usage. Prefer removing the hook entirely if no callers remain; otherwise leave it only if another concrete current caller still needs it.

Use the existing `useRespondToInteractionMutation(identifier)` and `useResumeIssueMutation(identifier)` hooks, or replace them with a combined helper if that makes error handling clearer.

Implementation rules:

- derive the active interaction id from `pending_input.ask_id` or `current_interaction.interaction_request_id`
- fetch interaction detail with `useInteractionDetailQuery(interactionId)` as today
- map composer replies to the generated `InteractionResponseBody` shape expected by the interaction type
- after successful response, call resume for the same encoded issue identifier when the interaction state requires `awaiting_resume` or when the current backend contract requires explicit resume after response
- invalidate state, open interactions, and issue detail queries after response/resume
- do not post to `/api/v1/issues/{identifier}/input`

- [ ] **Step 5: Add failing tests for minimal finalize controls**

Add `IssueDetail` tests for finalize states exposed in `IssueDetailSnapshot`.

Cover:

- `pending_approval` renders an approval panel/button and calls finalize approve
- `failed` renders a retry panel/button and calls finalize retry
- `skipped_headless` or `in_progress` renders a clear passive/in-progress state, without exposing invalid actions
- finalize action errors remain visible inline

This is not #303's richer review gate. Keep the UI compact and action-focused.

- [ ] **Step 6: Implement finalize approve/retry mutations and minimal UI**

Add hook-level mutations for:

- `POST /api/v1/{identifier}/finalize/approve`
- `POST /api/v1/{identifier}/finalize/retry`

Ensure these paths encode the issue identifier. Invalidate state and issue detail queries on success.

Add a small finalize section in `IssueDetail.tsx`, near the existing stop/retry controls or artifacts summary, that reflects current finalize status from issue detail data. The section should be reusable or easy to move into `IssueCommandPanel` later.

- [ ] **Step 7: Run foundation tests**

Run:

```bash
pnpm test -- src/pages/IssueDetail.test.tsx
```

Working directory: `crates/ensemble-ui/src-ui`

Also run any hook/API test file added in this task.

Expected: PASS.

---

### Task 1: Add Mission Control Data Model Helpers

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/model.ts`
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/model.test.ts`

- [ ] **Step 1: Write failing tests for normalized groups, attention items, and search**

Create `crates/ensemble-ui/src-ui/src/pages/mission-control/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot } from "@/generated/models";
import {
  deriveMissionControlState,
  filterMissionControlIssues,
  type MissionControlFilters,
} from "./model";

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_totals: { input_tokens: 1000, output_tokens: 2500, total_tokens: 3500, seconds_running: 95 },
    counts: { running: 1, retrying: 1, waiting_on_human: 1, completed: 1 },
    generated_at: "2026-07-09T09:30:00Z",
    last_tick_at: "2026-07-09T09:29:58Z",
    poll_interval_ms: 3000,
    rate_limits: { limit: 100, remaining: 8, reset_at: "2026-07-09T10:00:00Z" },
    running: [
      {
        issue_id: "issue-running",
        issue_identifier: "repo#1",
        last_event: "tool_call",
        last_event_at: "2026-07-09T09:29:50Z",
        last_message: "Running tests",
        session_id: "session-1",
        started_at: "2026-07-09T09:00:00Z",
        state: "running",
        step_name: "build",
        tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        turn_count: 3,
      },
    ],
    retrying: [
      {
        issue_id: "issue-retry",
        issue_identifier: "repo#2",
        attempt: 2,
        due_at_ms: 1000,
        error: "clippy failed",
      },
    ],
    waiting_on_human: [
      {
        interaction_request_id: "ask-1",
        issue_id: "issue-waiting",
        issue_identifier: "repo#3",
        requested_at: "2026-07-09T09:10:00Z",
        step_name: "review",
      },
    ],
    completed: [
      {
        issue_id: "issue-completed",
        issue_identifier: "repo#4",
        completed_at: "2026-07-09T09:20:00Z",
        status: "completed_succeeded",
      },
    ],
    ...overrides,
  } as RuntimeSnapshot;
}

describe("mission-control model", () => {
  it("groups runtime snapshot rows into operational columns", () => {
    const state = deriveMissionControlState(snapshot());

    expect(state.groups.map((group) => [group.id, group.issues.map((issue) => issue.identifier)])).toEqual([
      ["running", ["repo#1"]],
      ["retrying", ["repo#2"]],
      ["waiting_on_human", ["repo#3"]],
      ["completed_recently", ["repo#4"]],
    ]);
  });

  it("promotes human questions and retry recovery into attention items", () => {
    const state = deriveMissionControlState(snapshot());

    expect(state.attentionItems.map((item) => [item.issueIdentifier, item.kind, item.primaryAction])).toEqual([
      ["repo#3", "human_input", "Reply"],
      ["repo#2", "retry", "Inspect"],
    ]);
  });

  it("derives compact system stats", () => {
    const state = deriveMissionControlState(snapshot());

    expect(state.stats).toMatchObject({
      running: 1,
      retrying: 1,
      waitingOnHuman: 1,
      completed: 1,
      lastTickAt: "2026-07-09T09:29:58Z",
      pollIntervalMs: 3000,
      rateLimitRemaining: 8,
      rateLimitLimit: 100,
    });
  });

  it("filters by search text and operational status", () => {
    const state = deriveMissionControlState(snapshot());
    const filters: MissionControlFilters = { query: "repo#2", status: "retrying", attentionOnly: false };

    expect(filterMissionControlIssues(state.issues, filters).map((issue) => issue.identifier)).toEqual([
      "repo#2",
    ]);
  });

  it("filters to attention-only issues", () => {
    const state = deriveMissionControlState(snapshot());
    const filters: MissionControlFilters = { query: "", status: "all", attentionOnly: true };

    expect(filterMissionControlIssues(state.issues, filters).map((issue) => issue.identifier)).toEqual([
      "repo#2",
      "repo#3",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm test -- src/pages/mission-control/model.test.ts
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: FAIL because `./model` does not exist.

- [ ] **Step 3: Implement the model helpers**

Create `crates/ensemble-ui/src-ui/src/pages/mission-control/model.ts`:

```ts
import type {
  CompletedRow,
  RetryRow,
  RunningSessionRow,
  RuntimeSnapshot,
  WaitingInteractionRow,
} from "@/generated/models";

export type MissionIssueStatus = "running" | "retrying" | "waiting_on_human" | "completed_recently";
export type MissionAttentionKind = "human_input" | "retry";
export type MissionPrimaryAction = "Reply" | "Inspect" | "Open";

export interface MissionIssueSummary {
  id: string;
  identifier: string;
  status: MissionIssueStatus;
  statusLabel: string;
  stepName: string | null;
  activity: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retryAttempt: number | null;
  tokenTotal: number | null;
  turnCount: number | null;
  attention: boolean;
  source: RunningSessionRow | RetryRow | WaitingInteractionRow | CompletedRow;
}

export interface MissionGroup {
  id: MissionIssueStatus;
  title: string;
  issues: MissionIssueSummary[];
}

export interface MissionAttentionItem {
  id: string;
  issueId: string;
  issueIdentifier: string;
  kind: MissionAttentionKind;
  title: string;
  detail: string;
  stepName: string | null;
  requestedAt: string | null;
  primaryAction: MissionPrimaryAction;
}

export interface MissionSystemStats {
  running: number;
  retrying: number;
  waitingOnHuman: number;
  completed: number;
  generatedAt: string;
  lastTickAt: string | null;
  pollIntervalMs: number;
  rateLimitRemaining: number | null;
  rateLimitLimit: number | null;
  rateLimitResetAt: string | null;
}

export interface MissionControlState {
  issues: MissionIssueSummary[];
  groups: MissionGroup[];
  attentionItems: MissionAttentionItem[];
  stats: MissionSystemStats;
}

export interface MissionControlFilters {
  query: string;
  status: MissionIssueStatus | "all";
  attentionOnly: boolean;
}

const GROUP_TITLES: Record<MissionIssueStatus, string> = {
  running: "Running",
  retrying: "Retrying",
  waiting_on_human: "Waiting on Human",
  completed_recently: "Completed Recently",
};

function runningIssue(row: RunningSessionRow): MissionIssueSummary {
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: "running",
    statusLabel: "Running",
    stepName: row.step_name ?? null,
    activity: row.last_message ?? row.last_event ?? row.state,
    updatedAt: row.last_event_at ?? row.started_at,
    startedAt: row.started_at,
    completedAt: null,
    retryAttempt: null,
    tokenTotal: row.tokens.total_tokens,
    turnCount: row.turn_count,
    attention: false,
    source: row,
  };
}

function retryIssue(row: RetryRow): MissionIssueSummary {
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: "retrying",
    statusLabel: "Retrying",
    stepName: null,
    activity: row.error ?? `Retry attempt ${row.attempt}`,
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    retryAttempt: row.attempt,
    tokenTotal: null,
    turnCount: null,
    attention: true,
    source: row,
  };
}

function waitingIssue(row: WaitingInteractionRow): MissionIssueSummary {
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: "waiting_on_human",
    statusLabel: "Waiting on Human",
    stepName: row.step_name,
    activity: "Agent needs input",
    updatedAt: row.requested_at,
    startedAt: null,
    completedAt: null,
    retryAttempt: null,
    tokenTotal: null,
    turnCount: null,
    attention: true,
    source: row,
  };
}

function completedIssue(row: CompletedRow): MissionIssueSummary {
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: "completed_recently",
    statusLabel: row.status,
    stepName: null,
    activity: row.status,
    updatedAt: row.completed_at,
    startedAt: null,
    completedAt: row.completed_at,
    retryAttempt: null,
    tokenTotal: null,
    turnCount: null,
    attention: false,
    source: row,
  };
}

export function deriveMissionControlState(snapshot: RuntimeSnapshot): MissionControlState {
  const issues = [
    ...snapshot.running.map(runningIssue),
    ...snapshot.retrying.map(retryIssue),
    ...snapshot.waiting_on_human.map(waitingIssue),
    ...snapshot.completed.map(completedIssue),
  ];

  const groups = (Object.keys(GROUP_TITLES) as MissionIssueStatus[]).map((id) => ({
    id,
    title: GROUP_TITLES[id],
    issues: issues.filter((issue) => issue.status === id),
  }));

  const attentionItems: MissionAttentionItem[] = [
    ...snapshot.waiting_on_human.map((row) => ({
      id: row.interaction_request_id,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier,
      kind: "human_input" as const,
      title: "Agent needs input",
      detail: `Waiting in ${row.step_name}`,
      stepName: row.step_name,
      requestedAt: row.requested_at,
      primaryAction: "Reply" as const,
    })),
    ...snapshot.retrying.map((row) => ({
      id: `retry:${row.issue_id}`,
      issueId: row.issue_id,
      issueIdentifier: row.issue_identifier,
      kind: "retry" as const,
      title: "Retry scheduled",
      detail: row.error ?? `Attempt ${row.attempt} is waiting to retry`,
      stepName: null,
      requestedAt: null,
      primaryAction: "Inspect" as const,
    })),
  ];

  return {
    issues,
    groups,
    attentionItems,
    stats: {
      running: snapshot.counts.running,
      retrying: snapshot.counts.retrying,
      waitingOnHuman: snapshot.counts.waiting_on_human,
      completed: snapshot.counts.completed,
      generatedAt: snapshot.generated_at,
      lastTickAt: snapshot.last_tick_at ?? null,
      pollIntervalMs: snapshot.poll_interval_ms,
      rateLimitRemaining: snapshot.rate_limits?.remaining ?? null,
      rateLimitLimit: snapshot.rate_limits?.limit ?? null,
      rateLimitResetAt: snapshot.rate_limits?.reset_at ?? null,
    },
  };
}

export function filterMissionControlIssues(
  issues: MissionIssueSummary[],
  filters: MissionControlFilters,
): MissionIssueSummary[] {
  const query = filters.query.trim().toLowerCase();
  return issues.filter((issue) => {
    if (filters.status !== "all" && issue.status !== filters.status) return false;
    if (filters.attentionOnly && !issue.attention) return false;
    if (!query) return true;
    return [issue.identifier, issue.statusLabel, issue.stepName, issue.activity]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(query));
  });
}

export function regroupMissionControlIssues(issues: MissionIssueSummary[]): MissionGroup[] {
  return (Object.keys(GROUP_TITLES) as MissionIssueStatus[]).map((id) => ({
    id,
    title: GROUP_TITLES[id],
    issues: issues.filter((issue) => issue.status === id),
  }));
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
pnpm test -- src/pages/mission-control/model.test.ts
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS.

---

### Task 2: Build Mission Control Toolbar and Attention Queue

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControlToolbar.tsx`
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/AttentionQueue.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControl.test.tsx`

- [ ] **Step 1: Add failing tests for toolbar stats and attention selection**

Create the first version of `MissionControl.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MissionAttentionItem, MissionSystemStats } from "./model";
import { AttentionQueue } from "./AttentionQueue";
import { MissionControlToolbar } from "./MissionControlToolbar";

const stats: MissionSystemStats = {
  running: 2,
  retrying: 1,
  waitingOnHuman: 1,
  completed: 3,
  generatedAt: "2026-07-09T09:30:00Z",
  lastTickAt: "2026-07-09T09:29:58Z",
  pollIntervalMs: 3000,
  rateLimitRemaining: 8,
  rateLimitLimit: 100,
  rateLimitResetAt: "2026-07-09T10:00:00Z",
};

const attentionItems: MissionAttentionItem[] = [
  {
    id: "ask-1",
    issueId: "issue-1",
    issueIdentifier: "repo#1",
    kind: "human_input",
    title: "Agent needs input",
    detail: "Waiting in review",
    stepName: "review",
    requestedAt: "2026-07-09T09:10:00Z",
    primaryAction: "Reply",
  },
];

describe("Mission Control shell components", () => {
  it("renders compact system stats and view controls", () => {
    render(
      <MissionControlToolbar
        stats={stats}
        query=""
        status="all"
        attentionOnly={false}
        viewMode="board"
        isRefreshing={false}
        onQueryChange={() => {}}
        onStatusChange={() => {}}
        onAttentionOnlyChange={() => {}}
        onViewModeChange={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByText("Mission Control")).toBeInTheDocument();
    expect(screen.getByText("2 running")).toBeInTheDocument();
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
    expect(screen.getByText("Rate 8/100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "false");
  });

  it("selects an attention item", async () => {
    const onSelectIssue = vi.fn();
    render(
      <AttentionQueue
        items={attentionItems}
        selectedIssueIdentifier={null}
        onSelectIssue={onSelectIssue}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Reply to repo#1/i }));

    expect(onSelectIssue).toHaveBeenCalledWith("repo#1");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm test -- src/pages/mission-control/MissionControl.test.tsx
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: FAIL because `MissionControlToolbar` and `AttentionQueue` do not exist.

- [ ] **Step 3: Implement `MissionControlToolbar`**

Create `MissionControlToolbar.tsx`:

```tsx
import type { MissionControlFilters, MissionIssueStatus, MissionSystemStats } from "./model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ViewMode = "board" | "list";

interface MissionControlToolbarProps extends MissionControlFilters {
  stats: MissionSystemStats;
  viewMode: ViewMode;
  isRefreshing: boolean;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: MissionIssueStatus | "all") => void;
  onAttentionOnlyChange: (value: boolean) => void;
  onViewModeChange: (value: ViewMode) => void;
  onRefresh: () => void;
}

const STATUS_OPTIONS: Array<{ value: MissionIssueStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "retrying", label: "Retrying" },
  { value: "waiting_on_human", label: "Waiting" },
  { value: "completed_recently", label: "Completed" },
];

function formatTime(value: string | null): string {
  if (!value) return "No tick yet";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function MissionControlToolbar({
  stats,
  query,
  status,
  attentionOnly,
  viewMode,
  isRefreshing,
  onQueryChange,
  onStatusChange,
  onAttentionOnlyChange,
  onViewModeChange,
  onRefresh,
}: MissionControlToolbarProps) {
  return (
    <header className="rounded-xl border bg-card/95 p-4 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Mission Control</h1>
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              Last tick {formatTime(stats.lastTickAt)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{stats.running} running</span>
            <span>{stats.retrying} retrying</span>
            <span>{stats.waitingOnHuman} waiting</span>
            <span>{stats.completed} completed</span>
            {stats.rateLimitLimit != null && stats.rateLimitRemaining != null ? (
              <span>Rate {stats.rateLimitRemaining}/{stats.rateLimitLimit}</span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search issues, steps, activity"
            className="h-9 min-w-64 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value as MissionIssueStatus | "all")}
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <Button
            variant={attentionOnly ? "default" : "outline"}
            size="sm"
            onClick={() => onAttentionOnlyChange(!attentionOnly)}
          >
            Attention only
          </Button>
          <div className="grid grid-cols-2 rounded-md border bg-muted p-1">
            {(["board", "list"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                onClick={() => onViewModeChange(mode)}
                className={cn(
                  "rounded px-3 py-1 text-sm font-medium capitalize text-muted-foreground",
                  viewMode === mode && "bg-background text-foreground shadow-sm",
                )}
              >
                {mode === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Implement `AttentionQueue`**

Create `AttentionQueue.tsx`:

```tsx
import type { MissionAttentionItem } from "./model";
import { cn } from "@/lib/utils";

interface AttentionQueueProps {
  items: MissionAttentionItem[];
  selectedIssueIdentifier: string | null;
  onSelectIssue: (identifier: string) => void;
}

function formatAge(value: string | null): string {
  if (!value) return "scheduled";
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AttentionQueue({ items, selectedIssueIdentifier, onSelectIssue }: AttentionQueueProps) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Needs Attention</h2>
          <p className="text-sm text-muted-foreground">Human questions and recovery paths.</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Nothing needs intervention right now.
        </div>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const selected = selectedIssueIdentifier === item.issueIdentifier;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectIssue(item.issueIdentifier)}
                aria-label={`${item.primaryAction} to ${item.issueIdentifier}`}
                className={cn(
                  "rounded-lg border p-3 text-left transition hover:border-primary/50 hover:bg-muted/40",
                  selected && "border-primary bg-primary/5",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{item.issueIdentifier}</div>
                    <div className="mt-1 text-sm text-foreground">{item.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">
                    {item.primaryAction}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{item.stepName ?? item.kind}</span>
                  <span>{formatAge(item.requestedAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run toolbar/attention tests**

Run:

```bash
pnpm test -- src/pages/mission-control/MissionControl.test.tsx
```

Expected: PASS.

---

### Task 3: Build Board and List Operations Surfaces

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/OperationsBoard.tsx`
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/OperationsList.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControl.test.tsx`

- [ ] **Step 1: Add failing tests for board/list selection**

Append these tests to `MissionControl.test.tsx`:

```tsx
import type { MissionGroup, MissionIssueSummary } from "./model";
import { OperationsBoard } from "./OperationsBoard";
import { OperationsList } from "./OperationsList";

function issue(overrides: Partial<MissionIssueSummary> = {}): MissionIssueSummary {
  return {
    id: "issue-1",
    identifier: "repo#1",
    status: "running",
    statusLabel: "Running",
    stepName: "build",
    activity: "Running tests",
    updatedAt: "2026-07-09T09:29:50Z",
    startedAt: "2026-07-09T09:00:00Z",
    completedAt: null,
    retryAttempt: null,
    tokenTotal: 150,
    turnCount: 3,
    attention: false,
    source: {} as MissionIssueSummary["source"],
    ...overrides,
  };
}

describe("Mission Control operation surfaces", () => {
  it("selects an issue from the board", async () => {
    const onSelectIssue = vi.fn();
    const groups: MissionGroup[] = [
      { id: "running", title: "Running", issues: [issue()] },
      { id: "retrying", title: "Retrying", issues: [] },
      { id: "waiting_on_human", title: "Waiting on Human", issues: [] },
      { id: "completed_recently", title: "Completed Recently", issues: [] },
    ];

    render(<OperationsBoard groups={groups} selectedIssueIdentifier={null} onSelectIssue={onSelectIssue} />);

    await userEvent.click(screen.getByRole("button", { name: /Open repo#1/i }));

    expect(onSelectIssue).toHaveBeenCalledWith("repo#1");
  });

  it("selects an issue from the list", async () => {
    const onSelectIssue = vi.fn();

    render(<OperationsList issues={[issue()]} selectedIssueIdentifier={null} onSelectIssue={onSelectIssue} />);

    await userEvent.click(screen.getByRole("button", { name: /Open repo#1/i }));

    expect(onSelectIssue).toHaveBeenCalledWith("repo#1");
    expect(screen.getByText("Running tests")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm test -- src/pages/mission-control/MissionControl.test.tsx
```

Expected: FAIL because `OperationsBoard` and `OperationsList` do not exist.

- [ ] **Step 3: Implement `OperationsBoard`**

Create `OperationsBoard.tsx`:

```tsx
import type { MissionGroup, MissionIssueSummary } from "./model";
import { cn } from "@/lib/utils";

interface OperationsBoardProps {
  groups: MissionGroup[];
  selectedIssueIdentifier: string | null;
  onSelectIssue: (identifier: string) => void;
}

function IssueTile({
  issue,
  selected,
  onSelect,
}: {
  issue: MissionIssueSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Open ${issue.identifier}`}
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border bg-background p-3 text-left shadow-sm transition hover:border-primary/50 hover:bg-muted/30",
        selected && "border-primary ring-1 ring-primary",
        issue.attention && "border-amber-400/70 bg-amber-50/40 dark:bg-amber-950/10",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-semibold">{issue.identifier}</div>
        {issue.attention ? <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">ATTN</span> : null}
      </div>
      <div className="mt-2 text-xs font-medium text-muted-foreground">{issue.stepName ?? issue.statusLabel}</div>
      {issue.activity ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{issue.activity}</div> : null}
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{issue.retryAttempt != null ? `retry ${issue.retryAttempt}` : issue.turnCount != null ? `${issue.turnCount} turns` : "--"}</span>
        <span>{issue.tokenTotal != null ? `${issue.tokenTotal} tokens` : issue.completedAt ? "complete" : "active"}</span>
      </div>
    </button>
  );
}

export function OperationsBoard({ groups, selectedIssueIdentifier, onSelectIssue }: OperationsBoardProps) {
  return (
    <div className="flex min-h-[28rem] gap-3 overflow-x-auto pb-2">
      {groups.map((group) => (
        <section key={group.id} className="flex w-72 shrink-0 flex-col rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">{group.title}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{group.issues.length}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {group.issues.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No issues</div>
            ) : (
              group.issues.map((issue) => (
                <IssueTile
                  key={`${group.id}:${issue.id}`}
                  issue={issue}
                  selected={selectedIssueIdentifier === issue.identifier}
                  onSelect={() => onSelectIssue(issue.identifier)}
                />
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement `OperationsList`**

Create `OperationsList.tsx`:

```tsx
import type { MissionIssueSummary } from "./model";
import { cn } from "@/lib/utils";

interface OperationsListProps {
  issues: MissionIssueSummary[];
  selectedIssueIdentifier: string | null;
  onSelectIssue: (identifier: string) => void;
}

export function OperationsList({ issues, selectedIssueIdentifier, onSelectIssue }: OperationsListProps) {
  if (issues.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No issues match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="grid grid-cols-[minmax(12rem,1.2fr)_9rem_minmax(10rem,1fr)_8rem] border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Issue</span>
        <span>Status</span>
        <span>Activity</span>
        <span className="text-right">Signals</span>
      </div>
      <div className="divide-y">
        {issues.map((issue) => {
          const selected = selectedIssueIdentifier === issue.identifier;
          return (
            <button
              key={`${issue.status}:${issue.id}`}
              type="button"
              aria-label={`Open ${issue.identifier}`}
              onClick={() => onSelectIssue(issue.identifier)}
              className={cn(
                "grid w-full grid-cols-[minmax(12rem,1.2fr)_9rem_minmax(10rem,1fr)_8rem] items-center gap-3 px-4 py-3 text-left text-sm transition hover:bg-muted/30",
                selected && "bg-primary/5",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{issue.identifier}</span>
                <span className="block truncate text-xs text-muted-foreground">{issue.stepName ?? "No active step"}</span>
              </span>
              <span className="text-xs text-muted-foreground">{issue.statusLabel}</span>
              <span className="truncate text-xs text-muted-foreground">{issue.activity ?? "--"}</span>
              <span className="text-right text-xs text-muted-foreground">
                {issue.attention ? "Needs attention" : issue.turnCount != null ? `${issue.turnCount} turns` : "--"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run board/list tests**

Run:

```bash
pnpm test -- src/pages/mission-control/MissionControl.test.tsx
```

Expected: PASS.

---

### Task 4: Extract Reusable Selected Issue Runtime Hook

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/useIssueRuntime.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Preserve existing IssueDetail behavior before extraction**

Run:

```bash
pnpm test -- src/pages/IssueDetail.test.tsx
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS before refactoring. If it fails before any edit, stop and inspect the existing failure.

- [ ] **Step 2: Create `useIssueRuntime` by moving the existing runtime logic**

Create `useIssueRuntime.ts` with the logic currently in `IssueDetail.tsx` from imports/useState/useEffect/useMemo through `pendingQuestion`. The hook must return all values needed by both `IssueDetail` and `IssueCommandPanel`.

Use this return shape exactly:

```ts
export interface IssueRuntimeState {
  identifier: string;
  data: IssueDetailSnapshot | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  interaction: InteractionDetail | undefined;
  pendingQuestion: {
    interactionId: string;
    question: string;
    whyBlocked: string;
    suggestedAnswer: string | null;
    stepName: string;
  } | null;
  isLiveRun: boolean;
  wsStatus: WsStatus;
  effectiveRunId: string;
  activeStepName: string | null;
  events: WsEventData[];
  transcriptEntries: GroupedTranscriptEntry[];
  activeTranscriptEntryId: string | null;
  transcriptSessionKey: string;
  timelineIsError: boolean;
  retryMutation: ReturnType<typeof useRetryMutation>;
  stopMutation: ReturnType<typeof useStopMutation>;
  respondMutation: ReturnType<typeof useRespondToInteractionMutation>;
  resumeMutation: ReturnType<typeof useResumeIssueMutation>;
  cancelMutation: ReturnType<typeof useCancelInteractionMutation>;
  finalizeApproveMutation: ReturnType<typeof useFinalizeApproveMutation>;
  finalizeRetryMutation: ReturnType<typeof useFinalizeRetryMutation>;
  submitInteractionReply: (value: string) => void;
  setActiveEntryIdForConversationIndex: (index: number) => void;
  setActiveEntryId: (entryId: string | null) => void;
}
```

The hook signature must be:

```ts
export function useIssueRuntime(identifier: string): IssueRuntimeState
```

Important extraction rules:

- Move `triggerNotification`, `formatTokens` should stay in `IssueDetail.tsx` only if still used there; otherwise move formatting to the consumer.
- Keep `requestPermissionIfNeeded()` and `connectWs()` behavior unchanged.
- Keep transcript deduplication and timeline merge behavior unchanged.
- Keep the corrected mutation behavior from Task 0 unchanged: interaction replies must use respond/resume, and finalize controls must use finalize approve/retry.
- Do not add new backend API calls.

- [ ] **Step 3: Update `IssueDetail.tsx` to use `useIssueRuntime`**

Replace the local query/WebSocket/transcript state setup with:

```tsx
const runtime = useIssueRuntime(identifier);
const {
  data,
  isLoading,
  isError,
  error,
  interaction,
  pendingQuestion,
  isLiveRun,
  wsStatus,
  effectiveRunId,
  activeStepName,
  events,
  transcriptEntries,
  activeTranscriptEntryId,
  transcriptSessionKey,
  timelineIsError,
  retryMutation,
  stopMutation,
  respondMutation,
  resumeMutation,
  cancelMutation,
  finalizeApproveMutation,
  finalizeRetryMutation,
  submitInteractionReply,
  setActiveEntryIdForConversationIndex,
  setActiveEntryId,
} = runtime;
```

Replace `timelineQuery.isError` with `timelineIsError`.

Replace repeated `activeEntrySessionKeyRef.current = transcriptSessionKey; setActiveEntryId(...)` callbacks with:

```tsx
onViewConversation={setActiveEntryIdForConversationIndex}
```

Replace `onJumpToEntry` with:

```tsx
onJumpToEntry={setActiveEntryId}
```

- [ ] **Step 4: Run IssueDetail tests after extraction**

Run:

```bash
pnpm test -- src/pages/IssueDetail.test.tsx
```

Expected: PASS with no behavior changes beyond the Task 0 interaction/finalize fixes already covered by tests.

- [ ] **Step 5: Run TypeScript check for the frontend**

Run:

```bash
pnpm exec tsc --noEmit
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS.

---

### Task 5: Build Selected Issue Command Panel

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/IssueCommandPanel.tsx`
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/IssueCommandPanel.test.tsx`

- [ ] **Step 1: Add panel tests for empty state and tabs**

Create `IssueCommandPanel.test.tsx` with mocked `useIssueRuntime`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { IssueCommandPanel } from "./IssueCommandPanel";

vi.mock("./useIssueRuntime", () => ({
  useIssueRuntime: vi.fn(() => ({
    identifier: "repo#1",
    data: {
      issue_identifier: "repo#1",
      issue_id: "issue-1",
      status: "running",
      running: {
        step_name: "build",
        turn_count: 3,
        tokens: { total_tokens: 150, input_tokens: 100, output_tokens: 50 },
      },
      retry: null,
      attempts: { restart_count: 1 },
      workspace: { path: "/tmp/workspace" },
      workflow_steps: [],
      artifacts: null,
      finalize: { status: "not_required", repos: [] },
      issue: { title: "Test issue" },
      last_error: null,
    },
    isLoading: false,
    isError: false,
    error: null,
    interaction: undefined,
    pendingQuestion: null,
    isLiveRun: true,
    wsStatus: "connected",
    effectiveRunId: "run-1",
    activeStepName: "build",
    events: [],
    transcriptEntries: [],
    activeTranscriptEntryId: null,
    transcriptSessionKey: "repo#1:run-1:build",
    timelineIsError: false,
    retryMutation: { mutate: vi.fn(), isPending: false },
    stopMutation: { mutate: vi.fn(), isPending: false },
    respondMutation: { mutate: vi.fn(), isPending: false },
    resumeMutation: { mutate: vi.fn(), isPending: false },
    cancelMutation: { mutate: vi.fn(), isPending: false },
    finalizeApproveMutation: { mutate: vi.fn(), isPending: false },
    finalizeRetryMutation: { mutate: vi.fn(), isPending: false },
    submitInteractionReply: vi.fn(),
    setActiveEntryIdForConversationIndex: vi.fn(),
    setActiveEntryId: vi.fn(),
  })),
}));

function renderPanel(activeTab = "overview") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#1"
          activeTab={activeTab}
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("IssueCommandPanel", () => {
  it("asks the operator to select an issue when empty", () => {
    render(
      <IssueCommandPanel
        identifier={null}
        activeTab="overview"
        onActiveTabChange={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Select an issue")).toBeInTheDocument();
  });

  it("renders selected issue overview", () => {
    renderPanel();

    expect(screen.getByText("repo#1")).toBeInTheDocument();
    expect(screen.getByText("Test issue")).toBeInTheDocument();
    expect(screen.getByText("Current step")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
  });

  it("can switch to the transcript tab", async () => {
    const onActiveTabChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <IssueCommandPanel
            identifier="repo#1"
            activeTab="overview"
            onActiveTabChange={onActiveTabChange}
            onClose={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(onActiveTabChange).toHaveBeenCalledWith("transcript");
  });

});
```

- [ ] **Step 2: Run panel tests and verify failure**

Run:

```bash
pnpm test -- src/pages/mission-control/IssueCommandPanel.test.tsx
```

Expected: FAIL because `IssueCommandPanel` does not exist.

- [ ] **Step 3: Implement `IssueCommandPanel`**

Create `IssueCommandPanel.tsx`:

```tsx
import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import ConfirmDialog from "@/components/ConfirmDialog";
import StatusBadge from "@/components/StatusBadge";
import EventTimeline from "@/components/EventTimeline";
import IssueInfoSection from "@/components/IssueInfoSection";
import WorkflowStepsSidebar from "@/components/WorkflowStepsSidebar";
import ArtifactsPanel from "@/components/ArtifactsPanel";
import { IssueComposer } from "@/components/issue-detail/IssueComposer";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import { useIssueRuntime } from "./useIssueRuntime";
import { cn } from "@/lib/utils";

export type IssueCommandPanelTab = "overview" | "respond" | "steps" | "transcript" | "logs" | "artifacts";

interface IssueCommandPanelProps {
  identifier: string | null;
  activeTab: IssueCommandPanelTab;
  onActiveTabChange: (tab: IssueCommandPanelTab) => void;
  onClose: () => void;
}

const TABS: Array<{ id: IssueCommandPanelTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "respond", label: "Respond" },
  { id: "steps", label: "Steps" },
  { id: "transcript", label: "Transcript" },
  { id: "logs", label: "Logs" },
  { id: "artifacts", label: "Artifacts" },
];

function formatTokens(value: number | undefined): string {
  if (value == null) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function IssueCommandPanel({ identifier, activeTab, onActiveTabChange, onClose }: IssueCommandPanelProps) {
  const runtime = useIssueRuntime(identifier ?? "");
  const [showStopConfirm, setShowStopConfirm] = useState(false);

  if (!identifier) {
    return (
      <aside className="flex h-full min-h-[28rem] w-full flex-col rounded-xl border bg-card p-6 lg:w-[28rem]">
        <div className="text-lg font-semibold">Select an issue</div>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose an issue from the board, list, or attention queue to inspect and intervene.
        </p>
      </aside>
    );
  }

  const {
    data,
    isLoading,
    isError,
    error,
    interaction,
    pendingQuestion,
    isLiveRun,
    wsStatus,
    events,
    transcriptEntries,
    activeTranscriptEntryId,
    transcriptSessionKey,
    timelineIsError,
    retryMutation,
    stopMutation,
    respondMutation,
    resumeMutation,
    cancelMutation,
    finalizeApproveMutation,
    finalizeRetryMutation,
    submitInteractionReply,
    setActiveEntryIdForConversationIndex,
    setActiveEntryId,
  } = runtime;

  const interactionSubmitting = respondMutation.isPending || resumeMutation.isPending;

  if (isLoading) {
    return <aside className="min-h-[28rem] rounded-xl border bg-card p-6 text-sm text-muted-foreground lg:w-[28rem]">Loading issue...</aside>;
  }

  if (isError || !data) {
    return (
      <aside className="min-h-[28rem] rounded-xl border bg-card p-6 lg:w-[28rem]">
        <div className="font-semibold text-destructive">Failed to load issue</div>
        <p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? error.message : "Unknown error"}</p>
      </aside>
    );
  }

  const finalizeStatus = data.finalize?.status;
  const canApproveFinalize = finalizeStatus === "pending_approval";
  const canRetryFinalize = finalizeStatus === "failed";

  return (
    <aside className="flex h-full min-h-[34rem] w-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:w-[30rem] xl:w-[34rem]">
      <div className="border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{data.issue_identifier}</h2>
              <StatusBadge status={data.status} />
            </div>
            {data.issue?.title ? <p className="mt-1 truncate text-sm text-muted-foreground">{data.issue.title}</p> : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close issue panel">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {isLiveRun ? (
            <Button variant="destructive" size="sm" onClick={() => setShowStopConfirm(true)}>Stop</Button>
          ) : null}
          {data.retry ? (
            <Button size="sm" onClick={() => retryMutation.mutate({ identifier })} disabled={retryMutation.isPending}>
              Retry
            </Button>
          ) : null}
          {canApproveFinalize ? (
            <Button size="sm" onClick={() => finalizeApproveMutation.mutate({ identifier })} disabled={finalizeApproveMutation.isPending}>
              Approve finalize
            </Button>
          ) : null}
          {canRetryFinalize ? (
            <Button size="sm" onClick={() => finalizeRetryMutation.mutate({ identifier })} disabled={finalizeRetryMutation.isPending}>
              Retry finalize
            </Button>
          ) : null}
          <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">WS: {isLiveRun ? wsStatus : "inactive"}</span>
        </div>
      </div>

      <div role="tablist" className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => onActiveTabChange(tab.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground",
              activeTab === tab.id && "bg-muted text-foreground",
              tab.id === "respond" && pendingQuestion && "text-primary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {activeTab === "overview" ? (
          <div className="space-y-4">
            {pendingQuestion ? (
              <button
                type="button"
                onClick={() => onActiveTabChange("respond")}
                className="w-full rounded-lg border border-primary/40 bg-primary/5 p-3 text-left"
              >
                <div className="text-sm font-semibold text-primary">Agent needs input</div>
                <p className="mt-1 text-sm">{pendingQuestion.question}</p>
              </button>
            ) : null}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border bg-muted/20 p-3"><div className="text-muted-foreground">Current step</div><div className="font-semibold">{data.running?.step_name ?? "--"}</div></div>
              <div className="rounded-lg border bg-muted/20 p-3"><div className="text-muted-foreground">Attempts</div><div className="font-semibold">{data.attempts.restart_count}</div></div>
              <div className="rounded-lg border bg-muted/20 p-3"><div className="text-muted-foreground">Turns</div><div className="font-semibold">{data.running?.turn_count ?? 0}</div></div>
              <div className="rounded-lg border bg-muted/20 p-3"><div className="text-muted-foreground">Tokens</div><div className="font-semibold">{formatTokens(data.running?.tokens.total_tokens)}</div></div>
            </div>
            {finalizeStatus && finalizeStatus !== "not_required" ? (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="font-medium">Finalize</div>
                <div className="mt-1 text-muted-foreground">{finalizeStatus}</div>
              </div>
            ) : null}
            {data.last_error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{data.last_error}</div> : null}
          </div>
        ) : null}

        {activeTab === "respond" ? (
          <div className="space-y-3">
            {pendingQuestion ? (
              <IssueComposer
                pendingQuestion={pendingQuestion}
                onSubmitReply={submitInteractionReply}
                onSubmitFollowUp={() => {}}
                isSubmitting={interactionSubmitting}
              />
            ) : (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                No response is currently available. Use Transcript or Steps to inspect the issue.
              </div>
            )}
            {interaction && interaction.status !== "resolved" ? (
              <Button variant="outline" size="sm" onClick={() => cancelMutation.mutate({ id: interaction.id })} disabled={cancelMutation.isPending}>
                Cancel Request
              </Button>
            ) : null}
          </div>
        ) : null}

        {activeTab === "steps" ? (
          data.workflow_steps && data.workflow_steps.length > 0 ? (
            <WorkflowStepsSidebar steps={data.workflow_steps} issueIdentifier={identifier} currentStep={data.running?.step_name ?? undefined} />
          ) : (
            <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">No workflow steps available.</div>
          )
        ) : null}

        {activeTab === "transcript" ? (
          <RunTranscript
            entries={transcriptEntries}
            activeEntryId={activeTranscriptEntryId}
            onJumpToEntry={setActiveEntryId}
            transcriptSessionKey={transcriptSessionKey}
          />
        ) : null}

        {activeTab === "logs" ? (
          <div className="space-y-3">
            {timelineIsError ? <p className="text-sm text-amber-700">Could not load saved timeline history; showing live events only.</p> : null}
            <EventTimeline events={events} live={isLiveRun} onViewConversation={setActiveEntryIdForConversationIndex} />
          </div>
        ) : null}

        {activeTab === "artifacts" ? (
          <div className="space-y-3">
            <ArtifactsPanel identifier={identifier} workspacePath={data.workspace.path} artifacts={data.artifacts ?? null} />
            {data.issue ? <IssueInfoSection issue={data.issue} /> : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={showStopConfirm}
        title="Stop Agent"
        message={`Are you sure you want to stop the agent for ${identifier}? This action cannot be undone.`}
        confirmLabel="Stop"
        onConfirm={() => {
          stopMutation.mutate({ identifier });
          setShowStopConfirm(false);
        }}
        onCancel={() => setShowStopConfirm(false)}
      />
    </aside>
  );
}
```

- [ ] **Step 4: Run panel tests**

Run:

```bash
pnpm test -- src/pages/mission-control/IssueCommandPanel.test.tsx
```

Expected: PASS.

---

### Task 6: Compose the Mission Control Page

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControl.tsx`
- Create: `crates/ensemble-ui/src-ui/src/pages/mission-control/index.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/Dashboard.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/mission-control/MissionControl.test.tsx`

- [ ] **Step 1: Add failing integration tests for Mission Control page**

Replace `Dashboard.test.tsx` with route-level assertions for the new dashboard wrapper:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import Dashboard from "./Dashboard";
import type { RuntimeSnapshot } from "@/generated/models";

function mockSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    counts: { running: 1, retrying: 0, waiting_on_human: 1, completed: 0 },
    generated_at: "2026-07-09T09:30:00Z",
    last_tick_at: "2026-07-09T09:29:58Z",
    poll_interval_ms: 3000,
    running: [
      {
        issue_id: "issue-running",
        issue_identifier: "repo#1",
        last_event: "tool_call",
        last_event_at: "2026-07-09T09:29:50Z",
        last_message: "Running tests",
        session_id: "session-1",
        started_at: "2026-07-09T09:00:00Z",
        state: "running",
        step_name: "build",
        tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        turn_count: 3,
      },
    ],
    retrying: [],
    waiting_on_human: [
      {
        interaction_request_id: "ask-1",
        issue_id: "issue-waiting",
        issue_identifier: "repo#2",
        requested_at: "2026-07-09T09:10:00Z",
        step_name: "review",
      },
    ],
    completed: [],
    ...overrides,
  } as RuntimeSnapshot;
}

function renderDashboardWithData(data: RuntimeSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["/api/v1/state"], data);

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Dashboard", () => {
  it("renders Mission Control with attention and operations surfaces", () => {
    renderDashboardWithData(mockSnapshot());

    expect(screen.getByText("Mission Control")).toBeInTheDocument();
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("repo#1")).toBeInTheDocument();
    expect(screen.getByText("repo#2")).toBeInTheDocument();
  });
});
```

Append a full-page view-mode test to `MissionControl.test.tsx` after the component imports exist:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import MissionControl from "./MissionControl";
import type { RuntimeSnapshot } from "@/generated/models";

function renderMissionControl(snapshot: RuntimeSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["/api/v1/state"], { data: snapshot });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MissionControl />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

Add this test:

```tsx
it("switches from board to list view", async () => {
  renderMissionControl(snapshot());

  await userEvent.click(screen.getByRole("button", { name: "List" }));

  expect(screen.getByText("Activity")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run route/page tests and verify failure**

Run:

```bash
pnpm test -- src/pages/Dashboard.test.tsx src/pages/mission-control/MissionControl.test.tsx
```

Expected: FAIL because `MissionControl` does not exist or dashboard still renders the old page.

- [ ] **Step 3: Implement `MissionControl` page**

Create `MissionControl.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRefreshMutation, useStateQuery } from "@/hooks";
import {
  deriveMissionControlState,
  filterMissionControlIssues,
  regroupMissionControlIssues,
  type MissionControlFilters,
  type MissionIssueStatus,
} from "./model";
import { MissionControlToolbar } from "./MissionControlToolbar";
import { AttentionQueue } from "./AttentionQueue";
import { OperationsBoard } from "./OperationsBoard";
import { OperationsList } from "./OperationsList";
import { IssueCommandPanel, type IssueCommandPanelTab } from "./IssueCommandPanel";

type ViewMode = "board" | "list";

const VIEW_MODE_KEY = "ensemble.mission-control.view-mode";
const ACTIVE_TAB_KEY = "ensemble.mission-control.active-tab";
const ATTENTION_ONLY_KEY = "ensemble.mission-control.attention-only";

function readViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "board";
}

function readActiveTab(): IssueCommandPanelTab {
  const value = localStorage.getItem(ACTIVE_TAB_KEY);
  return value === "respond" || value === "steps" || value === "transcript" || value === "logs" || value === "artifacts"
    ? value
    : "overview";
}

export default function MissionControl() {
  const { data, isLoading, isError, error } = useStateQuery();
  const refreshMutation = useRefreshMutation();
  const [selectedIssueIdentifier, setSelectedIssueIdentifier] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>(readActiveTab);
  const [filters, setFilters] = useState<MissionControlFilters>({
    query: "",
    status: "all",
    attentionOnly: localStorage.getItem(ATTENTION_ONLY_KEY) === "true",
  });

  useEffect(() => localStorage.setItem(VIEW_MODE_KEY, viewMode), [viewMode]);
  useEffect(() => localStorage.setItem(ACTIVE_TAB_KEY, activeTab), [activeTab]);
  useEffect(() => localStorage.setItem(ATTENTION_ONLY_KEY, String(filters.attentionOnly)), [filters.attentionOnly]);

  const missionState = useMemo(() => (data ? deriveMissionControlState(data) : null), [data]);
  const filteredIssues = useMemo(
    () => (missionState ? filterMissionControlIssues(missionState.issues, filters) : []),
    [filters, missionState],
  );
  const filteredGroups = useMemo(() => regroupMissionControlIssues(filteredIssues), [filteredIssues]);

  function selectIssue(identifier: string) {
    setSelectedIssueIdentifier(identifier);
    const attentionItem = missionState?.attentionItems.find((item) => item.issueIdentifier === identifier);
    if (attentionItem?.kind === "human_input") {
      setActiveTab("respond");
    }
  }

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground">Loading Mission Control...</div>;
  }

  if (isError || !missionState) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        <div className="font-semibold text-destructive">Failed to load Mission Control</div>
        <p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? error.message : "Unknown error"}</p>
        <Button className="mt-4" onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <MissionControlToolbar
        stats={missionState.stats}
        query={filters.query}
        status={filters.status}
        attentionOnly={filters.attentionOnly}
        viewMode={viewMode}
        isRefreshing={refreshMutation.isPending}
        onQueryChange={(query) => setFilters((current) => ({ ...current, query }))}
        onStatusChange={(status: MissionIssueStatus | "all") => setFilters((current) => ({ ...current, status }))}
        onAttentionOnlyChange={(attentionOnly) => setFilters((current) => ({ ...current, attentionOnly }))}
        onViewModeChange={setViewMode}
        onRefresh={() => refreshMutation.mutate()}
      />

      <AttentionQueue
        items={missionState.attentionItems}
        selectedIssueIdentifier={selectedIssueIdentifier}
        onSelectIssue={selectIssue}
      />

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_34rem]">
        <main className="min-w-0">
          {viewMode === "board" ? (
            <OperationsBoard
              groups={filteredGroups}
              selectedIssueIdentifier={selectedIssueIdentifier}
              onSelectIssue={selectIssue}
            />
          ) : (
            <OperationsList
              issues={filteredIssues}
              selectedIssueIdentifier={selectedIssueIdentifier}
              onSelectIssue={selectIssue}
            />
          )}
        </main>
        <IssueCommandPanel
          identifier={selectedIssueIdentifier}
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          onClose={() => setSelectedIssueIdentifier(null)}
        />
      </div>
    </div>
  );
}
```

Create `index.ts`:

```ts
export { default } from "./MissionControl";
```

- [ ] **Step 4: Replace `Dashboard.tsx` with wrapper**

Replace `Dashboard.tsx` with:

```tsx
import MissionControl from "./mission-control";

export default function Dashboard() {
  return <MissionControl />;
}
```

- [ ] **Step 5: Run Mission Control page tests**

Run:

```bash
pnpm test -- src/pages/Dashboard.test.tsx src/pages/mission-control/MissionControl.test.tsx src/pages/mission-control/IssueCommandPanel.test.tsx
```

Expected: PASS.

---

### Task 7: Update Layout Shell for Mission Control

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/Layout.tsx`
- Test: existing layout coverage if present; otherwise verify through dashboard tests and manual build

- [ ] **Step 1: Update `Layout.tsx` to use tokenized shell styles**

Replace the hard-coded gray nav classes with tokenized classes and let Mission Control use more horizontal space.

Use this structure in `Layout.tsx` while preserving notification, theme, config gating, and routes:

```tsx
return (
  <div className="flex min-h-screen bg-background text-foreground">
    <aside className="hidden w-16 shrink-0 flex-col items-center border-r bg-card px-2 py-3 md:flex">
      <NavLink to="/" end className={(props) => navIconClass(props, !isConfigRunnable)} aria-label="Mission Control">
        MC
      </NavLink>
      <NavLink to="/history" className={(props) => navIconClass(props, !isConfigRunnable)} aria-label="History">
        H
      </NavLink>
      <NavLink to="/config" className={navIconClass} aria-label="Config">
        C
      </NavLink>
      <div className="flex-1" />
      {/* keep notification popover and theme button here */}
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <nav className="flex h-14 items-center justify-between border-b bg-card px-4 md:hidden">
        {/* keep text nav for mobile */}
      </nav>
      <main className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <Outlet />
      </main>
    </div>
  </div>
);
```

Add a helper next to `navLinkClass`:

```tsx
function navIconClass({ isActive }: { isActive: boolean }, disabled = false) {
  return cn(
    "mb-2 flex h-10 w-10 items-center justify-center rounded-lg text-xs font-semibold transition-colors",
    isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    disabled && "pointer-events-none cursor-not-allowed opacity-50",
  );
}
```

Keep the current mobile/text `navLinkClass`, but change it to token classes:

```tsx
function navLinkClass({ isActive }: { isActive: boolean }, disabled = false) {
  return cn(
    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    disabled && "pointer-events-none cursor-not-allowed opacity-50",
  );
}
```

- [ ] **Step 2: Run dashboard tests after layout changes**

Run:

```bash
pnpm test -- src/pages/Dashboard.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript check**

Run:

```bash
pnpm exec tsc --noEmit
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS.

---

### Task 8: Final Verification and Documentation Check

**Files:**
- Existing implementation files from previous tasks
- Existing docs only if implementation behavior diverges from `docs/superpowers/specs/2026-07-09-mission-control-phase-1-design.md`

- [ ] **Step 1: Run focused frontend tests**

Run:

```bash
pnpm test -- src/pages/mission-control/model.test.ts src/pages/mission-control/MissionControl.test.tsx src/pages/mission-control/IssueCommandPanel.test.tsx src/pages/Dashboard.test.tsx src/pages/IssueDetail.test.tsx
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS.

- [ ] **Step 2: Run full frontend tests**

Run:

```bash
pnpm test
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
pnpm run build
```

Working directory: `crates/ensemble-ui/src-ui`

Expected: PASS.

- [ ] **Step 4: Run Rust checks that should be unaffected by UI-only work**

Run:

```bash
SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
```

Working directory: repository root.

Expected: PASS.

- [ ] **Step 5: Manual verification checklist**

Start the web UI using the project’s normal development flow and verify:

- Empty state distinguishes no work from load failure.
- Mission Control shows system strip, attention queue, board, and selected issue panel.
- Board view shows Running, Retrying, Waiting on Human, and Completed Recently columns.
- List view shows the same filtered issues in dense rows.
- Search narrows visible issues by issue id, step, status, or activity.
- Status filter narrows visible issues by operational state.
- Attention-only shows retrying and waiting-on-human issues.
- Selecting a waiting human issue opens the command panel and activates Respond.
- Respond tab can submit through the existing interaction flow.
- Steps tab renders workflow status when available.
- Transcript tab renders existing transcript entries.
- Logs tab renders timeline events.
- Artifacts tab renders existing artifacts.
- `/issue/:identifier` still renders the standalone issue detail page.
- Narrow viewport keeps the UI usable by stacking the panel below the operations surface.

- [ ] **Step 6: Documentation drift check**

Compare the implementation to `docs/superpowers/specs/2026-07-09-mission-control-phase-1-design.md`.

If the implementation changes user-visible behavior beyond the spec, update the spec or relevant docs before finishing. If not, state in the completion summary that no additional docs were needed because the design spec already covers the behavior.

---

## Self-Review Notes

Spec coverage:

- MVP action foundations: Task 0 covers #305, #306, and minimal #307 before Mission Control shares issue-detail behavior.
- Mission Control shell: Tasks 6 and 7.
- System strip: Task 2.
- Attention queue: Task 2.
- Board/list views: Task 3 and Task 6.
- Search/basic filters: Task 1 and Task 6.
- Selected issue command panel: Task 4 and Task 5.
- Reuse existing detail components: Task 5.
- Local storage preferences: Task 6.
- Existing polling and per-issue WebSocket behavior: Task 4 and Task 6.
- Phase 2 exclusions: no task adds backend capabilities, global stream, workspace browser, diff review, keyboard shortcuts, operator notes, or the richer #303 finalization/review gate. Task 0 only adds minimal finalize approve/retry controls for the existing backend endpoints.

Placeholder scan:

- The plan intentionally avoids deferred implementation placeholders.
- The only flexible areas are explicitly bounded by the Phase 1 spec, such as omitting attention-only persistence only if the toggle is omitted; this plan implements the toggle and persistence.

Type consistency:

- `MissionIssueStatus`, `MissionControlFilters`, and `IssueCommandPanelTab` names are introduced before use.
- `useIssueRuntime` return shape is shared by `IssueDetail` and `IssueCommandPanel`.
- Query cache setup uses the existing `useStateQuery` query key `['/api/v1/state']` with `{ data: snapshot }`, matching the current tests and generated client response shape.
