import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import { connectWs } from "@/ws";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import type { GroupedTranscriptEntry } from "@/components/transcript/transcript-model";
import IssueDetail from "./IssueDetail";
import type { ReactNode } from "react";

const hooksMock = vi.hoisted(() => {
  const stopMutate = vi.fn();
  const retryMutate = vi.fn();
  const inputMutate = vi.fn();
  const cancelMutate = vi.fn();

  return {
    stopMutate,
    retryMutate,
    inputMutate,
    cancelMutate,
    useIssueDetailQuery: vi.fn(() => ({
      data: {
        issue_identifier: "todo-1",
        status: "running",
        running: {
          step_name: "deploy",
          turn_count: 2,
          tokens: { total_tokens: 100 },
          run_id: "run-1",
        },
        attempts: { restart_count: 0 },
        retry: null,
        last_error: null,
        issue: { title: "Deploy feature", labels: [] },
        workspace: { path: "/tmp/workspace" },
        workflow_steps: [
          {
            name: "deploy",
            agent: "builder",
            dependencies: [],
            state: "running",
            can_navigate: true,
          },
        ],
        pending_input: { ask_id: "ask-1" },
        current_interaction: { interaction_request_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    })),
    useInteractionDetailQuery: vi.fn(() => ({
      data: {
        agent_name: "builder",
        id: "ask-1",
        issue_id: "issue-1",
        issue_identifier: "todo-1",
        status: "pending",
        question: "Which environment?",
        why_blocked: "Need target",
        suggested_answer: "staging",
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-04-14T10:00:00Z",
      },
    })),
    useTimelineQuery: vi.fn(() => ({ data: { events: [] }, isError: false })),
    useStepConversationQuery: vi.fn(() => ({
      data: {
        records: [
          {
            schema_version: 1,
            run_id: "run-1",
            issue_identifier: "todo-1",
            step_name: "deploy",
            attempt: 1,
            sequence: 1,
            timestamp: "2026-04-14T10:00:01Z",
            kind: "assistant_message",
            payload: { text: "I am ready" },
          },
        ],
      } as any,
      isLoading: false,
      isError: false,
    })),
    useStopMutation: vi.fn(() => ({ mutate: stopMutate, isPending: false })),
    useRetryMutation: vi.fn(() => ({ mutate: retryMutate, isPending: false })),
    useIssueInputMutation: vi.fn(() => ({ mutate: inputMutate, isPending: false })),
    useCancelInteractionMutation: vi.fn(() => ({ mutate: cancelMutate, isPending: false })),
  };
});

vi.mock("@/hooks", () => hooksMock);
vi.mock("@/ws", () => ({ connectWs: vi.fn(() => () => {}) }));
vi.mock("@/notifications", () => ({
  addNotification: vi.fn(),
  requestPermissionIfNeeded: vi.fn(),
}));

describe("RunTranscript", () => {
  it("renders an empty state when there are no entries", () => {
    render(
      <RunTranscript
        entries={[]}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="todo-1:run-1"
      />,
    );

    expect(screen.getByText("No transcript activity yet.")).toBeInTheDocument();
  });

  it("renders human and error transcript entries distinctly", () => {
    const entries: GroupedTranscriptEntry[] = [
      {
        kind: "human_message",
        id: "message:1",
        timestamp: "2026-04-14T09:59:59Z",
        message: "Please hold before deploying.",
      },
      {
        kind: "agent_question",
        id: "interaction:ask-1",
        timestamp: "2026-04-14T10:00:00Z",
        interaction: {
          agent_name: "builder",
          id: "ask-1",
          issue_id: "issue-1",
          issue_identifier: "todo-1",
          status: "pending",
          question: "Which environment should I deploy to?",
          why_blocked: "Needs a deployment target",
          suggested_answer: "Use staging",
          extra_context: null,
          step_name: "deploy",
          requested_at: "2026-04-14T10:00:00Z",
        },
      },
      {
        kind: "human_reply",
        id: "reply:1",
        timestamp: "2026-04-14T10:00:01Z",
        reply: "Use staging for this run.",
      },
      {
        kind: "error",
        id: "error:1",
        timestamp: "2026-04-14T10:00:02Z",
        message: "Deployment failed before the approval step.",
      },
      {
        kind: "tool_activity_group",
        id: "tool-group:event:run-1:1:tool_call:2",
        timestamp: "2026-04-14T10:00:03Z",
        count: 2,
        defaultExpanded: false,
        entries: [
          {
            kind: "tool_activity",
            id: "event:run-1:1:tool_call",
            timestamp: "2026-04-14T10:00:03Z",
            event: {
              type: "tool_call",
              timestamp: "2026-04-14T10:00:03Z",
              detail: "rg src",
              runId: "run-1",
              sequence: 1,
            },
          },
          {
            kind: "tool_activity",
            id: "event:run-1:2:output",
            timestamp: "2026-04-14T10:00:04Z",
            event: {
              type: "output",
              timestamp: "2026-04-14T10:00:04Z",
              detail: "match found",
              runId: "run-1",
              sequence: 2,
            },
          },
        ],
      } as any,
    ];

    render(
      <RunTranscript
        entries={entries}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="todo-1:run-1"
      />,
    );

    expect(screen.getByText("Please hold before deploying.")).toBeInTheDocument();
    expect(screen.getByText("Which environment should I deploy to?")).toBeInTheDocument();
    expect(screen.getByText("Use staging for this run.")).toBeInTheDocument();
    expect(screen.getByText("Deployment failed before the approval step.")).toBeInTheDocument();
    expect(screen.getByText("2 low-level activities")).toBeInTheDocument();
  });

  it("highlights the active transcript entry and expands grouped activity on demand", async () => {
    const user = userEvent.setup();

    render(
        <RunTranscript
          entries={[
          {
            id: "group-1",
            kind: "tool_activity_group",
            timestamp: "2026-04-14T10:00:00Z",
            count: 2,
            defaultExpanded: false,
            entries: [
              {
                id: "event-1",
                kind: "tool_activity",
                timestamp: "2026-04-14T10:00:00Z",
                event: {
                  type: "tool_call",
                  timestamp: "2026-04-14T10:00:00Z",
                  detail: "rg src",
                  stepName: "build",
                  runId: "run-1",
                  sequence: 1,
                },
              },
            ],
          },
          ]}
          activeEntryId="group-1"
          onJumpToEntry={() => {}}
          transcriptSessionKey="todo-1:run-1"
        />, 
    );

    expect(screen.getByText("2 low-level activities").closest('[data-active="true"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("rg src")).toBeInTheDocument();
  });

});

describe("IssueDetail", () => {
  it("renders the merged transcript shell and composer", () => {
    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getAllByText("Which environment?")).toHaveLength(2);
    expect(screen.getByText("I am ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Workflow" })).toBeInTheDocument();
  });

  it("appends live transcript records from the websocket", async () => {
    let onMessage: Parameters<typeof connectWs>[0]["onMessage"] | null = null;
    vi.mocked(connectWs).mockImplementation((options) => {
      onMessage = options.onMessage;
      return () => {};
    });
    hooksMock.useStepConversationQuery.mockImplementation(() => ({
      data: { records: [] },
      isLoading: false,
      isError: false,
    }));

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    act(() => {
      onMessage?.({
        type: "transcript_record",
        data: {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "todo-1",
          step_name: "deploy",
          attempt: 1,
          sequence: 2,
          timestamp: "2026-06-15T10:00:00Z",
          kind: "assistant_message",
          payload: { text: "live hello" },
        },
      });
    });

    expect(await screen.findByText("live hello")).toBeInTheDocument();
  });

  it("dedupes live transcript records against replayed records", async () => {
    let onMessage: Parameters<typeof connectWs>[0]["onMessage"] | null = null;
    vi.mocked(connectWs).mockImplementation((options) => {
      onMessage = options.onMessage;
      return () => {};
    });
    hooksMock.useStepConversationQuery.mockImplementation(() => ({
      data: {
        records: [
          {
            schema_version: 1,
            run_id: "run-1",
            issue_identifier: "todo-1",
            step_name: "deploy",
            attempt: 1,
            sequence: 2,
            timestamp: "2026-06-15T09:59:59Z",
            kind: "assistant_message",
            payload: { text: "stale hello" },
          },
        ],
      } as any,
      isLoading: false,
      isError: false,
    }));

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    act(() => {
      onMessage?.({
        type: "transcript_record",
        data: {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "todo-1",
          step_name: "deploy",
          attempt: 1,
          sequence: 2,
          timestamp: "2026-06-15T10:00:00Z",
          kind: "assistant_message",
          payload: { text: "live hello" },
        },
      });
    });

    expect(await screen.findByText("live hello")).toBeInTheDocument();
    expect(screen.queryByText("stale hello")).not.toBeInTheDocument();
    expect(screen.getAllByText("live hello")).toHaveLength(1);
  });

  it("reveals hidden transcript history when a raw event jumps to an older conversation entry", async () => {
    const user = userEvent.setup();
    const connectWsMock = vi.mocked(connectWs);

    hooksMock.useStepConversationQuery.mockImplementation(() => ({
      data: {
        records: Array.from({ length: 55 }, (_, index) => ({
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "todo-1",
          step_name: "deploy",
          attempt: 1,
          sequence: index + 1,
          timestamp: `2026-04-14T10:${String(index).padStart(2, "0")}:00Z`,
          kind: "assistant_message",
          payload: { text: `history message ${index + 1}` },
        })),
      },
      isLoading: false,
      isError: false,
    }));
    connectWsMock.mockImplementation(({ onMessage }) => {
      onMessage({
        type: "event",
        data: {
          event_type: "turn_completed",
          timestamp: "2026-04-14T10:00:00Z",
          detail: "Conversation turn completed",
          conversation_index: 5,
          run_id: "run-1",
          sequence: 1,
        },
      });

      return () => {};
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.queryByText("history message 5")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Raw events" }));
    await user.click(screen.getByRole("button", { name: "View in conversation" }));

    expect(screen.getByText("history message 5")).toBeInTheDocument();
  });


  it("resets transcript history after rerendering with a different run session", async () => {
    const user = userEvent.setup();
    const connectWsMock = vi.mocked(connectWs);
    let currentRunId = "run-1";
    let currentPrefix = "session one";

    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      data: {
        issue_identifier: "todo-1",
        status: "running",
        running: {
          step_name: "deploy",
          turn_count: 2,
          tokens: { total_tokens: 100 },
          run_id: currentRunId,
        },
        attempts: { restart_count: 0 },
        retry: null,
        last_error: null,
        issue: { title: "Deploy feature", labels: [] },
        workspace: { path: "/tmp/workspace" },
        workflow_steps: [
          {
            name: "deploy",
            agent: "builder",
            dependencies: [],
            state: "running",
            can_navigate: true,
          },
        ],
        pending_input: { ask_id: "ask-1" },
        current_interaction: { interaction_request_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    }));

    hooksMock.useStepConversationQuery.mockImplementation(() => ({
      data: {
        records: Array.from({ length: 55 }, (_, index) => ({
          schema_version: 1,
          run_id: currentRunId,
          issue_identifier: "todo-1",
          step_name: "deploy",
          attempt: 1,
          sequence: index + 1,
          timestamp: `2026-04-14T10:${String(index).padStart(2, "0")}:00Z`,
          kind: "assistant_message",
          payload: { text: `${currentPrefix} message ${index + 1}` },
        })),
      },
      isLoading: false,
      isError: false,
    }));

    connectWsMock.mockImplementation(({ onMessage }) => {
      onMessage({
        type: "event",
        data: {
          event_type: "turn_completed",
          timestamp: "2026-04-14T10:00:00Z",
          detail: "Conversation turn completed",
          conversation_index: 5,
          run_id: currentRunId,
          sequence: 1,
        },
      });

      return () => {};
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/issue/todo-1"]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );

    const view = render(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { wrapper },
    );

    expect(screen.queryByText("session one message 5")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Raw events" }));
    await user.click(screen.getByRole("button", { name: "View in conversation" }));

    expect(screen.getByText("session one message 5")).toBeInTheDocument();

    currentRunId = "run-2";
    currentPrefix = "session two";

    view.rerender(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
    );

    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
    expect(screen.queryByText("session two message 5")).not.toBeInTheDocument();
    expect(screen.getByText("session two message 55")).toBeInTheDocument();
  });

  it("resets transcript history after rerendering with a different step in the same run", async () => {
    const user = userEvent.setup();
    let currentStepName = "build";

    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      data: {
        issue_identifier: "todo-1",
        status: "running",
        running: {
          step_name: currentStepName,
          turn_count: 2,
          tokens: { total_tokens: 100 },
          run_id: "run-1",
        },
        attempts: { restart_count: 0 },
        retry: null,
        last_error: null,
        issue: { title: "Deploy feature", labels: [] },
        workspace: { path: "/tmp/workspace" },
        workflow_steps: [
          {
            name: currentStepName,
            agent: "builder",
            dependencies: [],
            state: "running",
            can_navigate: true,
          },
        ],
        pending_input: { ask_id: "ask-1" },
        current_interaction: { interaction_request_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    }));

    hooksMock.useStepConversationQuery.mockImplementation(() => ({
      data: {
        records: Array.from({ length: 55 }, (_, index) => ({
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "todo-1",
          step_name: currentStepName,
          attempt: 1,
          sequence: index + 1,
          timestamp: `2026-04-14T10:${String(index).padStart(2, "0")}:00Z`,
          kind: "assistant_message",
          payload: { text: `${currentStepName} message ${index + 1}` },
        })),
      },
      isLoading: false,
      isError: false,
    }));

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/issue/todo-1"]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );

    const view = render(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { wrapper },
    );

    expect(screen.queryByText("build message 1")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(screen.getByText("build message 1")).toBeInTheDocument();

    currentStepName = "review";

    view.rerender(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
    );

    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
    expect(screen.queryByText("review message 1")).not.toBeInTheDocument();
    expect(screen.getByText("review message 55")).toBeInTheDocument();
  });

  it("keeps querying the last running step after the run completes", () => {
    let isRunning = true;

    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      data: {
        issue_identifier: "todo-1",
        status: isRunning ? "running" : "completed",
        running: isRunning
          ? {
              step_name: "build",
              turn_count: 2,
              tokens: { total_tokens: 100 },
              run_id: "run-1",
            }
          : null,
        attempts: { restart_count: 0 },
        retry: null,
        last_error: null,
        issue: { title: "Deploy feature", labels: [] },
        workspace: { path: "/tmp/workspace" },
        workflow_steps: [
          {
            name: "build",
            agent: "builder",
            dependencies: [],
            state: isRunning ? "running" : "completed",
            can_navigate: true,
          },
        ],
        pending_input: { ask_id: "ask-1" },
        current_interaction: { interaction_request_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    }) as ReturnType<typeof hooksMock.useIssueDetailQuery>);

    hooksMock.useStepConversationQuery.mockImplementation(((
      _identifier: string,
      _runId: string,
      stepName: string,
    ) => ({
      data: {
        records:
          stepName === "build"
            ? [
                {
                  schema_version: 1,
                  run_id: "run-1",
                  issue_identifier: "todo-1",
                  step_name: "build",
                  attempt: 1,
                  sequence: 1,
                  timestamp: "2026-04-14T10:00:01Z",
                  kind: "assistant_message",
                  payload: { text: isRunning ? "running build record" : "completed build record" },
                },
              ]
            : [],
      },
      isLoading: false,
      isError: false,
    })) as () => ReturnType<typeof hooksMock.useStepConversationQuery>);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/issue/todo-1"]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );

    const view = render(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { wrapper },
    );

    expect(screen.getByText("running build record")).toBeInTheDocument();

    isRunning = false;

    view.rerender(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
    );

    expect(hooksMock.useStepConversationQuery).toHaveBeenLastCalledWith(
      "todo-1",
      "run-1",
      "build",
      { limit: 200 },
    );
    expect(screen.getByText("completed build record")).toBeInTheDocument();
  });

  it("renders durable artifacts and keeps workflow steps clickable when can_navigate is false", async () => {
    const user = userEvent.setup();

    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        issue_identifier: "todo-1",
        issue_id: "NODE_1",
        status: "completed_succeeded",
        running: null,
        attempts: { restart_count: 0, current_retry_attempt: null },
        retry: null,
        pending_input: null,
        current_interaction: null,
        last_error: null,
        issue: { title: "Deploy feature", labels: [] },
        workspace: { path: "/tmp/workspace" },
        finalize: { status: "not_required", repos: [] },
        artifacts: {
          run_id: "run-1",
          workspace_path: "/tmp/workspace",
          repos: [
            {
              repo: "repo",
              worktree_path: "/tmp/workspace/repo",
              base_branch: "main",
              branch: "ensemble/todo-1",
              head_sha: "abc123",
              changed_files: ["src/lib.rs"],
              finalize_mode: "push_and_pr",
              finalize_status: "succeeded",
              pushed_ref: "origin/ensemble/todo-1",
              pr_url: "https://github.com/acme/repo/pull/1",
              last_error: null,
            },
          ],
          transcripts: [{ step_name: "deploy", run_id: "run-1", record_count: 4 }],
        },
        workflow_steps: [
          {
            name: "deploy",
            agent: "builder",
            kind: "agent",
            dependencies: [],
            state: "passed",
            can_navigate: false,
          },
        ],
      } as any,
      isLoading: false,
      isError: false,
      error: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/issue/todo-1"]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );

    render(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { wrapper },
    );

    expect(screen.getByRole("link", { name: "deploy" })).toHaveAttribute(
      "href",
      "/issue/todo-1/step/deploy",
    );

    await user.click(screen.getByRole("tab", { name: "Artifacts" }));

    expect(screen.getByText("/tmp/workspace")).toBeInTheDocument();
    expect(screen.getByText("ensemble/todo-1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pull request/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/1",
    );
  });
});
