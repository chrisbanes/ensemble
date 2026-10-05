import { randomUUID, createHash } from "node:crypto";
import type { Database } from "../core/store.js";
import type { DomainStore } from "../core/domain.js";
import { TaskReviewStore } from "../core/task-review.js";
import { SchedulerStore, type TurnRequest } from "./scheduler.js";

/** Rebase only an unadmitted inbox request after startup's derived source refresh.
 * Old requests and context captures remain immutable and never become successes. */
export class InboxStartupReconciliation {
  constructor(
    private readonly db: Database,
    private readonly domain: DomainStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_request_anchors (
      workId TEXT PRIMARY KEY REFERENCES turn_requests(workId), sourceId TEXT NOT NULL,
      sourceDigest TEXT NOT NULL, policyDigest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox_request_supersessions (
      oldWorkId TEXT PRIMARY KEY REFERENCES turn_requests(workId),
      newWorkId TEXT NOT NULL UNIQUE REFERENCES turn_requests(workId),
      batchId TEXT NOT NULL, sourceId TEXT NOT NULL, sourceDigest TEXT NOT NULL,
      oldTaskVersion INTEGER NOT NULL, newTaskVersion INTEGER NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch())
    );`);
  }

  private policyDigest(request: TurnRequest): string {
    const one = (sql: string) => this.db.prepare(sql).get(request.projectId);
    // Project pause and derived task versions intentionally are not policy material.
    // Configuration versions remain included, so revoke-then-restore cannot revive work.
    const material = {
      project: one(
        "SELECT id,leadProfileId,instructionsRevision FROM domain_projects WHERE id=?",
      ),
      taskControls: this.db
        .prepare(
          "SELECT key,payloadHash FROM command_receipts WHERE scope=? AND (json_extract(result,'$.id')=? OR json_extract(result,'$.taskId')=?) ORDER BY key",
        )
        .all(request.projectId, request.taskId, request.taskId),
      routing: one("SELECT * FROM project_routing WHERE projectId=?"),
      source: one("SELECT * FROM project_github_sources WHERE projectId=?"),
      selections: this.db
        .prepare(
          "SELECT * FROM project_github_active WHERE projectId=? ORDER BY selectionId",
        )
        .all(request.projectId),
      delivery: one("SELECT * FROM delivery_policies WHERE projectId=?"),
      assignment: this.db
        .prepare("SELECT * FROM domain_assignments WHERE id=?")
        .get(request.assignmentId) as Record<string, unknown> | undefined,
      profile: this.db
        .prepare(
          "SELECT p.* FROM profiles p JOIN domain_assignments a ON a.profileId=p.id WHERE a.id=?",
        )
        .get(request.assignmentId),
    };
    // Assignment runtime state may progress without changing its immutable responsibility.
    if (material.assignment) {
      delete material.assignment.state;
    }
    return createHash("sha256").update(JSON.stringify(material)).digest("hex");
  }

  capture(request: TurnRequest): void {
    if (
      !request.taskId ||
      !request.assignmentId ||
      !request.workId.includes(":inbox:")
    )
      return;
    if (
      this.db
        .prepare("SELECT 1 FROM inbox_request_anchors WHERE workId=?")
        .get(request.workId)
    )
      return;
    const source = new TaskReviewStore(this.db).sources(request.taskId).at(-1);
    if (!source) return;
    this.db
      .prepare("INSERT OR IGNORE INTO inbox_request_anchors VALUES (?,?,?,?)")
      .run(
        request.workId,
        source.sourceId,
        source.digest,
        this.policyDigest(request),
      );
  }

  reconcile(): void {
    const scheduler = new SchedulerStore(this.db);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const request of scheduler.queued()) {
        if (
          !request.taskId ||
          !request.assignmentId ||
          !request.projectId ||
          request.assignmentVersion === null ||
          request.instructionsRevision === null ||
          request.profileRevision === null ||
          !request.workId.includes(":inbox:")
        )
          continue;
        const task = this.domain.task(request.taskId);
        if (
          Number(task.version) === request.taskVersion ||
          task.state !== "open"
        )
          continue;
        const anchor = this.db
          .prepare("SELECT * FROM inbox_request_anchors WHERE workId=?")
          .get(request.workId) as
          | { sourceId: string; sourceDigest: string; policyDigest: string }
          | undefined;
        const source = new TaskReviewStore(this.db)
          .sources(request.taskId)
          .at(-1);
        if (
          !anchor ||
          !source ||
          anchor.sourceId !== source.sourceId ||
          anchor.sourceDigest !== source.digest ||
          anchor.policyDigest !== this.policyDigest(request)
        )
          continue;
        const context = new TaskReviewStore(this.db).contextForWork(
          request.taskId,
          request.assignmentId,
          request.workId,
          request.assignmentVersion!,
        );
        if (
          !context ||
          context.sourceId !== anchor.sourceId ||
          context.instructionsRevision !== request.instructionsRevision ||
          context.profileRevision !== request.profileRevision
        )
          continue;
        const admission = this.domain.assignmentAdmission(
          request.assignmentId,
          {
            taskVersion: Number(task.version),
            assignmentVersion: request.assignmentVersion!,
            instructionsRevision: request.instructionsRevision!,
            profileRevision: request.profileRevision!,
          },
        );
        if (admission.reasons.some((r) => r !== "project-paused")) continue;
        const exact = this.db
          .prepare(`SELECT intent.id,batch.batchId FROM execution_intents intent
          JOIN task_execution_bindings binding ON binding.workId=intent.workId
          JOIN coordination_delivery_batches batch ON batch.deliveryWorkId=intent.workId
          WHERE intent.workId=? AND intent.state='ready' AND intent.threadId IS NULL AND intent.turnId IS NULL
            AND batch.state='queued' AND batch.taskId=? AND batch.recipientAssignmentId=?
            AND binding.taskId=batch.taskId AND binding.assignmentId=batch.recipientAssignmentId
            AND binding.assignmentVersion=? AND binding.instructionsRevision=? AND binding.profileRevision=?`)
          .get(
            request.workId,
            request.taskId,
            request.assignmentId,
            request.assignmentVersion,
            request.instructionsRevision,
            request.profileRevision,
          ) as { id: string; batchId: string } | undefined;
        if (!exact) continue;
        const blocked = this.db
          .prepare(`SELECT 1 FROM task_writer_holds WHERE taskId=?
          UNION ALL SELECT 1 FROM task_writer_ambiguity_holds WHERE taskId=?
          UNION ALL SELECT 1 FROM task_archival_holds WHERE taskId=?
          UNION ALL SELECT 1 FROM execution_stop_targets WHERE taskId=?
          UNION ALL SELECT 1 FROM execution_intents i JOIN task_execution_bindings b ON b.workId=i.workId
            WHERE b.taskId=? AND i.workId<>? AND i.state IN ('held','submitting','running','capacity-waiting','ready')
          UNION ALL SELECT 1 FROM delivery_actions WHERE taskId=? AND json_extract(recordJson,'$.state') IN ('prepared','attempting','uncertain') LIMIT 1`)
          .get(
            request.taskId,
            request.taskId,
            request.taskId,
            request.taskId,
            request.taskId,
            request.workId,
            request.taskId,
          );
        if (blocked) continue;
        const admitted = this.db
          .prepare(`SELECT 1 FROM task_writer_admissions WHERE workId=?
          UNION ALL SELECT 1 FROM execution_capacity_reservations WHERE workId=?
          UNION ALL SELECT 1 FROM execution_recovery_identities WHERE workId=?
          UNION ALL SELECT 1 FROM execution_recovery_observations WHERE workId=?
          UNION ALL SELECT 1 FROM execution_recovery_receipts WHERE workId=?
          UNION ALL SELECT 1 FROM execution_pending_effects WHERE workId=?
          UNION ALL SELECT 1 FROM execution_request_refusals WHERE workId=?
          UNION ALL SELECT 1 FROM task_work_revisions WHERE workId=? LIMIT 1`)
          .get(...Array(8).fill(request.workId));
        if (admitted) continue;
        const newWorkId = `assignment:${request.assignmentId}:v${request.assignmentVersion}:inbox:${randomUUID()}`;
        scheduler.ensure({
          ...request,
          workId: newWorkId,
          requestKey: newWorkId,
          taskVersion: Number(task.version),
        });
        this.db
          .prepare("INSERT INTO inbox_request_anchors VALUES (?,?,?,?)")
          .run(
            newWorkId,
            anchor.sourceId,
            anchor.sourceDigest,
            anchor.policyDigest,
          );
        this.db
          .prepare(
            "INSERT INTO inbox_request_supersessions(oldWorkId,newWorkId,batchId,sourceId,sourceDigest,oldTaskVersion,newTaskVersion) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            request.workId,
            newWorkId,
            exact.batchId,
            anchor.sourceId,
            anchor.sourceDigest,
            request.taskVersion,
            Number(task.version),
          );
        this.db
          .prepare(
            "UPDATE coordination_delivery_batches SET deliveryWorkId=? WHERE batchId=? AND deliveryWorkId=? AND state='queued'",
          )
          .run(newWorkId, exact.batchId, request.workId);
        scheduler.hold(
          request.workId,
          "Superseded never-admitted inbox request after source revalidation",
        );
        this.db
          .prepare(
            "UPDATE execution_intents SET state='reconciled',reason='Superseded never-admitted inbox request after source revalidation' WHERE id=? AND state='ready'",
          )
          .run(exact.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
