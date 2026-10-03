import { TaskReviewStore } from "./task-review.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Database } from "./store.js";

export interface IssueSnapshot {
  providerInstance: "github.com";
  nodeId: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  projectFields: Array<{
    projectNodeId: string;
    fieldNodeId: string;
    optionNodeId: string;
  }>;
}
export type SelectionSnapshot =
  | { complete: true; issues: IssueSnapshot[]; reason: null }
  | { complete: false; issues: IssueSnapshot[]; reason: string };
export type IssueStatus = {
  status: "open" | "closed" | "unknown";
  reason?: string;
};
export type BlockerSnapshot = {
  complete: boolean;
  blockers: IssueSnapshot[];
  reason: string | null;
};
export interface IssueReference {
  nodeId: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
}

export interface GitHubObservationBinding {
  projectId: string;
  configVersion: number;
  credentialRef: string | null;
}

import {
  nonempty,
  projectFieldsSchema,
  repositoryLinkSchema,
  readinessSchema,
  selectionSchema,
  type GitHubSelection,
} from "./github-source-contracts.js";
export {
  repositoryLinkSchema,
  readinessSchema,
  selectionSchema,
  githubConfigurationSchema,
  type GitHubConfigurationInput,
  type GitHubSelection,
} from "./github-source-contracts.js";
export const linkedRepositorySchema = repositoryLinkSchema.extend({
  gitCommonDirectory: z.string().min(1).refine(isAbsolute),
});
export type LinkedRepository = z.output<typeof linkedRepositorySchema>;

const execFileAsync = promisify(execFile);

export async function verifiedRepository(
  input: z.output<typeof repositoryLinkSchema>,
): Promise<LinkedRepository> {
  if (!isAbsolute(input.path))
    throw new Error("Linked repository path must be absolute");
  const path = await realpath(input.path);
  const common = (
    await execFileAsync(
      "git",
      ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 5000 },
    )
  ).stdout.trim();
  const ref = (
    await execFileAsync(
      "git",
      ["-C", path, "rev-parse", "--verify", input.ref],
      { encoding: "utf8", timeout: 5000 },
    )
  ).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(ref))
    throw new Error("Linked repository ref is invalid");
  return { ...input, path, gitCommonDirectory: await realpath(common) };
}

type Row = Record<string, string | number | null>;

export function sourceTextDigest(title: string, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([title, body]))
    .digest("hex");
}

/** Provider-owned observations. Each selection's complete generation commits atomically. */
export class GitHubSourceStore {
  constructor(private readonly db: Database) {}

  private currentBinding(
    binding: GitHubObservationBinding,
    selectionId?: string,
  ): boolean {
    const current = this.db
      .prepare(
        "SELECT version, credentialRef FROM project_github_sources WHERE projectId = ?",
      )
      .get(binding.projectId) as Row | undefined;
    if (
      !current ||
      Number(current.version) !== binding.configVersion ||
      current.credentialRef !== binding.credentialRef
    )
      return false;
    return (
      !selectionId ||
      Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM project_github_active WHERE projectId = ? AND selectionId = ? AND configVersion = ?",
          )
          .get(binding.projectId, selectionId, binding.configVersion),
      )
    );
  }

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS github_external_issues (
      providerInstance TEXT NOT NULL CHECK(providerInstance = 'github.com'), nodeId TEXT NOT NULL,
      taskId TEXT NOT NULL UNIQUE REFERENCES domain_tasks(id), repositoryId TEXT NOT NULL,
      repositoryName TEXT NOT NULL, issueNumber INTEGER NOT NULL,
      observedTitle TEXT NOT NULL, observedBody TEXT NOT NULL, observedState TEXT NOT NULL,
      labels TEXT NOT NULL, PRIMARY KEY(providerInstance, nodeId), UNIQUE(nodeId)
    );
    CREATE TABLE IF NOT EXISTS github_memberships (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      nodeId TEXT NOT NULL, projectFields TEXT NOT NULL,
      PRIMARY KEY(projectId, selectionId, nodeId),
      FOREIGN KEY(nodeId) REFERENCES github_external_issues(nodeId)
    );
    CREATE TABLE IF NOT EXISTS github_sync_state (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT,
      refreshedAt TEXT NOT NULL, PRIMARY KEY(projectId, selectionId)
    );
    CREATE TABLE IF NOT EXISTS github_placement_decisions (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      projectId TEXT NOT NULL REFERENCES domain_projects(id)
    );
    CREATE TABLE IF NOT EXISTS github_native_blockers (
      nodeId TEXT NOT NULL REFERENCES github_external_issues(nodeId), blockerNodeId TEXT NOT NULL,
      repositoryId TEXT NOT NULL, repositoryName TEXT NOT NULL, issueNumber INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','closed')),
      PRIMARY KEY(nodeId, blockerNodeId)
    );
    CREATE TABLE IF NOT EXISTS github_dependency_observations (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT, refreshedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS github_source_reviews (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      observedDigest TEXT NOT NULL, acceptedDigest TEXT NOT NULL,
      decision TEXT, decidedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS github_delivery_closures (nodeId TEXT PRIMARY KEY, operationId TEXT NOT NULL, closerPrNodeId TEXT, snapshotJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_source_holds (
      nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
      active INTEGER NOT NULL CHECK(active IN (0,1)), reason TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0)
    );`);
  }

  issue(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT * FROM github_external_issues WHERE providerInstance = 'github.com' AND nodeId = ?",
      )
      .get(nodeId) as Row | undefined;
  }

  memberships(nodeId: string): Row[] {
    return this.db
      .prepare(
        "SELECT projectId, selectionId, nodeId, projectFields FROM github_memberships WHERE nodeId = ? ORDER BY selectionId, projectId",
      )
      .all(nodeId) as Row[];
  }

  syncState(projectId: string, selectionId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT projectId, selectionId, complete, reason, refreshedAt FROM github_sync_state WHERE projectId = ? AND selectionId = ?",
      )
      .get(projectId, selectionId) as Row | undefined;
  }

  review(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT observedDigest, acceptedDigest, decision, decidedAt FROM github_source_reviews WHERE nodeId = ?",
      )
      .get(nodeId) as Row | undefined;
  }

  hold(nodeId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT active, reason, generation FROM github_source_holds WHERE nodeId = ?",
      )
      .get(nodeId) as Row | undefined;
  }

  conflicts(): Array<{ nodeId: string; taskId: string; projectIds: string[] }> {
    const rows = this.db
      .prepare(`SELECT e.nodeId, e.taskId, m.projectId
      FROM github_external_issues e JOIN github_memberships m ON m.nodeId = e.nodeId
      WHERE NOT EXISTS (SELECT 1 FROM github_placement_decisions d WHERE d.nodeId = e.nodeId)
        AND NOT EXISTS (SELECT 1 FROM domain_assignments a WHERE a.taskId = e.taskId)
      ORDER BY e.nodeId, m.projectId`)
      .all() as Row[];
    const grouped = new Map<
      string,
      { nodeId: string; taskId: string; projectIds: Set<string> }
    >();
    for (const row of rows) {
      const nodeId = String(row.nodeId);
      const item = grouped.get(nodeId) ?? {
        nodeId,
        taskId: String(row.taskId),
        projectIds: new Set<string>(),
      };
      item.projectIds.add(String(row.projectId));
      grouped.set(nodeId, item);
    }
    return [...grouped.values()]
      .filter((item) => item.projectIds.size > 1)
      .map((item) => ({
        nodeId: item.nodeId,
        taskId: item.taskId,
        projectIds: [...item.projectIds],
      }));
  }

  nativeBlockers(nodeId: string): Row[] {
    return this.db
      .prepare(
        "SELECT blockerNodeId, repositoryId, repositoryName, issueNumber, status FROM github_native_blockers WHERE nodeId = ? ORDER BY blockerNodeId",
      )
      .all(nodeId) as Row[];
  }

  activeHolds(): Array<{
    nodeId: string;
    taskId: string;
    reason: string;
    generation: number;
  }> {
    const rows = this.db
      .prepare(`SELECT h.nodeId, e.taskId, h.reason, h.generation
      FROM github_source_holds h JOIN github_external_issues e ON e.nodeId = h.nodeId
      WHERE h.active = 1 ORDER BY h.nodeId`)
      .all() as Row[];
    return rows.map((row) => ({
      nodeId: String(row.nodeId),
      taskId: String(row.taskId),
      reason: String(row.reason),
      generation: Number(row.generation),
    }));
  }

  localBlockerReferences(): Array<{
    projectId: string;
    reference: IssueReference;
  }> {
    const rows = this.db
      .prepare(`SELECT DISTINCT t.projectId, e.nodeId, e.repositoryId,
      e.repositoryName, e.issueNumber FROM local_dependencies d
      JOIN github_external_issues e ON e.taskId = d.blockerTaskId
      JOIN domain_tasks t ON t.id = e.taskId ORDER BY e.nodeId`)
      .all() as Row[];
    return rows.map((row) => ({
      projectId: String(row.projectId),
      reference: {
        nodeId: String(row.nodeId),
        repositoryId: String(row.repositoryId),
        repositoryName: String(row.repositoryName),
        number: Number(row.issueNumber),
      },
    }));
  }

  recordIssueStatus(
    nodeId: string,
    observation: IssueStatus,
    binding?: GitHubObservationBinding & { reference: IssueReference },
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const issue = this.issue(nodeId);
      if (
        binding &&
        (!this.currentBinding(binding) ||
          !issue ||
          issue.nodeId !== binding.reference.nodeId ||
          issue.repositoryId !== binding.reference.repositoryId ||
          issue.repositoryName !== binding.reference.repositoryName ||
          Number(issue.issueNumber) !== binding.reference.number ||
          !this.db
            .prepare(
              "SELECT 1 FROM domain_tasks WHERE id = ? AND projectId = ?",
            )
            .get(String(issue.taskId), binding.projectId))
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      if (!issue) throw new Error("Unknown imported issue");
      const prior = this.db
        .prepare("SELECT status FROM github_issue_status WHERE nodeId = ?")
        .get(nodeId) as Row | undefined;
      this.db
        .prepare(
          "INSERT INTO github_issue_status (nodeId, status, reason, refreshedAt) VALUES (?, ?, ?, ?) ON CONFLICT(nodeId) DO UPDATE SET status = excluded.status, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          nodeId,
          observation.status,
          observation.reason ?? null,
          new Date().toISOString(),
        );
      if ((prior?.status === "closed") !== (observation.status === "closed"))
        this.db
          .prepare(
            "UPDATE domain_tasks SET version = version + 1 WHERE id IN (SELECT taskId FROM local_dependencies WHERE blockerTaskId = ?)",
          )
          .run(String(issue.taskId));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  invalidateProviderObservations(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`UPDATE domain_tasks SET importedBlockers = 'unknown', version = version + 1
        WHERE id IN (SELECT taskId FROM github_external_issues) AND importedBlockers != 'unknown'`)
        .run();
      this.db
        .prepare(`UPDATE domain_tasks SET version = version + 1
        WHERE id IN (SELECT d.taskId FROM local_dependencies d
          JOIN github_external_issues e ON e.taskId = d.blockerTaskId
          JOIN github_issue_status s ON s.nodeId = e.nodeId WHERE s.status = 'closed')`)
        .run();
      this.db
        .prepare(
          "UPDATE github_issue_status SET status = 'unknown', reason = 'startup-refresh-required'",
        )
        .run();
      this.db
        .prepare(
          "UPDATE github_dependency_observations SET complete = 0, reason = 'startup-refresh-required'",
        )
        .run();
      this.db
        .prepare(
          "UPDATE github_sync_state SET complete = 0, reason = 'startup-refresh-required'",
        )
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reconcileBlockers(
    nodeId: string,
    snapshot: BlockerSnapshot,
    binding?: GitHubObservationBinding & {
      selectionId: string;
      reference: IssueReference;
    },
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const issue = this.issue(nodeId);
      if (!issue) throw new Error("Unknown imported issue");
      if (
        binding &&
        (!this.currentBinding(binding, binding.selectionId) ||
          nodeId !== binding.reference.nodeId ||
          issue.repositoryId !== binding.reference.repositoryId ||
          issue.repositoryName !== binding.reference.repositoryName ||
          Number(issue.issueNumber) !== binding.reference.number ||
          !this.db
            .prepare(
              "SELECT 1 FROM github_memberships WHERE projectId = ? AND selectionId = ? AND nodeId = ?",
            )
            .get(binding.projectId, binding.selectionId, nodeId))
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      if (snapshot.complete) {
        this.db
          .prepare("DELETE FROM github_native_blockers WHERE nodeId = ?")
          .run(nodeId);
        for (const blocker of snapshot.blockers) {
          if (blocker.providerInstance !== "github.com")
            throw new Error("Provider identity mismatch");
          this.db
            .prepare(
              "INSERT OR IGNORE INTO github_native_blockers (nodeId, blockerNodeId, repositoryId, repositoryName, issueNumber, status) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              nodeId,
              blocker.nodeId,
              blocker.repositoryId,
              blocker.repositoryName,
              blocker.number,
              blocker.state,
            );
        }
      }
      this.db
        .prepare(
          "INSERT INTO github_dependency_observations (nodeId, complete, reason, refreshedAt) VALUES (?, ?, ?, ?) ON CONFLICT(nodeId) DO UPDATE SET complete = excluded.complete, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          nodeId,
          Number(snapshot.complete),
          snapshot.reason,
          new Date().toISOString(),
        );
      const state = !snapshot.complete
        ? "unknown"
        : this.nativeBlockers(nodeId).some(
              (blocker) => blocker.status === "open",
            )
          ? "blocked"
          : "clear";
      const task = this.db
        .prepare("SELECT importedBlockers FROM domain_tasks WHERE id = ?")
        .get(String(issue.taskId)) as Row;
      if (task.importedBlockers !== state)
        this.db
          .prepare(
            "UPDATE domain_tasks SET importedBlockers = ?, version = version + 1 WHERE id = ?",
          )
          .run(state, String(issue.taskId));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reconcileSelection(
    projectId: string,
    selectionId: string,
    snapshot: SelectionSnapshot,
    binding?: GitHubObservationBinding,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        binding &&
        (binding.projectId !== projectId ||
          !this.currentBinding(binding, selectionId))
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      const config = this.db
        .prepare(
          "SELECT version, readiness, selections FROM project_github_sources WHERE projectId = ?",
        )
        .get(projectId) as Row | undefined;
      if (!config) throw new Error("GitHub selection is not active");
      const active = this.db
        .prepare(
          "SELECT 1 FROM project_github_active WHERE projectId = ? AND selectionId = ? AND configVersion = ?",
        )
        .get(projectId, selectionId, Number(config.version)) as Row | undefined;
      if (!active) throw new Error("GitHub selection is not active");
      const selections = z
        .array(selectionSchema)
        .parse(JSON.parse(String(config.selections)) as unknown);
      if (!selections.some((selection) => selection.id === selectionId))
        throw new Error("Unknown GitHub selection");
      const previousSync = this.syncState(projectId, selectionId);
      const seen = new Set<string>();
      for (const issue of snapshot.issues) {
        if (issue.providerInstance !== "github.com")
          throw new Error("Provider identity mismatch");
        if (seen.has(issue.nodeId)) continue;
        seen.add(issue.nodeId);
        const existing = this.issue(issue.nodeId);
        let taskId: string;
        if (!existing) {
          taskId = randomUUID();
          this.db
            .prepare(
              "INSERT INTO tasks (id, projectId, title) VALUES (?, ?, ?)",
            )
            .run(taskId, projectId, issue.title);
          this.db
            .prepare(
              "INSERT INTO domain_tasks (id, projectId, version, outcome, ready, state, importedBlockers) VALUES (?, ?, 1, ?, 0, 'open', 'unknown')",
            )
            .run(taskId, projectId, issue.body);
          this.db
            .prepare(
              "INSERT INTO github_imported_tasks (taskId, providerInstance, nodeId, repositoryId) VALUES (?, 'github.com', ?, ?)",
            )
            .run(taskId, issue.nodeId, issue.repositoryId);
          this.db
            .prepare(
              "INSERT INTO github_external_issues (providerInstance, nodeId, taskId, repositoryId, repositoryName, issueNumber, observedTitle, observedBody, observedState, labels) VALUES ('github.com', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              issue.nodeId,
              taskId,
              issue.repositoryId,
              issue.repositoryName,
              issue.number,
              issue.title,
              issue.body,
              issue.state,
              JSON.stringify(issue.labels),
            );
          const digest = sourceTextDigest(issue.title, issue.body);
          this.db
            .prepare(
              "INSERT INTO github_source_reviews (nodeId, observedDigest, acceptedDigest) VALUES (?, ?, ?)",
            )
            .run(issue.nodeId, digest, digest);
        } else {
          taskId = String(existing.taskId);
          const digest = sourceTextDigest(issue.title, issue.body);
          const prior = this.db
            .prepare(
              "SELECT observedDigest FROM github_source_reviews WHERE nodeId = ?",
            )
            .get(issue.nodeId) as Row | undefined;
          if (prior?.observedDigest !== digest) {
            this.db
              .prepare(
                "INSERT INTO github_source_reviews (nodeId, observedDigest, acceptedDigest) VALUES (?, ?, ?) ON CONFLICT(nodeId) DO UPDATE SET observedDigest = excluded.observedDigest",
              )
              .run(
                issue.nodeId,
                digest,
                prior?.observedDigest ??
                  sourceTextDigest(
                    String(existing.observedTitle),
                    String(existing.observedBody),
                  ),
              );
            this.db
              .prepare(
                "UPDATE domain_tasks SET version = version + 1 WHERE id = ?",
              )
              .run(taskId);
            this.setSourceHold(issue.nodeId, "changed-text");
          }
          this.db
            .prepare(
              "UPDATE github_external_issues SET repositoryId = ?, repositoryName = ?, issueNumber = ?, observedTitle = ?, observedBody = ?, observedState = ?, labels = ? WHERE providerInstance = 'github.com' AND nodeId = ?",
            )
            .run(
              issue.repositoryId,
              issue.repositoryName,
              issue.number,
              issue.title,
              issue.body,
              issue.state,
              JSON.stringify(issue.labels),
              issue.nodeId,
            );
        }
        this.db
          .prepare(
            "INSERT INTO github_memberships (projectId, selectionId, nodeId, projectFields) VALUES (?, ?, ?, ?) ON CONFLICT(projectId, selectionId, nodeId) DO UPDATE SET projectFields = excluded.projectFields",
          )
          .run(
            projectId,
            selectionId,
            issue.nodeId,
            JSON.stringify(issue.projectFields),
          );
        new TaskReviewStore(this.db).captureSource(taskId, "github", {
          title: issue.title,
          body: issue.body,
        });
        this.updateReadiness(taskId);
      }
      if (snapshot.complete) {
        const old = this.db
          .prepare(
            "SELECT nodeId FROM github_memberships WHERE projectId = ? AND selectionId = ?",
          )
          .all(projectId, selectionId) as Row[];
        for (const membership of old)
          if (!seen.has(String(membership.nodeId))) {
            this.db
              .prepare(
                "DELETE FROM github_memberships WHERE projectId = ? AND selectionId = ? AND nodeId = ?",
              )
              .run(projectId, selectionId, String(membership.nodeId));
            const external = this.issue(String(membership.nodeId));
            if (external) this.updateReadiness(String(external.taskId));
          }
      } else {
        const retained = this.db
          .prepare(`SELECT e.nodeId, e.taskId FROM github_memberships m
          JOIN github_external_issues e ON e.nodeId = m.nodeId
          WHERE m.projectId = ? AND m.selectionId = ?`)
          .all(projectId, selectionId) as Row[];
        for (const issue of retained) {
          this.db
            .prepare(
              "UPDATE github_dependency_observations SET complete = 0, reason = 'source-read-incomplete' WHERE nodeId = ?",
            )
            .run(String(issue.nodeId));
          this.db
            .prepare(
              "UPDATE domain_tasks SET importedBlockers = 'unknown', version = version + 1 WHERE id = ? AND importedBlockers != 'unknown'",
            )
            .run(String(issue.taskId));
        }
      }
      this.db
        .prepare(
          "INSERT INTO github_sync_state (projectId, selectionId, complete, reason, refreshedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(projectId, selectionId) DO UPDATE SET complete = excluded.complete, reason = excluded.reason, refreshedAt = excluded.refreshedAt",
        )
        .run(
          projectId,
          selectionId,
          Number(snapshot.complete),
          snapshot.reason,
          new Date().toISOString(),
        );
      if (
        previousSync &&
        Number(previousSync.complete) !== Number(snapshot.complete)
      )
        this.db
          .prepare(`UPDATE domain_tasks SET version = version + 1 WHERE id IN (
          SELECT e.taskId FROM github_external_issues e JOIN github_memberships m ON m.nodeId = e.nodeId
          WHERE m.projectId = ? AND m.selectionId = ?)`)
          .run(projectId, selectionId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordDeliveryClosure(
    projectId: string,
    configVersion: number,
    input: IssueSnapshot,
    operationId: string,
    closerPrNodeId: string | null,
  ): boolean {
    const snapshot = z
      .object({
        providerInstance: z.literal("github.com"),
        nodeId: nonempty,
        repositoryId: nonempty,
        repositoryName: nonempty,
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string(),
        state: z.literal("closed"),
        labels: z.array(nonempty),
        projectFields: projectFieldsSchema,
      })
      .strict()
      .parse(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const issue = this.issue(snapshot.nodeId),
        config = this.db
          .prepare(
            "SELECT version,readiness,selections FROM project_github_sources WHERE projectId=?",
          )
          .get(projectId) as Row | undefined;
      if (
        !issue ||
        !config ||
        config.version !== configVersion ||
        issue.repositoryId !== snapshot.repositoryId ||
        issue.repositoryName !== snapshot.repositoryName ||
        Number(issue.issueNumber) !== snapshot.number ||
        !this.db
          .prepare("SELECT 1 FROM domain_tasks WHERE id=? AND projectId=?")
          .get(String(issue.taskId), projectId)
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      const digest = sourceTextDigest(snapshot.title, snapshot.body),
        review = this.review(snapshot.nodeId);
      if (review?.observedDigest !== digest) {
        this.db
          .prepare(
            "UPDATE github_source_reviews SET observedDigest=? WHERE nodeId=?",
          )
          .run(digest, snapshot.nodeId);
        this.db
          .prepare("UPDATE domain_tasks SET version=version+1 WHERE id=?")
          .run(String(issue.taskId));
        this.setSourceHold(snapshot.nodeId, "changed-text");
      }
      this.db
        .prepare(
          "UPDATE github_external_issues SET observedState='closed',observedTitle=?,observedBody=?,labels=? WHERE nodeId=?",
        )
        .run(
          snapshot.title,
          snapshot.body,
          JSON.stringify(snapshot.labels),
          snapshot.nodeId,
        );
      new TaskReviewStore(this.db).captureSource(
        String(issue.taskId),
        "github",
        { title: snapshot.title, body: snapshot.body },
      );
      const priorHold = this.db
        .prepare("SELECT active,reason FROM github_source_holds WHERE nodeId=?")
        .get(snapshot.nodeId) as Row | undefined;
      this.updateReadiness(String(issue.taskId));
      const rule = readinessSchema.parse(JSON.parse(String(config.readiness)));
      const labelProof =
        rule.conditions.every((c) => c.kind === "label") &&
        (rule.mode === "all"
          ? rule.conditions.every(
              (c) => c.kind === "label" && snapshot.labels.includes(c.name),
            )
          : rule.conditions.some(
              (c) => c.kind === "label" && snapshot.labels.includes(c.name),
            ));
      const hold = priorHold;
      if (
        labelProof &&
        (!hold?.active ||
          ["closed", "withdrawn", "closure-read-unavailable"].includes(
            String(hold.reason),
          ))
      )
        this.setSourceHold(snapshot.nodeId, "closed");
      else if (!labelProof && (!hold?.active || hold.reason === "closed"))
        this.setSourceHold(snapshot.nodeId, "readiness-lost");
      else if (hold?.active)
        this.setSourceHold(snapshot.nodeId, String(hold.reason));
      this.db
        .prepare(
          "INSERT INTO github_delivery_closures VALUES (?,?,?,?) ON CONFLICT(nodeId) DO UPDATE SET operationId=excluded.operationId,closerPrNodeId=excluded.closerPrNodeId,snapshotJson=excluded.snapshotJson",
        )
        .run(
          snapshot.nodeId,
          operationId,
          closerPrNodeId,
          JSON.stringify(snapshot),
        );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recordDeliveryClosureUnavailable(nodeId: string): void {
    const hold = this.db
      .prepare("SELECT active,reason FROM github_source_holds WHERE nodeId=?")
      .get(nodeId) as Row | undefined;
    if (!hold?.active || hold.reason === "closed")
      this.setSourceHold(nodeId, "closure-read-unavailable");
  }

  updateReadiness(taskId: string): void {
    const external = this.db
      .prepare(
        "SELECT e.nodeId, e.labels, e.observedState, t.projectId FROM github_external_issues e JOIN domain_tasks t ON t.id = e.taskId WHERE e.taskId = ?",
      )
      .get(taskId) as Row;
    const config = this.db
      .prepare(
        "SELECT readiness FROM project_github_sources WHERE projectId = ?",
      )
      .get(String(external.projectId)) as Row;
    const rule = readinessSchema.parse(
      JSON.parse(String(config.readiness)) as unknown,
    );
    const memberships = this.db
      .prepare(
        "SELECT projectFields FROM github_memberships WHERE nodeId = ? AND projectId = ?",
      )
      .all(String(external.nodeId), String(external.projectId)) as Row[];
    const fields = memberships.flatMap((row) =>
      projectFieldsSchema.parse(JSON.parse(String(row.projectFields))),
    );
    const labels = z
      .array(z.string())
      .parse(JSON.parse(String(external.labels)) as unknown);
    const satisfied = rule.conditions.map((condition) =>
      condition.kind === "label"
        ? labels.includes(condition.name)
        : fields.some(
            (field) =>
              field.projectNodeId === condition.projectNodeId &&
              field.fieldNodeId === condition.fieldNodeId &&
              field.optionNodeId === condition.optionNodeId,
          ),
    );
    const ready =
      memberships.length > 0 &&
      external.observedState === "open" &&
      (rule.mode === "all"
        ? satisfied.every(Boolean)
        : satisfied.some(Boolean));
    const row = this.db
      .prepare("SELECT ready FROM domain_tasks WHERE id = ?")
      .get(taskId) as Row;
    if (Number(row.ready) === 1 && !ready)
      this.setSourceHold(
        String(external.nodeId),
        external.observedState === "closed"
          ? "closed"
          : memberships.length === 0
            ? "withdrawn"
            : "readiness-lost",
      );
    if (Number(row.ready) !== Number(ready))
      this.db
        .prepare(
          "UPDATE domain_tasks SET ready = ?, version = version + 1 WHERE id = ?",
        )
        .run(Number(ready), taskId);
  }

  private setSourceHold(nodeId: string, reason: string): void {
    this.db
      .prepare(`INSERT INTO github_source_holds (nodeId, active, reason, generation) VALUES (?, 1, ?, 1)
      ON CONFLICT(nodeId) DO UPDATE SET active = 1, reason = excluded.reason,
      generation = CASE WHEN active = 0 OR reason != excluded.reason THEN generation + 1 ELSE generation END`)
      .run(nodeId, reason);
  }
}
