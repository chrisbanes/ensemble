import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { IssueComposer } from "./IssueComposer";

describe("IssueComposer", () => {
  it("renders question mode when a pending interaction exists and submits a reply", async () => {
    const user = userEvent.setup();
    const onSubmitReply = vi.fn();

    renderWithProviders(
      <IssueComposer
        pendingQuestion={{
          interactionId: "ask-1",
          question: "Which API key?",
          whyBlocked: "Deploy is blocked",
          suggestedAnswer: "Use staging",
          stepName: "deploy",
        }}
        onSubmitReply={onSubmitReply}
        onSubmitFollowUp={vi.fn()}
        isSubmitting={false}
      />,
      { route: "/" },
    );

    expect(screen.getByText("Which API key?")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Reply"), "Use staging key");
    await user.click(screen.getByRole("button", { name: "Submit Reply" }));

    expect(onSubmitReply).toHaveBeenCalledWith("Use staging key");
  });
});
