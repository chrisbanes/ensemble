import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import { connectWs } from "@/ws";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import type { GroupedTranscriptEntry } from "@/components/transcript/transcript-model";
import IssueDetail from "./IssueDetail";

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
    useConversationQuery: vi.fn(() => ({
      data: {
        messages: [
          { index: 1, role: "assistant", content: "I am ready", tool_calls: null },
        ],
      },
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
      },
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

  it("reveals hidden transcript history when a raw event jumps to an older conversation entry", async () => {
    const user = userEvent.setup();
    const connectWsMock = vi.mocked(connectWs);

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
});
