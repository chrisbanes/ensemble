import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postRefresh } from "@/generated/api/controls/controls";
import { getState } from "@/generated/api/state/state";
import type { IssueDetailSnapshot, RuntimeSnapshot } from "@/generated/models";
import { AttentionQueue } from "./AttentionQueue";
import MissionControl from "./MissionControl";
import { MissionControlToolbar } from "./MissionControlToolbar";
import { OperationsBoard } from "./OperationsBoard";
import { OperationsList } from "./OperationsList";
import type { MissionAttentionItem, MissionGroup, MissionIssueSummary, MissionSystemStats } from "./model";
import { useIssueRuntime, type IssueRuntimeState } from "./useIssueRuntime";

vi.mock("@/generated/api/controls/controls", () => ({ postRefresh: vi.fn() }));
vi.mock("@/generated/api/state/state", () => ({ getState: vi.fn() }));
vi.mock("./useIssueRuntime", () => ({ useIssueRuntime: vi.fn() }));

const VIEW_MODE_KEY = "ensemble.mission-control.view-mode";
const ACTIVE_TAB_KEY = "ensemble.mission-control.active-tab";
const ATTENTION_ONLY_KEY = "ensemble.mission-control.attention-only";
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);

const storedPreferences = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return storedPreferences.size;
  },
  clear: () => storedPreferences.clear(),
  getItem: (key) => storedPreferences.get(key) ?? null,
  key: (index) => [...storedPreferences.keys()][index] ?? null,
  removeItem: (key) => storedPreferences.delete(key),
  setItem: (key, value) => storedPreferences.set(key, value),
};

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      media: "(min-width: 1280px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function restoreProperty(
  object: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(object, key, descriptor);
  } else {
    Reflect.deleteProperty(object, key);
  }
}

const stats: MissionSystemStats = {
  running: 2,
  retrying: 1,
  waitingOnHuman: 1,
  completed: 3,
  failed: 1,
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
    issueIdentifier: "repo#1",
    kind: "runtime.interaction.awaiting_input",
    title: "Agent needs a decision",
    detail: "Reply in the issue panel.",
    references: ["interaction:ask-1"],
    requestedAt: "2026-07-09T09:10:00Z",
    canNavigate: true,
  },
];

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

function runtimeSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_totals: { input_tokens: 100, output_tokens: 50, total_tokens: 150, seconds_running: 60 },
    attention_items: [
      {
        identity: {
          producer_key: "runtime.interaction",
          subject_ref: "repo#3",
          kind: "runtime.interaction.awaiting_input",
        },
        presentation: {
          summary: "Agent needs a decision",
          remedy: "Reply in the issue panel.",
          references: ["interaction:ask-1"],
        },
        evidence: { fingerprint: "ask-1" },
        state: "open",
        opened_at: "2026-07-09T09:10:00Z",
        updated_at: "2026-07-09T09:10:00Z",
      },
      {
        identity: {
          producer_key: "adapter.policy",
          subject_ref: "repo#2",
          kind: "adapter.policy.escalation",
        },
        presentation: {
          summary: "Retry scheduling needs review",
          remedy: "Inspect the policy record.",
          references: ["policy:retry-2"],
        },
        evidence: { fingerprint: "retry-2" },
        state: "open",
        opened_at: "2026-07-09T09:11:00Z",
        updated_at: "2026-07-09T09:11:00Z",
      },
    ],
    counts: { running: 1, retrying: 1, waiting_on_human: 1, completed: 1 },
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

function mockMutation<T>(): T {
  return {
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  } as T;
}

function runtimeFixture(identifier: string): IssueRuntimeState {
  const data = {
    acceptance_attempts: [],
    attention_items: [],
    issue_identifier: identifier,
    issue_id: `id:${identifier}`,
    status: "running",
    running: null,
    retry: null,
    attempts: { restart_count: 0, current_retry_attempt: null },
    workspace: { path: "/tmp/workspace" },
    workflow_steps: [],
    artifacts: null,
    finalize: { status: "not_required", repos: [] },
    issue: { title: `Selected ${identifier}`, description: null, labels: [] },
    last_error: null,
    pending_input: null,
    current_interaction: null,
  } satisfies IssueDetailSnapshot;

  return {
    identifier,
    data,
    isLoading: false,
    isError: false,
    error: null,
    interaction: undefined,
    interactionIsLoading: false,
    interactionIsError: false,
    interactionError: null,
    pendingQuestion: null,
    isLiveRun: false,
    wsStatus: "disconnected",
    effectiveRunId: "",
    activeStepName: null,
    events: [],
    transcriptEntries: [],
    activeTranscriptEntryId: null,
    transcriptSessionKey: `${identifier}:idle`,
    transcriptIsError: false,
    timelineIsError: false,
    retryMutation: mockMutation<IssueRuntimeState["retryMutation"]>(),
    stopMutation: mockMutation<IssueRuntimeState["stopMutation"]>(),
    respondMutation: mockMutation<IssueRuntimeState["respondMutation"]>(),
    resumeMutation: mockMutation<IssueRuntimeState["resumeMutation"]>(),
    cancelMutation: mockMutation<IssueRuntimeState["cancelMutation"]>(),
    finalizeApproveMutation: mockMutation<IssueRuntimeState["finalizeApproveMutation"]>(),
    finalizeRetryMutation: mockMutation<IssueRuntimeState["finalizeRetryMutation"]>(),
    composerError: null,
    resumeQueued: false,
    submitInteractionReply: vi.fn(),
    resumeInteraction: vi.fn(),
    submitFollowUpInput: vi.fn(),
    setActiveEntryIdForConversationIndex: vi.fn(),
    setActiveEntryId: vi.fn(),
  };
}

function renderMissionControl(snapshot?: RuntimeSnapshot) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (snapshot) queryClient.setQueryData(["/api/v1/state"], { data: snapshot });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <MissionControl />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function dispatchShortcut(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
  act(() => window.dispatchEvent(event));
  return event;
}

function missionGroups(overrides: Partial<Record<MissionGroup["id"], MissionIssueSummary[]>> = {}): MissionGroup[] {
  return [
    { id: "running", title: "Running", issues: overrides.running ?? [issue()] },
    { id: "retrying", title: "Retrying", issues: overrides.retrying ?? [] },
    { id: "waiting_on_human", title: "Waiting on Human", issues: overrides.waiting_on_human ?? [] },
    { id: "completed_recently", title: "Completed Recently", issues: overrides.completed_recently ?? [] },
    { id: "failed_or_blocked", title: "Failed or Blocked", issues: overrides.failed_or_blocked ?? [] },
  ];
}

function renderToolbar(overrides: Partial<ComponentProps<typeof MissionControlToolbar>> = {}) {
  return render(
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
      {...overrides}
    />,
  );
}

function ToolbarControlHarness({
  onQueryChange,
  onStatusChange,
  onAttentionOnlyChange,
  onViewModeChange,
  onRefresh,
}: Pick<
  ComponentProps<typeof MissionControlToolbar>,
  | "onQueryChange"
  | "onStatusChange"
  | "onAttentionOnlyChange"
  | "onViewModeChange"
  | "onRefresh"
>) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ComponentProps<typeof MissionControlToolbar>["status"]>("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ComponentProps<typeof MissionControlToolbar>["viewMode"]>(
    "board",
  );

  return (
    <MissionControlToolbar
      stats={stats}
      query={query}
      status={status}
      attentionOnly={attentionOnly}
      viewMode={viewMode}
      isRefreshing={false}
      onQueryChange={(value) => {
        onQueryChange(value);
        setQuery(value);
      }}
      onStatusChange={(value) => {
        onStatusChange(value);
        setStatus(value);
      }}
      onAttentionOnlyChange={(value) => {
        onAttentionOnlyChange(value);
        setAttentionOnly(value);
      }}
      onViewModeChange={(value) => {
        onViewModeChange(value);
        setViewMode(value);
      }}
      onRefresh={onRefresh}
    />
  );
}

describe("Mission Control shell components", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders compact system stats and view controls", () => {
    renderToolbar();

    expect(screen.getByText("Mission Control")).toBeInTheDocument();
    expect(screen.getByText("2 running")).toBeInTheDocument();
    expect(screen.getByText("1 retrying")).toBeInTheDocument();
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
    expect(screen.getByText("3 completed")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText(/Rate low: 8\/100/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search issues" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("all");
    expect(screen.getByRole("button", { name: "Attention only" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("renders the last tick timestamp", () => {
    renderToolbar();

    const expectedTick = new Date(stats.lastTickAt ?? "").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    expect(screen.getByText(`Last tick ${expectedTick}`)).toBeInTheDocument();
  });

  it("marks system health stale when time advances without a rerender", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T09:30:05Z"));
    renderToolbar();

    expect(screen.getByRole("status", { name: /System live and fresh/i })).toHaveTextContent(
      "Live / Fresh",
    );

    act(() => vi.advanceTimersByTime(4_000));

    expect(screen.getByRole("status", { name: /System stale/i })).toHaveTextContent("Stale");
  });

  it("cleans up the system freshness clock on unmount", () => {
    vi.useFakeTimers();
    const view = renderToolbar();

    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes normal rate capacity from a low-capacity warning with reset time", () => {
    const normal = renderToolbar({
      stats: { ...stats, rateLimitRemaining: 50 },
    });
    expect(screen.getByText("Rate 50/100")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    normal.rerender(
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

    expect(screen.getByRole("alert")).toHaveTextContent("Rate low: 8/100");
    expect(screen.getByRole("alert")).toHaveTextContent("resets");
  });

  it("omits rate text when rate limit values are unavailable", () => {
    renderToolbar({
      stats: {
        ...stats,
        rateLimitLimit: null,
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      },
    });

    expect(screen.queryByText(/Rate /)).not.toBeInTheDocument();
  });

  it("reports toolbar control changes", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onStatusChange = vi.fn();
    const onAttentionOnlyChange = vi.fn();
    const onViewModeChange = vi.fn();
    const onRefresh = vi.fn();
    render(
      <ToolbarControlHarness
        onQueryChange={onQueryChange}
        onStatusChange={onStatusChange}
        onAttentionOnlyChange={onAttentionOnlyChange}
        onViewModeChange={onViewModeChange}
        onRefresh={onRefresh}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Search issues" }), "repo#1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "retrying");
    await user.click(screen.getByRole("button", { name: "Attention only" }));
    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(onQueryChange).toHaveBeenLastCalledWith("repo#1");
    expect(onStatusChange).toHaveBeenCalledWith("retrying");
    expect(onAttentionOnlyChange).toHaveBeenCalledWith(true);
    expect(onViewModeChange).toHaveBeenCalledWith("list");
    expect(onRefresh).toHaveBeenCalledTimes(1);
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

    await userEvent.click(screen.getByRole("button", { name: "Open repo#1" }));

    expect(onSelectIssue).toHaveBeenCalledWith("repo#1");
  });

  it("renders attention item details and selected state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T09:42:00Z"));

    render(
      <AttentionQueue
        items={[
          ...attentionItems,
          {
            id: "retry:issue-2",
            issueIdentifier: "repo#2",
            kind: "adapter.policy.escalation",
            title: "Policy review required",
            detail: "A retry needs policy review.",
            references: ["policy:retry-2", "run:7"],
            requestedAt: "2026-07-09T09:20:00Z",
            canNavigate: true,
          },
          {
            id: "failure:issue-3",
            issueIdentifier: "repo#failed",
            kind: "integration.release.decision",
            title: "Release decision required",
            detail: "Check the release record.",
            references: [],
            requestedAt: "2026-07-09T09:30:00Z",
            canNavigate: true,
          },
        ]}
        selectedIssueIdentifier="repo#1"
        onSelectIssue={() => {}}
      />,
    );

    expect(screen.getByText("repo#1")).toBeInTheDocument();
    expect(screen.getByText("Agent needs a decision")).toBeInTheDocument();
    expect(screen.getByText("Reply in the issue panel.")).toBeInTheDocument();
    expect(screen.getByText("runtime.interaction.awaiting_input")).toBeInTheDocument();
    expect(screen.getByText("1 reference")).toBeInTheDocument();
    expect(screen.getByText("32m ago")).toBeInTheDocument();
    expect(screen.getByText("repo#2")).toBeInTheDocument();
    expect(screen.getByText("adapter.policy.escalation")).toBeInTheDocument();
    expect(screen.getByText("2 references")).toBeInTheDocument();
    expect(screen.getByText("repo#failed")).toBeInTheDocument();
    expect(screen.getByText("Release decision required")).toBeInTheDocument();
    expect(screen.getByText("integration.release.decision")).toBeInTheDocument();
    expect(screen.getByText("0 references")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open repo#1" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    vi.useRealTimers();
  });

  it("renders an empty attention state", () => {
    render(<AttentionQueue items={[]} selectedIssueIdentifier={null} onSelectIssue={() => {}} />);

    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs intervention right now.")).toBeInTheDocument();
  });

  it("renders an orphan attention item without a navigation action", () => {
    render(
      <AttentionQueue
        items={[{ ...attentionItems[0]!, issueIdentifier: "repo#orphan", canNavigate: false }]}
        selectedIssueIdentifier={null}
        onSelectIssue={() => {}}
      />,
    );

    expect(screen.getByText("repo#orphan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open repo#orphan" })).not.toBeInTheDocument();
  });
});

describe("Mission Control operation surfaces", () => {
  it("selects an issue from the board", async () => {
    const onSelectIssue = vi.fn();

    render(
      <OperationsBoard
        groups={missionGroups()}
        selectedIssueIdentifier={null}
        onSelectIssue={onSelectIssue}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Open\s*repo#1.*Running tests.*3 turns/i }));

    expect(onSelectIssue).toHaveBeenCalledWith("repo#1");
  });

  it("selects an issue from the list and renders activity", async () => {
    const onSelectIssue = vi.fn();

    render(<OperationsList issues={[issue()]} selectedIssueIdentifier={null} onSelectIssue={onSelectIssue} />);

    await userEvent.click(screen.getByRole("button", { name: /Open\s*repo#1.*Running tests.*3 turns/i }));

    expect(onSelectIssue).toHaveBeenCalledWith("repo#1");
    expect(screen.getByText("Running tests")).toBeInTheDocument();
  });

  it("renders empty board and list states", () => {
    render(
      <>
        <OperationsBoard groups={missionGroups({ running: [] })} selectedIssueIdentifier={null} onSelectIssue={() => {}} />
        <OperationsList issues={[]} selectedIssueIdentifier={null} onSelectIssue={() => {}} />
      </>,
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getAllByText("No issues")).toHaveLength(5);
    expect(screen.getByText("No issues match the current filters.")).toBeInTheDocument();
  });

  it("renders failed terminal work as attention in board and list views", () => {
    const failedIssue = issue({
      id: "issue-failed",
      identifier: "repo#failed",
      status: "failed_or_blocked",
      statusLabel: "completed_failed",
      activity: "completed_failed",
      attention: true,
      completedAt: "2026-07-09T09:25:00Z",
    });

    const board = render(
      <OperationsBoard
        groups={missionGroups({ running: [], failed_or_blocked: [failedIssue] })}
        selectedIssueIdentifier={null}
        onSelectIssue={() => {}}
      />,
    );
    expect(screen.getByText("Failed or Blocked")).toBeInTheDocument();
    expect(screen.getByText("Attention")).toBeInTheDocument();

    board.unmount();
    render(
      <OperationsList
        issues={[failedIssue]}
        selectedIssueIdentifier={null}
        onSelectIssue={() => {}}
      />,
    );
    expect(screen.getByText("repo#failed")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("renders updated time and available operational signals in board and list views", () => {
    const metadataIssue = issue({
      attention: true,
      retryAttempt: 3,
      tokenTotal: 1_250,
      turnCount: null,
      updatedAt: "2026-07-09T09:29:50Z",
    });

    const board = render(
      <OperationsBoard
        groups={missionGroups({ running: [metadataIssue] })}
        selectedIssueIdentifier={null}
        onSelectIssue={() => {}}
      />,
    );
    expect(screen.getByText("Updated Jul 9, 09:29 UTC")).toBeInTheDocument();
    expect(screen.getByText("retry 3")).toBeInTheDocument();
    expect(screen.getByText("1,250 tokens")).toBeInTheDocument();

    board.unmount();
    render(
      <OperationsList
        issues={[metadataIssue]}
        selectedIssueIdentifier={null}
        onSelectIssue={() => {}}
      />,
    );
    expect(screen.getByText("Updated Jul 9, 09:29 UTC")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("retry 3")).toBeInTheDocument();
    expect(screen.getByText("1,250 tokens")).toBeInTheDocument();
  });
});

describe("Mission Control page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: testStorage,
    });
    mockMatchMedia(true);
    window.localStorage.clear();
    vi.mocked(getState).mockReturnValue(new Promise(() => {}));
    vi.mocked(postRefresh).mockResolvedValue({} as Awaited<ReturnType<typeof postRefresh>>);
    vi.mocked(useIssueRuntime).mockImplementation((identifier) => runtimeFixture(identifier || "unselected"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreProperty(window, "matchMedia", originalMatchMedia);
    restoreProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  });

  it("switches from board to list while keeping the filtered collection", async () => {
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.type(screen.getByRole("textbox", { name: "Search issues" }), "repo#4");
    await user.click(screen.getByRole("button", { name: "List" }));

    const operations = screen.getByRole("region", { name: "Operations" });
    expect(within(operations).getByText("Activity")).toBeInTheDocument();
    expect(within(operations).getByText("repo#4")).toBeInTheDocument();
    expect(within(operations).queryByText("repo#1")).not.toBeInTheDocument();
  });

  it("focuses search and cycles filtered issue selection from the keyboard", async () => {
    renderMissionControl(runtimeSnapshot());
    const search = screen.getByRole("textbox", { name: "Search issues" });

    const focusSearch = dispatchShortcut("/");
    expect(focusSearch.defaultPrevented).toBe(true);
    expect(search).toHaveFocus();

    search.blur();
    const next = dispatchShortcut("j");
    expect(next.defaultPrevented).toBe(true);
    expect(await screen.findByRole("heading", { name: "repo#1" })).toBeInTheDocument();

    dispatchShortcut("j");
    expect(await screen.findByRole("heading", { name: "repo#2" })).toBeInTheDocument();

    dispatchShortcut("k");
    expect(await screen.findByRole("heading", { name: "repo#1" })).toBeInTheDocument();
  });

  it("handles non-destructive toolbar shortcuts and renders their shared reference", async () => {
    renderMissionControl(runtimeSnapshot());

    dispatchShortcut("l");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    dispatchShortcut("b");
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    dispatchShortcut("a");
    expect(screen.getByRole("button", { name: "Attention only" })).toHaveAttribute("aria-pressed", "true");

    const refresh = dispatchShortcut("R", { shiftKey: true });
    expect(refresh.defaultPrevented).toBe(true);
    await waitFor(() => expect(postRefresh).toHaveBeenCalledTimes(1));

    const reference = dispatchShortcut("?", { shiftKey: true });
    expect(reference.defaultPrevented).toBe(true);
    expect(await screen.findByText("Focus issue search")).toBeInTheDocument();
    expect(screen.getByText("Shift + R")).toBeInTheDocument();
    expect(screen.getByText("Reply field required")).toBeInTheDocument();
  });

  it("does not steal editable input or unavailable shortcuts, but closes a selected panel with Escape", async () => {
    renderMissionControl(runtimeSnapshot());
    const search = screen.getByRole("textbox", { name: "Search issues" });
    search.focus();

    const typedShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "j",
    });
    act(() => search.dispatchEvent(typedShortcut));
    expect(typedShortcut.defaultPrevented).toBe(false);
    expect(screen.getByText("Select an issue")).toBeInTheDocument();

    const unavailableReply = dispatchShortcut("r");
    expect(unavailableReply.defaultPrevented).toBe(false);

    const composing = dispatchShortcut("j", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(screen.getByText("Select an issue")).toBeInTheDocument();

    dispatchShortcut("j");
    expect(await screen.findByRole("heading", { name: "repo#1" })).toBeInTheDocument();
    const close = dispatchShortcut("Escape");
    expect(close.defaultPrevented).toBe(true);
    expect(await screen.findByText("Select an issue")).toBeInTheDocument();
  });

  it("focuses an already rendered reply surface without changing the active tab", async () => {
    vi.mocked(useIssueRuntime).mockImplementation((identifier) => ({
      ...runtimeFixture(identifier || "unselected"),
      pendingQuestion: {
        interactionId: "ask-1",
        kind: "question",
        status: "open",
        awaitingResume: false,
        question: "Proceed?",
        whyBlocked: "A decision is required.",
        suggestedAnswer: null,
        stepName: "review",
      },
    }));
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    dispatchShortcut("j");
    expect(await screen.findByRole("heading", { name: "repo#1" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Respond" }));
    const composer = screen.getByRole("textbox", { name: "Reply" });
    expect(composer).not.toHaveFocus();

    const focusReply = dispatchShortcut("r");
    expect(focusReply.defaultPrevented).toBe(true);
    expect(composer).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Respond" })).toHaveAttribute("aria-selected", "true");
  });

  it("exposes operations as a named section without adding a nested main landmark", () => {
    renderMissionControl(runtimeSnapshot());

    expect(screen.getByRole("region", { name: "Operations" })).toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
  });

  it("filters operations by status and attention without filtering the attention queue", async () => {
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());
    const operations = screen.getByRole("region", { name: "Operations" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "retrying");
    expect(within(operations).getByText("repo#2")).toBeInTheDocument();
    expect(within(operations).queryByText("repo#1")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    await user.click(screen.getByRole("button", { name: "Attention only" }));
    expect(within(operations).getByText("repo#2")).toBeInTheDocument();
    expect(within(operations).getByText("repo#3")).toBeInTheDocument();
    expect(within(operations).queryByText("repo#1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open repo#3" })).toBeInTheDocument();
  });

  it("shows one filtered-empty state in board mode", async () => {
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.type(screen.getByRole("textbox", { name: "Search issues" }), "no-such-issue");

    const operations = screen.getByRole("region", { name: "Operations" });
    expect(within(operations).getByText("No issues match the current filters.")).toBeInTheDocument();
    expect(within(operations).queryByText("No issues")).not.toBeInTheDocument();
  });

  it("opens issues from board and list and closes the inline panel without resetting controls", async () => {
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());
    const operations = screen.getByRole("region", { name: "Operations" });

    await user.click(within(operations).getByRole("button", { name: /Open\s*repo#1/i }));
    expect(screen.getByRole("heading", { name: "repo#1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close issue panel" }));
    expect(screen.getByText("Select an issue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(within(operations).getByRole("button", { name: /Open\s*repo#4/i }));
    expect(screen.getByRole("heading", { name: "repo#4" })).toBeInTheDocument();
  });

  it("restores focus to the originating issue control when the panel closes", async () => {
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());
    const trigger = within(screen.getByRole("region", { name: "Operations" })).getByRole(
      "button",
      { name: /Open\s*repo#1/i },
    );

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Close issue panel" }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens a canonical attention record without changing the selected panel tab", async () => {
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.click(screen.getByRole("button", { name: "Open repo#3" }));
    expect(screen.getByRole("heading", { name: "repo#3" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Open repo#2" }));
    expect(screen.getByRole("heading", { name: "repo#2" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not infer attention from waiting, retrying, halted, or failed runtime rows", () => {
    renderMissionControl(
      runtimeSnapshot({
        attention_items: [],
        counts: { running: 0, retrying: 1, waiting_on_human: 1, completed: 1 },
        running: [],
        waiting_on_human: [{
          interaction_request_id: "halted:issue-halted:review",
          issue_id: "issue-halted",
          issue_identifier: "repo#halted",
          requested_at: "2026-07-09T09:15:00Z",
          step_name: "review",
        }],
        completed: [{
          issue_id: "issue-failed",
          issue_identifier: "repo#failed",
          completed_at: "2026-07-09T09:25:00Z",
          status: "completed_failed",
        }],
      }),
    );

    expect(screen.getByText("Nothing needs intervention right now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open repo#2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open repo#halted" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open repo#failed" })).not.toBeInTheDocument();
  });

  it("closes the panel and focuses Operations when a refreshed snapshot removes the selected issue", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderMissionControl(runtimeSnapshot());
    const operations = screen.getByRole("region", { name: "Operations" });

    await user.click(
      within(screen.getByRole("region", { name: "Operations" })).getByRole("button", {
        name: /Open\s*repo#1/i,
      }),
    );
    expect(screen.getByRole("heading", { name: "repo#1" })).toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(["/api/v1/state"], {
        data: runtimeSnapshot({
          counts: { running: 0, retrying: 1, waiting_on_human: 1, completed: 1 },
          running: [],
        }),
      });
    });

    expect(await screen.findByText("Select an issue")).toBeInTheDocument();
    await waitFor(() => expect(operations).toHaveFocus());
  });

  it("does not move focus or scroll the panel after desktop selection", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());
    const trigger = within(screen.getByRole("region", { name: "Operations" })).getByRole(
      "button",
      { name: /Open\s*repo#1/i },
    );

    await user.click(trigger);

    expect(screen.getByRole("region", { name: "Issue command panel" })).not.toHaveFocus();
    expect(trigger).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("moves focus and scrolls to the issue panel after mobile selection", async () => {
    mockMatchMedia(false);
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.click(
      within(screen.getByRole("region", { name: "Operations" })).getByRole("button", {
        name: /Open\s*repo#1/i,
      }),
    );

    const panel = screen.getByRole("region", { name: "Issue command panel" });
    await waitFor(() => expect(panel).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("handles missing matchMedia support during selection", async () => {
    Reflect.deleteProperty(window, "matchMedia");
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.click(
      within(screen.getByRole("region", { name: "Operations" })).getByRole("button", {
        name: /Open\s*repo#1/i,
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Issue command panel" })).toHaveFocus(),
    );
  });

  it("falls back from corrupt preferences and persists control changes", async () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "tiles");
    window.localStorage.setItem(ACTIVE_TAB_KEY, "debug");
    window.localStorage.setItem(ATTENTION_ONLY_KEY, "sometimes");
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Attention only" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(screen.getByRole("button", { name: "Attention only" }));
    await user.click(
      within(screen.getByRole("region", { name: "Operations" })).getByRole("button", {
        name: /Open\s*repo#2/i,
      }),
    );
    await user.click(screen.getByRole("tab", { name: "Logs" }));

    await waitFor(() => {
      expect(window.localStorage.getItem(VIEW_MODE_KEY)).toBe("list");
      expect(window.localStorage.getItem(ACTIVE_TAB_KEY)).toBe("logs");
      expect(window.localStorage.getItem(ATTENTION_ONLY_KEY)).toBe("true");
    });
  });

  it("restores valid preferences", async () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "list");
    window.localStorage.setItem(ACTIVE_TAB_KEY, "acceptance");
    window.localStorage.setItem(ATTENTION_ONLY_KEY, "true");
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Attention only" })).toHaveAttribute("aria-pressed", "true");
    await user.click(
      within(screen.getByRole("region", { name: "Operations" })).getByRole("button", {
        name: /Open\s*repo#2/i,
      }),
    );
    expect(screen.getByRole("tab", { name: "Acceptance" })).toHaveAttribute("aria-selected", "true");
  });

  it("renders when localStorage access is unavailable", () => {
    vi.spyOn(testStorage, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    vi.spyOn(testStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    renderMissionControl(runtimeSnapshot());

    expect(screen.getByText("Mission Control")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a loading state while the runtime snapshot is pending", () => {
    renderMissionControl();

    expect(screen.getByText("Loading Mission Control...")).toBeInTheDocument();
    expect(screen.queryByText("Needs Attention")).not.toBeInTheDocument();
  });

  it("shows an error and retries through the refresh control", async () => {
    vi.mocked(getState).mockRejectedValueOnce(new Error("runtime offline"));
    const user = userEvent.setup();
    renderMissionControl();

    expect(await screen.findByText("Failed to load Mission Control")).toBeInTheDocument();
    expect(screen.getByText("runtime offline")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(postRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps cached operations visible when a background refresh fails", async () => {
    vi.mocked(getState).mockRejectedValueOnce(new Error("poll failed"));
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    expect(await screen.findByRole("alert")).toHaveTextContent("poll failed");
    expect(screen.getByText("Mission Control")).toBeInTheDocument();
    expect(screen.getByText("repo#1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry refresh" }));
    expect(postRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows a true empty operational state", () => {
    renderMissionControl(
      runtimeSnapshot({
        attention_items: [],
        counts: { running: 0, retrying: 0, waiting_on_human: 0, completed: 0 },
        running: [],
        retrying: [],
        waiting_on_human: [],
        completed: [],
      }),
    );

    expect(screen.getByText("Nothing needs intervention right now.")).toBeInTheDocument();
    expect(screen.getByText("No operational issues are currently tracked.")).toBeInTheDocument();
  });

  it("wires refresh and exposes its pending state", async () => {
    let resolveRefresh: (value: Awaited<ReturnType<typeof postRefresh>>) => void = () => {};
    vi.mocked(postRefresh).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(postRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Refreshing..." })).toBeDisabled();

    resolveRefresh({} as Awaited<ReturnType<typeof postRefresh>>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  });

  it("keeps cached operations visible and exposes manual refresh failures", async () => {
    vi.mocked(postRefresh).mockRejectedValue(new Error("manual refresh failed"));
    const user = userEvent.setup();
    renderMissionControl(runtimeSnapshot());

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("manual refresh failed");
    expect(screen.getByText("repo#1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry manual refresh" }));
    expect(postRefresh).toHaveBeenCalledTimes(2);
  });
});
