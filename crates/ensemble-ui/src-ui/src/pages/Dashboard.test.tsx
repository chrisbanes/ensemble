import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "@/generated/models";
import Dashboard from "./Dashboard";

function mockSnapshot(): RuntimeSnapshot {
  return {
    agent_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    attention_items: [{
      identity: {
        producer_key: "runtime.interaction",
        subject_ref: "repo#2",
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
    }],
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
  } as RuntimeSnapshot;
}

describe("Dashboard", () => {
  it("renders Mission Control with attention and operations surfaces", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["/api/v1/state"], { data: mockSnapshot() });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <Dashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Mission Control")).toBeInTheDocument();
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Running" })).toBeInTheDocument();
    expect(screen.getByText("repo#1")).toBeInTheDocument();
    expect(screen.getAllByText("repo#2")).toHaveLength(2);
  });
});
