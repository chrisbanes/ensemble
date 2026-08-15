import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { GateEvidence, RunArtifacts } from "@/generated/models";
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

const evaluatedArtifacts = {
  ...artifacts,
  artifact_access_evidence: [
    { consumer_step: "review-a", enforcement: "direct_acp_unsupported" },
  ],
  artifact_integrity_violations: [
    {
      consumer_step: "review-b",
      producer_step: "produce",
      artifact_identity: "snapshot-identity",
      repository: "source",
      expected_digest: "expected",
      observed_digest: "observed",
      changed_paths: ["README.md"],
      omitted_changed_path_count: 0,
    },
  ],
  gate_evidence: {
    gate: {
      assessments: {
        "review-a": {
          findings: [{ id: "a-1", severity: "non_blocking", summary: "Minor concern", evidence: { path: "README.md" } }],
        },
        "review-b": {
          findings: [{ id: "b-1", severity: "blocking", summary: "Major concern", evidence: { path: "src/lib.rs" } }],
        },
      },
      adjudication: {
        dispositions: [
          { source_step: "review-a", finding_id: "a-1", disposition: "dismissed", rationale: "not reproducible", evidence: { check: "none" } },
          { source_step: "review-b", finding_id: "b-1", disposition: "unresolved", rationale: "needs approval", evidence: { check: "manual" } },
        ],
      },
      outcome: "awaiting_human",
      human_resolution: { decision: "approved", reason: "accepted residual risk" },
    },
  },
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

  it("groups assessment findings by source with dispositions and content-free integrity evidence", () => {
    render(
      <MemoryRouter>
        <ArtifactsPanel
          identifier="ensemble#303"
          workspacePath="/tmp/workspace"
          artifacts={evaluatedArtifacts}
          workflowSteps={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Evaluation evidence")).toBeInTheDocument();
    expect(screen.getByText("Assessment source: review-a")).toBeInTheDocument();
    expect(screen.getByText("Assessment source: review-b")).toBeInTheDocument();
    expect(screen.getByText(/a-1: Minor concern/)).toBeInTheDocument();
    expect(screen.getByText(/Severity: non_blocking; Disposition: dismissed/)).toBeInTheDocument();
    expect(screen.getByText(/b-1: Major concern/)).toBeInTheDocument();
    expect(screen.getByText(/Severity: blocking; Disposition: unresolved/)).toBeInTheDocument();
    expect(screen.getByText(/Outcome:/)).toHaveTextContent("awaiting_human");
    expect(screen.getByText(/Human decision:/)).toHaveTextContent("approved");
    expect(screen.getByText(/immutable access enforcement is unsupported/i)).toBeInTheDocument();
    expect(screen.getByText(/README\.md/)).toBeInTheDocument();
    expect(screen.queryByText("not reproducible")).not.toBeInTheDocument();
  });

  it.each([
    ["passed", { assessments: {}, adjudication: { dispositions: [] }, outcome: "passed" }, "passed", null],
    ["failed", { assessments: {}, adjudication: { dispositions: [] }, outcome: "failed" }, "failed", null],
    ["unresolved", { assessments: {}, adjudication: { dispositions: [] }, outcome: "awaiting_human" }, "awaiting_human", "unresolved"],
    [
      "human-resolved",
      {
        assessments: {},
        adjudication: { dispositions: [] },
        outcome: "awaiting_human",
        human_resolution: { decision: "approved", reason: "accepted residual risk" },
      },
      "awaiting_human",
      "approved",
    ],
  ] satisfies [string, GateEvidence, string, string | null][])(
    "renders %s gate evidence",
    (_state, gate, outcome, humanDecision) => {
      render(
        <MemoryRouter>
          <ArtifactsPanel
            identifier="ensemble#303"
            workspacePath="/tmp/workspace"
            artifacts={{ ...artifacts, gate_evidence: { gate } }}
            workflowSteps={[]}
          />
        </MemoryRouter>,
      );

      expect(screen.getByLabelText("gate gate evidence")).toHaveTextContent(`Outcome: ${outcome}`);
      if (humanDecision) {
        expect(screen.getByLabelText("gate gate evidence")).toHaveTextContent(`Human decision: ${humanDecision}`);
      } else {
        expect(screen.getByLabelText("gate gate evidence")).not.toHaveTextContent("Human decision:");
      }
    },
  );

  it("does not imply evaluation evidence for legacy artifacts", () => {
    render(
      <MemoryRouter>
        <ArtifactsPanel identifier="ensemble#303" workspacePath="/tmp/workspace" artifacts={artifacts} workflowSteps={[]} />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Evaluation evidence")).not.toBeInTheDocument();
  });
});
