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
    kind: "question",
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
  it("renders question interactions with text response form", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction()}
        issueIdentifier="my-repo#42"
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onResume={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText("Need clarification")).toBeInTheDocument();
    expect(screen.getByLabelText("Response")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Response" })).toBeInTheDocument();
  });

  it("renders approval interactions with approve and reject actions", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          kind: "approval",
          title: "Ready to ship?",
          body: "Approve or reject this rollout.",
          options: [],
        })}
        issueIdentifier="my-repo#42"
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onResume={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("shows resume button only when interaction is resolved", () => {
    const { rerender } = renderWithProviders(
      <InteractionPanel
        interaction={interaction()}
        issueIdentifier="my-repo#42"
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onResume={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.queryByRole("button", { name: "Resume Issue" })).not.toBeInTheDocument();

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
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onResume={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Resume Issue" })).toBeInTheDocument();
  });
});
