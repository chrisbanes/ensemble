import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RepoFinalizeSnapshot } from "@/generated/models";
import FinalizeApprovalDialog from "./FinalizeApprovalDialog";

const pendingRepo = {
  approval_required: true,
  last_error: null,
  mode: "push_and_pr",
  repo: "acme/backend",
  status: "pending_approval",
} satisfies RepoFinalizeSnapshot;

describe("FinalizeApprovalDialog", () => {
  it("confirms an unchanged pending target", async () => {
    const onConfirm = vi.fn();
    render(
      <FinalizeApprovalDialog
        open
        status="pending_approval"
        repos={[pendingRepo]}
        isPending={false}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Approve finalize" }),
    );

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it.each([
    ["status", "in_progress", [{ ...pendingRepo, status: "in_progress" }]],
    ["target", "pending_approval", [{ ...pendingRepo, repo: "acme/frontend" }]],
  ] as const)("invalidates confirmation when the pending %s changes", async (_change, status, repos) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <FinalizeApprovalDialog
        open
        status="pending_approval"
        repos={[pendingRepo]}
        isPending={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await screen.findByRole("alertdialog");

    view.rerender(
      <FinalizeApprovalDialog
        open
        status={status}
        repos={[...repos]}
        isPending={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks confirmation while the approval mutation is pending", async () => {
    const onConfirm = vi.fn();
    render(
      <FinalizeApprovalDialog
        open
        status="pending_approval"
        repos={[pendingRepo]}
        isPending
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Approve finalize",
    });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
