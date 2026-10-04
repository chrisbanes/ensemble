import type { OperatorCommentReview } from "../core/delivery.js";
import { previewRecordedArtifact, ArtifactUnavailable } from "./task-review.js";
import { taskReviewReadSchema } from "../core/task-review.js";
import type { CoordinationView } from "./coordination-view.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  DomainCommands,
  DomainConflictError,
  DomainPolicyError,
} from "../core/domain.js";
import type {
  CoordinationInteraction,
  TaskCompletionRequest,
} from "../core/coordination.js";
import {
  runtimeSettingsSchema,
  assignmentRecoverySchema,
  recoveryObservationSchema,
  sourceObservationSchema,
  projectConfigurationSchema,
  profileConfigurationSchema,
  taskListPageSchema,
  taskListQuerySchema,
  composerOptionsSchema,
  admissionSchema,
  assignmentHistorySchema,
  commandReceiptSchema,
  materialSchema,
  operatorCommandSchema,
  projectSchema,
  taskSchema,
  reviewReadSchema,
  searchQuerySchema,
  searchReadSchema,
  deliveryReadSchema,
  uuid,
  workspaceSchema,
  type Execution,
} from "../operator/contracts.js";
import {
  GitHubHttpSourceReader,
  type GitHubSourceReader,
} from "./github-source.js";
import type { StandaloneService } from "./service.js";
import {
  sanitizeConversationText,
  type ConversationHistoryBinding,
} from "./conversation-history.js";
type Row =
  ReturnType<StandaloneService["domain"]> extends { task(id: string): infer R }
    ? R
    : never;
export class OperatorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "not-found"
      | "invalid-input"
      | "forbidden"
      | "conflict"
      | "unavailable"
      | "command-outcome-unknown",
    readonly fieldPaths?: readonly string[],
  ) {
    super(code);
  }
}
const conflicts = new Set([
  "Operator command key reused with different content",
  "Interaction is not open for this response",
  "Interaction revision conflict",
  "Approval material does not match the requested revision",
  "Legacy approval material is unavailable and cannot be approved",
  "Message recipient assignment version conflict",
  "Message recipient must be pending or running",
  "Result destination is already reconciled",
  "Result destination revision conflict",
]);
export class OperatorApi {
  private readonly commands: DomainCommands;
  constructor(
    private readonly service: StandaloneService,
    private readonly controlPaths: readonly string[] = [],
    private readonly coordination: () => CoordinationView = () =>
      service.coordinationView(),
    private readonly previewReader: (
      credentialRef: string,
    ) => Pick<GitHubSourceReader, "readSelection"> = (ref) =>
      new GitHubHttpSourceReader(process.env[ref.slice(4)]),
  ) {
    this.commands = new DomainCommands(service.domain());
  }
  private visibilityToken() {
    const d = this.domain();
    return createHash("sha256")
      .update(
        JSON.stringify({
          profiles: d.profiles().map((p) => [p.id, p.version, p.revoked]),
          projects: d
            .projects()
            .map((p) => [
              p.id,
              p.version,
              p.instructionsRevision,
              d.githubConfiguration(String(p.id)).version,
              d.routing(String(p.id)).version,
              this.service.delivery().configuration(String(p.id)).version,
            ]),
          credentials: Object.entries(process.env).filter(([key]) =>
            /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(key),
          ),
        }),
      )
      .digest("hex");
  }
  private domain() {
    return this.service.domain();
  }
  private requireProject(id: string) {
    uuid.parse(id);
    if (
      !this.domain()
        .projects()
        .some((p) => p.id === id)
    )
      throw new OperatorApiError(404, "not-found");
    return this.domain().project(id);
  }
  private requireTask(id: string) {
    uuid.parse(id);
    for (const p of this.domain().projects())
      if (
        this.domain()
          .tasks(String(p.id))
          .some((t) => t.id === id)
      )
        return this.domain().task(id);
    throw new OperatorApiError(404, "not-found");
  }
  private async exclusions(
    projectId?: string,
    taskId?: string,
    historyBindings: readonly ConversationHistoryBinding[] = [],
  ): Promise<string[] | undefined> {
    try {
      const d = this.domain(),
        profiles = d.profiles(),
        projects = d.projects();
      const values = [...this.controlPaths],
        covered = new Set<string>();
      // Bound retained-revision lookups before iterating persisted counters.
      let remaining = 128;
      if (profiles.length + projects.length > remaining) return undefined;
      for (const profile of profiles) {
        const count = Number(profile.version);
        if (!Number.isSafeInteger(count) || count < 1 || count > remaining)
          return undefined;
        remaining -= count;
        for (let revision = 1; revision <= count; revision++) {
          values.push(
            String(
              d.profileRevision(String(profile.id), revision).instructions,
            ),
          );
          covered.add(`profile:${profile.id}:${revision}`);
        }
      }
      for (const project of projects) {
        const id = String(project.id),
          count = Number(project.instructionsRevision);
        if (!Number.isSafeInteger(count) || count < 1 || count > remaining)
          return undefined;
        remaining -= count;
        for (let revision = 1; revision <= count; revision++) {
          values.push(d.instructionRevision(id, revision));
          covered.add(`project:${id}:${revision}`);
        }
        const g = d.githubConfiguration(id);
        for (const ref of [
          d.routingCredentialReference(id),
          g.credentialRef,
          d.deliveryCredentialReference(id),
        ])
          if (ref) {
            const envKey = ref.slice(4);
            values.push(ref, envKey);
            const value = process.env[envKey];
            if (value) values.push(value);
          }
        if (g.repositories.length > 128) return undefined;
        for (const repo of g.repositories)
          values.push(repo.path, repo.gitCommonDirectory);
      }
      if (taskId) {
        const requests = this.service.turnRequests(),
          recovery = this.service.recoveryView(),
          assignments = d.assignments(taskId);
        if (
          requests.length > 128 ||
          recovery.length > 128 ||
          assignments.length > 128 ||
          historyBindings.length > 400
        )
          return undefined;
        const retained = [
          ...requests.filter((r) => r.taskId === taskId),
          ...recovery.flatMap((r) =>
            r.binding?.taskId === taskId ? [r.binding] : [],
          ),
          ...historyBindings,
        ];
        const assignmentIds = new Set(assignments.map((a) => String(a.id)));
        if (
          retained.some(
            (r) =>
              r.assignmentId === null || !assignmentIds.has(r.assignmentId),
          )
        )
          return undefined;
        for (const a of assignments) {
          for (const snapshot of [
            a,
            ...retained.filter((r) => r.assignmentId === a.id),
          ]) {
            // Missing or inconsistent captured revisions cannot be ignored.
            if (
              !covered.has(
                `project:${projectId}:${snapshot.instructionsRevision}`,
              ) ||
              !covered.has(`profile:${a.profileId}:${snapshot.profileRevision}`)
            )
              return undefined;
          }
        }
        const workspace = await this.service.taskWorkspace(taskId);
        if (workspace) {
          values.push(workspace.path);
          for (const repo of workspace.repositories)
            values.push(
              repo.sourcePath,
              repo.workspacePath,
              ...(repo.gitCommonDir ? [repo.gitCommonDir] : []),
            );
        }
      }
      return [...new Set(values.filter(Boolean))];
    } catch {
      return undefined;
    }
  }
  private safe(
    value: unknown,
    excluded: readonly string[] | undefined,
  ): string | null {
    if (value === null || value === undefined) return null;
    const prose = String(value);
    if (prose.length > 16000) return null;
    const sanitized = excluded
      ? sanitizeConversationText(prose, excluded)
      : null;
    return sanitized && sanitized.length > 16000 ? null : (sanitized ?? null);
  }
  private exact(value: unknown, excluded: readonly string[] | undefined) {
    const safe = this.safe(value, excluded);
    return safe === String(value) ? safe : null;
  }
  private project(row: Row, excluded: readonly string[] | undefined) {
    return {
      id: String(row.id),
      name: this.safe(row.name, excluded),
      version: Number(row.version),
      paused: Boolean(row.paused),
      leadProfileId:
        row.leadProfileId === null ? null : String(row.leadProfileId),
    };
  }
  private profiles(excluded: readonly string[] | undefined) {
    return this.domain()
      .profiles()
      .map((p) => ({
        id: String(p.id),
        name: this.safe(p.name, excluded),
        version: Number(p.version),
        revoked: Boolean(p.revoked),
      }));
  }
  async readWorkspace() {
    const excluded = await this.exclusions();
    return workspaceSchema.parse({
      data: {
        projects: this.domain()
          .projects()
          .map((p) => this.project(p, excluded)),
        profiles: this.profiles(excluded),
      },
      observedAt: Date.now(),
    });
  }
  private selection(a: Row) {
    const requests = this.service
      .turnRequests()
      .filter((r) => r.assignmentId === a.id);
    const latest = (rows: typeof requests) =>
      rows.reduce<(typeof requests)[number] | undefined>(
        (old, r) => (!old || r.sequence > old.sequence ? r : old),
        undefined,
      );
    const request =
      latest(requests.filter((r) => r.state === "active")) ??
      latest(requests.filter((r) => r.assignmentVersion === Number(a.version)));
    const recovery = this.service
      .recoveryView()
      .filter(
        (r) =>
          r.binding?.assignmentId === a.id &&
          r.binding?.assignmentVersion ===
            (request?.assignmentVersion ?? Number(a.version)),
      );
    const record = request
      ? recovery.find((r) => r.workId === request.workId)
      : recovery.sort(
          (x, y) => y.generation.requestSequence - x.generation.requestSequence,
        )[0];
    const intent = request
      ? this.service.list().find((i) => i.workId === request.workId)
      : undefined;
    return { request, record, intent };
  }
  private execution(task: Row): Execution {
    const selections = this.domain()
      .assignments(String(task.id))
      .map((a) => this.selection(a));
    const holds = {
      stop:
        this.service.taskHold(String(task.id)) === "Task stopped" ||
        selections.some((s) => s.record?.holds.stop),
      writer: selections.some((s) => s.record?.holds.writer),
      capacity: selections.some((s) => s.record?.holds.capacity),
      uncertainty: selections.some((s) => s.record?.holds.uncertainty),
      task:
        Boolean(this.service.taskHold(String(task.id))) ||
        selections.some((s) => s.record?.holds.task),
    };
    let state: Execution["state"] = "idle";
    const reasonCodes: Execution["reasonCodes"] = [];
    if (holds.stop) state = "stopping";
    else if (
      holds.uncertainty ||
      holds.task ||
      selections.some((s) => s.request?.state === "held") ||
      selections.some(
        (s) =>
          (s.record?.holds.writer || s.record?.holds.capacity) &&
          !(
            s.request?.state === "active" &&
            ["running", "submitting"].includes(s.intent?.state ?? "")
          ),
      )
    ) {
      state = "uncertain";
      reasonCodes.push(holds.task ? "task-held" : "recovery-held");
    } else if (
      selections.some(
        (s) => s.request?.state === "active" && s.intent?.state === "running",
      )
    )
      state = "running";
    else if (
      selections.some(
        (s) =>
          s.request?.state === "active" && s.intent?.state === "submitting",
      )
    )
      state = "starting";
    else if (selections.some((s) => s.request?.state === "active")) {
      state = "uncertain";
      reasonCodes.push("runtime-unconfirmed");
    } else if (task.state === "done") state = "completed";
    else if (task.state === "cancelled") state = "cancelled";
    else if (this.domain().project(String(task.projectId)).paused) {
      state = "paused";
      reasonCodes.push("project-paused");
    } else if (!this.domain().admission(String(task.id)).eligible) {
      state = "waiting";
      reasonCodes.push("admission-blocked");
    } else if (selections.some((s) => s.request?.state === "queued"))
      state = "queued";
    else if (
      this.domain()
        .assignments(String(task.id))
        .some((a) => a.state === "pending")
    )
      state = "selected";
    else {
      const view = this.coordination().readTask(String(task.id));
      if (
        [...view.questions, ...view.approvals].some((i) => i.status === "open")
      )
        state = "waiting";
    }
    return { state, reasonCodes, holds };
  }
  private identity(taskId: string) {
    const imported = this.domain().importedTask(taskId);
    return imported
      ? {
          provider: "github.com" as const,
          nodeId: String(imported.nodeId),
          repositoryId: String(imported.repositoryId),
        }
      : null;
  }
  async readProject(projectId: string) {
    const p = this.requireProject(projectId),
      excluded = await this.exclusions(projectId);
    return projectSchema.parse({
      data: {
        project: this.project(p, excluded),
        profiles: this.profiles(excluded),
        tasks: await Promise.all(
          this.domain()
            .tasks(projectId)
            .map(async (t) => ({
              id: String(t.id),
              projectId,
              title: this.safe(
                t.title,
                await this.exclusions(projectId, String(t.id)),
              ),
              version: Number(t.version),
              state: t.state,
              ready: Boolean(t.ready),
              execution: this.execution(t),
              sourceIdentity: this.identity(String(t.id)),
            })),
        ),
      },
      observedAt: Date.now(),
    });
  }
  private capacity(projectId: string) {
    const c = this.domain().capacityLimits([projectId]);
    return {
      globalUsage: c.currentUsage.global,
      globalLimit: c.globalLimit,
      projectUsage: c.currentUsage.projects[projectId] ?? 0,
      projectLimit:
        c.effectiveProjectLimits[projectId] ?? c.defaultProjectLimit,
    };
  }
  private admission(taskId: string) {
    const a = this.domain().admission(taskId);
    return {
      eligible: a.eligible,
      reasons: a.reasons.map((r) =>
        admissionSchema.shape.reasons.element.safeParse(r).success
          ? r
          : r.startsWith("source-")
            ? "source-held"
            : "admission-blocked",
      ),
    };
  }
  private taskLead(task: Row, excluded: readonly string[] | undefined) {
    const d = this.domain(),
      projectId = String(task.projectId);
    const binding = d
      .leadBindings()
      .find((b) => b.taskId === task.id && b.projectId === projectId);
    if (binding) {
      let name: string | null = null;
      try {
        name = this.safe(
          d.profileRevision(
            String(binding.profileId),
            Number(binding.profileRevision),
          ).name,
          excluded,
        );
      } catch {}
      return { profileId: String(binding.profileId), name };
    }
    const project = d.project(projectId);
    if (!project.leadProfileId) return null;
    let name: string | null = null;
    try {
      name = this.safe(d.profile(String(project.leadProfileId)).name, excluded);
    } catch {}
    return { profileId: String(project.leadProfileId), name };
  }
  private sourceSummary(
    taskId: string,
    excluded: readonly string[] | undefined,
  ) {
    const identity = this.identity(taskId);
    if (!identity) return null;
    const issue = this.service.githubSources().issue(identity.nodeId);
    const rawName = issue?.repositoryName;
    const repositoryName =
      rawName &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(rawName)) &&
      this.safe(rawName, excluded) === rawName
        ? String(rawName)
        : null;
    const number =
      issue &&
      Number.isSafeInteger(Number(issue.issueNumber)) &&
      Number(issue.issueNumber) > 0
        ? Number(issue.issueNumber)
        : null;
    return {
      identity,
      repositoryName,
      number,
      url:
        repositoryName && number
          ? `https://github.com/${repositoryName}/issues/${number}`
          : null,
      state: issue?.observedState ?? null,
    };
  }
  private async taskSummary(taskId: string) {
    const d = this.domain(),
      task = d.task(taskId),
      projectId = String(task.projectId),
      excluded = await this.exclusions(projectId, taskId),
      view = this.coordination().readTask(taskId),
      execution = this.execution(task),
      assignments = d.assignments(taskId);
    const codes: string[] = [];
    let count = 0;
    const add = (code: string, n: number) => {
      if (n) {
        codes.push(code);
        count += n;
      }
    };
    add("question", view.questions.filter((i) => i.status === "open").length);
    add("approval", view.approvals.filter((i) => i.status === "open").length);
    add("unresolved-result", view.unresolvedResults.length);
    add(
      "completion-rejected",
      view.completionRequests.filter(
        (c) =>
          c.status === "rejected" && c.taskVersion === Number(task.version),
      ).length,
    );
    const uncertain =
      execution.holds.uncertainty ||
      (this.service.taskHold(taskId) !== undefined &&
        this.service.taskHold(taskId) !== "Task stopped") ||
      assignments.some((a) => {
        const s = this.selection(a);
        const confirmed =
          s.request?.state === "active" &&
          ["running", "submitting"].includes(s.intent?.state ?? "");
        return (
          s.request?.state === "held" ||
          (s.request?.state === "active" && !confirmed) ||
          Boolean(
            (s.record?.holds.writer || s.record?.holds.capacity) && !confirmed,
          )
        );
      });
    add("execution-uncertain", uncertain ? 1 : 0);
    add(
      "lead-review",
      assignments.length === 0 &&
        view.routing.attempts.some(
          (a) =>
            a.taskVersion === Number(task.version) &&
            a.status === "lead-review",
        )
        ? 1
        : 0,
    );
    return {
      id: taskId,
      projectId,
      title: this.safe(task.title, excluded),
      version: Number(task.version),
      state: task.state,
      ready: Boolean(task.ready),
      project: this.project(d.project(projectId), excluded),
      lead: this.taskLead(task, excluded),
      execution,
      admission: this.admission(taskId),
      capacity: this.capacity(projectId),
      source: this.sourceSummary(taskId, excluded),
      attention: { codes, count },
    };
  }
  async readTaskListPage(params = new URLSearchParams()) {
    const values: Record<string, string> = {};
    for (const [key, value] of params) {
      if (key in values) throw new OperatorApiError(400, "invalid-input");
      values[key] = value;
    }
    const query = taskListQuerySchema.parse(values),
      catalog = this.domain().taskCatalog();
    if (catalog.length > 10000) throw new OperatorApiError(503, "unavailable");
    const catalogFingerprint = createHash("sha256")
      .update(JSON.stringify(catalog.map((t) => [t.id, t.projectId])))
      .digest("hex");
    const index = query.cursor
      ? catalog.findIndex((t) => t.id === query.cursor)
      : -1;
    if (query.cursor && index < 0)
      throw new OperatorApiError(400, "invalid-input");
    const page = catalog.slice(index + 1, index + 1 + query.limit);
    return taskListPageSchema.parse({
      data: {
        tasks: await Promise.all(page.map((t) => this.taskSummary(t.id))),
        nextCursor:
          index + 1 + page.length < catalog.length
            ? (page.at(-1)?.id ?? null)
            : null,
        catalogFingerprint,
      },
      observedAt: Date.now(),
    });
  }
  async readComposerOptions(projectId: string) {
    const p = this.requireProject(projectId),
      d = this.domain(),
      catalog = d.taskCatalog();
    if (catalog.length > 10000) throw new OperatorApiError(503, "unavailable");
    const excluded = await this.exclusions(projectId);
    const permitted = new Set(
      d.routingCandidates(projectId).map((p) => String(p.profileId)),
    );
    if (p.leadProfileId) permitted.add(String(p.leadProfileId));
    const profiles = this.profiles(excluded).filter(
      (p) => !p.revoked && permitted.has(p.id),
    );
    const lead = p.leadProfileId
      ? {
          profileId: String(p.leadProfileId),
          name: this.safe(d.profile(String(p.leadProfileId)).name, excluded),
        }
      : null;
    const dependencies = await Promise.all(
      catalog
        .filter((t) => t.projectId === projectId)
        .map(async (t) => {
          const row = d.task(t.id),
            safe = await this.exclusions(projectId, t.id);
          return {
            id: t.id,
            title: this.safe(row.title, safe),
            state: row.state,
            source: this.sourceSummary(t.id, safe),
          };
        }),
    );
    return composerOptionsSchema.parse({
      data: {
        project: this.project(p, excluded),
        lead,
        profiles,
        dependencies,
        capacity: this.capacity(projectId),
        routingEnabled: Boolean(d.routing(projectId).enabled),
      },
      observedAt: Date.now(),
    });
  }
  private interaction(
    i: CoordinationInteraction,
    excluded: readonly string[] | undefined,
  ) {
    let material = null;
    let materialUnavailable = i.kind === "approval";
    if (i.materialJson !== null && excluded) {
      try {
        const parsed = materialSchema.parse(JSON.parse(i.materialJson));
        if (this.safe(i.materialJson, excluded) === i.materialJson) {
          material = parsed;
          materialUnavailable = false;
        }
      } catch {}
    }
    return {
      interactionId: i.interactionId,
      taskId: i.taskId,
      requestingAssignmentId: i.requestingAssignmentId,
      requestingWorkId: i.requestingWorkId,
      requestingWorkRevision: i.requestingWorkRevision,
      requestingAssignmentVersion: i.requestingAssignmentVersion,
      conversationRevision: i.conversationRevision,
      kind: i.kind,
      status: i.status,
      prompt: this.safe(i.prompt, excluded),
      action: this.safe(i.action, excluded),
      target: this.safe(i.target, excluded),
      materialHash: i.materialHash,
      material,
      approvable:
        i.kind === "approval" &&
        !materialUnavailable &&
        this.safe(i.action, excluded) === i.action &&
        this.safe(i.target, excluded) === i.target,
      materialUnavailable,
      response: this.safe(i.response, excluded),
      revision: i.revision,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }
  private completion(c: TaskCompletionRequest) {
    return {
      requestId: c.requestId,
      taskId: c.taskId,
      leadAssignmentId: c.leadAssignmentId,
      leadWorkId: c.leadWorkId,
      leadWorkRevision: c.leadWorkRevision,
      taskVersion: c.taskVersion,
      reviewedResultIds: c.reviewedResultIds,
      status: c.status,
      rejectionReasons: c.rejectionReasons.map(() => "completion-rejected"),
      revision: c.revision,
      createdAt: c.createdAt,
      finalizedAt: c.finalizedAt,
    };
  }
  async readTask(
    taskId: string,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    const visibility = this.visibilityToken();
    const t = this.requireTask(taskId),
      projectId = String(t.projectId),
      d = this.domain(),
      p = d.project(projectId),
      excluded = await this.exclusions(projectId, taskId),
      view = this.coordination().readTask(taskId),
      assignments = d.assignments(taskId),
      lead = d
        .leadBindings()
        .find((b) => b.taskId === taskId && b.projectId === projectId);
    const profile = p.leadProfileId ? d.profile(String(p.leadProfileId)) : null;
    const identity = this.identity(taskId),
      issue = identity
        ? this.service.githubSources().issue(identity.nodeId)
        : undefined;
    const messages = view.messages.map((m) => ({
      eventId: m.eventId,
      eventType: m.eventType,
      recipientAssignmentId: m.recipientAssignmentId,
      deliveryState: m.deliveryState,
      createdAt: m.createdAt,
      ...(m.text === undefined ? {} : { text: this.safe(m.text, excluded) }),
      ...(m.decision === undefined ? {} : { decision: m.decision }),
      ...(m.action === undefined
        ? {}
        : { action: this.safe(m.action, excluded) }),
      ...(m.target === undefined
        ? {}
        : { target: this.safe(m.target, excluded) }),
      ...(m.resultId === undefined ? {} : { resultId: m.resultId }),
      ...(m.routingOperationId === undefined
        ? {}
        : { routingOperationId: m.routingOperationId }),
      ...(m.routingReason === undefined
        ? {}
        : { routingReason: this.safe(m.routingReason, excluded) }),
      ...(m.reference ? { reference: m.reference } : {}),
      ...(m.interactionId === undefined
        ? {}
        : { interactionId: m.interactionId }),
    }));
    const data = {
      task: {
        id: taskId,
        projectId,
        title: this.safe(t.title, excluded),
        outcome: this.safe(t.outcome, excluded),
        version: Number(t.version),
        state: t.state,
        ready: Boolean(t.ready),
      },
      lead: profile
        ? {
            profileId: String(profile.id),
            name: this.safe(profile.name, excluded),
          }
        : null,
      leadAssignmentId:
        this.domain()
          .leadBindings()
          .find((b) => String(b.taskId) === taskId)?.assignmentId ?? null,
      assignments: assignments.map((a) => {
        const s = this.selection(a),
          request = s.request;
        return {
          assignmentId: String(a.id),
          profileId: String(a.profileId),
          name: this.safe(d.profile(String(a.profileId)).name, excluded),
          brief: this.safe(a.brief, excluded),
          requesterAssignmentId: a.requesterAssignmentId
            ? String(a.requesterAssignmentId)
            : null,
          resultDestination: this.safe(a.resultDestination, excluded),
          resultRecipientAssignmentId: a.resultRecipientAssignmentId
            ? String(a.resultRecipientAssignmentId)
            : null,
          resultRecipientDisposition: this.safe(
            a.resultRecipientDisposition,
            excluded,
          ),
          waitReason: this.safe(
            s.intent?.reason ??
              (d.assignmentAdmission(String(a.id)).reasons.join("; ") || null),
            excluded,
          ),
          version: Number(a.version),
          state: a.state,
          profileRevision: Number(a.profileRevision),
          instructionsRevision: Number(a.instructionsRevision),
          currentProfileRevision: Number(
            d.profile(String(a.profileId)).version,
          ),
          currentInstructionsRevision: Number(p.instructionsRevision),
          executionGeneration:
            request?.assignmentVersion &&
            request.instructionsRevision &&
            request.profileRevision
              ? {
                  workId: request.workId,
                  assignmentVersion: request.assignmentVersion,
                  requestSequence: request.sequence,
                  instructionsRevision: request.instructionsRevision,
                  profileRevision: request.profileRevision,
                }
              : null,
        };
      }),
      admission: {
        eligible: d.admission(taskId).eligible,
        reasons: d
          .admission(taskId)
          .reasons.map((r) =>
            [
              "project-paused",
              "project-lead-unconfigured",
              "project-lead-revoked",
              "task-unready",
              "task-not-open",
              "local-dependency",
              "imported-blockers-unknown",
              "imported-blockers-blocked",
            ].includes(r)
              ? r
              : "admission-blocked",
          ),
      },
      execution: this.execution(t),
      localDependencies: d.dependencies(taskId).map((id) => {
        const b = d.task(id);
        return { id, title: this.safe(b.title, excluded), state: b.state };
      }),
      source: identity
        ? this.source(identity, issue, projectId, excluded)
        : null,
      messages,
      results: view.results.map((r) => ({
        resultId: r.resultId,
        taskId: r.taskId,
        assignmentId: r.assignmentId,
        workId: r.workId,
        workRevision: r.workRevision,
        assignmentVersion: r.assignmentVersion,
        summary: this.safe(r.summary, excluded),
        recipientAssignmentId: r.recipientAssignmentId,
        destinationDisposition: r.destinationDisposition,
        createdAt: r.createdAt,
      })),
      unresolvedResults: view.unresolvedResults.map((u) => {
        const a = assignments.find((a) => a.id === u.assignmentId);
        const desired =
          a?.requesterAssignmentId ??
          (assignments.some((b) => b.id === a?.resultDestination)
            ? a?.resultDestination
            : lead?.assignmentId);
        const recipient = assignments.find((b) => b.id === desired);
        const retained = lead?.assignmentId === desired ? lead : undefined;
        const permitted = recipient ?? retained;
        return {
          resultId: u.resultId,
          taskId: u.taskId,
          assignmentId: u.assignmentId,
          revision: u.revision,
          reasonCode: "unresolved-destination",
          permittedRecipient: permitted
            ? {
                assignmentId: String(desired),
                name: this.safe(
                  d.profile(String(permitted.profileId)).name,
                  excluded,
                ),
              }
            : null,
          availability: permitted ? "available" : "recipient-unavailable",
        };
      }),
      questions: view.questions.map((i) => this.interaction(i, excluded)),
      approvals: view.approvals.map((i) => this.interaction(i, excluded)),
      completionRequests: view.completionRequests.map((c) =>
        this.completion(c),
      ),
      attention: {
        interactions: view.attention.interactions.map((a) => ({
          attentionId: a.attentionId,
          interactionId: a.interactionId,
          status: a.status,
          revision: a.revision,
          createdAt: a.createdAt,
          resolvedAt: a.resolvedAt,
        })),
        completions: view.attention.completions.map((c) => ({
          requestId: c.requestId,
          status: c.status,
          revision: c.revision,
        })),
        routingFallbacks: view.attention.routingFallbacks.map((f) => ({
          eventId: f.eventId,
          operationId: f.operationId,
          reasonCode: "routing-fallback",
          createdAt: f.createdAt,
        })),
      },
      review: await this.reviewProjection(taskId, excluded, selection),
      delivery: this.deliveryProjection(taskId, excluded),
      commentPolicy: this.commentPolicy(taskId),
      contentUnavailable:
        excluded === undefined ||
        [
          t.title,
          t.outcome,
          issue?.observedBody,
          issue?.observedTitle,
          ...view.messages.map((m) => m.text),
          ...view.results.map((r) => r.summary),
          ...view.questions.map((i) => i.prompt),
          ...view.approvals.map((i) => i.prompt),
        ].some(
          (v) =>
            v !== null && v !== undefined && this.safe(v, excluded) === null,
        ),
    };
    if (
      visibility !== this.visibilityToken() ||
      this.requireTask(taskId).version !== t.version
    )
      throw new OperatorApiError(503, "unavailable");
    return taskSchema.parse({ data, observedAt: Date.now() });
  }
  private source(
    identity: NonNullable<ReturnType<OperatorApi["identity"]>>,
    issue: Row | undefined,
    projectId: string,
    excluded: readonly string[] | undefined,
  ) {
    const store = this.service.githubSources(),
      repositoryName =
        issue &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(issue.repositoryName))
          ? String(issue.repositoryName)
          : null;
    const number =
      issue &&
      Number.isSafeInteger(Number(issue.issueNumber)) &&
      Number(issue.issueNumber) > 0
        ? Number(issue.issueNumber)
        : null;
    const review = store.review(identity.nodeId),
      hold = store.hold(identity.nodeId);
    return {
      identity,
      repositoryName,
      number,
      url:
        repositoryName && number
          ? `https://github.com/${repositoryName}/issues/${number}`
          : null,
      title: this.safe(issue?.observedTitle, excluded),
      body: this.safe(issue?.observedBody, excluded),
      state: issue?.observedState ?? null,
      memberships: store
        .memberships(identity.nodeId)
        .filter((m) => m.projectId === projectId)
        .map((m) => {
          const sync = store.syncState(projectId, String(m.selectionId));
          const complete = sync ? Boolean(sync.complete) : null;
          const active = this.domain()
            .githubActiveSelectionIds(projectId)
            .includes(String(m.selectionId));
          const fields = z
            .array(
              z
                .object({
                  projectNodeId: z.string().max(512),
                  fieldNodeId: z.string().max(512),
                  optionNodeId: z.string().max(512),
                })
                .strict(),
            )
            .parse(JSON.parse(String(m.projectFields)));
          return {
            selectionId: String(m.selectionId),
            projectFields: fields,
            sync: {
              lastAttemptAt: sync ? String(sync.refreshedAt) : null,
              lastSuccessfulAt:
                complete && active ? String(sync?.refreshedAt) : null,
              complete: active ? complete : false,
              reasonCode: sync
                ? complete && active
                  ? null
                  : "partial-sync"
                : "sync-unavailable",
            },
          };
        }),
      nativeBlockers: store.nativeBlockers(identity.nodeId).map((b) => ({
        nodeId: String(b.blockerNodeId),
        repositoryId: String(b.repositoryId),
        repositoryName: String(b.repositoryName),
        number: Number(b.issueNumber),
        state: b.status,
      })),
      review: review
        ? {
            observedDigest: String(review.observedDigest),
            acceptedDigest: String(review.acceptedDigest),
            decision: this.safe(review.decision, excluded),
            decidedAt:
              review.decidedAt === null ? null : String(review.decidedAt),
          }
        : null,
      hold: hold
        ? {
            active: Boolean(hold.active),
            revision: Number(hold.generation),
            reasonCode: "source-held",
          }
        : null,
    };
  }
  async readAssignmentHistory(
    assignmentId: string,
    beforeSequence?: number,
    beforeOmissionSequence?: number,
  ) {
    const visibility = this.visibilityToken();
    uuid.parse(assignmentId);
    for (const p of this.domain().projects())
      for (const task of this.domain().tasks(String(p.id)))
        if (
          this.domain()
            .assignments(String(task.id))
            .some((a) => a.id === assignmentId)
        ) {
          const history = this.coordination().readAssignmentHistory(
            assignmentId,
            beforeSequence,
            beforeOmissionSequence,
          );
          const excluded = await this.exclusions(
            String(p.id),
            String(task.id),
            [...history.items, ...history.turnOmissions],
          );
          if (
            visibility !== this.visibilityToken() ||
            this.requireTask(String(task.id)).version !== task.version
          )
            throw new OperatorApiError(503, "unavailable");
          return assignmentHistorySchema.parse({
            data: {
              ...history,
              visibilityRevision: createHash("sha256")
                .update(`${visibility}:${task.version}`)
                .digest("hex"),
              items: history.items.map((item) => {
                if (item.lifecycle !== "completed") return item;
                const text =
                  excluded === undefined
                    ? undefined
                    : sanitizeConversationText(item.text ?? "", excluded);
                return text === undefined
                  ? {
                      ...item,
                      lifecycle: "omitted",
                      text: null,
                      omissionReason: "redaction-unavailable",
                    }
                  : { ...item, text };
              }),
            },
            observedAt: Date.now(),
          });
        }
    throw new OperatorApiError(404, "not-found");
  }
  private commentPolicy(taskId: string) {
    const task = this.requireTask(taskId),
      source = this.identity(taskId),
      policy = this.service.delivery().configuration(String(task.projectId)),
      grant = source
        ? policy.grants.find(
            (g) =>
              g.action === "issue.comment" &&
              g.repositoryId === source.repositoryId,
          )
        : undefined,
      held =
        this.service.taskHold(taskId) ||
        !this.domain().admission(taskId).eligible ||
        this.service.delivery().actionBlockers(taskId).length;
    return {
      available: Boolean(source && grant && !held),
      mode: grant?.mode ?? null,
      reason: !source
        ? "Task has no bound GitHub issue"
        : !grant
          ? "No project grant for issue comments"
          : held
            ? "Task admission or delivery is held"
            : null,
    };
  }
  private commentReviewReceipt(
    key: string,
    review: OperatorCommentReview,
    excluded: readonly string[] | undefined,
  ) {
    if (review.action.kind !== "issue.comment")
      throw new OperatorApiError(403, "forbidden");
    return commandReceiptSchema.parse({
      kind: "comment-review",
      key,
      recorded: true,
      taskId: review.taskId,
      reviewId: review.reviewId,
      operationId: review.operationId,
      revision: review.revision,
      materialHash: review.materialHash,
      decision: review.decision,
      body: this.safe(review.action.body, excluded),
      target: review.action.target,
      taskVersion: review.caller.taskVersion,
      sourceId: review.caller.sourceId,
      sourceRevision: review.caller.sourceRevision,
      sourceDigest: review.caller.sourceDigest,
      policyVersion: review.caller.policyVersion,
    });
  }
  private async reviewProjection(
    taskId: string,
    excluded: readonly string[] | undefined,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    const read = (() => {
      try {
        return this.service.taskReview().read(taskId, selection);
      } catch {
        throw new OperatorApiError(404, "not-found");
      }
    })();
    return taskReviewReadSchema.parse({
      ...read,
      sources: read.sources.map((source) => ({
        ...source,
        title: this.safe(source.title, excluded),
        body: this.safe(source.body, excluded),
        criteria: source.criteria.map((c) => ({
          ...c,
          text: this.safe(c.text, excluded) ?? "[Content unavailable]",
        })),
      })),
      contexts: read.contexts.map((c) => ({
        ...c,
        brief: this.safe(c.brief, excluded),
      })),
      results: read.results.map((result) => ({
        ...result,
        metadata: {
          ...result.metadata,
          criteria: result.metadata.criteria.map((c) => ({
            ...c,
            scope: this.safe(c.scope, excluded) ?? "[Content unavailable]",
            provenance:
              this.safe(c.provenance, excluded) ?? "[Content unavailable]",
          })),
          validations: result.metadata.validations.map((v) => ({
            ...v,
            label: this.safe(v.label, excluded) ?? "[Content unavailable]",
            scope: this.safe(v.scope, excluded) ?? "[Content unavailable]",
            provenance:
              this.safe(v.provenance, excluded) ?? "[Content unavailable]",
          })),
          decisions: result.metadata.decisions.map((d) => ({
            text: this.safe(d.text, excluded) ?? "[Content unavailable]",
            attribution:
              this.safe(d.attribution, excluded) ?? "[Content unavailable]",
          })),
          ...(result.metadata.changes
            ? {
                changes: {
                  ...result.metadata.changes,
                  files: result.metadata.changes.files.map(
                    (file) =>
                      this.safe(file, excluded) ?? "[Content unavailable]",
                  ),
                  ...(result.metadata.changes.diff
                    ? {
                        diff:
                          this.safe(result.metadata.changes.diff, excluded) ??
                          "[Content unavailable]",
                      }
                    : {}),
                  reference:
                    result.metadata.changes.reference &&
                    ["http:", "https:"].includes(
                      new URL(result.metadata.changes.reference).protocol,
                    ) &&
                    this.safe(result.metadata.changes.reference, excluded) ===
                      result.metadata.changes.reference
                      ? result.metadata.changes.reference
                      : undefined,
                  findings: result.metadata.changes.findings.map((f) => ({
                    ...f,
                    finding:
                      this.safe(f.finding, excluded) ?? "[Content unavailable]",
                  })),
                },
              }
            : {}),
          artifacts: result.metadata.artifacts.map((artifact) => {
            const { file: _file, url, ...rest } = artifact;
            return {
              ...rest,
              label:
                this.safe(artifact.label, excluded) ?? "Content unavailable",
              availability:
                excluded === undefined ||
                this.safe(artifact.label, excluded) !== artifact.label
                  ? "redacted"
                  : artifact.availability,
              ...(url && this.safe(url, excluded) === url ? { url } : {}),
            };
          }),
        },
      })),
    });
  }
  private deliveryProjection(
    taskId: string,
    excluded: readonly string[] | undefined,
  ) {
    const v = this.service.delivery().publicTask(taskId),
      b = v.binding;
    return deliveryReadSchema.parse({
      mode: v.mode,
      policyVersion: v.policyVersion,
      blockers: v.blockers.slice(0, 128),
      omittedBlockerCount: Math.max(0, v.blockers.length - 128),
      omittedActionCount: Math.max(0, v.actions.length - 128),
      binding: b
        ? {
            revision: b.revision,
            number: b.observation.number,
            repositoryName:
              this.sourceSummary(taskId, excluded)?.repositoryName ??
              b.observation.repositoryId,
            headSha: b.observation.headSha,
            state: b.observation.state,
            observedAt: b.observedAt,
            readError: this.safe(b.readError, excluded),
            omittedCheckCount: Math.max(0, b.observation.checks.length - 128),
            omittedFeedbackCount: Math.max(
              0,
              (b.observation.feedback?.length ?? 0) - 128,
            ),
            checks: b.observation.checks.slice(0, 128).map((c) => ({
              name: this.safe(c.name, excluded),
              sha: c.sha,
              status: c.status,
            })),
            feedback: (b.observation.feedback ?? []).slice(0, 128).map((f) => ({
              ...f,
              author: this.safe(f.author, excluded),
              body: this.safe(f.body, excluded),
              commitSha: f.commitSha,
            })),
          }
        : null,
      actions: v.actions.slice(-128).map((a) => ({
        operationId: a.operationId,
        kind: a.kind,
        state: a.state,
        reason: this.safe(a.reason, excluded),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    });
  }
  async readReview(
    taskId: string,
    selection: {
      resultId?: string | undefined;
      sourceId?: string | undefined;
    } = {},
  ) {
    const visibility = this.visibilityToken();
    const t = this.requireTask(taskId),
      excluded = await this.exclusions(String(t.projectId), taskId);
    const data = await this.reviewProjection(taskId, excluded, selection);
    if (
      visibility !== this.visibilityToken() ||
      this.requireTask(taskId).version !== t.version
    )
      throw new OperatorApiError(503, "unavailable");
    return reviewReadSchema.parse({
      data,
      observedAt: Date.now(),
    });
  }
  async readSearch(params: URLSearchParams) {
    const visibility = this.visibilityToken();
    const query = searchQuerySchema.parse(Object.fromEntries(params));
    if (query.projectId) this.requireProject(query.projectId);
    const rows = await this.service.taskReview().search(query);
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    const page = rows.slice(0, query.limit),
      matches = [],
      versions = new Map<string, number>();
    let omittedCount = 0;
    for (const row of page) {
      try {
        const taskId = String(row.taskId),
          t = this.requireTask(taskId),
          p = this.requireProject(String(t.projectId)),
          excluded = await this.exclusions(String(t.projectId), taskId),
          view = this.coordination().readTask(taskId),
          resultId = row.resultId === null ? null : String(row.resultId),
          sourceId = row.sourceId === null ? null : String(row.sourceId),
          source = sourceId
            ? this.service.taskReview().source(taskId, sourceId)
            : undefined,
          reviewResult = resultId
            ? this.service.taskReview().result(taskId, resultId)
            : undefined,
          decision =
            row.type === "decision"
              ? reviewResult?.metadata.decisions.find(
                  (_, position) =>
                    row.recordId === `${resultId}:decision:${position}`,
                )
              : undefined,
          retained = resultId
            ? view.results.some((r) => r.resultId === resultId)
            : source !== undefined;
        const current = this.requireTask(taskId);
        if (
          current.version !== t.version ||
          current.projectId !== t.projectId ||
          (query.projectId && current.projectId !== query.projectId)
        )
          throw new OperatorApiError(503, "unavailable");
        const excerpt = this.safe(row.excerpt, excluded);
        if (
          !retained ||
          excerpt === null ||
          excerpt !== row.excerpt ||
          (row.type === "decision" &&
            (!decision ||
              excerpt !==
                `${decision.attribution}: ${decision.text}`.slice(0, 16000) ||
              (reviewResult?.metadata.sourceId ?? null) !== sourceId ||
              [decision.attribution, decision.text].some(
                (value) => this.safe(value, excluded) !== value,
              ))) ||
          (source &&
            [source.title, source.body].some(
              (value) => value !== null && this.safe(value, excluded) !== value,
            ))
        ) {
          omittedCount++;
          continue;
        }
        const historical = resultId
          ? view.results.at(-1)?.resultId !== resultId
          : this.service.taskReview().sources(taskId).at(-1)?.sourceId !==
            sourceId;
        versions.set(taskId, Number(t.version));
        matches.push({
          recordId: row.recordId,
          type: row.type,
          taskId,
          projectId: String(t.projectId),
          projectName: this.safe(p.name, excluded),
          taskTitle: this.safe(t.title, excluded),
          sourceId,
          resultId,
          excerpt,
          createdAt: Number(row.createdAt),
          historical,
          href: `/app/tasks/${taskId}?section=${row.type === "task" ? "brief" : "review"}&record=${encodeURIComponent(String(row.recordId))}${resultId ? `&result=${resultId}` : ""}${sourceId ? `&source=${sourceId}` : ""}`,
        });
      } catch (error) {
        if (error instanceof OperatorApiError) {
          omittedCount++;
          continue;
        }
        throw error;
      }
    }
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    const eligibleRecords = new Set(
      (await this.service.taskReview().search(query)).map(
        (row) => row.recordId,
      ),
    );
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    const permitted = matches.filter((m) => {
      try {
        const current = this.requireTask(m.taskId);
        if (
          Number(current.version) !== versions.get(m.taskId) ||
          String(current.projectId) !== m.projectId ||
          (query.projectId && String(current.projectId) !== query.projectId)
        )
          return false;
        this.requireProject(m.projectId);
        return (
          eligibleRecords.has(m.recordId) &&
          (query.historical ||
            this.service
              .taskReview()
              .isCurrentSearchRecord(m.taskId, m.sourceId, m.resultId))
        );
      } catch {
        return false;
      }
    });
    return searchReadSchema.parse({
      data: {
        matches: permitted,
        nextCursor:
          rows.length > query.limit ? String(page.at(-1)?.recordId) : null,
        coverage: "retained-records-only",
        omittedCount: omittedCount + matches.length - permitted.length,
      },
      observedAt: Date.now(),
    });
  }
  async readArtifact(taskId: string, artifactId: string) {
    uuid.parse(artifactId);
    this.requireTask(taskId);
    try {
      return await previewRecordedArtifact(async () => {
        const visibility = this.visibilityToken();
        const t = this.requireTask(taskId),
          excluded = await this.exclusions(String(t.projectId), taskId),
          workspace = await this.service.taskWorkspace(taskId);
        const current = this.requireTask(taskId),
          record = this.service.taskReview().artifactOwner(taskId, artifactId),
          artifact = record?.metadata.artifacts.find(
            (a) => a.artifactId === artifactId,
          );
        if (
          visibility !== this.visibilityToken() ||
          !workspace ||
          workspace.state !== "ready" ||
          !record ||
          !artifact ||
          excluded === undefined ||
          this.safe(artifact.label, excluded) !== artifact.label
        )
          return undefined;
        return {
          artifact,
          workspace: workspace.path,
          identity: JSON.stringify({
            taskId,
            taskVersion: current.version,
            workspaceId: workspace.workspaceId,
            workspaceState: workspace.state,
            resultId: record.resultId,
            workId: record.workId,
            workRevision: record.workRevision,
            artifact,
            excluded,
          }),
        };
      });
    } catch (error) {
      if (error instanceof OperatorApiError) throw error;
      throw new OperatorApiError(
        error instanceof ArtifactUnavailable && error.reason === "mismatch"
          ? 409
          : 404,
        error instanceof ArtifactUnavailable && error.reason === "mismatch"
          ? "conflict"
          : "not-found",
      );
    }
  }
  async readProfileConfiguration(profileId: string) {
    uuid.parse(profileId);
    const row = this.domain()
      .profiles()
      .find((p) => p.id === profileId);
    if (!row) throw new OperatorApiError(404, "not-found");
    const excluded = await this.exclusions();
    return profileConfigurationSchema.parse({
      data: {
        profile: {
          ...this.profiles(excluded).find((p) => p.id === profileId),
          name: this.exact(row.name, excluded),
        },
        instructionPresent: Boolean(row.instructions),
        instructionRevision: Number(row.version),
        capabilities: this.safe(row.capabilities, excluded),
      },
      observedAt: Date.now(),
    });
  }
  async readProjectConfiguration(projectId: string) {
    const p = this.requireProject(projectId),
      d = this.domain(),
      excluded = await this.exclusions(projectId),
      g = d.githubConfiguration(projectId),
      r = d.routing(projectId),
      active = d.githubActiveSelectionIds(projectId);
    return projectConfigurationSchema.parse({
      data: {
        project: {
          ...this.project(p, excluded),
          name: this.exact(p.name, excluded),
        },
        profiles: this.profiles(excluded),
        instructionsRevision: Number(p.instructionsRevision),
        instructionPresent: Boolean(p.instructions),
        placements: this.service
          .githubSources()
          .conflicts()
          .filter((c) => c.projectIds.includes(projectId))
          .map((c) => {
            const task = d.task(c.taskId);
            return {
              taskId: c.taskId,
              projectId: String(task.projectId),
              version: Number(task.version),
              title: this.safe(task.title, excluded),
              choices: c.projectIds.map((id) =>
                this.project(d.project(id), excluded),
              ),
            };
          }),
        routing: {
          version: Number(r.version),
          enabled: Boolean(r.enabled),
          candidateProfileIds: JSON.parse(String(r.candidateProfileIds)),
          credentialConfigured:
            d.routingCredentialReference(projectId) !== null,
          availability:
            this.service.routingAvailability(projectId).reason ?? "available",
        },
        source: {
          version: g.version,
          credentialConfigured: g.credentialRef !== null,
          selections: g.selections.map((s) => ({
            id: this.exact(s.id, excluded),
            kind: s.kind,
            descriptor: this.safe(
              s.kind === "repository"
                ? `${s.owner}/${s.name}`
                : s.kind === "project"
                  ? s.projectNodeId
                  : null,
              excluded,
            ),
            active: active.includes(s.id),
          })),
          readiness:
            this.exact(JSON.stringify(g.readiness), excluded) === null
              ? null
              : g.readiness,
          repositories: g.repositories.map((r) => ({
            repositoryId: this.safe(r.repositoryId, excluded),
            ref: this.safe(r.ref, excluded),
          })),
        },
      },
      observedAt: Date.now(),
    });
  }
  async readRuntimeSettings() {
    const d = this.domain(),
      projects = d.projects(),
      excluded = await this.exclusions(),
      limits = this.service.capacityLimits(projects.map((p) => String(p.id)));
    return runtimeSettingsSchema.parse({
      data: {
        globalLimit: limits.globalLimit,
        defaultProjectLimit: limits.defaultProjectLimit,
        globalUsage: limits.currentUsage.global,
        projects: await Promise.all(
          projects.map(async (p) => {
            const id = String(p.id);
            return {
              project: this.project(p, excluded),
              limit: limits.effectiveProjectLimits[id],
              usage: limits.currentUsage.projects[id] ?? 0,
              override: limits.projectOverrides[id] ?? null,
              tasks: await Promise.all(
                d.tasks(id).map(async (t) => {
                  const taskId = String(t.id),
                    assignments = d.assignments(taskId),
                    known = new Set(assignments.map((a) => String(a.id))),
                    taskExcluded = await this.exclusions(id, taskId);
                  const records = this.service
                    .recoveryView()
                    .filter(
                      (r) =>
                        r.binding?.taskId === taskId &&
                        known.has(r.binding.assignmentId),
                    );
                  return {
                    taskId,
                    title: this.safe(t.title, taskExcluded),
                    paused: Boolean(p.paused),
                    held:
                      this.service.taskHold(taskId) !== undefined ||
                      records.some(
                        (r) =>
                          r.holds.stop ||
                          r.holds.writer ||
                          r.holds.capacity ||
                          r.holds.uncertainty ||
                          r.holds.task !== null,
                      ),
                    assignments: assignments.map((a) => ({
                      assignmentId: String(a.id),
                      name: this.safe(
                        d.profile(String(a.profileId)).name,
                        taskExcluded,
                      ),
                    })),
                  };
                }),
              ),
            };
          }),
        ),
      },
      observedAt: Date.now(),
    });
  }
  async readAssignmentRecovery(assignmentId: string) {
    uuid.parse(assignmentId);
    const d = this.domain(),
      entry = d
        .taskCatalog()
        .find((t) => d.assignments(t.id).some((a) => a.id === assignmentId));
    if (!entry) throw new OperatorApiError(404, "not-found");
    const taskId = entry.id,
      projectId = entry.projectId,
      task = await this.readTask(taskId),
      assignment = task.data.assignments.find(
        (a) => a.assignmentId === assignmentId,
      );
    if (!assignment) throw new OperatorApiError(404, "not-found");
    const selected = this.selection(d.assignment(assignmentId)).request,
      known = new Set(d.assignments(taskId).map((a) => String(a.id))),
      excluded = await this.exclusions(projectId, taskId);
    const records = this.service
      .recoveryView()
      .filter((r) =>
        r.binding
          ? r.binding.taskId === taskId &&
            known.has(r.binding.assignmentId) &&
            uuid.safeParse(r.binding.assignmentId).success
          : selected?.workId === r.workId &&
            selected.assignmentId === assignmentId &&
            selected.taskId === taskId &&
            r.request?.assignmentId === assignmentId,
      );
    const taskHold = this.service.taskHold(taskId);
    const holds = {
      stop: taskHold === "Task stopped" || records.some((r) => r.holds.stop),
      writer: records.some((r) => r.holds.writer),
      capacity: records.some((r) => r.holds.capacity),
      uncertainty: records.some((r) => r.holds.uncertainty),
      task:
        taskHold !== undefined || records.some((r) => r.holds.task !== null),
    };
    const visible = records.slice(-20);
    const intentStates = new Set([
        "ready",
        "capacity-waiting",
        "held",
        "submitting",
        "running",
        "completed",
        "reconciled",
        "resolved-failed",
      ]),
      requestStates = new Set(["queued", "active", "completed", "held"]);
    return assignmentRecoverySchema.parse({
      data: {
        assignment,
        taskId,
        project:
          task.data.task.projectId === projectId
            ? this.project(d.project(projectId), excluded)
            : null,
        held: Object.values(holds).some(Boolean),
        holds,
        evidenceAvailable: records.length > 0,
        omittedCount: records.length - visible.length,
        records: visible.map((r) => ({
          workId: this.safe(r.workId, excluded),
          generation: r.generation,
          binding: r.binding
            ? {
                assignmentId: r.binding.assignmentId,
                assignmentVersion: r.binding.assignmentVersion,
                instructionsRevision: r.binding.instructionsRevision,
                profileRevision: r.binding.profileRevision,
              }
            : null,
          intentState: intentStates.has(r.intent.state)
            ? r.intent.state
            : "unknown",
          requestState: r.request
            ? requestStates.has(r.request.state)
              ? r.request.state
              : "unknown"
            : null,
          holds: {
            stop: r.holds.stop,
            writer: r.holds.writer,
            capacity: r.holds.capacity,
            uncertainty: r.holds.uncertainty,
            task: r.holds.task !== null,
          },
          observations: [
            ...new Set(
              r.observations.map((o) => {
                const parsed = recoveryObservationSchema.safeParse(o.kind);
                return parsed.success ? parsed.data : "unknown";
              }),
            ),
          ],
          pendingEffectCount: r.pendingEffects.length,
          ...(r.noTurnSubmission
            ? { noTurnSubmission: r.noTurnSubmission }
            : {}),
          ...(r.preTurnRejection
            ? {
                preTurnRejection: {
                  ...r.preTurnRejection,
                  predecessorThreadId: this.safe(
                    r.preTurnRejection.predecessorThreadId,
                    excluded,
                  ),
                },
              }
            : {}),
          receiptRecorded: r.receipt !== null,
          workspace:
            r.receipt?.workspaceDisposition === "preserved"
              ? "preserved"
              : r.receipt?.workspaceDisposition === "reconciled"
                ? "reconciled"
                : "unknown",
        })),
      },
      observedAt: Date.now(),
    });
  }
  async readSourceObservations() {
    const excluded = await this.exclusions(),
      d = this.domain();
    return sourceObservationSchema.parse({
      data: {
        projects: d.projects().map((p) => {
          const projectId = String(p.id);
          return {
            projectId,
            selections: d.githubConfiguration(projectId).selections.map((s) => {
              const sync = this.service
                .githubSources()
                .syncState(projectId, s.id);
              const at =
                sync?.refreshedAt === undefined
                  ? null
                  : String(sync.refreshedAt);
              return {
                selectionId: this.safe(s.id, excluded),
                state:
                  excluded === undefined
                    ? "unavailable"
                    : sync
                      ? sync.complete
                        ? "complete"
                        : "partial"
                      : "never",
                lastAttemptAt: at,
                lastSuccessfulAt: sync && sync.complete ? at : null,
              };
            }),
          };
        }),
      },
      observedAt: Date.now(),
    });
  }
  async refreshSources() {
    await this.service.refreshGitHub();
    return this.readSourceObservations();
  }
  private async previewGitHubSelection(
    c: Extract<
      z.infer<typeof operatorCommandSchema>,
      { type: "github.preview" }
    >,
  ) {
    const command = {
      ...c,
      type: "github.activate" as const,
      actor: "operator" as const,
    };
    let raw = this.domain().recordedCommand(command);
    if (raw === undefined) {
      const config = this.domain().githubConfiguration(c.projectId);
      if (config.version !== c.expectedVersion || !config.credentialRef)
        throw new DomainConflictError("Preview configuration conflict");
      const selection = config.selections.find((s) => s.id === c.selectionId);
      if (!selection) throw new DomainConflictError("Unknown GitHub selection");
      const preview = await this.previewReader(
        config.credentialRef,
      ).readSelection(selection);
      if (!preview.complete)
        throw new DomainConflictError("Preview incomplete");
      raw = await this.executeDomain(command);
    }
    const r = raw as {
      projectId: string;
      selectionId: string;
      configVersion: number;
      active: true;
    };
    const excluded = await this.exclusions(c.projectId);
    if (this.safe(r.selectionId, excluded) !== r.selectionId)
      throw new Error("Receipt unavailable");
    return commandReceiptSchema.parse({
      kind: "configuration",
      key: c.key,
      recorded: true,
      result: {
        commandType: "github.preview",
        resourceId: r.projectId,
        selectionId: r.selectionId,
        configVersion: r.configVersion,
        active: r.active,
      },
    });
  }
  private async executeDomain(c: Parameters<typeof this.commands.execute>[0]) {
    try {
      return await this.commands.execute(c);
    } catch (error) {
      if (
        error instanceof Error &&
        /Operator (?:review|confirmation|delivery|task)|Operation key used|Feedback (?:source|result|work|criterion|artifact)|Imported task source unavailable/.test(
          error.message,
        )
      )
        throw new OperatorApiError(409, "conflict");
      if (error instanceof DomainPolicyError)
        throw new OperatorApiError(
          error.code === "forbidden" ? 403 : 400,
          error.code,
          c.type === "github.configure" &&
            error.code === "invalid-input" &&
            error.message === "Repository verification failed"
            ? ["repositories"]
            : undefined,
        );
      throw error;
    }
  }
  async execute(input: unknown) {
    const c = operatorCommandSchema.parse(input);
    try {
      if (
        c.type === "comment.review" ||
        c.type === "comment.confirm" ||
        c.type === "comment.send"
      ) {
        const task = this.requireTask(c.taskId),
          visibility = this.visibilityToken(),
          excluded = await this.exclusions(String(task.projectId), c.taskId);
        if (
          visibility !== this.visibilityToken() ||
          this.requireTask(c.taskId).version !== task.version
        )
          throw new OperatorApiError(409, "conflict");
        if ("body" in c && this.safe(c.body, excluded) !== c.body)
          throw new OperatorApiError(403, "forbidden");
        if (c.type === "comment.review")
          return this.commentReviewReceipt(
            c.key,
            this.service.reviewOperatorComment(c),
            excluded,
          );
        if (c.type === "comment.confirm") {
          const r = this.service.delivery().operatorReview(c.reviewId);
          if (
            !r ||
            r.taskId !== c.taskId ||
            r.action.kind !== "issue.comment" ||
            this.safe(r.action.body, excluded) !== r.action.body
          )
            throw new OperatorApiError(403, "forbidden");
          return this.commentReviewReceipt(
            c.key,
            this.service.confirmOperatorComment(c),
            excluded,
          );
        }
        const saved = await this.service.postOperatorComment(c);
        this.requireTask(c.taskId);
        return commandReceiptSchema.parse({
          kind: "delivery",
          key: c.key,
          recorded: true,
          taskId: c.taskId,
          operationId: saved.operationId,
          state: saved.state,
          reason: this.safe(
            saved.observation?.reason,
            await this.exclusions(String(task.projectId), c.taskId),
          ),
        });
      }
      if (c.type === "review.view") {
        this.requireTask(c.taskId);
        const excluded = await this.exclusions(
          String(this.requireTask(c.taskId).projectId),
          c.taskId,
        );
        if (excluded === undefined)
          throw new OperatorApiError(503, "unavailable");
        this.requireTask(c.taskId);
        this.service
          .taskReview()
          .recordViewed(c.taskId, c.key, c.sourceId, c.resultIds);
        return commandReceiptSchema.parse({
          kind: "review",
          key: c.key,
          recorded: true,
          taskId: c.taskId,
          operation: c.type,
        });
      }
      if (c.type === "delivery.refresh") {
        this.requireTask(c.taskId);
        await this.coordination().refreshDelivery(c.taskId);
        this.requireTask(c.taskId);
        return commandReceiptSchema.parse({
          kind: "review",
          key: c.key,
          recorded: true,
          taskId: c.taskId,
          operation: c.type,
        });
      }
      if (c.type === "capacity.configure") {
        const command = { ...c, actor: "operator" as const };
        let raw = this.domain().recordedCommand(command);
        if (raw === undefined) {
          for (const id of Object.keys(c.projectOverrides))
            this.requireProject(id);
          raw = await this.service.configureCapacity({
            key: c.key,
            globalLimit: c.globalLimit,
            projectOverrides: c.projectOverrides,
          });
        }
        const r = raw as {
          globalLimit: number;
          defaultProjectLimit: 2;
          projectOverrides: Record<string, number>;
        };
        return commandReceiptSchema.parse({
          kind: "configuration",
          key: c.key,
          recorded: true,
          result: {
            commandType: c.type,
            resourceId: "system:capacity",
            globalLimit: r.globalLimit,
            defaultProjectLimit: r.defaultProjectLimit,
            projectOverrides: r.projectOverrides,
          },
        });
      }
      if (c.type === "github.preview")
        return await this.previewGitHubSelection(c);
      if (
        c.type === "project.create" ||
        c.type === "project.configure" ||
        c.type === "profile.create" ||
        c.type === "profile.configure" ||
        c.type === "routing.configure" ||
        c.type === "github.configure" ||
        c.type === "github.place"
      ) {
        const raw = await this.executeDomain({ ...c, actor: "operator" });
        const r = raw as Row;
        const result =
          c.type === "project.create" || c.type === "project.configure"
            ? {
                commandType: c.type,
                resourceId: String(r.id),
                version: Number(r.version),
                paused: Boolean(r.paused),
                leadProfileId:
                  r.leadProfileId === null ? null : String(r.leadProfileId),
                instructionsRevision: Number(r.instructionsRevision),
              }
            : c.type === "profile.create" || c.type === "profile.configure"
              ? {
                  commandType: c.type,
                  resourceId: String(r.id),
                  version: Number(r.version),
                  revoked: Boolean(r.revoked),
                }
              : c.type === "routing.configure"
                ? {
                    commandType: c.type,
                    resourceId: c.projectId,
                    version: Number(r.version),
                    enabled: Boolean(r.enabled),
                    credentialConfigured: Boolean(r.credentialAvailable),
                  }
                : c.type === "github.configure"
                  ? {
                      commandType: c.type,
                      resourceId: c.projectId,
                      version: Number(r.version),
                      credentialConfigured: r.credentialRef !== null,
                      selectionCount: (raw as { selections: unknown[] })
                        .selections.length,
                      repositoryCount: (raw as { repositories: unknown[] })
                        .repositories.length,
                    }
                  : {
                      commandType: c.type,
                      resourceId: String(r.id),
                      projectId: String(r.projectId),
                      version: Number(r.version),
                    };
        return commandReceiptSchema.parse({
          kind: "configuration",
          key: c.key,
          recorded: true,
          result,
        });
      }
      if ("projectId" in c) {
        this.requireProject(c.projectId);
        if (c.type !== "task.create") {
          const task =
            c.type === "assignment.apply"
              ? this.domain().assignment(c.assignmentId)
              : this.requireTask(c.taskId);
          if (task.projectId !== c.projectId)
            throw new OperatorApiError(403, "forbidden");
          if (
            c.type === "task.configure" &&
            this.domain().importedTask(c.taskId) &&
            (c.title !== undefined || c.outcome !== undefined)
          )
            throw new OperatorApiError(403, "forbidden");
        }
        let raw: unknown;
        try {
          raw = await this.commands.execute({ ...c, actor: "operator" });
        } catch (error) {
          // DomainStore wraps post-commit callbacks; only a rolled-back apply
          // can preserve this definite policy error from the domain command.
          if (error instanceof DomainPolicyError)
            throw new OperatorApiError(
              error.code === "forbidden" ? 403 : 400,
              error.code,
            );
          throw error;
        }
        const r = raw as Row;
        const result =
          c.type === "assignment.apply"
            ? {
                id: String(r.id),
                taskId: String(r.taskId),
                projectId: String(r.projectId),
                version: Number(r.version),
                profileRevision: Number(r.profileRevision),
                instructionsRevision: Number(r.instructionsRevision),
              }
            : {
                id: String(r.id),
                projectId: String(r.projectId),
                version: Number(r.version),
                state: r.state,
                ready: Boolean(r.ready),
              };
        return commandReceiptSchema.parse({
          kind: "domain",
          key: c.key,
          recorded: true,
          result,
        });
      }
      this.requireTask(c.taskId);
      const view = this.coordination();
      const { type, ...submitted } = c;
      let command: typeof submitted = submitted;
      if (
        c.type === "approval.decide" &&
        c.decision === "denied" &&
        c.material === undefined
      ) {
        const retained = view
          .readTask(c.taskId)
          .approvals.find((i) => i.interactionId === c.interactionId);
        if (
          retained?.materialJson !== null &&
          retained?.materialJson !== undefined
        ) {
          command = {
            ...submitted,
            // Display bounds deliberately exclude some core-valid retained JSON.
            // The existing command compares these immutable bytes canonically.
            material: JSON.parse(retained.materialJson),
          };
        }
      }
      if (c.type === "approval.decide" && c.decision === "approved") {
        const approval = (await this.readTask(c.taskId)).data.approvals.find(
          (a) => a.interactionId === c.interactionId,
        );
        if (!approval?.approvable && approval?.status !== "approved")
          throw new OperatorApiError(403, "forbidden");
      }
      const saved =
        type === "message"
          ? await view.postOperatorMessage(
              command as Parameters<typeof view.postOperatorMessage>[0],
            )
          : type === "question.answer"
            ? await view.answerQuestion(
                command as Parameters<typeof view.answerQuestion>[0],
              )
            : type === "approval.decide"
              ? await view.decideApproval(
                  command as Parameters<typeof view.decideApproval>[0],
                )
              : await view.reconcileResultRecipient(
                  command as Parameters<
                    typeof view.reconcileResultRecipient
                  >[0],
                );
      return commandReceiptSchema.parse({
        kind: "coordination",
        key: c.key,
        recorded: true,
        eventId: saved.eventId,
        taskId: saved.taskId,
        recipientAssignmentId: saved.recipientAssignmentId,
        eventType: saved.eventType,
        createdAt: saved.createdAt,
      });
    } catch (error) {
      if (error instanceof OperatorApiError || error instanceof z.ZodError)
        throw error;
      if (
        error instanceof Error &&
        /^Feedback (?:source|result|work|criterion|artifact)/.test(
          error.message,
        )
      )
        throw new OperatorApiError(409, "conflict");
      if (error instanceof DomainPolicyError)
        throw new OperatorApiError(503, "command-outcome-unknown");
      if (
        error instanceof DomainConflictError ||
        (error instanceof Error && conflicts.has(error.message))
      )
        throw new OperatorApiError(409, "conflict");
      if (
        error instanceof Error &&
        [
          "Recipient is not permitted by the assignment",
          "Message recipient is not in this task",
          "Question is not in this task",
          "Approval is not in this task",
          "Result is not in this task",
          "Contextual feedback must target the accountable lead",
        ].includes(error.message)
      )
        throw new OperatorApiError(403, "forbidden");
      throw new OperatorApiError(503, "command-outcome-unknown");
    }
  }
}
