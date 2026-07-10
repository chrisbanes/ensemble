import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import { connectWs } from "@/ws";
import { addNotification, requestPermissionIfNeeded } from "@/notifications";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import type { GroupedTranscriptEntry } from "@/components/transcript/transcript-model";
import type { InteractionKind, IssueDetailSnapshot } from "@/generated/models";
import { FetchError } from "@/fetch-client";
import IssueDetail from "./IssueDetail";
import { useIssueRuntime } from "./mission-control/useIssueRuntime";
import { StrictMode, type ReactNode } from "react";

const hooksMock = vi.hoisted(() => {
  const stopMutate = vi.fn();
  const retryMutate = vi.fn();
  const respondMutateAsync = vi.fn();
  const resumeMutateAsync = vi.fn();
  const interactionRefetch = vi.fn();
  const finalizeApproveMutate = vi.fn();
  const finalizeRetryMutate = vi.fn();
  const cancelMutate = vi.fn();

  return {
    stopMutate,
    retryMutate,
    respondMutateAsync,
    resumeMutateAsync,
    interactionRefetch,
    finalizeApproveMutate,
    finalizeRetryMutate,
    cancelMutate,
    useIssueDetailQuery: vi.fn((_identifier: string): any => ({
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
      error: null as Error | null,
    })),
    useInteractionDetailQuery: vi.fn((_interactionId: string): any => ({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: "ask-1",
        issue_id: "issue-1",
        issue_identifier: "todo-1",
        status: "open",
        kind: "question",
        question: "Which environment?",
        why_blocked: "Need target",
        suggested_answer: "staging",
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-04-14T10:00:00Z",
      },
      refetch: interactionRefetch,
    })),
    useTimelineQuery: vi.fn(
      (_identifier: string, _runId?: string): any => ({ data: { events: [] }, isError: false }),
    ),
    useStepConversationQuery: vi.fn(
      (_identifier: string, _runId: string, _stepName: string, _params?: unknown): any => ({
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
      }),
    ),
    useStopMutation: vi.fn(() => ({
      mutate: stopMutate,
      isPending: false,
      isError: false,
      error: null as Error | null,
    })),
    useRetryMutation: vi.fn(() => ({
      mutate: retryMutate,
      isPending: false,
      isError: false,
      error: null as Error | null,
    })),
    useRespondToInteractionMutation: vi.fn(() => ({
      mutateAsync: respondMutateAsync,
      isPending: false,
      isError: false,
      error: null as Error | null,
    })),
    useResumeIssueMutation: vi.fn(() => ({
      mutateAsync: resumeMutateAsync,
      isPending: false,
      isError: false,
      error: null,
    })),
    useFinalizeApproveMutation: vi.fn(() => ({
      mutate: finalizeApproveMutate,
      isPending: false,
      isError: false,
      error: null as Error | null,
    })),
    useFinalizeRetryMutation: vi.fn(() => ({
      mutate: finalizeRetryMutate,
      isPending: false,
      isError: false,
      error: null as Error | null,
    })),
    useCancelInteractionMutation: vi.fn(() => ({
      mutate: cancelMutate,
      isPending: false,
      isError: false,
      error: null as Error | null,
    })),
  };
});

vi.mock("@/hooks", () => hooksMock);
vi.mock("@/ws", () => ({ connectWs: vi.fn(() => () => {}) }));
vi.mock("@/notifications", () => ({
  addNotification: vi.fn(),
  requestPermissionIfNeeded: vi.fn(),
}));

function SwitchableIssueDetail() {
  const navigate = useNavigate();

  return (
    <>
      <button type="button" onClick={() => navigate("/issue/issue-b")}>
        Switch issue
      </button>
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>
    </>
  );
}

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
          awaiting_resume: true,
          id: "ask-1",
          issue_id: "issue-1",
          issue_identifier: "todo-1",
          status: "open",
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

describe("useIssueRuntime lifecycle", () => {
  const issueDetail = (
    identifier: string,
    runId: string | null,
    stepName: string | null = "deploy",
  ) => ({
    issue_identifier: identifier,
    status: runId ? "running" : "completed",
    running: runId
      ? {
          step_name: stepName,
          turn_count: 2,
          tokens: { total_tokens: 100 },
          run_id: runId,
        }
      : null,
    attempts: { restart_count: 0 },
    retry: null,
    last_error: null,
    issue: { title: `${identifier} title`, labels: [] },
    workspace: { path: "/tmp/workspace" },
    workflow_steps: [],
    pending_input: null,
    current_interaction: null,
  });

  beforeEach(() => {
    vi.mocked(connectWs).mockReset().mockImplementation(() => () => {});
    vi.mocked(requestPermissionIfNeeded).mockClear();
    vi.mocked(addNotification).mockClear();
    hooksMock.respondMutateAsync.mockReset().mockResolvedValue({});
    hooksMock.resumeMutateAsync.mockReset().mockResolvedValue({});
    hooksMock.interactionRefetch.mockReset().mockResolvedValue({ data: undefined });
    hooksMock.useInteractionDetailQuery.mockReset().mockReturnValue({ data: undefined });
    hooksMock.useStepConversationQuery.mockReset().mockReturnValue({
      data: { records: [] },
      isLoading: false,
      isError: false,
    });
    hooksMock.useTimelineQuery.mockReset().mockReturnValue({
      data: { events: [] },
      isError: false,
    });
  });

  it("does not reuse the previous issue run, step, or live events after an identifier switch", () => {
    const connections: Parameters<typeof connectWs>[0][] = [];
    vi.mocked(connectWs).mockImplementation((options) => {
      connections.push(options);
      return () => {};
    });
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: issueDetail(identifier, identifier === "issue-a" ? "run-a" : null),
      isLoading: false,
      isError: false,
      error: null,
    }));

    const { result, rerender } = renderHook(
      ({ identifier }) => useIssueRuntime(identifier),
      { initialProps: { identifier: "issue-a" } },
    );

    act(() => {
      connections[0]?.onMessage({
        type: "event",
        data: {
          event_type: "output",
          timestamp: "2026-07-09T10:00:00Z",
          detail: "issue A live event",
          run_id: "run-a",
          sequence: 1,
        },
      });
    });
    expect(result.current.events.map((event) => event.detail)).toEqual(["issue A live event"]);

    rerender({ identifier: "issue-b" });

    expect(result.current.effectiveRunId).toBe("");
    expect(result.current.activeStepName).toBe("");
    expect(result.current.events).toEqual([]);
    expect(hooksMock.useStepConversationQuery).toHaveBeenLastCalledWith(
      "issue-b",
      "",
      "",
      { limit: 200 },
    );
  });

  it("starts a new live event buffer when the run changes", () => {
    let runId = "run-1";
    const connections: Parameters<typeof connectWs>[0][] = [];
    vi.mocked(connectWs).mockImplementation((options) => {
      connections.push(options);
      return () => {};
    });
    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      data: issueDetail("issue-a", runId, runId === "run-1" ? "build" : null),
      isLoading: false,
      isError: false,
      error: null,
    }));

    const { result, rerender } = renderHook(() => useIssueRuntime("issue-a"));
    act(() => {
      connections[0]?.onMessage({
        type: "event",
        data: {
          event_type: "output",
          timestamp: "2026-07-09T10:00:00Z",
          detail: "first run event",
          run_id: "run-1",
          sequence: 1,
        },
      });
    });

    runId = "run-2";
    rerender();

    expect(result.current.effectiveRunId).toBe("run-2");
    expect(result.current.activeStepName).toBe("");
    expect(result.current.events).toEqual([]);

    act(() => {
      connections[connections.length - 1]?.onMessage({
        type: "event",
        data: {
          event_type: "output",
          timestamp: "2026-07-09T10:01:00Z",
          detail: "second run event",
          run_id: "run-2",
          sequence: 1,
        },
      });
    });
    expect(result.current.events.map((event) => event.detail)).toEqual(["second run event"]);
  });

  it("reuses transcript entries within a session but not across issue sessions", () => {
    let appendRecord = false;
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: issueDetail(identifier, "run-1", "build"),
      isLoading: false,
      isError: false,
      error: null,
    }));
    hooksMock.useStepConversationQuery.mockImplementation((identifier: string) => ({
      data: {
        records: [
          {
            schema_version: 1,
            run_id: "run-1",
            issue_identifier: identifier,
            step_name: "build",
            attempt: 1,
            sequence: 1,
            timestamp: "2026-07-09T10:00:00Z",
            kind: "assistant_message",
            payload: { text: "unchanged" },
          },
          ...(appendRecord
            ? [
                {
                  schema_version: 1,
                  run_id: "run-1",
                  issue_identifier: identifier,
                  step_name: "build",
                  attempt: 1,
                  sequence: 2,
                  timestamp: "2026-07-09T10:00:01Z",
                  kind: "assistant_message",
                  payload: { text: "appended" },
                },
              ]
            : []),
        ],
      },
      isLoading: false,
      isError: false,
    }));

    const { result, rerender } = renderHook(
      ({ identifier }) => useIssueRuntime(identifier),
      { initialProps: { identifier: "issue-a" } },
    );
    const firstSessionEntry = result.current.transcriptEntries[0];

    appendRecord = true;
    rerender({ identifier: "issue-a" });
    expect(result.current.transcriptEntries[0]).toBe(firstSessionEntry);

    const committedEntry = result.current.transcriptEntries[0];
    rerender({ identifier: "issue-b" });
    expect(result.current.transcriptEntries[0]).not.toBe(committedEntry);
  });

  it("retires the previous run websocket before accepting events without a run id", () => {
    let runId = "run-1";
    const connections: Parameters<typeof connectWs>[0][] = [];
    vi.mocked(connectWs).mockImplementation((options) => {
      connections.push(options);
      return () => {};
    });
    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      data: issueDetail("issue-a", runId),
      isLoading: false,
      isError: false,
      error: null,
    }));

    const { result, rerender } = renderHook(() => useIssueRuntime("issue-a"));
    const retiredConnection = connections[0]!;

    runId = "run-2";
    rerender();
    expect(connections).toHaveLength(2);

    act(() => {
      retiredConnection.onMessage({
        type: "event",
        data: {
          event_type: "error",
          timestamp: "2026-07-09T10:00:00Z",
          detail: "queued first-run event",
          sequence: 1,
        },
      });
    });

    expect(result.current.events).toEqual([]);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("ignores messages and status changes from a retired websocket", () => {
    const connections: Parameters<typeof connectWs>[0][] = [];
    vi.mocked(connectWs).mockImplementation((options) => {
      connections.push(options);
      return () => {};
    });
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: issueDetail(identifier, `run-${identifier}`),
      isLoading: false,
      isError: false,
      error: null,
    }));

    const { result, rerender } = renderHook(
      ({ identifier }) => useIssueRuntime(identifier),
      { initialProps: { identifier: "issue-a" } },
    );
    const retiredConnection = connections[0]!;

    rerender({ identifier: "issue-b" });
    act(() => {
      retiredConnection.onStatusChange?.("connected");
      retiredConnection.onMessage({
        type: "event",
        data: {
          event_type: "output",
          timestamp: "2026-07-09T10:00:00Z",
          detail: "retired event",
          run_id: "run-issue-a",
          sequence: 1,
        },
      });
    });

    expect(result.current.wsStatus).toBe("disconnected");
    expect(result.current.events).toEqual([]);
  });

  it("keeps only the committed websocket active under StrictMode lifecycle replay", () => {
    let runId = "run-1";
    const connections: Parameters<typeof connectWs>[0][] = [];
    vi.mocked(connectWs).mockImplementation((options) => {
      connections.push(options);
      return () => {};
    });
    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      data: issueDetail("issue-a", runId),
      isLoading: false,
      isError: false,
      error: null,
    }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { result, rerender } = renderHook(() => useIssueRuntime("issue-a"), { wrapper });
    const retiredConnection = connections[0]!;

    runId = "run-2";
    rerender();
    expect(connections).toHaveLength(2);

    act(() => {
      retiredConnection.onMessage({
        type: "event",
        data: {
          event_type: "error",
          timestamp: "2026-07-09T10:00:00Z",
          detail: "retired strict event",
          sequence: 1,
        },
      });
      connections[1]!.onMessage({
        type: "event",
        data: {
          event_type: "error",
          timestamp: "2026-07-09T10:00:01Z",
          detail: "committed strict event",
          sequence: 2,
        },
      });
    });

    expect(result.current.events.map((event) => event.detail)).toEqual([
      "committed strict event",
    ]);
    expect(addNotification).toHaveBeenCalledTimes(1);
  });

  it("does not request notification permission or connect without an identifier", () => {
    renderHook(() => useIssueRuntime(""));

    expect(requestPermissionIfNeeded).not.toHaveBeenCalled();
    expect(connectWs).not.toHaveBeenCalled();
  });

  it("exposes transcript persistence failures to runtime consumers", () => {
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: issueDetail("issue-a", "run-a", "build"),
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useStepConversationQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    const { result } = renderHook(() => useIssueRuntime("issue-a"));

    expect(result.current.transcriptIsError).toBe(true);
  });

  it("exposes interaction detail loading and failure state to runtime consumers", () => {
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a", "build"),
        pending_input: { ask_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });

    const loadingView = renderHook(() => useIssueRuntime("issue-a"));
    expect(loadingView.result.current.interactionIsLoading).toBe(true);
    expect(loadingView.result.current.interactionIsError).toBe(false);
    loadingView.unmount();

    const interactionError = new Error("interaction lookup failed");
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: interactionError,
    });
    const errorView = renderHook(() => useIssueRuntime("issue-a"));

    expect(errorView.result.current.interactionIsLoading).toBe(false);
    expect(errorView.result.current.interactionIsError).toBe(true);
    expect(errorView.result.current.interactionError).toBe(interactionError);
  });

  it("does not query or expose interaction UI for a synthetic halted id", () => {
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", null, "review"),
        status: "halted",
        pending_input: { ask_id: "halted:issue-a:review" },
        current_interaction: {
          interaction_request_id: "halted:issue-a:review",
          requested_at: "2026-07-09T10:00:00Z",
          step_name: "review",
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockImplementation((interactionId: string) => ({
      data: undefined,
      isLoading: interactionId.length > 0,
      isError: interactionId.length > 0,
      error: interactionId.length > 0 ? new Error("interaction lookup should be disabled") : null,
    }));

    const { result } = renderHook(() => useIssueRuntime("issue-a"));

    expect(hooksMock.useInteractionDetailQuery).toHaveBeenCalledWith("");
    expect(result.current.interaction).toBeUndefined();
    expect(result.current.pendingQuestion).toBeNull();
    expect(result.current.interactionIsLoading).toBe(false);
    expect(result.current.interactionIsError).toBe(false);
  });

  it("does not expose an in-flight reply error after the identifier changes", async () => {
    let rejectReply: (error: Error) => void = () => {};
    hooksMock.respondMutateAsync.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectReply = reject;
        }),
    );
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: {
        ...issueDetail(identifier, `run-${identifier}`),
        pending_input: { ask_id: `ask-${identifier}` },
      },
      isLoading: false,
      isError: false,
      error: null,
    }));
    hooksMock.useInteractionDetailQuery.mockImplementation((interactionId: string) => ({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: interactionId,
        issue_id: interactionId,
        issue_identifier: interactionId.replace("ask-", ""),
        status: "open",
        kind: "question",
        question: "Continue?",
        why_blocked: "Needs input",
        suggested_answer: null,
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-07-09T10:00:00Z",
      },
    }));

    const { result, rerender } = renderHook(
      ({ identifier }) => useIssueRuntime(identifier),
      { initialProps: { identifier: "issue-a" } },
    );
    let submission: Promise<boolean> | undefined;
    act(() => {
      submission = result.current.submitInteractionReply({ kind: "question", text: "continue" });
    });

    rerender({ identifier: "issue-b" });
    await act(async () => {
      rejectReply(new Error("issue A reply failed"));
      await submission;
    });

    expect(result.current.identifier).toBe("issue-b");
    expect(result.current.composerError).toBeNull();
  });

  it("answers a new issue normally after the previous issue was awaiting a resume retry", async () => {
    hooksMock.resumeMutateAsync
      .mockRejectedValueOnce(new Error("issue A resume failed"))
      .mockResolvedValueOnce({});
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: {
        ...issueDetail(identifier, `run-${identifier}`),
        pending_input: { ask_id: `ask-${identifier}` },
      },
      isLoading: false,
      isError: false,
      error: null,
    }));
    hooksMock.useInteractionDetailQuery.mockImplementation((interactionId: string) => ({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: interactionId,
        issue_id: interactionId,
        issue_identifier: interactionId.replace("ask-", ""),
        status: "open",
        kind: "question",
        question: "Continue?",
        why_blocked: "Needs input",
        suggested_answer: null,
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-07-09T10:00:00Z",
      },
    }));

    const { result, rerender } = renderHook(
      ({ identifier }) => useIssueRuntime(identifier),
      { initialProps: { identifier: "issue-a" } },
    );

    await act(async () => {
      expect(
        await result.current.submitInteractionReply({ kind: "question", text: "answer A" }),
      ).toBe(false);
    });
    expect(hooksMock.respondMutateAsync).toHaveBeenCalledTimes(1);
    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledTimes(1);

    rerender({ identifier: "issue-b" });
    await act(async () => {
      expect(
        await result.current.submitInteractionReply({ kind: "question", text: "answer B" }),
      ).toBe(true);
    });

    expect(hooksMock.respondMutateAsync).toHaveBeenCalledTimes(2);
    expect(hooksMock.respondMutateAsync).toHaveBeenLastCalledWith({
      id: "ask-issue-b",
      kind: "question",
      response_schema_version: 1,
      selected_option: null,
      text: "answer B",
    });
    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledTimes(2);
    expect(hooksMock.resumeMutateAsync).toHaveBeenLastCalledWith({
      identifier: "issue-b",
      interactionId: "ask-issue-b",
    });
  });

  it("resumes a persisted resolved interaction without responding again after remount", async () => {
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a"),
        pending_input: { ask_id: "ask-resolved" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: "ask-resolved",
        issue_id: "issue-a",
        issue_identifier: "issue-a",
        status: "resolved",
        kind: "approval",
        question: "Continue?",
        why_blocked: "Needs approval",
        suggested_answer: null,
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-07-09T10:00:00Z",
      },
      isLoading: false,
      isError: false,
      error: null,
    });

    const { result } = renderHook(() => useIssueRuntime("issue-a"));
    await act(async () => {
      expect(await result.current.resumeInteraction()).toBe(true);
    });

    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledWith({
      identifier: "issue-a",
      interactionId: "ask-resolved",
    });
    expect(hooksMock.respondMutateAsync).not.toHaveBeenCalled();
  });

  it("queues resume only once until server authority reports completion", async () => {
    let currentInteraction = {
      agent_name: "builder",
      awaiting_resume: true,
      id: "ask-resolved",
      issue_id: "issue-a",
      issue_identifier: "issue-a",
      status: "resolved" as const,
      kind: "question" as const,
      question: "Continue?",
      why_blocked: "Needs input",
      suggested_answer: null,
      extra_context: null,
      step_name: "deploy",
      requested_at: "2026-07-09T10:00:00Z",
    };
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a"),
        pending_input: { ask_id: "ask-resolved" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockImplementation(() => ({
      data: currentInteraction,
      isLoading: false,
      isError: false,
      error: null,
    }));

    const { result, rerender } = renderHook(() => useIssueRuntime("issue-a"));
    await act(async () => {
      expect(await result.current.resumeInteraction()).toBe(true);
      expect(await result.current.resumeInteraction()).toBe(true);
    });

    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledOnce();
    expect(result.current.resumeQueued).toBe(true);
    expect(result.current.pendingQuestion).not.toBeNull();

    currentInteraction = { ...currentInteraction, awaiting_resume: false };
    rerender();

    expect(result.current.resumeQueued).toBe(false);
    expect(result.current.pendingQuestion).toBeNull();
  });

  it("does not restore queued recovery after server authority completes during the request", async () => {
    let currentInteraction = {
      agent_name: "builder",
      awaiting_resume: true,
      id: "ask-resolved",
      issue_id: "issue-a",
      issue_identifier: "issue-a",
      status: "resolved" as const,
      kind: "question" as const,
      question: "Continue?",
      why_blocked: "Needs input",
      suggested_answer: null,
      extra_context: null,
      step_name: "deploy",
      requested_at: "2026-07-09T10:00:00Z",
    };
    let resolveResume: () => void = () => {};
    hooksMock.resumeMutateAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve;
        }),
    );
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a"),
        pending_input: { ask_id: "ask-resolved" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockImplementation(() => ({
      data: currentInteraction,
      isLoading: false,
      isError: false,
      error: null,
    }));

    const { result, rerender } = renderHook(() => useIssueRuntime("issue-a"));
    let submission: Promise<boolean> | undefined;
    act(() => {
      submission = result.current.resumeInteraction();
    });
    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledOnce();

    currentInteraction = { ...currentInteraction, awaiting_resume: false };
    rerender();
    expect(result.current.resumeQueued).toBe(false);

    await act(async () => {
      resolveResume();
      await submission;
    });

    expect(result.current.resumeQueued).toBe(false);
    expect(result.current.pendingQuestion).toBeNull();
  });

  it("allows resume retry after a queued request fails", async () => {
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a"),
        pending_input: { ask_id: "ask-resolved" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: "ask-resolved",
        issue_id: "issue-a",
        issue_identifier: "issue-a",
        status: "resolved",
        kind: "question",
        question: "Continue?",
        why_blocked: "Needs input",
        suggested_answer: null,
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-07-09T10:00:00Z",
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.resumeMutateAsync
      .mockRejectedValueOnce(new Error("resume unavailable"))
      .mockResolvedValueOnce({});

    const { result } = renderHook(() => useIssueRuntime("issue-a"));
    await act(async () => {
      expect(await result.current.resumeInteraction()).toBe(false);
      expect(await result.current.resumeInteraction()).toBe(true);
    });

    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.resumeQueued).toBe(true);
  });

  it("recovers a committed response after the response request rejects", async () => {
    const openInteraction = {
      agent_name: "builder",
      awaiting_resume: true,
      id: "ask-1",
      issue_id: "issue-a",
      issue_identifier: "issue-a",
      status: "open",
      kind: "question",
      question: "Continue?",
      why_blocked: "Needs input",
      suggested_answer: null,
      extra_context: null,
      step_name: "deploy",
      requested_at: "2026-07-09T10:00:00Z",
    } as const;
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a"),
        pending_input: { ask_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.respondMutateAsync.mockRejectedValueOnce(new Error("response lost"));
    hooksMock.interactionRefetch.mockResolvedValueOnce({
      data: { ...openInteraction, status: "resolved", awaiting_resume: true },
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: openInteraction,
      refetch: hooksMock.interactionRefetch,
      isLoading: false,
      isError: false,
      error: null,
    });

    const { result } = renderHook(() => useIssueRuntime("issue-a"));
    await act(async () => {
      expect(
        await result.current.submitInteractionReply({ kind: "question", text: "continue" }),
      ).toBe(true);
    });

    expect(hooksMock.respondMutateAsync).toHaveBeenCalledOnce();
    expect(hooksMock.interactionRefetch).toHaveBeenCalledOnce();
    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledWith({
      identifier: "issue-a",
      interactionId: "ask-1",
    });
    expect(result.current.composerError).toBeNull();
  });

  it("does not recover a definitive interaction response conflict", async () => {
    const openInteraction = {
      agent_name: "builder",
      awaiting_resume: true,
      id: "ask-1",
      issue_id: "issue-a",
      issue_identifier: "issue-a",
      status: "open",
      kind: "question",
      question: "Continue?",
      why_blocked: "Needs input",
      suggested_answer: null,
      extra_context: null,
      step_name: "deploy",
      requested_at: "2026-07-09T10:00:00Z",
    } as const;
    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        ...issueDetail("issue-a", "run-a"),
        pending_input: { ask_id: "ask-1" },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.respondMutateAsync.mockRejectedValueOnce(
      new FetchError(409, {
        error: { code: "already_resolved", message: "interaction is already resolved" },
      }),
    );
    hooksMock.interactionRefetch.mockResolvedValueOnce({
      data: { ...openInteraction, status: "resolved", awaiting_resume: true },
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: openInteraction,
      refetch: hooksMock.interactionRefetch,
      isLoading: false,
      isError: false,
      error: null,
    });

    const { result } = renderHook(() => useIssueRuntime("issue-a"));
    await act(async () => {
      expect(
        await result.current.submitInteractionReply({ kind: "question", text: "continue" }),
      ).toBe(false);
    });

    expect(hooksMock.interactionRefetch).not.toHaveBeenCalled();
    expect(hooksMock.resumeMutateAsync).not.toHaveBeenCalled();
    expect(result.current.composerError).toBe("interaction is already resolved");
  });

  it.each([
    ["completed_failed", "failed"],
    ["completed_succeeded", "passed"],
  ])(
    "prefers the last persisted transcript artifact when mounting a %s issue directly",
    async (status, terminalStepState) => {
      const terminalDetail = {
        issue_identifier: "todo-1",
        issue_id: "NODE_1",
        status,
        running: null,
        attempts: { restart_count: 0, current_retry_attempt: null },
        retry: null,
        pending_input: null,
        current_interaction: null,
        last_error: status === "completed_failed" ? "review failed" : null,
        issue: { title: "Deploy feature", description: null, labels: [] },
        workspace: { path: "/tmp/workspace" },
        finalize: { status: "not_required", repos: [] },
        artifacts: {
          run_id: "run-terminal",
          workspace_path: "/tmp/workspace",
          repos: [],
          transcripts: [
            { step_name: "setup", run_id: "run-terminal", record_count: 2 },
            { step_name: "build", run_id: "run-terminal", record_count: 1 },
          ],
        },
        workflow_steps: [
          {
            name: "build",
            agent: "builder",
            kind: "agent",
            dependencies: [],
            state: "passed",
            can_navigate: true,
          },
          {
            name: "review",
            agent: "reviewer",
            kind: "agent",
            dependencies: ["build"],
            state: terminalStepState,
            can_navigate: true,
          },
          {
            name: "publish",
            agent: "publisher",
            kind: "agent",
            dependencies: ["review"],
            state: "pending",
            can_navigate: false,
          },
        ],
      } satisfies IssueDetailSnapshot;
      hooksMock.useIssueDetailQuery.mockReturnValue({
        data: terminalDetail,
        isLoading: false,
        isError: false,
        error: null,
      });
      hooksMock.useInteractionDetailQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: false,
        error: null,
      });
      hooksMock.useTimelineQuery.mockImplementation((_identifier: string, runId?: string) => ({
        data: {
          events:
            runId === "run-terminal"
              ? [
                  {
                    run_id: "run-terminal",
                    issue_identifier: "todo-1",
                    sequence: 1,
                    timestamp: "2026-07-09T10:00:00Z",
                    event_type: "output",
                    step_name: "review",
                    attempt: 1,
                    detail: "Persisted terminal log",
                  },
                ]
              : [],
          total: runId === "run-terminal" ? 1 : 0,
        },
        isError: false,
      }));
      hooksMock.useStepConversationQuery.mockImplementation(
        (_identifier: string, runId: string, stepName: string) => ({
          data: {
            records:
              runId === "run-terminal" && stepName === "build"
                ? [
                    {
                      schema_version: 1,
                      run_id: "run-terminal",
                      issue_identifier: "todo-1",
                      step_name: "build",
                      attempt: 1,
                      sequence: 1,
                      timestamp: "2026-07-09T10:00:01Z",
                      kind: "assistant_message",
                      payload: { text: "Persisted terminal transcript" },
                    },
                  ]
                : [],
          },
          isLoading: false,
          isError: false,
        }),
      );

      const { result } = renderHook(() => useIssueRuntime("todo-1"));

      expect(result.current.effectiveRunId).toBe("run-terminal");
      expect(result.current.activeStepName).toBe("build");
      expect(result.current.transcriptEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent_message",
            message: expect.objectContaining({ content: "Persisted terminal transcript" }),
          }),
        ]),
      );
      expect(result.current.events).toEqual([
        expect.objectContaining({ detail: "Persisted terminal log", stepName: "review" }),
      ]);
      expect(hooksMock.useTimelineQuery).toHaveBeenLastCalledWith("todo-1", "run-terminal");
      expect(hooksMock.useStepConversationQuery).toHaveBeenLastCalledWith(
        "todo-1",
        "run-terminal",
        "build",
        { limit: 200 },
      );

      renderWithProviders(
        <Routes>
          <Route path="/issue/:identifier" element={<IssueDetail />} />
        </Routes>,
        { route: "/issue/todo-1" },
      );
      expect(screen.getByText("Persisted terminal transcript")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("tab", { name: "Raw events" }));
      expect(screen.getAllByText("Persisted terminal log").length).toBeGreaterThan(0);
    },
  );
});

describe("IssueDetail", () => {
  beforeEach(() => {
    hooksMock.stopMutate.mockClear();
    hooksMock.retryMutate.mockClear();
    hooksMock.respondMutateAsync.mockReset().mockResolvedValue({});
    hooksMock.resumeMutateAsync.mockReset().mockResolvedValue({});
    hooksMock.interactionRefetch.mockReset().mockResolvedValue({ data: undefined });
    hooksMock.finalizeApproveMutate.mockClear();
    hooksMock.finalizeRetryMutate.mockClear();
    hooksMock.cancelMutate.mockClear();
    hooksMock.useStopMutation.mockReturnValue({
      mutate: hooksMock.stopMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    hooksMock.useRetryMutation.mockReturnValue({
      mutate: hooksMock.retryMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    hooksMock.useCancelInteractionMutation.mockReturnValue({
      mutate: hooksMock.cancelMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    vi.mocked(connectWs).mockReset().mockImplementation(() => () => {});
    hooksMock.useIssueDetailQuery.mockReturnValue({
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
    });
    hooksMock.useTimelineQuery.mockReturnValue({ data: { events: [] }, isError: false });
    hooksMock.useStepConversationQuery.mockReturnValue({
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
    });
    hooksMock.useFinalizeApproveMutation.mockReturnValue({
      mutate: hooksMock.finalizeApproveMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    hooksMock.useFinalizeRetryMutation.mockReturnValue({
      mutate: hooksMock.finalizeRetryMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: "ask-1",
        issue_id: "issue-1",
        issue_identifier: "todo-1",
        status: "open",
        kind: "question",
        question: "Which environment?",
        why_blocked: "Need target",
        suggested_answer: "staging",
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-04-14T10:00:00Z",
      },
      refetch: hooksMock.interactionRefetch,
    });
  });

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

  it("shows interaction loading instead of an unsupported follow-up composer", () => {
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByText("Loading interaction...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Follow-up" })).not.toBeInTheDocument();
  });

  it("shows interaction errors instead of an unsupported follow-up composer", () => {
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("interaction endpoint unavailable"),
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByText("Failed to load interaction")).toBeInTheDocument();
    expect(screen.getByText("interaction endpoint unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Follow-up" })).not.toBeInTheDocument();
  });

  it("renders a passive Respond state when no interaction is actionable", () => {
    const current = hooksMock.useIssueDetailQuery("todo-1");
    hooksMock.useIssueDetailQuery.mockReturnValue({
      ...current,
      data: {
        ...current.data,
        pending_input: null,
        current_interaction: null,
      },
    });
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByText(/No response is currently available/)).toBeInTheDocument();
    expect(screen.getByText(/Transcript or Steps/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send Follow-up" })).not.toBeInTheDocument();
  });

  it("renders synthetic halted detail as passive inspection without an interaction error", () => {
    const current = hooksMock.useIssueDetailQuery("todo-1");
    hooksMock.useIssueDetailQuery.mockReturnValue({
      ...current,
      data: {
        ...current.data,
        status: "halted",
        running: null,
        pending_input: { ask_id: "halted:issue-1:deploy" },
        current_interaction: {
          interaction_request_id: "halted:issue-1:deploy",
          requested_at: "2026-07-09T10:00:00Z",
          step_name: "deploy",
        },
      },
    });
    hooksMock.useInteractionDetailQuery.mockImplementation((interactionId: string) => ({
      data: undefined,
      isLoading: false,
      isError: interactionId.length > 0,
      error: interactionId.length > 0 ? new Error("interaction not found") : null,
    }));

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(hooksMock.useInteractionDetailQuery).toHaveBeenCalledWith("");
    expect(screen.getByText(/No response is currently available/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load interaction")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
  });

  it.each([
    ["open", true],
    ["resolved", false],
    ["cancelled", false],
  ])("shows cancellation for %s interactions: %s", (status, shouldShowCancel) => {
    hooksMock.useInteractionDetailQuery.mockReturnValue({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: "ask-1",
        issue_id: "issue-1",
        issue_identifier: "todo-1",
        status,
        kind: "question",
        question: "Which environment?",
        why_blocked: "Need target",
        suggested_answer: "staging",
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-04-14T10:00:00Z",
      },
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    if (shouldShowCancel) {
      expect(screen.getByRole("button", { name: "Cancel Request" })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("button", { name: "Cancel Request" })).not.toBeInTheDocument();
    }
  });

  it("shows transcript persistence failure instead of an empty transcript", () => {
    hooksMock.useStepConversationQuery.mockReturnValue({
      data: { records: [] },
      isLoading: false,
      isError: true,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByText(/Could not load saved transcript history/)).toBeInTheDocument();
    expect(screen.queryByText("No transcript activity yet.")).not.toBeInTheDocument();
  });

  it("resets action UI when the route identifier changes", async () => {
    const user = userEvent.setup();
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: {
        issue_identifier: identifier,
        status: "running",
        running: {
          step_name: "deploy",
          turn_count: 2,
          tokens: { total_tokens: 100 },
          run_id: `run-${identifier}`,
        },
        attempts: { restart_count: 0 },
        retry: null,
        last_error: null,
        issue: { title: `${identifier} title`, labels: [] },
        workspace: { path: "/tmp/workspace" },
        workflow_steps: [],
        pending_input: { ask_id: `ask-${identifier}` },
        current_interaction: { interaction_request_id: `ask-${identifier}` },
      },
      isLoading: false,
      isError: false,
      error: null,
    }));
    hooksMock.useInteractionDetailQuery.mockImplementation((interactionId: string) => ({
      data: {
        agent_name: "builder",
        awaiting_resume: true,
        id: interactionId,
        issue_id: interactionId,
        issue_identifier: interactionId.replace("ask-", ""),
        status: "open",
        kind: "question",
        question: `Question for ${interactionId}`,
        why_blocked: "Needs input",
        suggested_answer: null,
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-07-09T10:00:00Z",
      },
    }));

    renderWithProviders(<SwitchableIssueDetail />, { route: "/issue/issue-a" });

    await user.type(screen.getByLabelText("Reply"), "issue A draft");
    await user.click(screen.getByRole("button", { name: "Stop Agent" }));
    expect(screen.getByText(/stop the agent for issue-a/i)).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Switch issue", hidden: true }).click();
    });

    expect(screen.getByLabelText("Reply")).toHaveValue("");
    expect(screen.queryByText(/stop the agent for issue-b/i)).not.toBeInTheDocument();
  });

  it("answers a blocked interaction and resumes the issue without using stale input", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    await user.type(screen.getByLabelText("Reply"), "Deploy to production");
    await user.click(screen.getByRole("button", { name: "Submit Reply" }));

    expect(hooksMock.respondMutateAsync).toHaveBeenCalledWith({
      id: "ask-1",
      kind: "question",
      response_schema_version: 1,
      selected_option: null,
      text: "Deploy to production",
    });
    expect(hooksMock.resumeMutateAsync).toHaveBeenCalledWith({
      identifier: "todo-1",
      interactionId: "ask-1",
    });
  });

  const interactionResponseCases: Array<
    [InteractionKind, string, string, string, Record<string, unknown>]
  > = [
    [
      "approval",
      "Reason (optional)",
      "Ship it",
      "Approve",
      { id: "ask-1", kind: "approval", response_schema_version: 1, approved: true, reason: "Ship it" },
    ],
    [
      "approval",
      "Reason (optional)",
      "Unsafe to ship",
      "Reject",
      {
        id: "ask-1",
        kind: "approval",
        response_schema_version: 1,
        approved: false,
        reason: "Unsafe to ship",
      },
    ],
    [
      "handoff",
      "Notes (optional)",
      "Operator completed setup",
      "Complete",
      {
        id: "ask-1",
        kind: "handoff",
        response_schema_version: 1,
        completed: true,
        notes: "Operator completed setup",
      },
    ],
    [
      "handoff",
      "Notes (optional)",
      "Deployment failed",
      "Incomplete",
      {
        id: "ask-1",
        kind: "handoff",
        response_schema_version: 1,
        completed: false,
        notes: "Deployment failed",
      },
    ],
  ];

  it.each(interactionResponseCases)(
    "maps %s interactions to the matching response body",
    async (kind, inputLabel, reply, buttonName, expectedBody) => {
      const user = userEvent.setup();
      hooksMock.useInteractionDetailQuery.mockReturnValue({
        data: {
          agent_name: "builder",
          awaiting_resume: true,
          id: "ask-1",
          issue_id: "issue-1",
          issue_identifier: "todo-1",
          status: "open",
          kind,
          question: "Approve this action?",
          why_blocked: "Need operator confirmation",
          suggested_answer: "Approve this action",
          extra_context: null,
          step_name: "deploy",
          requested_at: "2026-04-14T10:00:00Z",
        },
      });

      renderWithProviders(
        <Routes>
          <Route path="/issue/:identifier" element={<IssueDetail />} />
        </Routes>,
        { route: "/issue/todo-1" },
      );

      await user.type(screen.getByLabelText(inputLabel), reply);
      await user.click(screen.getByRole("button", { name: buttonName }));

      expect(hooksMock.respondMutateAsync).toHaveBeenCalledWith(expectedBody);
      expect(hooksMock.resumeMutateAsync).toHaveBeenCalledWith({
        identifier: "todo-1",
        interactionId: "ask-1",
      });
    },
  );

  it("keeps the composer context visible and shows an inline error when reply fails", async () => {
    const user = userEvent.setup();
    hooksMock.respondMutateAsync.mockRejectedValueOnce(new Error("reply failed"));
    hooksMock.interactionRefetch.mockResolvedValueOnce({
      data: hooksMock.useInteractionDetailQuery("ask-1").data,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    await user.type(screen.getByLabelText("Reply"), "Deploy to production");
    await user.click(screen.getByRole("button", { name: "Submit Reply" }));

    expect(screen.getAllByText("Which environment?")).toHaveLength(2);
    expect(screen.getByLabelText("Reply")).toHaveValue("Deploy to production");
    expect(await screen.findByText("reply failed")).toBeInTheDocument();
    expect(hooksMock.interactionRefetch).toHaveBeenCalledOnce();
    expect(hooksMock.resumeMutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the composer context visible and shows an inline error when resume fails", async () => {
    const user = userEvent.setup();
    hooksMock.resumeMutateAsync.mockRejectedValueOnce(new Error("resume failed"));

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    await user.type(screen.getByLabelText("Reply"), "Deploy to production");
    await user.click(screen.getByRole("button", { name: "Submit Reply" }));

    expect(screen.getAllByText("Which environment?")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Resume issue" })).toBeInTheDocument();
    expect(await screen.findByText("resume failed")).toBeInTheDocument();
  });

  it("retries only resume after response succeeds but resume fails", async () => {
    const user = userEvent.setup();
    hooksMock.resumeMutateAsync.mockRejectedValueOnce(new Error("resume failed"));

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    await user.type(screen.getByLabelText("Reply"), "Deploy to production");
    await user.click(screen.getByRole("button", { name: "Submit Reply" }));
    expect(await screen.findByText("resume failed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume issue" }));

    await waitFor(() => expect(hooksMock.resumeMutateAsync).toHaveBeenCalledTimes(2));
    expect(hooksMock.respondMutateAsync).toHaveBeenCalledTimes(1);
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

  it("summarizes pending finalize targets and requires confirmation", async () => {
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
        finalize: {
          status: "pending_approval",
          repos: [
            {
              approval_required: true,
              last_error: null,
              mode: "push_and_pr",
              repo: "/tmp/workspace/backend",
              status: "pending_approval",
            },
          ],
        },
        workflow_steps: [],
      } as any,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByText("Finalize approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve finalize" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/\/tmp\/workspace\/backend/)).toBeInTheDocument();
    expect(within(dialog).getByText(/push_and_pr/)).toBeInTheDocument();
    expect(hooksMock.finalizeApproveMutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(hooksMock.finalizeApproveMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Approve finalize" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Approve finalize",
      }),
    );

    expect(hooksMock.finalizeApproveMutate).toHaveBeenCalledWith({ identifier: "todo-1" });
    expect(hooksMock.finalizeRetryMutate).not.toHaveBeenCalled();
  });

  it("invalidates finalize confirmation when status changes", async () => {
    const current = hooksMock.useIssueDetailQuery("todo-1");
    const pendingRepo = {
      approval_required: true,
      last_error: null,
      mode: "push_and_pr",
      repo: "/tmp/workspace/backend",
      status: "pending_approval",
    };
    let finalize = { status: "pending_approval", repos: [pendingRepo] };
    hooksMock.useIssueDetailQuery.mockImplementation(() => ({
      ...current,
      data: { ...current.data, finalize },
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
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
    await userEvent.click(screen.getByRole("button", { name: "Approve finalize" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    finalize = {
      status: "in_progress",
      repos: [{ ...pendingRepo, status: "in_progress" }],
    };
    view.rerender(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(hooksMock.finalizeApproveMutate).not.toHaveBeenCalled();
  });

  it("renders failed finalize controls and calls retry", async () => {
    const user = userEvent.setup();

    hooksMock.useIssueDetailQuery.mockReturnValue({
      data: {
        issue_identifier: "todo-1",
        issue_id: "NODE_1",
        status: "failed",
        running: null,
        attempts: { restart_count: 0, current_retry_attempt: null },
        retry: null,
        pending_input: null,
        current_interaction: null,
        last_error: null,
        issue: { title: "Deploy feature", labels: [] },
        workspace: { path: "/tmp/workspace" },
        finalize: { status: "failed", repos: [] },
        workflow_steps: [],
      } as any,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByText("Finalize failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry finalize" }));

    expect(hooksMock.finalizeRetryMutate).toHaveBeenCalledWith({ identifier: "todo-1" });
    expect(hooksMock.finalizeApproveMutate).not.toHaveBeenCalled();
  });

  it.each(["skipped_headless", "in_progress"])(
    "renders %s finalize status without invalid actions",
    (finalizeStatus) => {
      hooksMock.useIssueDetailQuery.mockReturnValue({
        data: {
          issue_identifier: "todo-1",
          issue_id: "NODE_1",
          status: "running",
          running: null,
          attempts: { restart_count: 0, current_retry_attempt: null },
          retry: null,
          pending_input: null,
          current_interaction: null,
          last_error: null,
          issue: { title: "Deploy feature", labels: [] },
          workspace: { path: "/tmp/workspace" },
          finalize: { status: finalizeStatus, repos: [] },
          workflow_steps: [],
        } as any,
        isLoading: false,
        isError: false,
        error: null,
      });

      renderWithProviders(
        <Routes>
          <Route path="/issue/:identifier" element={<IssueDetail />} />
        </Routes>,
        { route: "/issue/todo-1" },
      );

      expect(screen.getByText("Finalize status")).toBeInTheDocument();
      expect(screen.getByText(finalizeStatus)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve finalize" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry finalize" })).not.toBeInTheDocument();
    },
  );

  it("shows finalize action errors inline", () => {
    hooksMock.useFinalizeApproveMutation.mockReturnValue({
      mutate: hooksMock.finalizeApproveMutate,
      isPending: false,
      isError: true,
      error: new Error("approval failed"),
    });
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
        finalize: { status: "pending_approval", repos: [] },
        workflow_steps: [],
      } as any,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByRole("alert")).toHaveTextContent("approval failed");
  });

  it.each([
    ["stop", "stop failed"],
    ["retry", "retry failed"],
    ["cancel", "cancel failed"],
  ] as const)("shows %s action failures in an inline alert", (action, message) => {
    const failedMutation = {
      mutate: vi.fn(),
      isPending: false,
      isError: true,
      error: new Error(message),
    };
    if (action === "stop") hooksMock.useStopMutation.mockReturnValue(failedMutation);
    if (action === "retry") hooksMock.useRetryMutation.mockReturnValue(failedMutation);
    if (action === "cancel") hooksMock.useCancelInteractionMutation.mockReturnValue(failedMutation);
    if (action === "retry") {
      const current = hooksMock.useIssueDetailQuery("todo-1");
      hooksMock.useIssueDetailQuery.mockReturnValue({
        ...current,
        data: {
          ...current.data,
          retry: {
            issue_id: "issue-1",
            issue_identifier: "todo-1",
            attempt: 2,
            due_at_ms: 1000,
            error: "failed",
          },
        },
      });
    }

    renderWithProviders(
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>,
      { route: "/issue/todo-1" },
    );

    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("does not show an action failure after navigating to another identifier", async () => {
    hooksMock.useStopMutation.mockReturnValue({
      mutate: hooksMock.stopMutate,
      isPending: false,
      isError: true,
      error: new Error("issue A stop failed"),
    });
    hooksMock.useIssueDetailQuery.mockImplementation((identifier: string) => ({
      data: {
        issue_identifier: identifier,
        status: "running",
        running: {
          step_name: "deploy",
          turn_count: 2,
          tokens: { total_tokens: 100 },
          run_id: `run-${identifier}`,
        },
        attempts: { restart_count: 0 },
        retry: null,
        last_error: null,
        issue: { title: `${identifier} title`, labels: [] },
        workspace: { path: "/tmp/workspace" },
        workflow_steps: [],
        pending_input: null,
        current_interaction: null,
      },
      isLoading: false,
      isError: false,
      error: null,
    }));

    renderWithProviders(<SwitchableIssueDetail />, { route: "/issue/issue-a" });
    expect(screen.getByRole("alert")).toHaveTextContent("issue A stop failed");

    hooksMock.useStopMutation.mockReturnValue({
      mutate: hooksMock.stopMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    await userEvent.click(screen.getByRole("button", { name: "Switch issue", hidden: true }));
    expect(screen.queryByText("issue A stop failed")).not.toBeInTheDocument();
  });
});
