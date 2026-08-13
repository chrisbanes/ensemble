import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { IssueDetailSnapshot } from "@/generated/models";
import { ReviewGatePanel } from "./ReviewGatePanel";

type ReviewGateData = Pick<
  IssueDetailSnapshot,
  "issue_identifier" | "finalize" | "workflow_steps" | "acceptance_attempts" | "artifacts" | "workspace"
>;

const reviewData: ReviewGateData = {
  issue_identifier: "ensemble#303",
  finalize: {
    status: "pending_approval",
    repos: [
      {
        approval_required: true,
        last_error: null,
        mode: "push_and_pr",
        repo: "chrisbanes/ensemble",
        status: "pending_approval",
        observation: {
          schema_version: 1,
          freshness: "fresh",
          observed_at: "2026-08-13T12:00:00Z",
          last_attempt_at: "2026-08-13T12:00:00Z",
          retry: null,
          failure: null,
          facts: {
            pull_request_number: 535,
            pull_request_url: "https://github.com/chrisbanes/ensemble/pull/535",
            head_sha: "524e233",
            matches_delivery: true,
            head_diverged: false,
            terminal_state: "open",
            mergeability: "mergeable",
            base_freshness: "up_to_date",
            checks: [{ name: "CI", status: "completed", conclusion: "failure" }],
            check_summary: "failing",
            review_decision: "changes_requested",
          },
        },
      },
    ],
  },
  workflow_steps: [
    {
      name: "review",
      agent: "reviewer",
      kind: "agent",
      dependencies: [],
      state: "failed",
      can_navigate: true,
      capabilities: { inspect: { enabled: true } },
    },
  ],
  acceptance_attempts: [],
  artifacts: null,
  workspace: { path: "/tmp/workspace" },
};

describe("ReviewGatePanel", () => {
  it("renders failing CI and requested changes from the structured delivery observation", () => {
    render(
      <MemoryRouter>
        <ReviewGatePanel data={reviewData} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Delivery review")).toBeInTheDocument();
    expect(screen.getByText("failing")).toBeInTheDocument();
    expect(screen.getByText("changes_requested")).toBeInTheDocument();
    expect(screen.getByText("CI: failure")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #535" })).toHaveAttribute(
      "href",
      "https://github.com/chrisbanes/ensemble/pull/535",
    );
    expect(screen.getByRole("link", { name: "Review step: review" })).toHaveAttribute(
      "href",
      "/issue/ensemble%23303/step/review",
    );
    expect(screen.getByText("Acceptance evidence")).toBeInTheDocument();
    expect(screen.getByText("No acceptance evidence has been recorded.")).toBeInTheDocument();
  });

  it.each([
    ["stale", null, "Delivery observation is stale. No readiness outcome is implied."],
    ["fresh", { kind: "transport", message: "GitHub is unavailable." }, /GitHub is unavailable.*No readiness outcome is implied/],
  ] as const)("does not infer readiness from %s incomplete delivery evidence", (freshness, failure, expected) => {
    const data = {
      ...reviewData,
      finalize: {
        ...reviewData.finalize,
        repos: [
          {
              ...reviewData.finalize.repos[0]!,
              observation: {
              ...reviewData.finalize.repos[0]!.observation!,
              freshness,
              facts: null,
              failure,
            },
          },
        ],
      },
    };
    render(
      <MemoryRouter>
        <ReviewGatePanel data={data} />
      </MemoryRouter>,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
  });

  it("fails closed when the server disables review-step inspection", () => {
    const data = {
      ...reviewData,
      workflow_steps: [
        {
          ...reviewData.workflow_steps[0]!,
          capabilities: { inspect: { enabled: false, disabled_reason: "Step details are unavailable." } },
        },
      ],
    };
    render(
      <MemoryRouter>
        <ReviewGatePanel data={data} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Review step: review" })).not.toBeInTheDocument();
    expect(screen.getByText(/Step details are unavailable/)).toBeInTheDocument();
  });

  it("uses the retained artifact observation for a historical delivery", () => {
    const data: ReviewGateData = {
      ...reviewData,
      finalize: { status: "not_required", repos: [] },
      artifacts: {
        run_id: "run-303",
        workspace_path: "/tmp/workspace",
        transcripts: [],
        artifact_snapshots: [],
        repos: [
          {
            repo: "chrisbanes/ensemble",
            worktree_path: "/tmp/workspace",
            base_branch: "main",
            branch: "review-gate",
            head_sha: "524e233",
            changed_files: [],
            finalize_mode: "push_and_pr",
            finalize_status: "succeeded",
            pushed_ref: null,
            pr_number: 535,
            pr_url: "https://github.com/chrisbanes/ensemble/pull/535",
            review_state: null,
            review_projection: null,
            last_error: null,
            observation: {
              ...reviewData.finalize.repos[0]!.observation!,
              facts: {
                ...reviewData.finalize.repos[0]!.observation!.facts!,
                terminal_state: "merged",
              },
            },
          },
        ],
      },
    };
    render(
      <MemoryRouter>
        <ReviewGatePanel data={data} />
      </MemoryRouter>,
    );

    expect(screen.getByText("Pull request is merged.")).toBeInTheDocument();
  });

  it.each([
    [
      "ready evidence",
      {
        check_summary: "passing",
        review_decision: "approved",
        terminal_state: "open",
        mergeability: "mergeable",
        base_freshness: "up_to_date",
        head_diverged: false,
        matches_delivery: true,
      },
      "Delivery evidence is current. No readiness outcome is implied.",
    ],
    [
      "merged delivery",
      { terminal_state: "merged" },
      "Pull request is merged.",
    ],
    [
      "closed delivery",
      { terminal_state: "closed_without_merge" },
      "Pull request closed without merge.",
    ],
    [
      "diverged delivery",
      { head_diverged: true, matches_delivery: false },
      "Delivery head diverged. No readiness outcome is implied.",
    ],
  ] as const)("renders %s from explicit delivery facts", (_name, factsOverride, expected) => {
    const data: ReviewGateData = {
      ...reviewData,
      finalize: {
        ...reviewData.finalize,
        repos: [
          {
            ...reviewData.finalize.repos[0]!,
            observation: {
              ...reviewData.finalize.repos[0]!.observation!,
              facts: { ...reviewData.finalize.repos[0]!.observation!.facts!, ...factsOverride },
            },
          },
        ],
      },
    };
    render(
      <MemoryRouter>
        <ReviewGatePanel data={data} />
      </MemoryRouter>,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("labels a missing repository observation without hiding the observed evidence", () => {
    const data: ReviewGateData = {
      ...reviewData,
      finalize: {
        ...reviewData.finalize,
        repos: [
          reviewData.finalize.repos[0]!,
          {
            approval_required: false,
            last_error: null,
            mode: "push_and_pr",
            repo: "chrisbanes/docs",
            status: "succeeded",
            observation: null,
          },
        ],
      },
    };
    render(
      <MemoryRouter>
        <ReviewGatePanel data={data} />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("chrisbanes/ensemble delivery review")).toBeInTheDocument();
    expect(screen.getByLabelText("chrisbanes/docs delivery review")).toHaveTextContent(
      "Delivery observation is unavailable. No readiness outcome is implied.",
    );
  });
});
