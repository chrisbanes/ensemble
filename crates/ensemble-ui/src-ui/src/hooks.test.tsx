import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InteractionDetail, IssueDetailSnapshot } from "./generated/models";
import {
  useCancelInteractionMutation,
  useFinalizeApproveMutation,
  useFinalizeRetryMutation,
  useInteractionDetailQuery,
  useIssueDetailQuery,
  useRespondToInteractionMutation,
  useResumeIssueMutation,
  useRetryMutation,
  useStepConversationQuery,
  useStepDetailQuery,
  useStopMutation,
  useTimelineQuery,
} from "./hooks";

function jsonResponse(data: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(client = queryClient()) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function interaction(status: InteractionDetail["status"]): InteractionDetail {
  return {
    agent_name: "builder",
    awaiting_resume: status === "resolved",
    id: "ask-1",
    issue_id: "issue-1",
    issue_identifier: "repo#1",
    kind: "question",
    question: "Continue?",
    requested_at: "2026-07-09T10:00:00Z",
    status,
    step_name: "build",
    why_blocked: "Needs input",
  };
}

function issueDetail(finalizeStatus: string, approvalRequired = false): IssueDetailSnapshot {
  return {
    artifacts: null,
    attempts: { restart_count: 0, current_retry_attempt: null },
    current_interaction: null,
    finalize: {
      status: finalizeStatus,
      repos: [
        {
          approval_required: approvalRequired,
          last_error: finalizeStatus === "failed" ? "push failed" : null,
          mode: "push",
          repo: "repo",
          status: finalizeStatus,
        },
      ],
    },
    issue: { title: "Finalize issue", description: null, labels: [] },
    issue_id: "issue-1",
    issue_identifier: "repo#1",
    last_error: null,
    pending_input: null,
    retry: null,
    running: null,
    status: "completed_succeeded",
    workflow_steps: [],
    workspace: { path: "/tmp/workspace" },
  };
}

function ResumeControl() {
  const detail = useInteractionDetailQuery("ask-1");
  const mutation = useResumeIssueMutation();

  return detail.data?.status === "resolved" && detail.data.awaiting_resume ? (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() =>
        mutation.mutate({ identifier: "repo#1", interactionId: detail.data?.id })
      }
    >
      Resume issue
    </button>
  ) : (
    <span>Resume unavailable</span>
  );
}

function FinalizeApproveControl() {
  const detail = useIssueDetailQuery("repo#1");
  const mutation = useFinalizeApproveMutation();

  return detail.data?.finalize.status === "pending_approval" ? (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate({ identifier: "repo#1" })}
    >
      Approve finalize
    </button>
  ) : (
    <span>Finalize refreshed</span>
  );
}

function FinalizeRetryControl() {
  const detail = useIssueDetailQuery("repo#1");
  const mutation = useFinalizeRetryMutation();

  return detail.data?.finalize.status === "failed" ? (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate({ identifier: "repo#1" })}
    >
      Retry finalize
    </button>
  ) : (
    <span>Finalize refreshed</span>
  );
}

function FinalizeControl() {
  const detail = useIssueDetailQuery("repo#1");
  const approveMutation = useFinalizeApproveMutation();
  const retryMutation = useFinalizeRetryMutation();

  if (detail.data?.finalize.status === "pending_approval") {
    return (
      <button type="button" onClick={() => approveMutation.mutate({ identifier: "repo#1" })}>
        Approve finalize
      </button>
    );
  }

  if (detail.data?.finalize.status === "failed") {
    return (
      <button type="button" onClick={() => retryMutation.mutate({ identifier: "repo#1" })}>
        Retry finalize
      </button>
    );
  }

  return <span>Finalize refreshed</span>;
}

describe("issue-scoped API hooks", () => {
  it.each([
    ["repo#42", "/api/v1/repo%2342"],
    ["org/repo#42", "/api/v1/org%2Frepo%2342"],
  ])("URL-encodes issue detail identifier %s", async (identifier, expectedUrl) => {
    const fetchMock = vi.fn(() => jsonResponse({ issue_identifier: identifier }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useIssueDetailQuery(identifier), { wrapper: wrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ method: "GET" }));
  });

  it.each([
    ["stop", () => useStopMutation(), "/api/v1/org%2Frepo%2342/stop"],
    ["retry", () => useRetryMutation(), "/api/v1/org%2Frepo%2342/retry"],
    ["resume", () => useResumeIssueMutation("org/repo#42"), "/api/v1/issues/org%2Frepo%2342/resume"],
    [
      "finalize approve",
      () => useFinalizeApproveMutation("org/repo#42"),
      "/api/v1/org%2Frepo%2342/finalize/approve",
    ],
    [
      "finalize retry",
      () => useFinalizeRetryMutation("org/repo#42"),
      "/api/v1/org%2Frepo%2342/finalize/retry",
    ],
  ])("URL-encodes issue identifier for %s", async (_name, useHook, expectedUrl) => {
    const fetchMock = vi.fn(() => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(useHook, { wrapper: wrapper() });

    result.current.mutate({ identifier: "org/repo#42" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ method: "POST" }));
  });

  it("URL-encodes issue identifier for timeline", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ events: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useTimelineQuery("org/repo#42", "run-1"), { wrapper: wrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/org%2Frepo%2342/timeline?run_id=run-1&limit=200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("URL-encodes issue identifier and step name for step detail", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ step_name: "review pass" }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useStepDetailQuery("org/repo#42", "review pass"), { wrapper: wrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/org%2Frepo%2342/step/review%20pass",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("URL-encodes issue identifier and step name for step conversation transcript", async () => {
    const fetchMock = vi.fn(() => jsonResponse({ records: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useStepConversationQuery("org/repo#42", "run-1", "qa/review", { limit: 50 }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/org%2Frepo%2342/runs/run-1/steps/qa%2Freview/conversation?limit=50",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([
    ["respond", "resolved"],
    ["cancel", "cancelled"],
  ] as const)(
    "refreshes the cached interaction detail after %s so remount cannot restore an open action",
    async (action, terminalStatus) => {
      let status: InteractionDetail["status"] = "open";
      const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          status = terminalStatus;
          return jsonResponse({ ...interaction(status), body: "Continue?" });
        }
        if (url === "/api/v1/interactions/ask-1") {
          return jsonResponse(interaction(status));
        }
        return jsonResponse({});
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = queryClient();
      const hookWrapper = wrapper(client);
      const detail = renderHook(() => useInteractionDetailQuery("ask-1"), {
        wrapper: hookWrapper,
      });
      await waitFor(() => expect(detail.result.current.data?.status).toBe("open"));
      let unmountMutation = () => {};
      if (action === "respond") {
        const mutation = renderHook(() => useRespondToInteractionMutation("repo#1"), {
          wrapper: hookWrapper,
        });
        unmountMutation = mutation.unmount;
        await act(async () => {
          await mutation.result.current.mutateAsync({
            id: "ask-1",
            kind: "question",
            response_schema_version: 1,
            selected_option: null,
            text: "continue",
          });
        });
      } else {
        const mutation = renderHook(() => useCancelInteractionMutation("repo#1"), {
          wrapper: hookWrapper,
        });
        unmountMutation = mutation.unmount;
        await act(async () => {
          await mutation.result.current.mutateAsync({ id: "ask-1" });
        });
      }

      expect(
        client.getQueryData<InteractionDetail>(["getInteractionById", "ask-1"])?.status,
      ).toBe(terminalStatus);
      detail.unmount();
      unmountMutation();

      const remounted = renderHook(() => useInteractionDetailQuery("ask-1"), {
        wrapper: hookWrapper,
      });
      expect(remounted.result.current.data?.status).toBe(terminalStatus);
    },
  );

  it("keeps queued resume server-authoritative until polling reports completion", async () => {
    let interactionReads = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/issues/repo%231/resume" && init?.method === "POST") {
        return jsonResponse({ resumed: true });
      }
      if (url === "/api/v1/interactions/ask-1") {
        interactionReads += 1;
        return jsonResponse({
          ...interaction("resolved"),
          awaiting_resume: interactionReads < 3,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = queryClient();
    const hookWrapper = wrapper(client);
    const user = userEvent.setup();
    const view = render(<ResumeControl />, { wrapper: hookWrapper });

    await user.click(await screen.findByRole("button", { name: "Resume issue" }));
    await waitFor(() =>
      expect(
        client.getQueryData<InteractionDetail>(["getInteractionById", "ask-1"])
          ?.awaiting_resume,
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Resume issue" })).toBeInTheDocument();
    expect(interactionReads).toBe(2);

    await waitFor(
      () =>
        expect(
          client.getQueryData<InteractionDetail>(["getInteractionById", "ask-1"])
            ?.awaiting_resume,
        ).toBe(false),
      { timeout: 3000 },
    );
    expect(interactionReads).toBe(3);
    expect(screen.getByText("Resume unavailable")).toBeInTheDocument();

    view.unmount();
    render(<ResumeControl />, { wrapper: hookWrapper });
    expect(screen.queryByRole("button", { name: "Resume issue" })).not.toBeInTheDocument();
    expect(screen.getByText("Resume unavailable")).toBeInTheDocument();
    await act(async () => Promise.resolve());
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/v1/interactions/ask-1" && init?.method === "GET",
      ),
    ).toHaveLength(3);
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/v1/issues/repo%231/resume" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["approve", "pending_approval", FinalizeApproveControl, "Approve finalize"],
    ["retry", "failed", FinalizeRetryControl, "Retry finalize"],
  ] as const)(
    "suppresses the %s finalize control across remount while detail refresh is deferred",
    async (_action, initialStatus, Control, buttonName) => {
      let postCompleted = false;
      let resolveRefetch: (response: Response) => void = () => {};
      const refetchResponse = new Promise<Response>((resolve) => {
        resolveRefetch = resolve;
      });
      const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postCompleted = true;
          return jsonResponse({ ok: true });
        }
        if (url === "/api/v1/repo%231" && postCompleted) return refetchResponse;
        return jsonResponse(issueDetail(initialStatus));
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = queryClient();
      const user = userEvent.setup();
      const hookWrapper = wrapper(client);
      const view = render(<Control />, { wrapper: hookWrapper });

      const control = await screen.findByRole("button", { name: buttonName });
      await user.click(control);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/repo%231",
        expect.objectContaining({ method: "GET" }),
      ));

      expect(client.getQueryData<IssueDetailSnapshot>(["getIssueDetail", "repo#1"])).toMatchObject({
        finalize: {
          status: "in_progress",
          repos: [{ status: "in_progress", last_error: null }],
        },
      });
      view.unmount();
      render(<Control />, { wrapper: hookWrapper });
      expect(screen.queryByRole("button", { name: buttonName })).not.toBeInTheDocument();
      expect(screen.getByText("Finalize refreshed")).toBeInTheDocument();

      await act(async () => {
        resolveRefetch(
          await jsonResponse(issueDetail("in_progress")),
        );
      });
      expect(await screen.findByText("Finalize refreshed")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: buttonName })).not.toBeInTheDocument();
    },
  );

  it("preserves approval after retry when detail refresh fails and the control remounts", async () => {
    let postCompleted = false;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        postCompleted = true;
        return jsonResponse({ ok: true });
      }
      if (url === "/api/v1/repo%231" && postCompleted) {
        return Promise.reject(new Error("detail refresh failed"));
      }
      return jsonResponse(issueDetail("failed", true));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = queryClient();
    const hookWrapper = wrapper(client);
    const view = render(<FinalizeControl />, { wrapper: hookWrapper });

    await userEvent.click(await screen.findByRole("button", { name: "Retry finalize" }));
    await waitFor(() =>
      expect(client.getQueryData<IssueDetailSnapshot>(["getIssueDetail", "repo#1"]))
        .toMatchObject({
          finalize: {
            status: "pending_approval",
            repos: [{ status: "pending_approval", last_error: null }],
          },
        }),
    );

    view.unmount();
    render(<FinalizeControl />, { wrapper: hookWrapper });
    expect(screen.getByRole("button", { name: "Approve finalize" })).toBeInTheDocument();
    expect(screen.queryByText("Finalize refreshed")).not.toBeInTheDocument();
  });

  it.each([
    ["approve", "pending_approval", FinalizeApproveControl, "Approve finalize"],
    ["retry", "failed", FinalizeRetryControl, "Retry finalize"],
  ] as const)(
    "keeps the %s finalize control suppressed after detail refresh fails and the control remounts",
    async (_action, initialStatus, Control, buttonName) => {
      let postCompleted = false;
      const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postCompleted = true;
          return jsonResponse({ ok: true });
        }
        if (url === "/api/v1/repo%231" && postCompleted) {
          return Promise.reject(new Error("detail refresh failed"));
        }
        return jsonResponse(issueDetail(initialStatus));
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = queryClient();
      const hookWrapper = wrapper(client);
      const user = userEvent.setup();
      const view = render(<Control />, { wrapper: hookWrapper });

      await user.click(await screen.findByRole("button", { name: buttonName }));
      await waitFor(() =>
        expect(
          client.getQueryData<IssueDetailSnapshot>(["getIssueDetail", "repo#1"]),
        ).toMatchObject({
          finalize: {
            status: "in_progress",
            repos: [{ status: "in_progress", last_error: null }],
          },
        }),
      );

      view.unmount();
      render(<Control />, { wrapper: hookWrapper });
      expect(screen.queryByRole("button", { name: buttonName })).not.toBeInTheDocument();
      expect(screen.getByText("Finalize refreshed")).toBeInTheDocument();
    },
  );
});
