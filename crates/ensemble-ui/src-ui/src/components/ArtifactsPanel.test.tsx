import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RunArtifacts } from "@/generated/models";
import ArtifactsPanel from "./ArtifactsPanel";

const artifacts = {
  run_id: "run-303",
  workspace_path: "/tmp/workspace",
  repos: [],
  transcripts: [],
  artifact_snapshots: [
    {
      identity: "snapshot-identity",
      run_id: "run-303",
      cycle: 2,
      producer_step: "review",
      attempt: 1,
      output_digest: "output-digest",
      repositories: [
        {
          repository: "chrisbanes/ensemble",
          head: "524e233",
          index_digest: "index-digest",
          tracked_worktree_digest: "worktree-digest",
          untracked_paths: ["report.txt"],
        },
      ],
    },
  ],
} satisfies RunArtifacts;

describe("ArtifactsPanel", () => {
  it("shows content-free snapshot identity and links its producer step", () => {
    render(
      <MemoryRouter>
        <ArtifactsPanel
          identifier="ensemble#303"
          workspacePath="/tmp/workspace"
          artifacts={artifacts}
          workflowSteps={[
            {
              name: "review",
              agent: "reviewer",
              kind: "agent",
              dependencies: [],
              state: "passed",
              can_navigate: true,
              capabilities: { inspect: { enabled: true } },
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Artifact snapshots")).toBeInTheDocument();
    expect(screen.getByText("snapshot-identity")).toBeInTheDocument();
    expect(screen.getByText("output-digest")).toBeInTheDocument();
    expect(screen.getByText(/chrisbanes\/ensemble/)).toBeInTheDocument();
    expect(screen.getByText("524e233")).toBeInTheDocument();
    expect(screen.getByText("index-digest")).toBeInTheDocument();
    expect(screen.getByText("worktree-digest")).toBeInTheDocument();
    expect(screen.getByText(/Untracked: report\.txt/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Producer step: review" })).toHaveAttribute(
      "href",
      "/issue/ensemble%23303/step/review",
    );
    expect(screen.queryByText("source contents")).not.toBeInTheDocument();
  });

  it("fails closed when the producer step cannot be inspected", () => {
    render(
      <MemoryRouter>
        <ArtifactsPanel
          identifier="ensemble#303"
          workspacePath="/tmp/workspace"
          artifacts={artifacts}
          workflowSteps={[
            {
              name: "review",
              agent: "reviewer",
              kind: "agent",
              dependencies: [],
              state: "passed",
              can_navigate: false,
              capabilities: { inspect: { enabled: false, disabled_reason: "Step details are unavailable." } },
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Producer step: review" })).not.toBeInTheDocument();
    expect(screen.getByText(/Step details are unavailable/)).toBeInTheDocument();
  });
});
