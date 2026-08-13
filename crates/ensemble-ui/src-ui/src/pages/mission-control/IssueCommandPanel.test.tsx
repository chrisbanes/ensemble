import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import type {
  InteractionDetail,
  InteractionStatus,
  IssueActionCapabilities,
  IssueDetailSnapshot,
} from "@/generated/models";
import { IssueCommandPanel, type IssueCommandPanelTab } from "./IssueCommandPanel";
import { useIssueRuntime, type IssueRuntimeState } from "./useIssueRuntime";

vi.mock("./useIssueRuntime", () => ({
  useIssueRuntime: vi.fn(),
}));

const actions = {
  stop: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  finalizeApprove: vi.fn(),
  finalizeRetry: vi.fn(),
  submitReply: vi.fn(),
  setActiveEntry: vi.fn(),
  setActiveEntryForConversation: vi.fn(),
};

function capability(enabled: boolean, disabledReason = "Unavailable for this test.") {
  return enabled ? { enabled } : { enabled, disabled_reason: disabledReason };
}

function capabilitiesFor(
  data: Pick<IssueDetailSnapshot, "running" | "retry" | "finalize">,
  interaction?: InteractionDetail,
): IssueActionCapabilities {
  const interactionOpen = interaction?.status === "open";
  const canResume = interaction?.status === "resolved" && interaction.awaiting_resume;
  return {
    inspect: capability(true),
    reply: capability(interactionOpen ?? true),
    guide: capability(false),
    cancel: capability(interactionOpen ?? true),
    stop: capability(data.running != null),
    retry: capability(data.retry != null),
    resume: capability(canResume),
    finalize_approve: capability(data.finalize.status === "pending_approval"),
    finalize_retry: capability(data.finalize.status === "failed"),
    cleanup: capability(false),
  };
}

function mockMutation<T>(mutate: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isError: false,
    isIdle: true,
    isPaused: false,
    isPending: false,
    isSuccess: false,
    mutate,
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    status: "idle",
    submittedAt: 0,
    variables: undefined,
    ...overrides,
  } as T;
}

const issue = {
  attention_items: [],
  issue_identifier: "repo#1",
  issue_id: "issue-1",
  status: "running",
  running: {
    run_id: "run-1",
    session_id: "session-1",
    started_at: "2026-07-09T10:00:00Z",
    state: "running",
    step_name: "build",
    turn_count: 3,
    tokens: { total_tokens: 1_250, input_tokens: 1_000, output_tokens: 250 },
  },
  retry: null,
  attempts: { restart_count: 1, current_retry_attempt: null },
  workspace: { path: "/tmp/workspace" },
  workflow_steps: [
    {
      name: "build",
      agent: "builder",
      kind: "agent",
      dependencies: [],
      state: "running",
      can_navigate: true,
      capabilities: { inspect: { enabled: true } },
    },
  ],
  artifacts: null,
  finalize: { status: "not_required", repos: [] },
  issue: { title: "Test issue", description: "Ship the command panel", labels: ["ui"] },
  last_error: null,
  pending_input: null,
  current_interaction: null,
  acceptance_attempts: [
    {
      cycle: 1,
      results: [
        {
          version: 2,
          name: "unit tests",
          status: "passed",
          summary: "tests passed",
          timing: { kind: "unknown" },
          evidence: {
            kind: "command",
            exit_code: 0,
            stdout: { tail: "ok", total_bytes: 2, truncated: false },
            stderr: { tail: "", total_bytes: 0, truncated: false },
          },
        },
      ],
    },
  ],
  capabilities: capabilitiesFor({
    running: {} as IssueDetailSnapshot["running"],
    retry: null,
    finalize: { status: "not_required", repos: [] },
  }),
} satisfies IssueDetailSnapshot;

const openInteraction = {
  agent_name: "builder",
  awaiting_resume: true,
  id: "ask-1",
  issue_id: "issue-1",
  issue_identifier: "repo#1",
  kind: "question",
  question: "Which environment?",
  requested_at: "2026-07-09T10:05:00Z",
  status: "open" satisfies InteractionStatus,
  step_name: "build",
  suggested_answer: "staging",
  why_blocked: "A deployment target is required.",
} satisfies InteractionDetail;

function runtimeFixture(overrides: Partial<IssueRuntimeState> = {}): IssueRuntimeState {
  const { data: dataOverride, interaction, ...runtimeOverrides } = overrides;
  const data = dataOverride
    ? {
        ...dataOverride,
        capabilities:
          dataOverride.capabilities && dataOverride.capabilities !== issue.capabilities
            ? dataOverride.capabilities
            : capabilitiesFor(dataOverride, interaction),
      }
    : { ...issue, capabilities: capabilitiesFor(issue, interaction) };
  return {
    identifier: "repo#1",
    data,
    isLoading: false,
    isError: false,
    error: null,
    interaction: interaction ?? undefined,
    interactionIsLoading: false,
    interactionIsError: false,
    interactionError: null,
    pendingQuestion: null,
    isLiveRun: true,
    wsStatus: "connected",
    effectiveRunId: "run-1",
    activeStepName: "build",
    events: [],
    transcriptEntries: [],
    activeTranscriptEntryId: null,
    transcriptSessionKey: "repo#1:run-1:build",
    transcriptIsError: false,
    timelineIsError: false,
    retryMutation: mockMutation<IssueRuntimeState["retryMutation"]>(actions.retry),
    stopMutation: mockMutation<IssueRuntimeState["stopMutation"]>(actions.stop),
    respondMutation: mockMutation<IssueRuntimeState["respondMutation"]>(vi.fn()),
    resumeMutation: mockMutation<IssueRuntimeState["resumeMutation"]>(vi.fn()),
    cancelMutation: mockMutation<IssueRuntimeState["cancelMutation"]>(actions.cancel),
    finalizeApproveMutation: mockMutation<IssueRuntimeState["finalizeApproveMutation"]>(
      actions.finalizeApprove,
    ),
    finalizeRetryMutation: mockMutation<IssueRuntimeState["finalizeRetryMutation"]>(
      actions.finalizeRetry,
    ),
    composerError: null,
    resumeQueued: false,
    submitInteractionReply: actions.submitReply,
    resumeInteraction: vi.fn(),
    submitFollowUpInput: vi.fn(),
    setActiveEntryIdForConversationIndex: actions.setActiveEntryForConversation,
    setActiveEntryId: actions.setActiveEntry,
    ...runtimeOverrides,
  };
}

function renderPanel(
  activeTab: IssueCommandPanelTab = "overview",
  props: Partial<React.ComponentProps<typeof IssueCommandPanel>> = {},
) {
  return render(
    <MemoryRouter>
      <IssueCommandPanel
        identifier="repo#1"
        activeTab={activeTab}
        onActiveTabChange={() => {}}
        onClose={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("IssueCommandPanel", () => {
  it("provides a keyboard-navigable Review gate tab without deriving a finalize action", async () => {
    function ControlledPanel() {
      const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>("overview");
      return (
        <IssueCommandPanel
          identifier="repo#1"
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          onClose={() => {}}
        />
      );
    }

    render(
      <MemoryRouter>
        <ControlledPanel />
      </MemoryRouter>,
    );

    const reviewGate = screen.getByRole("tab", { name: "Review gate" });
    reviewGate.focus();
    await userEvent.keyboard("{Enter}");

    expect(screen.getByRole("tab", { name: "Review gate" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Delivery observation is unavailable. No readiness outcome is implied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve finalize:/ })).toBeDisabled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    actions.submitReply.mockResolvedValue(true);
    vi.mocked(useIssueRuntime).mockReturnValue(runtimeFixture());
  });

  it("asks the operator to select an issue without rendering selected issue controls", () => {
    renderPanel("overview", { identifier: null });

    expect(useIssueRuntime).toHaveBeenCalledWith("");
    expect(screen.getByText("Select an issue")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close issue panel" })).not.toBeInTheDocument();
  });

  it("renders the selected issue overview and accessible tabs", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "repo#1" })).toBeInTheDocument();
    expect(screen.getByText("Test issue")).toBeInTheDocument();
    expect(screen.getByText("WS: connected")).toBeInTheDocument();
    expect(screen.getByText("Current step")).toBeInTheDocument();
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("Current agent")).toBeInTheDocument();
    expect(screen.getByText("builder")).toBeInTheDocument();
    expect(screen.getByText("1.3k")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(8);
  });

  it("uses server capability reasons instead of inferring a disabled action locally", () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        data: {
          ...issue,
          capabilities: {
            ...issue.capabilities,
            stop: { enabled: false, disabled_reason: "The run has already stopped." },
          },
        },
      }),
    );
    renderPanel();

    const stop = screen.getByRole("button", { name: "Stop: The run has already stopped." });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute("title", "The run has already stopped.");
  });

  it("renders tabs in contract order and activates them with roving keyboard focus", async () => {
    const user = userEvent.setup();

    function ControlledPanel() {
      const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>("overview");
      return (
        <IssueCommandPanel
          identifier="repo#1"
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          onClose={() => {}}
        />
      );
    }

    render(
      <MemoryRouter>
        <ControlledPanel />
      </MemoryRouter>,
    );

    const labels = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(labels).toEqual([
      "Overview",
      "Respond",
      "Steps",
      "Transcript",
      "Logs",
      "Acceptance",
      "Review gate",
      "Artifacts",
    ]);
    const controlledPanelIds = screen
      .getAllByRole("tab")
      .map((tab) => tab.getAttribute("aria-controls"));
    expect(new Set(controlledPanelIds).size).toBe(1);
    expect(document.getElementById(controlledPanelIds[0]!)).not.toBeNull();

    const overview = screen.getByRole("tab", { name: "Overview" });
    overview.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Respond" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Respond" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Review gate" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Acceptance" })).toHaveFocus();
  });

  it("notifies the parent when a tab is selected", async () => {
    const onActiveTabChange = vi.fn();
    renderPanel("overview", { onActiveTabChange });

    await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));

    expect(onActiveTabChange).toHaveBeenCalledWith("transcript");
  });

  it("keeps the loading panel closable", async () => {
    const onClose = vi.fn();
    vi.mocked(useIssueRuntime).mockReturnValue(runtimeFixture({ isLoading: true, data: undefined }));
    renderPanel("overview", { onClose });

    expect(screen.getByText("Loading issue...")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close issue panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a readable backend error panel closable", async () => {
    const onClose = vi.fn();
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({ isLoading: false, isError: true, data: undefined, error: new Error("API offline") }),
    );
    renderPanel("overview", { onClose });

    expect(screen.getByText("Failed to load issue")).toBeInTheDocument();
    expect(screen.getByText("API offline")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close issue panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes the panel", async () => {
    const onClose = vi.fn();
    renderPanel("overview", { onClose });

    await userEvent.click(screen.getByRole("button", { name: "Close issue panel" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("confirms before stopping an active run", async () => {
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/stop the agent for repo#1/i)).toBeInTheDocument();
    expect(actions.stop).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(actions.stop).toHaveBeenCalledWith({ identifier: "repo#1" });
  });

  it("closes a pending stop confirmation when the selected issue changes", async () => {
    const view = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        identifier: "repo#2",
        data: { ...issue, issue_identifier: "repo#2", issue_id: "issue-2" },
      }),
    );
    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#2"
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("remounts runtime mutation state when the selected identifier changes", () => {
    vi.mocked(useIssueRuntime).mockImplementation((identifier) => {
      const [retryMutation] = useState(() =>
        mockMutation<IssueRuntimeState["retryMutation"]>(actions.retry, {
          error: identifier === "repo#1" ? new Error("repo one retry failed") : null,
          isError: identifier === "repo#1",
          isIdle: identifier !== "repo#1",
          status: identifier === "repo#1" ? "error" : "idle",
        }),
      );
      return runtimeFixture({
        identifier,
        data: { ...issue, issue_identifier: identifier, issue_id: identifier },
        retryMutation,
      });
    });

    const view = renderPanel();
    expect(screen.getByText("repo one retry failed")).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#2"
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("repo one retry failed")).not.toBeInTheDocument();
  });

  it("keeps the empty selection key distinct from a no-selection identifier", () => {
    let runtimeMountCount = 0;
    vi.mocked(useIssueRuntime).mockImplementation((identifier) => {
      const [runtimeMount] = useState(() => ++runtimeMountCount);
      return runtimeFixture({
        identifier,
        data: {
          ...issue,
          issue_identifier: identifier,
          issue_id: identifier,
          issue: { ...issue.issue, title: `Runtime mount ${runtimeMount}` },
        },
      });
    });

    const view = renderPanel("overview", { identifier: null });
    expect(screen.getByText("Select an issue")).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="no-selection"
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Runtime mount 2")).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier={null}
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Select an issue")).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="no-selection"
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Runtime mount 4")).toBeInTheDocument();
  });

  it("retries retryable issues and displays action errors inline", async () => {
    const retryError = new Error("retry endpoint unavailable");
    const dueAt = Date.now() + 60_000;
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        data: {
          ...issue,
          running: null,
          retry: {
            attempt: 2,
            due_at_ms: dueAt,
            error: "step failed",
            issue_id: "issue-1",
            issue_identifier: "repo#1",
            capabilities: capabilitiesFor({ running: null, retry: {} as IssueDetailSnapshot["retry"], finalize: issue.finalize }),
          },
        },
        isLiveRun: false,
        retryMutation: mockMutation<IssueRuntimeState["retryMutation"]>(actions.retry, {
          isError: true,
          isIdle: false,
          error: retryError,
          status: "error",
        }),
      }),
    );
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(actions.retry).toHaveBeenCalledWith({ identifier: "repo#1" });
    expect(screen.getByText("Scheduled retry")).toBeInTheDocument();
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
    expect(screen.getByText(new Date(dueAt).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText("step failed")).toBeInTheDocument();
    expect(screen.getByText("retry endpoint unavailable")).toBeInTheDocument();
  });

  it("shows latest activity and compact navigation controls in Overview", async () => {
    const onActiveTabChange = vi.fn();
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        events: [
          {
            type: "output",
            timestamp: "2026-07-09T10:06:00Z",
            detail: "Compiled release binary",
            runId: "run-1",
            sequence: 1,
            stepName: "build",
          },
        ],
      }),
    );
    renderPanel("overview", { onActiveTabChange });

    expect(screen.getByText("Latest activity")).toBeInTheDocument();
    expect(screen.getByText("Compiled release binary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View steps" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View transcript" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View logs" }));
    expect(onActiveTabChange).toHaveBeenCalledWith("logs");
  });

  it("activates and focuses Transcript from the Overview control", async () => {
    function ControlledPanel() {
      const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>("overview");
      return (
        <IssueCommandPanel
          identifier="repo#1"
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          onClose={() => {}}
        />
      );
    }

    render(
      <MemoryRouter>
        <ControlledPanel />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Transcript" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("summarizes pending finalize targets and requires confirmation", async () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        data: {
          ...issue,
          finalize: {
            status: "pending_approval",
            repos: [
              {
                approval_required: true,
                last_error: null,
                mode: "push_and_pr",
                repo: "acme/backend",
                status: "pending_approval",
              },
            ],
          },
        },
      }),
    );
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Approve finalize" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/acme\/backend/)).toBeInTheDocument();
    expect(within(dialog).getByText(/push_and_pr/)).toBeInTheDocument();
    expect(actions.finalizeApprove).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(actions.finalizeApprove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Approve finalize" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Approve finalize",
      }),
    );

    expect(actions.finalizeApprove).toHaveBeenCalledWith({ identifier: "repo#1" });
  });

  it("invalidates finalize confirmation when pending targets change", async () => {
    const finalizeRepo = {
      approval_required: true,
      last_error: null,
      mode: "push_and_pr",
      repo: "acme/backend",
      status: "pending_approval",
    };
    const view = renderPanel();
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        data: {
          ...issue,
          finalize: { status: "pending_approval", repos: [finalizeRepo] },
        },
      }),
    );
    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#1"
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve finalize" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        data: {
          ...issue,
          finalize: {
            status: "pending_approval",
            repos: [{ ...finalizeRepo, repo: "acme/frontend" }],
          },
        },
      }),
    );
    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#1"
          activeTab="overview"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(actions.finalizeApprove).not.toHaveBeenCalled();
  });

  it("retries failed finalize work", async () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({ data: { ...issue, finalize: { status: "failed", repos: [] } } }),
    );
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Retry finalize" }));

    expect(actions.finalizeRetry).toHaveBeenCalledWith({ identifier: "repo#1" });
  });

  it.each(["in_progress", "skipped_headless"])(
    "shows %s finalize work passively",
    (finalizeStatus) => {
      vi.mocked(useIssueRuntime).mockReturnValue(
        runtimeFixture({ data: { ...issue, finalize: { status: finalizeStatus, repos: [] } } }),
      );
      renderPanel();

      expect(screen.getByText(finalizeStatus)).toBeInTheDocument();
      for (const button of screen.getAllByRole("button", { name: /finalize/i })) {
        expect(button).toBeDisabled();
      }
    },
  );

  it("submits and can cancel an open interaction from Respond", async () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        interaction: openInteraction,
        pendingQuestion: {
          interactionId: "ask-1",
          kind: "question",
          status: "open",
          awaitingResume: true,
          question: "Which environment?",
          whyBlocked: "A deployment target is required.",
          suggestedAnswer: "staging",
          stepName: "build",
        },
        composerError: "Previous response failed",
      }),
    );
    renderPanel("respond");

    expect(screen.getByText("Previous response failed")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Reply"), "production");
    await userEvent.click(screen.getByRole("button", { name: "Submit Reply" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel Request" }));

    expect(actions.submitReply).toHaveBeenCalledWith({ kind: "question", text: "production" });
    expect(actions.cancel).toHaveBeenCalledWith({ id: "ask-1" });
  });

  it.each([
    ["approval", "Reason (optional)", "Approve", { kind: "approval", approved: true, reason: "approved" }],
    ["approval", "Reason (optional)", "Reject", { kind: "approval", approved: false, reason: "approved" }],
    ["handoff", "Notes (optional)", "Complete", { kind: "handoff", completed: true, notes: "approved" }],
    ["handoff", "Notes (optional)", "Incomplete", { kind: "handoff", completed: false, notes: "approved" }],
  ] as const)("submits an explicit %s decision from %s", async (kind, inputLabel, buttonName, expected) => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        interaction: { ...openInteraction, kind },
        pendingQuestion: {
          interactionId: "ask-1",
          kind,
          status: "open",
          awaitingResume: true,
          question: "Operator decision?",
          whyBlocked: "A decision is required.",
          suggestedAnswer: null,
          stepName: "build",
        },
      }),
    );
    renderPanel("respond");

    await userEvent.type(screen.getByLabelText(inputLabel), "approved");
    await userEvent.click(screen.getByRole("button", { name: buttonName }));

    expect(actions.submitReply).toHaveBeenCalledWith(expected);
  });

  it("offers resume-only recovery for a resolved interaction", async () => {
    const resumeInteraction = vi.fn().mockResolvedValue(true);
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        interaction: { ...openInteraction, status: "resolved", awaiting_resume: true },
        pendingQuestion: {
          interactionId: "ask-1",
          kind: "question",
          status: "resolved",
          awaitingResume: true,
          question: "Which environment?",
          whyBlocked: "A deployment target is required.",
          suggestedAnswer: null,
          stepName: "build",
        },
        resumeInteraction,
      }),
    );
    renderPanel("respond");

    expect(screen.queryByRole("button", { name: "Submit Reply" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resume issue" }));

    expect(resumeInteraction).toHaveBeenCalledOnce();
    expect(actions.submitReply).not.toHaveBeenCalled();
  });

  it("disables pending response submission and renders a passive Respond state", () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        interaction: openInteraction,
        pendingQuestion: {
          interactionId: "ask-1",
          kind: "question",
          status: "open",
          awaitingResume: true,
          question: "Which environment?",
          whyBlocked: "A deployment target is required.",
          suggestedAnswer: null,
          stepName: "build",
        },
        respondMutation: mockMutation<IssueRuntimeState["respondMutation"]>(vi.fn(), {
          isIdle: false,
          isPending: true,
          status: "pending",
        }),
      }),
    );
    const view = renderPanel("respond");
    expect(screen.getByRole("button", { name: "Submit Reply" })).toBeDisabled();

    vi.mocked(useIssueRuntime).mockReturnValue(runtimeFixture());
    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#1"
          activeTab="respond"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No response is currently available/)).toBeInTheDocument();
  });

  it("distinguishes interaction loading and failure from a passive Respond state", () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({ interactionIsLoading: true }),
    );
    const view = renderPanel("respond");

    expect(screen.getByText("Loading interaction...")).toBeInTheDocument();
    expect(screen.queryByText(/No response is currently available/)).not.toBeInTheDocument();

    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        interactionIsLoading: false,
        interactionIsError: true,
        interactionError: new Error("interaction endpoint unavailable"),
      }),
    );
    view.rerender(
      <MemoryRouter>
        <IssueCommandPanel
          identifier="repo#1"
          activeTab="respond"
          onActiveTabChange={() => {}}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Failed to load interaction")).toBeInTheDocument();
    expect(screen.getByText("interaction endpoint unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/No response is currently available/)).not.toBeInTheDocument();
  });

  it.each(["resolved", "cancelled"] satisfies InteractionStatus[])(
    "does not offer cancellation for a %s interaction",
    (status) => {
      vi.mocked(useIssueRuntime).mockReturnValue(
        runtimeFixture({ interaction: { ...openInteraction, status } }),
      );
      renderPanel("respond");

      expect(screen.queryByRole("button", { name: "Cancel Request" })).not.toBeInTheDocument();
    },
  );

  it("renders steps and a true empty transcript state", () => {
    const stepsView = renderPanel("steps");
    expect(screen.getByRole("link", { name: "build" })).toHaveAttribute(
      "href",
      "/issue/repo%231/step/build",
    );

    stepsView.unmount();
    renderPanel("transcript");
    expect(screen.getByText("No transcript activity yet.")).toBeInTheDocument();
  });

  it("distinguishes transcript persistence failure from an empty transcript", () => {
    vi.mocked(useIssueRuntime).mockReturnValue(runtimeFixture({ transcriptIsError: true }));
    renderPanel("transcript");

    expect(screen.getByText(/Could not load saved transcript history/)).toBeInTheDocument();
    expect(screen.queryByText("No transcript activity yet.")).not.toBeInTheDocument();
  });

  it("focuses Transcript after conversation-driven navigation", async () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        timelineIsError: true,
        events: [
          {
            type: "turn_completed",
            timestamp: "2026-07-09T10:06:00Z",
            detail: "Turn complete",
            runId: "run-1",
            sequence: 1,
            conversationIndex: 4,
          },
        ],
      }),
    );
    function ControlledPanel() {
      const [activeTab, setActiveTab] = useState<IssueCommandPanelTab>("logs");
      return (
        <IssueCommandPanel
          identifier="repo#1"
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          onClose={() => {}}
        />
      );
    }
    render(
      <MemoryRouter>
        <ControlledPanel />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Could not load saved timeline history/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View in conversation" }));
    expect(actions.setActiveEntryForConversation).toHaveBeenCalledWith(4);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Transcript" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders an explicit empty artifact state with issue information", () => {
    renderPanel("artifacts");

    expect(screen.getByText("No run artifacts recorded.")).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Ship the command panel")).toBeInTheDocument();
  });

  it("renders generated acceptance attempts in the accessible Acceptance tab", () => {
    renderPanel("acceptance");

    expect(screen.getByRole("tab", { name: "Acceptance" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("unit tests")).toBeInTheDocument();
    expect(screen.getByText("passed")).toBeInTheDocument();
  });

  it("reuses the artifact panel when run artifacts exist", () => {
    vi.mocked(useIssueRuntime).mockReturnValue(
      runtimeFixture({
        data: {
          ...issue,
          artifacts: {
            repos: [],
            run_id: "run-1",
            transcripts: [],
            workspace_path: "/tmp/artifact-workspace",
          },
        },
      }),
    );
    renderPanel("artifacts");

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("/tmp/artifact-workspace")).toBeInTheDocument();
    expect(screen.queryByText("No run artifacts recorded.")).not.toBeInTheDocument();
  });
});
