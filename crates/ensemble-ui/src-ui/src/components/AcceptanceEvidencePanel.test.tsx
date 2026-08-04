import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AcceptanceAttempt } from "@/generated/models";
import { AcceptanceEvidencePanel } from "./AcceptanceEvidencePanel";

const attempts = [
  {
    cycle: 1,
    results: [
      {
        version: 2,
        name: "unit tests",
        status: "passed",
        summary: "tests passed",
        timing: {
          kind: "observed",
          started_at: "2026-08-04T09:00:00Z",
          completed_at: "2026-08-04T09:00:01Z",
          duration_ms: 1000,
        },
        evidence: {
          kind: "command",
          exit_code: 0,
          stdout: { tail: "tests passed", total_bytes: 12, truncated: false },
          stderr: { tail: "", total_bytes: 0, truncated: false },
        },
      },
      {
        version: 2,
        name: "release notes",
        status: "failed",
        summary: "release notes are missing",
        timing: { kind: "unknown" },
        evidence: {
          kind: "file",
          repo: "ensemble",
          path: "docs/release.md",
          observation: "missing",
        },
      },
    ],
  },
  {
    cycle: 2,
    results: [
      {
        version: 2,
        name: "handoff",
        status: "timed_out",
        summary: "handoff inspection timed out",
        timing: { kind: "unknown" },
        evidence: {
          kind: "handoff",
          step: "review",
          output: { kind: "non_object", value_kind: "string" },
          sections: [{ name: "summary", observation: "missing" }],
        },
      },
      {
        version: 2,
        name: "pull request",
        status: "unavailable",
        summary: "pull request delivery is unavailable",
        timing: { kind: "unknown" },
        evidence: {
          kind: "pull_request",
          repo: "chrisbanes/ensemble",
          delivery_phase: "blocked",
          base_branch: "main",
          head_branch: "feature/acceptance",
          head_sha: "abc123",
          pr_number: 419,
          pr_url: "https://github.com/chrisbanes/ensemble/pull/419",
        },
      },
    ],
  },
] satisfies AcceptanceAttempt[];

describe("AcceptanceEvidencePanel", () => {
  it("renders every persisted result in cycle and result order with typed evidence", () => {
    render(<AcceptanceEvidencePanel attempts={attempts} />);

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Cycle 1",
      "Cycle 2",
    ]);
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual([
      "unit tests",
      "release notes",
      "handoff",
      "pull request",
    ]);
    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("timed_out")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText("Exit code: 0")).toBeInTheDocument();
    expect(screen.getByText("stdout (12 bytes)")).toBeInTheDocument();
    expect(screen.getAllByText("tests passed")).toHaveLength(2);
    expect(screen.getByText("File observation: missing")).toBeInTheDocument();
    expect(screen.getByText("Output observation: non_object (string)")).toBeInTheDocument();
    expect(screen.getByText("summary: missing")).toBeInTheDocument();
    expect(screen.getByText("Delivery phase: blocked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PR #419" })).toHaveAttribute(
      "href",
      "https://github.com/chrisbanes/ensemble/pull/419",
    );
    expect(screen.getByText("Observed: 1,000 ms")).toBeInTheDocument();
    expect(screen.getAllByText("Timing unknown")).toHaveLength(3);
  });

  it("uses neutral copy for empty and partial persisted sequences", () => {
    const { rerender } = render(<AcceptanceEvidencePanel attempts={[]} />);
    expect(screen.getByText("No acceptance evidence has been recorded.")).toBeInTheDocument();
    expect(screen.getByText(/No acceptance outcome is implied/)).toBeInTheDocument();

    rerender(<AcceptanceEvidencePanel attempts={[{ cycle: 3, results: attempts[0]!.results.slice(0, 1) }]} />);
    expect(screen.getByText(/Results are shown exactly as recorded/)).toBeInTheDocument();
    expect(screen.getByText(/No outcome is inferred for checks that were not recorded/)).toBeInTheDocument();
  });
});
