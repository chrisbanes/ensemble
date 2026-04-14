import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { InteractionDetail } from "@/generated/models";
import { renderWithProviders } from "@/test/render";
import InteractionPanel from "./InteractionPanel";

function interaction(overrides: Partial<InteractionDetail> = {}): InteractionDetail {
  return {
    id: "interaction-1",
    issue_id: "NODE_123",
    issue_identifier: "my-repo#42",
    step_name: "review",
    agent_name: "reviewer",
    status: "open",
    question: "Need clarification",
    why_blocked: "The agent needs human input to continue",
    requested_at: "2026-04-04T10:00:00Z",
    ...overrides,
  };
}

describe("InteractionPanel", () => {
  it("renders interactions with question as primary heading", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction()}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Need clarification");
    expect(screen.getByLabelText("Reply")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Answer the agent's question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit Input" })).toBeInTheDocument();
  });

  it("shows why the agent is blocked above the reply box", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          question: "Which environment should I deploy to?",
          why_blocked: "The agent needs human input to continue",
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText("The agent needs human input to continue")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Answer the agent's question")).toBeInTheDocument();
  });

  it("keeps workflow step context visible while waiting for input", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          question: "Which environment should I deploy to?",
          why_blocked: "The agent needs human input to continue",
          step_name: "review",
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText(/Step:\s*review/i)).toBeInTheDocument();
    expect(screen.getByText(/review/)).toBeInTheDocument();
  });

  it("renders suggested_answer in secondary UI when present", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          question: "Which environment should I deploy to?",
          why_blocked: "The agent needs human input to continue",
          suggested_answer: "Use staging for testing",
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText("Suggested:")).toBeInTheDocument();
    expect(screen.getByText("Use staging for testing")).toBeInTheDocument();
  });

  it("renders extra_context in secondary UI when present", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          question: "Which environment should I deploy to?",
          why_blocked: "The agent needs human input to continue",
          extra_context: "Only staging has the new SSL certificates",
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText(/Context:/i)).toBeInTheDocument();
    expect(screen.getByText("Only staging has the new SSL certificates")).toBeInTheDocument();
  });

  it("does not show suggested_answer or extra_context when not provided", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction({
          question: "Which environment should I deploy to?",
          why_blocked: "The agent needs human input to continue",
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.queryByText(/Suggested:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Context:/i)).not.toBeInTheDocument();
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
        })}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Submit Input" })).not.toBeInTheDocument();
  });

  it("shows issue identifier and status badge", () => {
    renderWithProviders(
      <InteractionPanel
        interaction={interaction()}
        issueIdentifier="my-repo#42"
        onSubmitInput={vi.fn()}
        onCancel={vi.fn()}
      />,
      { route: "/" },
    );

    expect(screen.getByText("my-repo#42")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });
});
