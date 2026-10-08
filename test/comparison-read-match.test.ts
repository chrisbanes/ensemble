import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceComparisonRead } from "../src/operator/contracts.js";
import { matchesWorkspaceComparisonRead } from "../web/src/comparison-read-match.js";

const taskId = "cee1f027-8169-46de-84a6-9c7e70ef91e3";
const comparisonId = "f6d207ea-dd9d-423a-ae70-cde35c65f1f1";
const expected = {
  target: "branch",
  repositoryId: "repo-alpha",
  baseBranch: "unrelated",
  changeSet: null,
} as const;
const noMergeBase = {
  taskId,
  target: "branch",
  state: "unavailable",
  comparisonId,
  reason: "no-merge-base",
  availableBaseBranches: ["base-alpha", "main", "unrelated"],
  comparison: {
    taskId,
    repositoryId: "repo-alpha",
    target: "branch",
    state: "unavailable",
    comparisonId,
    observedAt: 1791475034722,
    availableBaseBranches: ["base-alpha", "main", "unrelated"],
    entries: [],
    truncated: false,
    reason: "no-merge-base",
  },
} satisfies WorkspaceComparisonRead["data"];

test("no-merge-base is scoped to the exact listed task, repository, and target", () => {
  assert.equal(
    matchesWorkspaceComparisonRead(noMergeBase, expected, taskId),
    true,
  );
  assert.equal(
    matchesWorkspaceComparisonRead(
      noMergeBase,
      { ...expected, repositoryId: "repo-beta" },
      taskId,
    ),
    false,
  );
  assert.equal(
    matchesWorkspaceComparisonRead(
      {
        ...noMergeBase,
        comparison: { ...noMergeBase.comparison, target: "uncommitted" },
      } as WorkspaceComparisonRead["data"],
      expected,
      taskId,
    ),
    false,
  );
  assert.equal(
    matchesWorkspaceComparisonRead(
      {
        ...noMergeBase,
        target: "uncommitted",
      } as WorkspaceComparisonRead["data"],
      expected,
      taskId,
    ),
    false,
  );
  assert.equal(
    matchesWorkspaceComparisonRead(
      {
        ...noMergeBase,
        comparison: {
          ...noMergeBase.comparison,
          availableBaseBranches: ["base-alpha", "main"],
        },
        availableBaseBranches: ["base-alpha", "main"],
      } as WorkspaceComparisonRead["data"],
      expected,
      taskId,
    ),
    false,
  );
  assert.equal(
    matchesWorkspaceComparisonRead(
      {
        ...noMergeBase,
        comparison: { ...noMergeBase.comparison, reason: "head-unavailable" },
      } as WorkspaceComparisonRead["data"],
      expected,
      taskId,
    ),
    false,
  );
});
