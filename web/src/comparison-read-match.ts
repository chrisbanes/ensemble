import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";

type ComparisonData = WorkspaceComparisonRead["data"];

export type ExpectedWorkspaceComparisonRead = {
  target: "branch" | "uncommitted" | "last-turn";
  repositoryId: string | null;
  baseBranch: string | null;
  changeSet: "all" | "staged" | "unstaged" | null;
};

export function matchesWorkspaceComparisonRead(
  data: ComparisonData,
  expected: ExpectedWorkspaceComparisonRead,
  taskId: string,
) {
  if (data.taskId !== taskId || data.target !== expected.target) return false;
  if (data.state === "unsettled")
    return (
      expected.target === "last-turn" &&
      data.pending.identity.taskId === taskId &&
      (!data.latestFinished || data.latestFinished.taskId === taskId)
    );
  const snapshot = "comparison" in data ? data.comparison : undefined;
  if (!snapshot) return true;
  if (snapshot.taskId !== taskId) return false;
  if (expected.target === "last-turn") return snapshot.target === "turn";
  if (
    snapshot.target !== expected.target ||
    snapshot.repositoryId !== expected.repositoryId
  )
    return false;
  if (expected.target === "branch") {
    if (
      !expected.baseBranch ||
      snapshot.baseline?.branch === expected.baseBranch
    )
      return true;
    return (
      snapshot.state === "unavailable" &&
      snapshot.reason === "no-merge-base" &&
      snapshot.availableBaseBranches.includes(expected.baseBranch)
    );
  }
  return snapshot.changeSet === expected.changeSet;
}
