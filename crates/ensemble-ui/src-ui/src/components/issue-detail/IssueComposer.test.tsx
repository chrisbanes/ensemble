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
          kind: "question",
          status: "open",
          awaitingResume: true,
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

    expect(onSubmitReply).toHaveBeenCalledWith({ kind: "question", text: "Use staging key" });
  });

  it.each([
    ["Approve", true],
    ["Reject", false],
  ] as const)("submits an explicit approval decision from %s", async (buttonName, approved) => {
    const user = userEvent.setup();
    const onSubmitReply = vi.fn();

    renderWithProviders(
      <IssueComposer
        pendingQuestion={{
          interactionId: "ask-approval",
          kind: "approval",
          status: "open",
          awaitingResume: true,
          question: "Publish the release?",
          whyBlocked: "Approval is required",
          suggestedAnswer: null,
          stepName: "release",
        }}
        onSubmitReply={onSubmitReply}
        onSubmitFollowUp={vi.fn()}
        isSubmitting={false}
      />,
      { route: "/" },
    );

    await user.type(screen.getByLabelText("Reason (optional)"), "Operator decision");
    await user.click(screen.getByRole("button", { name: buttonName }));

    expect(onSubmitReply).toHaveBeenCalledWith({
      kind: "approval",
      approved,
      reason: "Operator decision",
    });
  });

  it.each([
    ["Complete", true],
    ["Incomplete", false],
  ] as const)("submits an explicit handoff decision from %s", async (buttonName, completed) => {
    const user = userEvent.setup();
    const onSubmitReply = vi.fn();

    renderWithProviders(
      <IssueComposer
        pendingQuestion={{
          interactionId: "ask-handoff",
          kind: "handoff",
          status: "open",
          awaitingResume: true,
          question: "Was the manual deployment completed?",
          whyBlocked: "Waiting for the operator",
          suggestedAnswer: null,
          stepName: "deploy",
        }}
        onSubmitReply={onSubmitReply}
        onSubmitFollowUp={vi.fn()}
        isSubmitting={false}
      />,
      { route: "/" },
    );

    await user.type(screen.getByLabelText("Notes (optional)"), "Deployment outcome");
    await user.click(screen.getByRole("button", { name: buttonName }));

    expect(onSubmitReply).toHaveBeenCalledWith({
      kind: "handoff",
      completed,
      notes: "Deployment outcome",
    });
  });

  it("offers resume-only recovery for a resolved interaction awaiting resume", async () => {
    const user = userEvent.setup();
    const onResumeInteraction = vi.fn();

    renderWithProviders(
      <IssueComposer
        pendingQuestion={{
          interactionId: "ask-resolved",
          kind: "approval",
          status: "resolved",
          awaitingResume: true,
          question: "Publish the release?",
          whyBlocked: "Approval is required",
          suggestedAnswer: null,
          stepName: "release",
        }}
        onSubmitReply={vi.fn()}
        onSubmitFollowUp={vi.fn()}
        onResumeInteraction={onResumeInteraction}
        isSubmitting={false}
      />,
      { route: "/" },
    );

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume issue" }));
    expect(onResumeInteraction).toHaveBeenCalledOnce();
  });
});
