import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { transaction, type Database } from "./store.js";
const uuid = z.string().uuid(),
  revision = z.number().int().positive(),
  text = z.string().max(16000),
  identity = z.string().min(1).max(512);
export const feedbackReferenceSchema = z
  .object({
    sourceId: uuid.optional(),
    resultId: uuid.optional(),
    criterionId: identity.optional(),
    artifactId: uuid.optional(),
    workId: identity.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const reviewMetadataSchema = z
  .object({
    sourceId: uuid.optional(),
    criteria: z
      .array(
        z
          .object({
            criterionId: identity,
            outcome: z.enum(["supported", "failed", "unverified"]),
            scope: text,
            provenance: text,
          })
          .strict(),
      )
      .max(128)
      .default([]),
    validations: z
      .array(
        z
          .object({
            label: text,
            outcome: z.enum(["passed", "failed", "unverified"]),
            scope: text,
            provenance: text,
            checkedHead: z
              .string()
              .regex(/^[a-f0-9]{40}$/)
              .optional(),
          })
          .strict(),
      )
      .max(128)
      .default([]),
    artifacts: z
      .array(
        z
          .object({
            artifactId: uuid,
            label: text,
            role: z.enum(["before", "after", "evidence"]),
            pairId: identity.optional(),
            revision,
            availability: z.enum(["available", "unavailable", "redacted"]),
            url: z
              .string()
              .url()
              .max(2000)
              .refine((v) => ["http:", "https:"].includes(new URL(v).protocol))
              .optional(),
            file: z
              .object({
                relativePath: z.string().min(1).max(2000),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                mime: z.enum(["image/png", "image/jpeg"]),
                size: z.number().int().min(1).max(5000000),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    changes: z
      .object({
        files: z.array(z.string().max(2000)).max(128).default([]),
        commits: z
          .array(z.string().regex(/^[a-f0-9]{40}$/))
          .max(128)
          .default([]),
        diff: text.optional(),
        reference: z.string().url().max(2000).optional(),
        findings: z
          .array(
            z
              .object({ finding: text, repairAssignmentId: uuid.optional() })
              .strict(),
          )
          .max(128)
          .default([]),
      })
      .strict()
      .optional(),
    decisions: z
      .array(z.object({ text, attribution: text }).strict())
      .max(128)
      .default([]),
  })
  .strict();
export type ReviewMetadata = z.output<typeof reviewMetadataSchema>;
export const sourceSnapshotSchema = z
  .object({
    sourceId: uuid,
    taskId: uuid,
    projectId: uuid,
    revision,
    kind: z.enum(["local", "github"]),
    title: text.nullable(),
    body: text.nullable(),
    digest: z.string().length(64),
    createdAt: z.number(),
    criteria: z
      .array(
        z
          .object({
            criterionId: identity,
            position: z.number().int().nonnegative(),
            text,
          })
          .strict(),
      )
      .max(128),
    criteriaOmittedCount: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    coverage: z.literal("literal-checklists-only"),
  })
  .strict();
export const contextCaptureSchema = z
  .object({
    captureId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    assignmentVersion: revision,
    workId: identity.nullable(),
    supplier: z.string().max(512),
    brief: text.nullable(),
    profileRevision: revision,
    instructionsRevision: revision,
    sourceId: uuid.nullable(),
    createdAt: z.number(),
  })
  .strict();
export const resultReviewSchema = z
  .object({
    resultId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    workId: identity,
    workRevision: revision,
    metadata: reviewMetadataSchema,
  })
  .strict();
export const viewedReferenceSchema = z
  .object({
    sourceId: uuid.nullable(),
    resultIds: z.array(uuid).max(128),
    viewedAt: z.number(),
  })
  .strict();
export const taskReviewReadSchema = z
  .object({
    sources: z.array(sourceSnapshotSchema).max(128),
    contexts: z.array(contextCaptureSchema).max(256),
    contextsOmittedCount: z.number().int().nonnegative(),
    results: z.array(resultReviewSchema).max(128),
    viewed: viewedReferenceSchema.nullable(),
    coverage: z.literal("retained-records-only"),
  })
  .strict();
type Row = Record<string, string | number | null>;
export class TaskReviewStore {
  constructor(private readonly db: Database) {}
  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_review_sources(sourceId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES domain_tasks(id),projectId TEXT NOT NULL,revision INTEGER NOT NULL,recordJson TEXT NOT NULL,UNIQUE(taskId,revision));
 CREATE TABLE IF NOT EXISTS task_review_contexts(captureId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES domain_tasks(id),assignmentId TEXT NOT NULL REFERENCES domain_assignments(id),assignmentVersion INTEGER NOT NULL,workId TEXT,recordJson TEXT NOT NULL,UNIQUE(assignmentId,assignmentVersion,workId));
 CREATE TABLE IF NOT EXISTS task_review_results(resultId TEXT PRIMARY KEY REFERENCES coordination_results(resultId),taskId TEXT NOT NULL REFERENCES domain_tasks(id),recordJson TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS task_review_artifact_ids(artifactId TEXT PRIMARY KEY,resultId TEXT NOT NULL REFERENCES task_review_results(resultId) ON DELETE CASCADE,taskId TEXT NOT NULL REFERENCES domain_tasks(id));
 CREATE TABLE IF NOT EXISTS task_review_search(recordId TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES domain_tasks(id),projectId TEXT NOT NULL,type TEXT NOT NULL,sourceId TEXT,resultId TEXT,excerpt TEXT NOT NULL,createdAt INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS task_review_search_order ON task_review_search(createdAt,recordId);
 CREATE INDEX IF NOT EXISTS task_review_search_project ON task_review_search(projectId,type,createdAt,recordId);
 CREATE TABLE IF NOT EXISTS task_review_viewed(taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),recordJson TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS task_review_view_receipts(key TEXT PRIMARY KEY,material TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS task_review_sources_task ON task_review_sources(taskId,revision);
 CREATE INDEX IF NOT EXISTS task_review_contexts_task ON task_review_contexts(taskId);
 CREATE INDEX IF NOT EXISTS task_review_results_task ON task_review_results(taskId);`);
  }
  // CoordinationStore owns the surrounding migration transaction after all input schemas exist.
  populateMissingWithinTransaction() {
    const externalAvailable = !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='github_external_issues'",
      )
      .get();
    let cursor = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT rowid AS cursor,id FROM domain_tasks WHERE rowid>? ORDER BY rowid LIMIT 64",
        )
        .all(cursor) as Row[];
      for (const row of rows) {
        const taskId = String(row.id);
        if (
          !this.db
            .prepare("SELECT 1 FROM task_review_sources WHERE taskId=? LIMIT 1")
            .get(taskId)
        ) {
          const imported = this.db
            .prepare("SELECT 1 FROM github_imported_tasks WHERE taskId=?")
            .get(taskId);
          if (!imported) this.captureSource(taskId);
          else if (externalAvailable) {
            const observed = this.db
              .prepare(
                "SELECT observedTitle,observedBody FROM github_external_issues WHERE taskId=?",
              )
              .get(taskId) as Row | undefined;
            if (observed)
              this.captureSource(taskId, "github", {
                title: String(observed.observedTitle),
                body: String(observed.observedBody),
              });
          }
        }
        cursor = Number(row.cursor);
      }
      if (rows.length < 64) break;
    }
    cursor = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT s.rowid AS cursor,s.recordJson FROM task_review_sources s WHERE s.rowid>? AND NOT EXISTS(SELECT 1 FROM task_review_search i WHERE i.recordId=s.sourceId) ORDER BY s.rowid LIMIT 64",
        )
        .all(cursor) as Row[];
      for (const row of rows) {
        const source = sourceSnapshotSchema.parse(
          JSON.parse(String(row.recordJson)),
        );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO task_review_search VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            source.sourceId,
            source.taskId,
            source.projectId,
            "task",
            source.sourceId,
            null,
            `${source.title === null ? "" : (this.safe(source.title) ?? "")}\n${source.body === null ? "" : (this.safe(source.body) ?? "")}`.slice(
              0,
              16000,
            ),
            source.createdAt,
          );
        cursor = Number(row.cursor);
      }
      if (rows.length < 64) break;
    }
    cursor = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT r.rowid AS cursor,r.*,t.projectId FROM coordination_results r JOIN domain_tasks t ON t.id=r.taskId WHERE r.rowid>? ORDER BY r.rowid LIMIT 64",
        )
        .all(cursor) as Row[];
      for (const row of rows) {
        const existing = this.db
          .prepare(
            "SELECT recordJson FROM task_review_results WHERE resultId=?",
          )
          .get(String(row.resultId)) as Row | undefined;
        const review = existing
          ? resultReviewSchema.parse(JSON.parse(String(existing.recordJson)))
          : resultReviewSchema.parse({
              resultId: row.resultId,
              taskId: row.taskId,
              assignmentId: row.assignmentId,
              workId: row.workId,
              workRevision: row.workRevision,
              metadata: {},
            });
        if (
          review.resultId !== row.resultId ||
          review.taskId !== row.taskId ||
          review.assignmentId !== row.assignmentId ||
          review.workId !== row.workId ||
          review.workRevision !== row.workRevision
        )
          throw Error("Retained result review identity mismatch");
        if (!existing)
          this.db
            .prepare("INSERT INTO task_review_results VALUES(?,?,?)")
            .run(
              String(row.resultId),
              String(row.taskId),
              JSON.stringify(review),
            );
        this.indexResult(
          String(row.resultId),
          String(row.taskId),
          String(row.projectId),
          this.safe(String(row.summary)) ?? "",
          Number(row.createdAt) * 1000,
        );
        this.indexArtifactIdentities(review);
        review.metadata.decisions.forEach((decision, index) => {
          const attribution = this.safe(decision.attribution),
            text = this.safe(decision.text);
          if (attribution === null || text === null) return;
          this.db
            .prepare(
              "INSERT OR IGNORE INTO task_review_search VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              `${row.resultId}:decision:${index}`,
              String(row.taskId),
              String(row.projectId),
              "decision",
              review.metadata.sourceId ?? null,
              String(row.resultId),
              `${attribution}: ${text}`.slice(0, 16000),
              Number(row.createdAt) * 1000,
            );
        });
        cursor = Number(row.cursor);
      }
      if (rows.length < 64) break;
    }
  }
  private exclusions(): string[] | undefined {
    const rows = this.db
      .prepare(
        "SELECT instructions FROM profile_revisions UNION ALL SELECT instructions FROM project_instruction_revisions LIMIT 257",
      )
      .all() as Row[];
    if (rows.length > 256) return undefined;
    const excluded = rows.map((r) => String(r.instructions)).filter(Boolean);
    const refs = this.db
      .prepare(
        "SELECT credentialRef FROM project_routing UNION ALL SELECT credentialRef FROM project_github_sources LIMIT 257",
      )
      .all() as Row[];
    if (refs.length > 256) return undefined;
    for (const ref of refs) {
      if (ref.credentialRef) {
        const name = String(ref.credentialRef).slice(4);
        excluded.push(String(ref.credentialRef), name);
        if (process.env[name]) excluded.push(process.env[name]!);
      }
    }
    const repositories = this.db
      .prepare("SELECT repositories FROM project_github_sources LIMIT 129")
      .all() as Row[];
    if (repositories.length > 128) return undefined;
    for (const row of repositories) {
      const repos = JSON.parse(String(row.repositories)) as {
        path?: string;
        gitCommonDirectory?: string;
      }[];
      if (repos.length > 128) return undefined;
      for (const repo of repos)
        excluded.push(
          ...[repo.path, repo.gitCommonDirectory].filter((v): v is string =>
            Boolean(v),
          ),
        );
    }
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='task_workspace_bindings'",
        )
        .get()
    ) {
      const workspaces = this.db
        .prepare("SELECT path FROM task_workspace_bindings LIMIT 129")
        .all() as Row[];
      if (workspaces.length > 128) return undefined;
      excluded.push(...workspaces.map((w) => String(w.path)));
    }
    const policies = this.db
      .prepare("SELECT policyJson FROM delivery_policies LIMIT 129")
      .all() as Row[];
    if (policies.length > 128) return undefined;
    for (const row of policies) {
      const policy = JSON.parse(String(row.policyJson)) as {
        credentialRef?: string;
      };
      if (policy.credentialRef) {
        const name = policy.credentialRef.slice(4);
        excluded.push(policy.credentialRef, name);
        if (process.env[name]) excluded.push(process.env[name]!);
      }
    }

    for (const [key, v] of Object.entries(process.env))
      if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(key) && v)
        excluded.push(v);
    return excluded;
  }
  private safe(
    value: string,
    snapshot: { excluded: readonly string[] | undefined } = {
      excluded: this.exclusions(),
    },
  ): string | null {
    const excluded = snapshot.excluded;
    if (excluded === undefined || excluded.some((v) => value.includes(v)))
      return null;
    const sanitized = value
      .replace(
        /((?:password|token|api[_-]?key|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1[redacted]",
      )
      .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .split("")
      .filter(
        (c) => c.charCodeAt(0) >= 32 || [9, 10, 13].includes(c.charCodeAt(0)),
      )
      .join("");
    return sanitized.length > 16000 ? null : sanitized;
  }
  captureSources(
    entries: readonly {
      taskId: string;
      kind: "local" | "github";
      supplied?: { title: string; body: string };
    }[],
  ) {
    if (!entries.length) return [];
    const snapshot = { excluded: this.exclusions() };
    return entries.map((entry) =>
      this.captureSourceWithSnapshot(
        entry.taskId,
        entry.kind,
        entry.supplied,
        snapshot,
      ),
    );
  }
  captureSource(
    taskId: string,
    kind: "local" | "github" = "local",
    supplied?: { title: string; body: string },
  ) {
    return this.captureSourceWithSnapshot(taskId, kind, supplied, {
      excluded: this.exclusions(),
    });
  }
  private captureSourceWithSnapshot(
    taskId: string,
    kind: "local" | "github" = "local",
    supplied: { title: string; body: string } | undefined,
    snapshot: { excluded: readonly string[] | undefined },
  ) {
    const t = this.db
      .prepare(
        "SELECT t.id,t.projectId,t.version,t.outcome,b.title FROM domain_tasks t JOIN tasks b ON b.id=t.id WHERE t.id=?",
      )
      .get(taskId) as Row | undefined;
    if (!t) throw Error("Review task unavailable");
    const originalTitle = supplied?.title ?? String(t.title),
      originalBody = supplied?.body ?? String(t.outcome),
      title =
        originalTitle.length > 16000
          ? null
          : this.safe(originalTitle, snapshot),
      body =
        originalBody.length > 16000 ? null : this.safe(originalBody, snapshot);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({ kind, title: originalTitle, body: originalBody }),
      )
      .digest("hex");
    const latest = this.sources(taskId).at(-1);
    if (latest?.digest === digest) return latest;
    const sourceId = randomUUID(),
      criteria: z.infer<typeof sourceSnapshotSchema>["criteria"] = [];
    let criteriaOmittedCount = body === null ? null : 0;
    (body ?? "").split("\n").forEach((line, position) => {
      const m = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
      if (m && criteria.length < 128)
        criteria.push({
          criterionId: `${sourceId}:${position}`,
          position,
          text: m[1] ?? "",
        });
      else if (m && criteriaOmittedCount !== null) criteriaOmittedCount++;
    });
    const record = sourceSnapshotSchema.parse({
      sourceId,
      taskId,
      projectId: t.projectId,
      revision: (latest?.revision ?? 0) + 1,
      kind,
      title,
      body,
      digest,
      createdAt: Date.now(),
      criteria,
      criteriaOmittedCount,
      coverage: "literal-checklists-only",
    });
    this.db
      .prepare("INSERT INTO task_review_sources VALUES(?,?,?,?,?)")
      .run(
        sourceId,
        taskId,
        String(t.projectId),
        record.revision,
        JSON.stringify(record),
      );
    this.db
      .prepare("INSERT INTO task_review_search VALUES(?,?,?,?,?,?,?,?)")
      .run(
        sourceId,
        taskId,
        record.projectId,
        "task",
        sourceId,
        null,
        `${title ?? ""}\n${body ?? ""}`.slice(0, 16000),
        record.createdAt,
      );
    return record;
  }
  captureAssignment(
    assignmentId: string,
    supplier: string,
    workId: string | null = null,
  ) {
    const a = this.db
      .prepare("SELECT * FROM domain_assignments WHERE id=?")
      .get(assignmentId) as Row | undefined;
    if (!a) throw Error("Review assignment unavailable");
    const prior = this.db
      .prepare(
        "SELECT recordJson FROM task_review_contexts WHERE assignmentId=? AND assignmentVersion=? AND workId IS ?",
      )
      .get(assignmentId, Number(a.version), workId) as Row | undefined;
    if (prior)
      return contextCaptureSchema.parse(JSON.parse(String(prior.recordJson)));
    const source = this.sources(String(a.taskId)).at(-1);
    const record = contextCaptureSchema.parse({
      captureId: randomUUID(),
      taskId: a.taskId,
      assignmentId,
      assignmentVersion: a.version,
      workId,
      supplier,
      brief: this.safe(String(a.brief)),
      profileRevision: a.profileRevision,
      instructionsRevision: a.instructionsRevision,
      sourceId: source?.sourceId ?? null,
      createdAt: Date.now(),
    });
    this.db
      .prepare("INSERT INTO task_review_contexts VALUES(?,?,?,?,?,?)")
      .run(
        record.captureId,
        record.taskId,
        assignmentId,
        record.assignmentVersion,
        workId,
        JSON.stringify(record),
      );
    return record;
  }
  contextForWork(
    taskId: string,
    assignmentId: string,
    workId: string,
    assignmentVersion: number,
  ) {
    revision.parse(assignmentVersion);
    const rows = this.db
      .prepare(
        "SELECT recordJson FROM task_review_contexts WHERE taskId=? AND assignmentId=? AND workId=? AND assignmentVersion=? LIMIT 2",
      )
      .all(taskId, assignmentId, workId, assignmentVersion) as Row[];
    if (rows.length > 1) throw Error("Review work context is ambiguous");
    if (!rows[0]) return undefined;
    const context = contextCaptureSchema.parse(
      JSON.parse(String(rows[0].recordJson)),
    );
    if (
      context.taskId !== taskId ||
      context.assignmentId !== assignmentId ||
      context.workId !== workId ||
      context.assignmentVersion !== assignmentVersion
    )
      throw Error("Review work context identity mismatch");
    return context;
  }
  indexResult(
    resultId: string,
    taskId: string,
    projectId: string,
    summary: string,
    createdAt: number,
    snapshot?: { excluded: readonly string[] | undefined },
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_review_search VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        resultId,
        taskId,
        projectId,
        "result",
        null,
        resultId,
        this.safe(summary, snapshot) ?? "",
        createdAt,
      );
  }
  async search(input: {
    query: string;
    projectId?: string | undefined;
    type?: string | undefined;
    after?: number | undefined;
    before?: number | undefined;
    historical: boolean;
    cursor?: string | undefined;
    limit: number;
  }) {
    const escaped = input.query.replace(/[\\%_]/g, "\\$&");
    const frontier = this.db
      .prepare(
        "SELECT createdAt,recordId FROM task_review_search ORDER BY createdAt DESC,recordId DESC LIMIT 1",
      )
      .get() as Row | undefined;
    if (!frontier) return [];
    let cursor = input.cursor
      ? (this.db
          .prepare(
            "SELECT createdAt,recordId FROM task_review_search WHERE recordId=?",
          )
          .get(input.cursor) as Row | undefined)
      : undefined;
    if (input.cursor && !cursor) return [];
    const matches: Row[] = [];
    while (matches.length < input.limit + 1) {
      const bounds = [cursor ? "(createdAt,recordId) > (?,?)" : "1=1"];
      const args: (string | number)[] = cursor
        ? [Number(cursor.createdAt), String(cursor.recordId)]
        : [];
      bounds.push("(createdAt,recordId) <= (?,?)");
      args.push(Number(frontier.createdAt), String(frontier.recordId));
      if (input.after !== undefined) {
        bounds.push("createdAt>=?");
        args.push(input.after);
      }
      if (input.before !== undefined) {
        bounds.push("createdAt<=?");
        args.push(input.before);
      }
      const batch = this.db
        .prepare(`WITH raw AS MATERIALIZED (
 SELECT * FROM task_review_search WHERE ${bounds.join(" AND ")}
 ORDER BY createdAt,recordId LIMIT 32
 ) SELECT s.*, CASE WHEN t.id IS NOT NULL AND s.excerpt LIKE ? ESCAPE '\\'
 AND (? IS NULL OR t.projectId=?) AND (? IS NULL OR s.type=?)
 AND (?=1 OR (s.type='task' AND s.sourceId=(SELECT sourceId FROM task_review_sources WHERE taskId=s.taskId ORDER BY revision DESC LIMIT 1)) OR (s.type<>'task' AND s.resultId=(SELECT resultId FROM coordination_results WHERE taskId=s.taskId ORDER BY createdAt DESC,rowid DESC LIMIT 1)))
 THEN 1 ELSE 0 END AS eligible FROM raw s LEFT JOIN domain_tasks t ON t.id=s.taskId ORDER BY s.createdAt,s.recordId`)
        .all(
          ...args,
          `%${escaped}%`,
          input.projectId ?? null,
          input.projectId ?? null,
          input.type ?? null,
          input.type ?? null,
          Number(input.historical),
        ) as Row[];
      for (const row of batch) {
        if (row.eligible) matches.push(row);
        if (matches.length === input.limit + 1) break;
      }
      if (batch.length < 32 || matches.length === input.limit + 1) break;
      cursor = batch.at(-1);
      await setImmediate();
    }
    return matches;
  }
  isCurrentSearchRecord(
    taskId: string,
    sourceId: string | null,
    resultId: string | null,
  ) {
    const row = resultId
      ? this.db
          .prepare(
            "SELECT resultId AS id FROM coordination_results WHERE taskId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1",
          )
          .get(taskId)
      : this.db
          .prepare(
            "SELECT sourceId AS id FROM task_review_sources WHERE taskId=? ORDER BY revision DESC LIMIT 1",
          )
          .get(taskId);
    return !!row && (row as Row).id === (resultId ?? sourceId);
  }
  sources(taskId: string) {
    return (
      this.db
        .prepare(
          "SELECT recordJson FROM task_review_sources WHERE taskId=? ORDER BY revision DESC LIMIT 128",
        )
        .all(taskId) as Row[]
    )
      .reverse()
      .map((r) => sourceSnapshotSchema.parse(JSON.parse(String(r.recordJson))));
  }
  source(taskId: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT recordJson FROM task_review_sources WHERE taskId=? AND sourceId=?",
      )
      .get(taskId, id) as Row | undefined;
    if (!row) return undefined;
    const source = sourceSnapshotSchema.parse(
      JSON.parse(String(row.recordJson)),
    );
    if (source.taskId !== taskId || source.sourceId !== id)
      throw Error("Review source identity mismatch");
    return source;
  }
  result(taskId: string, resultId: string) {
    const row = this.db
      .prepare(
        "SELECT recordJson FROM task_review_results WHERE taskId=? AND resultId=?",
      )
      .get(taskId, resultId) as Row | undefined;
    if (!row) return undefined;
    const record = resultReviewSchema.parse(JSON.parse(String(row.recordJson)));
    const actual = this.db
      .prepare(
        "SELECT taskId,assignmentId,workId,workRevision FROM coordination_results WHERE resultId=?",
      )
      .get(resultId) as Row | undefined;
    if (
      !actual ||
      actual.taskId !== taskId ||
      record.taskId !== taskId ||
      record.resultId !== resultId ||
      record.assignmentId !== actual.assignmentId ||
      record.workId !== actual.workId ||
      record.workRevision !== actual.workRevision
    )
      throw Error("Review result identity mismatch");
    return record;
  }
  private indexArtifactIdentities(record: z.infer<typeof resultReviewSchema>) {
    if (
      new Set(record.metadata.artifacts.map((a) => a.artifactId)).size !==
      record.metadata.artifacts.length
    )
      throw Error("Duplicate retained artifact identity");
    for (const artifact of record.metadata.artifacts) {
      const prior = this.db
        .prepare(
          "SELECT resultId,taskId FROM task_review_artifact_ids WHERE artifactId=?",
        )
        .get(artifact.artifactId) as Row | undefined;
      if (
        prior &&
        (prior.resultId !== record.resultId || prior.taskId !== record.taskId)
      )
        throw Error("Conflicting retained artifact identity");
      if (!prior)
        this.db
          .prepare("INSERT INTO task_review_artifact_ids VALUES(?,?,?)")
          .run(artifact.artifactId, record.resultId, record.taskId);
    }
  }
  artifactOwner(taskId: string, artifactId: string) {
    const owner = this.db
      .prepare(
        "SELECT resultId,taskId FROM task_review_artifact_ids WHERE artifactId=?",
      )
      .get(artifactId) as Row | undefined;
    if (!owner || owner.taskId !== taskId) return undefined;
    const record = this.result(taskId, String(owner.resultId));
    return record?.metadata.artifacts.filter((a) => a.artifactId === artifactId)
      .length === 1
      ? record
      : undefined;
  }
  recordResult(
    result: {
      resultId: string;
      taskId: string;
      assignmentId: string;
      workId: string;
      workRevision: number;
      assignmentVersion: number;
    },
    input: unknown,
  ) {
    const metadata = reviewMetadataSchema.parse(input);
    const snapshot = { excluded: this.exclusions() };
    if (
      new Set(metadata.criteria.map((c) => c.criterionId)).size !==
      metadata.criteria.length
    )
      throw Error("Duplicate criterion identity");
    if (metadata.sourceId && !this.source(result.taskId, metadata.sourceId))
      throw Error("Review source belongs to another task or is unavailable");
    if (metadata.sourceId) {
      const context = this.contextForWork(
        result.taskId,
        result.assignmentId,
        result.workId,
        result.assignmentVersion,
      );
      if (!context?.sourceId || context.sourceId !== metadata.sourceId)
        throw Error("Review source does not match captured work context");
    }
    const criteria =
      this.source(result.taskId, metadata.sourceId ?? "")?.criteria ?? [];
    if (
      metadata.criteria.some(
        (c) => !criteria.some((x) => x.criterionId === c.criterionId),
      )
    )
      throw Error("Review criterion anchor unavailable");
    for (const finding of metadata.changes?.findings ?? [])
      if (finding.repairAssignmentId) {
        const a = this.db
          .prepare("SELECT taskId FROM domain_assignments WHERE id=?")
          .get(finding.repairAssignmentId) as Row | undefined;
        if (a?.taskId !== result.taskId)
          throw Error("Repair assignment belongs to another task");
      }
    if (
      new Set(metadata.artifacts.map((a) => a.artifactId)).size !==
      metadata.artifacts.length
    )
      throw Error("Duplicate artifact identity");
    for (const artifact of metadata.artifacts) {
      if (
        artifact.file &&
        (/(^|[\\/])\.\.([\\/]|$)/.test(artifact.file.relativePath) ||
          artifact.file.relativePath.startsWith("/") ||
          artifact.file.relativePath.includes("\\"))
      )
        throw Error("Unsafe artifact path");
      if (
        this.db
          .prepare("SELECT 1 FROM task_review_artifact_ids WHERE artifactId=?")
          .get(artifact.artifactId)
      )
        throw Error("Artifact identity already recorded");
    }
    if (
      metadata.changes?.reference &&
      !["http:", "https:"].includes(
        new URL(metadata.changes.reference).protocol,
      )
    )
      throw Error("Unsupported recorded change reference protocol");
    // Validate supplied prose and paths, not structural enums/identities.
    const suppliedText = [
      ...metadata.criteria.flatMap((c) => [c.scope, c.provenance]),
      ...metadata.validations.flatMap((v) => [v.label, v.scope, v.provenance]),
      ...metadata.artifacts.flatMap((a) => [
        a.label,
        a.url,
        a.file?.relativePath,
      ]),
      ...(metadata.changes?.files ?? []),
      metadata.changes?.diff,
      metadata.changes?.reference,
      ...(metadata.changes?.findings.map((f) => f.finding) ?? []),
      ...metadata.decisions.flatMap((d) => [d.text, d.attribution]),
    ];
    if (
      suppliedText.some(
        (value) => value !== undefined && this.safe(value, snapshot) !== value,
      )
    )
      throw Error("Review metadata contains excluded material");
    const record = resultReviewSchema.parse({
      resultId: result.resultId,
      taskId: result.taskId,
      assignmentId: result.assignmentId,
      workId: result.workId,
      workRevision: result.workRevision,
      metadata,
    });
    this.db
      .prepare("INSERT INTO task_review_results VALUES(?,?,?)")
      .run(result.resultId, result.taskId, JSON.stringify(record));
    this.indexArtifactIdentities(record);
    const row = this.db
      .prepare(
        "SELECT projectId,summary,createdAt FROM coordination_results JOIN domain_tasks ON coordination_results.taskId=domain_tasks.id WHERE resultId=?",
      )
      .get(result.resultId) as Row;
    this.indexResult(
      result.resultId,
      result.taskId,
      String(row.projectId),
      this.safe(String(row.summary), snapshot) ?? "",
      Number(row.createdAt) * 1000,
      snapshot,
    );
    metadata.decisions.forEach((decision, index) => {
      this.db
        .prepare("INSERT INTO task_review_search VALUES(?,?,?,?,?,?,?,?)")
        .run(
          `${result.resultId}:decision:${index}`,
          result.taskId,
          String(row.projectId),
          "decision",
          metadata.sourceId ?? null,
          result.resultId,
          `${decision.attribution}: ${decision.text}`.slice(0, 16000),
          Number(row.createdAt) * 1000,
        );
    });
  }
  read(
    taskId: string,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    for (const [field, table] of [
      ["resultId", "coordination_results"],
      ["sourceId", "task_review_sources"],
    ] as const) {
      const id = selection[field];
      if (!id) continue;
      uuid.parse(id);
      const actual = this.db
        .prepare(`SELECT taskId FROM ${table} WHERE ${field}=?`)
        .get(id) as Row | undefined;
      if (actual && actual.taskId !== taskId)
        throw Error("Review selected anchor belongs to another task");
    }
    const result = selection.resultId
      ? this.result(taskId, selection.resultId)
      : undefined;
    const actualResult = selection.resultId
      ? (this.db
          .prepare(
            "SELECT taskId,assignmentId,workId,workRevision,assignmentVersion FROM coordination_results WHERE resultId=? AND taskId=?",
          )
          .get(selection.resultId, taskId) as Row | undefined)
      : undefined;
    const context = actualResult
      ? this.contextForWork(
          taskId,
          String(actualResult.assignmentId),
          String(actualResult.workId),
          Number(actualResult.assignmentVersion),
        )
      : undefined;
    if (
      result?.metadata.sourceId &&
      context &&
      context.sourceId !== result.metadata.sourceId
    )
      throw Error("Review captured source identity mismatch");
    const sourceIds = [
      ...new Set(
        [
          selection.sourceId,
          result?.metadata.sourceId,
          context?.sourceId,
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const sourcePins = sourceIds.flatMap((id) => {
      const source = this.source(taskId, id);
      return source ? [source.sourceId] : [];
    });
    const rows = (
      table: string,
      key: string,
      limit: number,
      ids: string[],
      order = "rowid",
    ) =>
      (
        this.db
          .prepare(
            `SELECT ${order} AS ordering,recordJson FROM ${table} WHERE taskId=? ORDER BY CASE WHEN ${key} IN (${ids.map(() => "?").join(",") || "NULL"}) THEN 1 ELSE 0 END DESC,${order} DESC LIMIT ?`,
          )
          .all(taskId, ...ids, limit) as Row[]
      ).sort((a, b) => Number(a.ordering) - Number(b.ordering));
    const contexts = rows(
      "task_review_contexts",
      "captureId",
      256,
      context ? [context.captureId] : [],
    ).map((r) => contextCaptureSchema.parse(JSON.parse(String(r.recordJson))));
    const contextCount = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_review_contexts WHERE taskId=?",
          )
          .get(taskId) as Row
      ).count,
    );
    return taskReviewReadSchema.parse({
      contextsOmittedCount:
        contextCount - new Set(contexts.map((c) => c.captureId)).size,
      sources: rows(
        "task_review_sources",
        "sourceId",
        128,
        sourcePins,
        "revision",
      ).map((r) =>
        sourceSnapshotSchema.parse(JSON.parse(String(r.recordJson))),
      ),
      contexts,
      results: rows(
        "task_review_results",
        "resultId",
        128,
        result ? [result.resultId] : [],
      ).map((r) => resultReviewSchema.parse(JSON.parse(String(r.recordJson)))),
      viewed: (() => {
        const r = this.db
          .prepare("SELECT recordJson FROM task_review_viewed WHERE taskId=?")
          .get(taskId) as Row | undefined;
        return r ? JSON.parse(String(r.recordJson)) : null;
      })(),
      coverage: "retained-records-only",
    });
  }
  validateReference(taskId: string, input: unknown) {
    const ref = feedbackReferenceSchema.parse(input);
    if (ref.sourceId && !this.source(taskId, ref.sourceId))
      throw Error("Feedback source unavailable");
    const artifactOwner = ref.artifactId
      ? this.artifactOwner(taskId, ref.artifactId)
      : undefined;
    if (ref.artifactId && !artifactOwner)
      throw Error("Feedback artifact unavailable");
    if (
      ref.resultId &&
      artifactOwner &&
      artifactOwner.resultId !== ref.resultId
    )
      throw Error("Feedback artifact does not match result");
    const ownerId = ref.resultId ?? artifactOwner?.resultId;
    const actual = ownerId
      ? (this.db
          .prepare(
            "SELECT taskId,workId FROM coordination_results WHERE resultId=?",
          )
          .get(ownerId) as Row | undefined)
      : undefined;
    if (ownerId && actual?.taskId !== taskId)
      throw Error("Feedback result unavailable");
    const linked = ownerId ? this.result(taskId, ownerId) : undefined;
    if (ownerId && ref.sourceId && linked?.metadata.sourceId !== ref.sourceId)
      throw Error("Feedback source does not match result");
    if (ref.workId && (!actual || actual.workId !== ref.workId))
      throw Error("Feedback work unavailable");
    if (ref.criterionId) {
      const sources = this.db
        .prepare(
          "SELECT DISTINCT s.sourceId FROM task_review_sources s, json_each(s.recordJson,'$.criteria') c WHERE s.taskId=? AND json_extract(c.value,'$.criterionId')=? LIMIT 2",
        )
        .all(taskId, ref.criterionId) as Row[];
      if (sources.length !== 1) throw Error("Feedback criterion unavailable");
      const criterionSourceId = String(sources[0]?.sourceId);
      if (ref.sourceId && criterionSourceId !== ref.sourceId)
        throw Error("Feedback criterion unavailable");
      if (ownerId && criterionSourceId !== linked?.metadata.sourceId)
        throw Error("Feedback criterion does not match result");
      if (
        !this.source(taskId, criterionSourceId)?.criteria.some(
          (c) => c.criterionId === ref.criterionId,
        )
      )
        throw Error("Feedback criterion unavailable");
    }
    return ref;
  }
  recordViewed(
    taskId: string,
    key: string,
    sourceId: string | null,
    resultIds: string[],
  ) {
    uuid.parse(key);
    if (sourceId && !this.source(taskId, sourceId))
      throw Error("Viewed source unavailable");
    for (const id of resultIds) {
      const r = this.db
        .prepare("SELECT taskId FROM coordination_results WHERE resultId=?")
        .get(id) as Row | undefined;
      if (r?.taskId !== taskId) throw Error("Viewed result unavailable");
    }
    const material = JSON.stringify({ taskId, sourceId, resultIds });
    transaction(this.db, () => {
      const prior = this.db
        .prepare("SELECT material FROM task_review_view_receipts WHERE key=?")
        .get(key) as Row | undefined;
      if (prior) {
        if (prior.material !== material) throw Error("Viewing key reused");
      } else {
        this.db
          .prepare(
            "INSERT INTO task_review_viewed VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET recordJson=excluded.recordJson",
          )
          .run(
            taskId,
            JSON.stringify({ sourceId, resultIds, viewedAt: Date.now() }),
          );
        this.db
          .prepare("INSERT INTO task_review_view_receipts VALUES(?,?)")
          .run(key, material);
      }
    });
  }
}
