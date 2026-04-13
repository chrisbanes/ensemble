import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import Dashboard from "./Dashboard";
import type { RuntimeSnapshot, WaitingInteractionRow } from "@/generated/models";

function mockSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    counts: { running: 0, retrying: 0, waiting_on_human: 0, completed: 0 },
    generated_at: "2026-04-14T12:00:00Z",
    poll_interval_ms: 3000,
    running: [],
    retrying: [],
    waiting_on_human: [],
    completed: [],
    ...overrides,
  } as RuntimeSnapshot;
}

function waitingInteraction(
  overrides: Partial<WaitingInteractionRow> = {},
): WaitingInteractionRow {
  return {
    interaction_request_id: "interaction-1",
    issue_id: "NODE_123",
    issue_identifier: "my-repo#42",
    requested_at: "2026-04-14T10:00:00Z",
    step_name: "review",
    ...overrides,
  } as WaitingInteractionRow;
}

function renderDashboardWithData(data: RuntimeSnapshot) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  queryClient.setQueryData(["/api/v1/state"], { data });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Dashboard", () => {
  it("renders a Needs attention section ahead of normal execution buckets", () => {
    const waiting: WaitingInteractionRow[] = [
      waitingInteraction({ issue_identifier: "org/repo#101" }),
    ];
    const snapshot = mockSnapshot({
      waiting_on_human: waiting,
      running: [],
      retrying: [],
      completed: [],
    });

    renderDashboardWithData(snapshot);

    const needsAttention = screen.getByText("Needs attention");
    expect(needsAttention).toBeInTheDocument();
  });

  it("shows waiting tickets as question-first queue items", () => {
    const waiting: WaitingInteractionRow[] = [
      waitingInteraction({
        issue_identifier: "my-repo#42",
        interaction_request_id: "interaction-1",
      }),
    ];
    const snapshot = mockSnapshot({
      waiting_on_human: waiting,
      running: [],
      retrying: [],
      completed: [],
    });

    renderDashboardWithData(snapshot);

    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    const links = screen.getAllByText("my-repo#42");
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute("href", "/issue/my-repo%2342");
    expect(screen.queryByText("brainstorm_prompt")).not.toBeInTheDocument();
  });
});
