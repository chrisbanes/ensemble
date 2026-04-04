import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { InteractionRequest } from "@/generated/models";
import { renderWithProviders } from "@/test/render";
import InteractionQueue from "./InteractionQueue";

function interaction(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "interaction-1",
    schema_version: 1,
    issue_id: "NODE_123",
    issue_identifier: "my-repo#42",
    pipeline_cycle: 1,
    completed_steps: ["build"],
    step_name: "review",
    agent_name: "reviewer",
    step_depends: ["build"],
    step_tracker_state: null,
    kind: "question",
    status: "open",
    blocking: true,
    awaiting_resume: true,
    title: "Need clarification",
    body: "Choose a deployment target",
    options: ["staging", "production"],
    artifacts: [],
    response: null,
    requested_at: "2026-04-04T10:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

describe("InteractionQueue", () => {
  it("renders open interaction rows with kind, title, step, and age", () => {
    renderWithProviders(
      <InteractionQueue interactions={[interaction()]} />,
      { route: "/" },
    );

    expect(screen.getByText("my-repo#42")).toBeInTheDocument();
    expect(screen.getByText("question")).toBeInTheDocument();
    expect(screen.getByText("Need clarification")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("Blocking")).toBeInTheDocument();
    expect(screen.getByText(/ago$/)).toBeInTheDocument();
  });

  it("shows an empty state when no interactions exist", () => {
    renderWithProviders(<InteractionQueue interactions={[]} />, { route: "/" });

    expect(
      screen.getByText("No pending interaction requests."),
    ).toBeInTheDocument();
  });
});
