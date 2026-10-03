import { randomUUID } from "node:crypto";
import { CoordinationStore } from "../../src/core/coordination.js";
import { ExecutionState } from "../../src/standalone/state.js";
import type { ReviewMetadata } from "../../src/core/task-review.js";
import type { createOperatorFixture } from "./operator-web.js";
export async function seedReviewTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  name = "Review project",
  title = "Restore command focus",
  body = "- [ ] Restore focus\n- [ ] Retain drafts",
) {
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Task lead",
    instructions: "PRIVATE REVIEW INSTRUCTIONS",
    capabilities: "review",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name,
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title,
    outcome: body,
    ready: false,
  });
  const assignment = d.ensureLeadAssignment(taskId);
  if (!assignment) throw Error("Fixture lead absent");
  await f.service.provisionTask(taskId);
  const assignmentId = String(assignment.id),
    source = f.service.taskReview().sources(taskId)[0]!;
  function result(summary: string, metadata?: Partial<ReviewMetadata>) {
    let resultId = "";
    const workId = randomUUID();
    f.seedPersistedState((db) => {
      const c = new CoordinationStore(db, d),
        s = new ExecutionState(db);
      db.prepare(
        "INSERT INTO execution_intents(id,workId,prompt,workspace,state,threadId,turnId,accountType,sandbox,approval) VALUES(?,?,'fixture','/tmp/fixture','running',?,?,'chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId, workId, workId);
      s.bindTask(workId, {
        taskId,
        assignmentId,
        assignmentVersion: Number(d.assignment(assignmentId).version),
        instructionsRevision: 1,
        profileRevision: 1,
      });
      db.prepare(
        "UPDATE domain_assignments SET state='running' WHERE id=?",
      ).run(assignmentId);
      const revision = c.results(taskId).length + 1;
      db.prepare(
        "INSERT INTO task_work_revisions(workId,assignmentId,conversationRevision,workRevision) VALUES(?,?,1,?)",
      ).run(workId, assignmentId, revision);
      const batch = c.bindDeliveryBatch(assignmentId, workId);
      if (batch) c.completeDeliveryBatch(workId);
      resultId = c.recordResult({
        threadId: workId,
        turnId: workId,
        callId: randomUUID(),
        tool: "ensemble_report_result",
        arguments: { summary, ...(metadata ? { review: metadata } : {}) },
      }).result.resultId;
      db.prepare(
        "UPDATE execution_intents SET state='completed' WHERE workId=?",
      ).run(workId);
    });
    return { resultId, workId };
  }
  return { profileId, projectId, taskId, assignmentId, source, result };
}
