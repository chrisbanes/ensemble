import { randomUUID } from "node:crypto";
import type { createOperatorFixture } from "./operator-web.js";
import { seedReviewTask } from "./task-review.js";
export async function seedDeliveryCoverage(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
) {
  const task = await seedReviewTask(
    f,
    "Bounded delivery",
    "Review provider observations",
  );
  const result = task.result("Reported delivery context");
  const caller = {
    projectId: task.projectId,
    taskId: task.taskId,
    taskVersion: Number(f.service.domain().task(task.taskId).version),
    assignmentId: task.assignmentId,
    assignmentVersion: Number(
      f.service.domain().assignment(task.assignmentId).version,
    ),
    workId: result.workId,
    workRevision: 1,
    conversationRevision: 1,
  };
  const head = "a".repeat(40);
  const observation = {
    repositoryId: "R1",
    nodeId: "P_COVERAGE",
    number: 1,
    baseRef: "main",
    headRef: "cb/coverage",
    headSha: head,
    baseSha: "b".repeat(40),
    state: "OPEN" as const,
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: Array.from({ length: 129 }, (_, i) => ({
      name: `Check ${i + 1}`,
      appId: null,
      sha: head,
      status: i === 128 ? ("failure" as const) : ("success" as const),
    })),
    feedback: Array.from({ length: 130 }, (_, i) => ({
      nodeId: `F${i}`,
      kind: "comment" as const,
      author: "Fixture reviewer",
      body: `Retained feedback ${i}`,
      commitSha: head,
      updatedAt: "2026-10-04T00:00:00Z",
      state: "COMMENTED",
    })),
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash" as const],
  };
  const store = f.service.delivery();
  store.registerPrWithinTransaction(caller, observation, task.assignmentId);
  // All actions use the real store's denied path; no grant, provider or task effect.
  for (let i = 0; i < 131; i++) {
    const action = store.prepareAction(
      {
        operationId: randomUUID(),
        action: {
          kind: "issue.comment",
          target: { repositoryId: "R1", number: 1, nodeId: "I_COVERAGE" },
          body: `Denied fixture action ${i}`,
        },
      },
      caller,
      false,
    );
    if (action.state !== "denied")
      throw Error("Fixture action unexpectedly authorized");
  }
  return { ...task, observation, result };
}
