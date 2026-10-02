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
  uuid,
  workspaceSchema,
  type Execution,
} from "../operator/contracts.js";
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
  ) {
    this.commands = new DomainCommands(service.domain());
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
        for (const ref of [d.routingCredentialReference(id), g.credentialRef])
          if (ref) {
            values.push(ref);
            const value = process.env[ref.slice(4)];
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
    return excluded
      ? (sanitizeConversationText(prose, excluded) ?? null)
      : null;
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
      stop: selections.some((s) => s.record?.holds.stop),
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
    const c = this.domain().capacityLimits();
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
      (execution.holds.task && !execution.holds.stop) ||
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
  async readTask(taskId: string) {
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
      assignments: assignments.map((a) => {
        const s = this.selection(a),
          request = s.request;
        return {
          assignmentId: String(a.id),
          profileId: String(a.profileId),
          name: this.safe(d.profile(String(a.profileId)).name, excluded),
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
  async readAssignmentHistory(assignmentId: string) {
    uuid.parse(assignmentId);
    for (const p of this.domain().projects())
      for (const task of this.domain().tasks(String(p.id)))
        if (
          this.domain()
            .assignments(String(task.id))
            .some((a) => a.id === assignmentId)
        ) {
          const history =
            this.coordination().readAssignmentHistory(assignmentId);
          const excluded = await this.exclusions(
            String(p.id),
            String(task.id),
            [...history.items, ...history.turnOmissions],
          );
          return assignmentHistorySchema.parse({
            data: {
              ...history,
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
  async execute(input: unknown) {
    const c = operatorCommandSchema.parse(input);
    try {
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
        const raw = await this.commands.execute({ ...c, actor: "operator" });
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
      if (error instanceof DomainPolicyError)
        throw new OperatorApiError(
          error.code === "forbidden" ? 403 : 400,
          error.code,
        );
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
        ].includes(error.message)
      )
        throw new OperatorApiError(403, "forbidden");
      throw new OperatorApiError(503, "command-outcome-unknown");
    }
  }
}
