import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { WaitingInteractionRow } from "@/generated/models";
import { renderWithProviders } from "@/test/render";
import InteractionQueue from "./InteractionQueue";

function waitingInteraction(
  overrides: Partial<WaitingInteractionRow> = {},
): WaitingInteractionRow {
  return {
    interaction_request_id: "interaction-1",
    issue_id: "NODE_123",
    issue_identifier: "my-repo#42",
    question: "Need clarification",
    requested_at: "2026-04-04T10:00:00Z",
    step_name: "review",
    ...overrides,
  };
}

describe("InteractionQueue", () => {
  it("renders waiting interaction rows with issue, step, and age", () => {
    renderWithProviders(
      <InteractionQueue interactions={[waitingInteraction()]} />,
      { route: "/" },
    );

    expect(screen.getByText("my-repo#42")).toBeInTheDocument();
    expect(screen.getByText("Need clarification")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText(/ago$/)).toBeInTheDocument();
  });

  it("shows an empty state when no interactions exist", () => {
    renderWithProviders(<InteractionQueue interactions={[]} />, { route: "/" });

    expect(
      screen.getByText("No issues need input."),
    ).toBeInTheDocument();
  });
});
