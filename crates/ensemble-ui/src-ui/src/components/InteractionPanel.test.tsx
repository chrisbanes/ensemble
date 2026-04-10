import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { InteractionRequest } from "@/generated/models";
import { renderWithProviders } from "@/test/render";
import InteractionPanel from "./InteractionPanel";

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
    kind: "brainstorm_prompt",
    status: "open",
    blocking: true,
    awaiting_resume: true,
    title: "Need clarification",
    body: "Choose a deployment target",
    options: ["staging", "production"],
    response: null,
    artifacts: [],
    requested_at: "2026-04-04T10:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

describe("InteractionPanel", () => {
  it("renders interactions with unified text input form", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction()}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText("Need clarification")).toBeInTheDocument();
    expect(screen.getByLabelText("Response")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit Input" })).toBeInTheDocument();
  });

  it("renders approval interactions with unified submit action", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          kind: "approval_gate",
          title: "Ready to ship?",
          body: "Approve or reject this rollout.",
          options: [],
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByRole("button", { name: "Submit Input" })).toBeInTheDocument();
  });

  it("hides input actions when interaction is resolved", () => {
    const { rerender } = renderWithProviders(
      <InteractionPanel
        interaction={interaction()}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByRole("button", { name: "Submit Input" })).toBeInTheDocument();

    rerender(
      <InteractionPanel
        interaction={interaction({
          status: "resolved",
          response: {
            kind: "question",
            response_schema_version: 1,
            text: "Use staging",
            selected_option: "staging",
          },
          resolved_at: "2026-04-04T11:00:00Z",
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Submit Input" })).not.toBeInTheDocument();
    expect(screen.getByText(/Latest response:/)).toBeInTheDocument();
  });
});
