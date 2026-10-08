import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { setImmediate as yieldTraversal } from "node:timers/promises";
import { z } from "zod";
import type {
  CoordinationInteraction,
  TaskCompletionRequest,
} from "../core/coordination.js";
import type { OperatorCommentReview } from "../core/delivery.js";
import {
  DomainCommands,
  DomainConflictError,
  DomainPolicyError,
} from "../core/domain.js";
import {
  nativeQuestionForm,
  type QuestionAnswers,
  questionFormSchema,
} from "../core/question-forms.js";
import { taskReviewReadSchema } from "../core/task-review.js";
import {
  admissionSchema,
  assignmentHistorySchema,
  assignmentRecoverySchema,
  commandReceiptSchema,
  composerOptionsSchema,
  deliveryReadSchema,
  type Execution,
  type InboxItem,
  inboxReadSchema,
  materialSchema,
  operatorCommandSchema,
  profileConfigurationSchema,
  projectConfigurationSchema,
  projectSchema,
  questionReadSchema,
  recoveryObservationSchema,
  reviewReadSchema,
  runtimeSettingsSchema,
  retainedEvidenceItemContentReadSchema,
  retainedResultEvidenceReadSchema,
  retainedReviewAnchorReadSchema,
  searchQuerySchema,
  searchReadSchema,
  sourceObservationSchema,
  taskListPageSchema,
  taskListQuerySchema,
  taskSchema,
  uuid,
  workspaceComparisonReadRequestSchema,
  workspaceComparisonReadSchema,
  workspaceDirectoryReadSchema,
  workspacePreviewReadSchema,
  workspaceSchema,
} from "../operator/contracts.js";
import {
  type ConversationHistoryBinding,
  sanitizeConversationText,
} from "./conversation-history.js";
import type { CoordinationView } from "./coordination-view.js";
import {
  GitHubHttpSourceReader,
  type GitHubSourceReader,
} from "./github-source.js";
import type { StandaloneService } from "./service.js";
import { ArtifactUnavailable, previewRecordedArtifact } from "./task-review.js";
import {
  compareRepository,
  type WorkspaceComparisonSideContent,
  type WorkspaceComparisonSnapshot,
  type WorkspaceTurnCaptureRecord,
} from "./workspace-comparison.js";
import {
  listWorkspaceDirectory,
  previewRetainedBytes,
  previewWorkspaceFile,
  retainedPathExcluded,
  type WorkspaceInspectionCurrent,
  WorkspaceInspectionInputError,
  type WorkspaceInspectionPathReference,
  type WorkspaceInspectionRequest,
  workspaceInspectionPathsExcluded,
} from "./workspace-inspection.js";

type Row =
  ReturnType<StandaloneService["domain"]> extends { task(id: string): infer R }
    ? R
    : never;
type RetainedReadPolicy = {
  taskId: string;
  projectId: string;
  taskVersion: number;
  visibility: string;
  workspaceVisibility: string;
  excluded: readonly string[];
  controlPaths: readonly string[];
  authorizedRepositoryIds: readonly string[];
  fingerprint: string;
};
type RetainedDiffPayload = {
  version: 1;
  repositoryId: string | null;
  path: string;
  previousPath?: string;
  left: { state: "absent" } | { state: "text"; text: string };
  right: { state: "absent" } | { state: "text"; text: string };
};
const relativePolicySegments = (path: string): string[] | undefined => {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\\")
  )
    return undefined;
  const segments = path.split("/");
  return segments.length <= 32 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/\p{Cc}/u.test(segment),
    ) &&
    Buffer.byteLength(path, "utf8") <= 2048
    ? segments
    : undefined;
};
function parseRetainedDiff(bytes: Buffer): RetainedDiffPayload | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const source = value as Record<string, unknown>;
    if (
      source.version !== 1 ||
      (source.repositoryId !== null &&
        typeof source.repositoryId !== "string") ||
      typeof source.path !== "string" ||
      (source.previousPath !== undefined &&
        typeof source.previousPath !== "string")
    )
      return undefined;
    const parseSide = (
      side: unknown,
    ): RetainedDiffPayload["left"] | undefined => {
      if (!side || typeof side !== "object" || Array.isArray(side))
        return undefined;
      const record = side as Record<string, unknown>;
      if (record.state === "absent" && Object.keys(record).length === 1)
        return { state: "absent" };
      if (record.state === "text" && typeof record.text === "string")
        return { state: "text", text: record.text };
      return undefined;
    };
    const left = parseSide(source.left);
    const right = parseSide(source.right);
    if (!left || !right) return undefined;
    return {
      version: 1,
      repositoryId: source.repositoryId as string | null,
      path: source.path,
      ...(source.previousPath
        ? { previousPath: source.previousPath as string }
        : {}),
      left,
      right,
    };
  } catch {
    return undefined;
  }
}
function retainedAnchorRange(
  source: Buffer,
  startLine: number,
  endLine: number,
) {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return undefined;
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === 0x0a) {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < source.length) lines.push({ start, end: source.length });
  if (endLine > lines.length) return undefined;
  const byteStart = lines[startLine - 1]?.start;
  const byteEnd = lines[endLine - 1]?.end;
  if (byteStart === undefined || byteEnd === undefined) return undefined;
  return {
    byteStart,
    byteEnd,
    bytes: source.subarray(byteStart, byteEnd),
  };
}
function exactRetainedAnchorExcerpt(
  anchor: NonNullable<
    ReturnType<
      ReturnType<StandaloneService["retainedEvidence"]>["reviewAnchor"]
    >
  >["anchor"],
  source: Buffer,
  excerpt: Buffer,
) {
  const range = retainedAnchorRange(source, anchor.startLine, anchor.endLine);
  return Boolean(
    range &&
      range.byteStart === anchor.byteStart &&
      range.byteEnd === anchor.byteEnd &&
      range.bytes.equals(excerpt) &&
      range.bytes.byteLength === anchor.size &&
      createHash("sha256").update(range.bytes).digest("hex") ===
        anchor.excerptSha256,
  );
}
function retainedTextLineCount(text: string) {
  if (!text) return 0;
  let count = 0;
  for (const character of text) if (character === "\n") count++;
  return text.endsWith("\n") ? count : count + 1;
}
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
  "Question requesting work is stale, cancelled or ambiguous",
  "Structured question unavailable or already answered",
  "Native question unavailable, already answered or stale",
  "Native requesting work is stale",
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
  async retainedEvidencePolicy(taskId: string) {
    const visibility = this.visibilityToken();
    const task = this.requireTask(taskId);
    const projectId = String(task.projectId);
    const workspaceVisibility = this.service.taskWorkspaceVisibility(taskId);
    const excluded = await this.exclusions(projectId, taskId);
    if (!excluded) return undefined;
    const repositories = this.domain()
      .githubConfiguration(projectId)
      .repositories.map((repository) => repository.repositoryId)
      .sort();
    const current = this.requireTask(taskId);
    if (
      current.projectId !== task.projectId ||
      current.version !== task.version ||
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId)
    )
      return undefined;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          taskId,
          projectId,
          taskVersion: task.version,
          visibility,
          workspaceVisibility,
          repositories,
          excluded,
          controlPaths: this.controlPaths,
        }),
      )
      .digest("hex");
    return {
      taskId,
      projectId,
      taskVersion: Number(task.version),
      visibility,
      workspaceVisibility,
      excluded,
      controlPaths: [...this.controlPaths],
      authorizedRepositoryIds: repositories,
      fingerprint,
    };
  }
  private sameRetainedPolicy(
    current: RetainedReadPolicy | undefined,
    initial: RetainedReadPolicy,
  ) {
    return Boolean(
      current &&
        current.taskId === initial.taskId &&
        current.projectId === initial.projectId &&
        current.taskVersion === initial.taskVersion &&
        current.fingerprint === initial.fingerprint,
    );
  }
  private async retainedPathUnavailable(
    policy: RetainedReadPolicy,
    originRoot: string,
    repositoryId: string | null,
    path: string,
  ): Promise<"excluded" | "unavailable" | undefined> {
    const segments = relativePolicySegments(path);
    if (!segments || !isAbsolute(originRoot)) return "unavailable";
    if (
      (repositoryId !== null &&
        !policy.authorizedRepositoryIds.includes(repositoryId)) ||
      sanitizeConversationText(path, policy.excluded) !== path
    )
      return "excluded";
    if (await retainedPathExcluded(originRoot, segments, policy.controlPaths))
      return "excluded";
    return undefined;
  }
  private async retainedItemUnavailable(
    item: {
      kind: "file" | "diff";
      repositoryId: string | null;
      path: string | null;
      mime?: string;
    },
    bytes: Buffer,
    originRoot: string,
    policy: RetainedReadPolicy,
  ): Promise<"excluded" | "unavailable" | undefined> {
    if (!item.path) return "unavailable";
    const sourcePath = await this.retainedPathUnavailable(
      policy,
      originRoot,
      item.repositoryId,
      item.path,
    );
    if (sourcePath) return sourcePath;
    if (item.kind === "file") {
      if (
        (item.mime?.startsWith("text/") ||
          item.mime === "application/json; charset=utf-8" ||
          item.mime === "application/sql; charset=utf-8") &&
        sanitizeConversationText(bytes.toString("utf8"), policy.excluded) !==
          bytes.toString("utf8")
      )
        return "excluded";
      return undefined;
    }
    const diff = parseRetainedDiff(bytes);
    if (
      !diff ||
      diff.path !== item.path ||
      diff.repositoryId !== item.repositoryId
    )
      return "unavailable";
    for (const path of [
      diff.path,
      ...(diff.previousPath ? [diff.previousPath] : []),
    ]) {
      const unavailable = await this.retainedPathUnavailable(
        policy,
        originRoot,
        diff.repositoryId,
        path,
      );
      if (unavailable) return unavailable;
    }
    const sourceText = bytes.toString("utf8");
    if (sanitizeConversationText(sourceText, policy.excluded) !== sourceText)
      return "excluded";
    for (const side of [diff.left, diff.right])
      if (
        side.state === "text" &&
        sanitizeConversationText(side.text, policy.excluded) !== side.text
      )
        return "excluded";
    return undefined;
  }
  private async workspaceInspectionCurrent(
    taskId: string,
  ): Promise<WorkspaceInspectionCurrent> {
    this.requireTask(taskId);
    const binding = await this.service.taskWorkspace(taskId);
    const task = this.requireTask(taskId);
    return {
      taskId,
      taskVersion: Number(task.version),
      visibility: JSON.stringify({
        operator: this.visibilityToken(),
        workspace: this.service.taskWorkspaceVisibility(taskId),
      }),
      ...(binding ? { binding } : {}),
      controlPaths: [...this.controlPaths],
    };
  }
  private workspaceInspectionFailure(error: unknown): never {
    if (error instanceof OperatorApiError) throw error;
    if (error instanceof WorkspaceInspectionInputError)
      throw new OperatorApiError(400, "invalid-input");
    throw new OperatorApiError(503, "unavailable");
  }
  async readWorkspaceDirectory(
    taskId: string,
    request: Omit<WorkspaceInspectionRequest, "taskId">,
  ) {
    this.requireTask(taskId);
    try {
      const result = await listWorkspaceDirectory({ ...request, taskId }, () =>
        this.workspaceInspectionCurrent(taskId),
      );
      const { observedAt, ...data } = result;
      return workspaceDirectoryReadSchema.parse({ data, observedAt });
    } catch (error) {
      return this.workspaceInspectionFailure(error);
    }
  }
  async readWorkspacePreview(
    taskId: string,
    request: Omit<WorkspaceInspectionRequest, "taskId">,
  ) {
    this.requireTask(taskId);
    try {
      const result = await previewWorkspaceFile({ ...request, taskId }, () =>
        this.workspaceInspectionCurrent(taskId),
      );
      const { observedAt, ...data } = result;
      return workspacePreviewReadSchema.parse({ data, observedAt });
    } catch (error) {
      return this.workspaceInspectionFailure(error);
    }
  }
  async readRetainedResultEvidence(taskId: string, resultId: string) {
    uuid.parse(resultId);
    const task = this.requireTask(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    const unavailable = (reason: "not-retained" | "excluded" | "unavailable") =>
      retainedResultEvidenceReadSchema.parse({
        data: { taskId, resultId, state: "unavailable", reason },
        observedAt: Date.now(),
      });
    if (
      !policy ||
      policy.projectId !== task.projectId ||
      policy.taskVersion !== Number(task.version)
    )
      return unavailable("unavailable");
    const store = this.service.retainedEvidence();
    const manifest = store.result(taskId, resultId);
    if (!manifest) {
      let exists = false;
      try {
        exists =
          this.service.taskReview().result(taskId, resultId) !== undefined;
      } catch {
        exists = false;
      }
      if (!exists) throw new OperatorApiError(404, "not-found");
      const latest = await this.retainedEvidencePolicy(taskId);
      return this.sameRetainedPolicy(latest, policy)
        ? unavailable("not-retained")
        : unavailable("unavailable");
    }
    const items = [];
    let hidden = false;
    for (const item of manifest.items) {
      if (item.state === "gap") {
        items.push({
          itemId: item.itemId,
          kind: item.kind,
          state: "gap" as const,
          reason: item.reason ?? "unavailable",
        });
        continue;
      }
      const content = store.item(taskId, resultId, item.itemId);
      const pathReason = content
        ? await this.retainedItemUnavailable(
            item,
            content.bytes,
            content.originRoot,
            policy,
          )
        : "unavailable";
      const preview = content
        ? previewRetainedBytes(content.bytes, item.mime ?? "")
        : undefined;
      if (
        pathReason ||
        !content ||
        !preview ||
        preview.sha256 !== item.sha256 ||
        preview.size !== item.size
      ) {
        hidden = true;
        items.push({
          itemId: item.itemId,
          kind: item.kind,
          state: "unavailable" as const,
          reason: pathReason ?? "unavailable",
        });
      } else {
        items.push({ ...item, state: "available" as const });
      }
    }
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!this.sameRetainedPolicy(latest, policy))
      return unavailable("unavailable");
    try {
      return retainedResultEvidenceReadSchema.parse({
        data: {
          taskId,
          resultId,
          state: hidden ? "partial" : manifest.state,
          evidenceId: manifest.evidenceId,
          identity: {
            taskVersion: manifest.taskVersion,
            assignmentId: manifest.assignmentId,
            assignmentVersion: manifest.assignmentVersion,
            workId: manifest.workId,
            workRevision: manifest.workRevision,
            requestSequence: manifest.requestSequence,
            conversationRevision: manifest.conversationRevision,
            instructionsRevision: manifest.instructionsRevision,
            profileRevision: manifest.profileRevision,
            profileId: manifest.profileId,
            threadId: manifest.threadId,
            turnId: manifest.turnId,
          },
          capturedAt: manifest.capturedAt,
          sourceObservation: manifest.sourceObservation,
          items,
        },
        observedAt: Date.now(),
      });
    } catch {
      throw new OperatorApiError(503, "unavailable");
    }
  }
  async readRetainedEvidenceItem(
    taskId: string,
    resultId: string,
    itemId: string,
  ) {
    uuid.parse(resultId);
    uuid.parse(itemId);
    const task = this.requireTask(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    const unavailable = (reason: "excluded" | "unavailable") =>
      retainedEvidenceItemContentReadSchema.parse({
        data: { taskId, resultId, itemId, state: "unavailable", reason },
        observedAt: Date.now(),
      });
    if (
      !policy ||
      policy.projectId !== task.projectId ||
      policy.taskVersion !== Number(task.version)
    )
      return unavailable("unavailable");
    const store = this.service.retainedEvidence();
    const manifest = store.result(taskId, resultId);
    if (!manifest) {
      try {
        if (!this.service.taskReview().result(taskId, resultId))
          throw new OperatorApiError(404, "not-found");
      } catch (error) {
        if (error instanceof OperatorApiError) throw error;
        throw new OperatorApiError(404, "not-found");
      }
      const latest = await this.retainedEvidencePolicy(taskId);
      return this.sameRetainedPolicy(latest, policy)
        ? unavailable("unavailable")
        : unavailable("unavailable");
    }
    const item = manifest.items.find(
      (candidate) => candidate.itemId === itemId,
    );
    if (!item) throw new OperatorApiError(404, "not-found");
    if (item.state === "gap") {
      const latest = await this.retainedEvidencePolicy(taskId);
      if (!this.sameRetainedPolicy(latest, policy))
        return unavailable("unavailable");
      return retainedEvidenceItemContentReadSchema.parse({
        data: {
          taskId,
          resultId,
          itemId,
          state: "gap",
          reason: item.reason ?? "unavailable",
        },
        observedAt: Date.now(),
      });
    }
    const content = store.item(taskId, resultId, itemId);
    if (!content) return unavailable("unavailable");
    const reason = await this.retainedItemUnavailable(
      item,
      content.bytes,
      content.originRoot,
      policy,
    );
    if (reason) return unavailable(reason);
    const preview = previewRetainedBytes(content.bytes, item.mime ?? "");
    if (
      !preview ||
      preview.sha256 !== item.sha256 ||
      preview.size !== item.size
    )
      return unavailable("unavailable");
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!this.sameRetainedPolicy(latest, policy))
      return unavailable("unavailable");
    return retainedEvidenceItemContentReadSchema.parse({
      data: {
        taskId,
        resultId,
        itemId,
        state: "available",
        item: { ...item, state: "available" },
        preview,
      },
      observedAt: Date.now(),
    });
  }
  private async retainedAnchorOriginRoot(
    taskId: string,
    repositoryId: string | null,
    retainedRoot?: string,
  ) {
    if (retainedRoot) return retainedRoot;
    const binding = await this.service.taskWorkspace(taskId);
    if (!binding) return undefined;
    if (!repositoryId) return binding.path;
    return binding.repositories.find(
      (repository) => repository.repositoryId === repositoryId,
    )?.workspacePath;
  }
  private async retainedAnchorStatus(
    anchor: NonNullable<
      ReturnType<
        ReturnType<StandaloneService["retainedEvidence"]>["reviewAnchor"]
      >
    >["anchor"],
    bytes: Buffer,
    policy: RetainedReadPolicy,
    originRoot: string,
  ): Promise<"current" | "outdated" | "unknown" | "excluded" | "unavailable"> {
    if (anchor.sourceKind === "workspace-file") {
      const current = await this.workspaceInspectionCurrent(anchor.taskId);
      if (current.binding?.state !== "ready") return "unknown";
      const path = relativePolicySegments(anchor.path);
      if (!path) return "unknown";
      const scope = anchor.repositoryId
        ? { kind: "repository" as const, repositoryId: anchor.repositoryId }
        : { kind: "workspace" as const };
      const preview = await previewWorkspaceFile(
        { taskId: anchor.taskId, scope, path, showIgnored: true },
        () => this.workspaceInspectionCurrent(anchor.taskId),
      );
      if (preview.state !== "ready" || preview.preview?.kind !== "text")
        return "unknown";
      const currentBytes = Buffer.from(preview.preview.text, "utf8");
      if (
        currentBytes.byteLength !== preview.preview.size ||
        createHash("sha256").update(currentBytes).digest("hex") !==
          preview.preview.sha256
      )
        return "unknown";
      if (preview.preview.sha256 !== anchor.sourceSha256) return "outdated";
      return exactRetainedAnchorExcerpt(anchor, currentBytes, bytes)
        ? "current"
        : "unavailable";
    }
    if (anchor.sourceKind === "result-evidence") {
      if (!anchor.resultId || !anchor.resultItemId) return "unknown";
      const store = this.service.retainedEvidence();
      const manifest = store.result(anchor.taskId, anchor.resultId);
      const item = manifest?.items.find(
        (candidate) => candidate.itemId === anchor.resultItemId,
      );
      const content = store.item(
        anchor.taskId,
        anchor.resultId,
        anchor.resultItemId,
      );
      if (
        !manifest ||
        !item ||
        !content ||
        manifest.taskId !== anchor.taskId ||
        manifest.workId !== anchor.workId ||
        item.state !== "available" ||
        item.kind !== "file" ||
        item.path !== anchor.path ||
        item.repositoryId !== anchor.repositoryId ||
        item.sha256 !== anchor.sourceSha256 ||
        createHash("sha256").update(content.bytes).digest("hex") !==
          anchor.sourceSha256
      )
        return "unknown";
      return exactRetainedAnchorExcerpt(anchor, content.bytes, bytes)
        ? "current"
        : "unavailable";
    }

    if (!anchor.comparisonId || anchor.side === "file") return "unknown";
    const exported = this.service.workspaceComparisonExport(
      anchor.taskId,
      anchor.comparisonId,
    );
    if (!exported) return "unknown";
    const comparison = exported.comparison;
    if (
      comparison.taskId !== anchor.taskId ||
      comparison.comparisonId !== anchor.comparisonId ||
      comparison.target !== anchor.context
    )
      return "unknown";
    if (anchor.context === "turn") {
      if (
        exported.captureState !== "finished" ||
        comparison.target !== "turn" ||
        comparison.state !== "available" ||
        comparison.outcome !== "completed" ||
        comparison.workId !== anchor.workId ||
        comparison.threadId !== anchor.threadId ||
        comparison.turnId !== anchor.turnId
      )
        return "unknown";
    } else if (comparison.state !== "available") {
      return "unknown";
    }
    const matches = comparison.entries.filter((entry) => {
      const selectedPath =
        anchor.side === "left"
          ? (entry.previousPath ?? entry.path)
          : entry.path;
      const repositoryId =
        comparison.target === "turn"
          ? (entry.repositoryId ?? null)
          : comparison.repositoryId;
      return (
        selectedPath === anchor.path && repositoryId === anchor.repositoryId
      );
    });
    if (matches.length !== 1) return "unknown";
    const entry = matches[0];
    if (!entry || entry.state !== "text") return "unknown";
    for (const path of [
      entry.path,
      ...(entry.previousPath ? [entry.previousPath] : []),
    ]) {
      const reason = await this.retainedPathUnavailable(
        policy,
        originRoot,
        anchor.repositoryId,
        path,
      );
      if (reason === "excluded") return "excluded";
      if (reason) return "unknown";
    }
    const selectedSide = anchor.side === "left" ? "left" : "right";
    const content = entry[selectedSide];
    const exportedSide = exported.sides.find(
      (side) => side.entryIndex === comparison.entries.indexOf(entry),
    );
    const sideText =
      selectedSide === "left"
        ? exportedSide?.leftText
        : exportedSide?.rightText;
    if (
      !content?.sha256 ||
      sideText === undefined ||
      content.size !== Buffer.byteLength(sideText, "utf8") ||
      content.lineCount !== retainedTextLineCount(sideText) ||
      createHash("sha256")
        .update(Buffer.from(sideText, "utf8"))
        .digest("hex") !== content.sha256
    )
      return "unknown";
    if (content.sha256 !== anchor.sourceSha256) return "outdated";
    return exactRetainedAnchorExcerpt(
      anchor,
      Buffer.from(sideText, "utf8"),
      bytes,
    )
      ? "current"
      : "unavailable";
  }
  async readRetainedReviewAnchor(taskId: string, anchorId: string) {
    uuid.parse(anchorId);
    const task = this.requireTask(taskId);
    const policy = await this.retainedEvidencePolicy(taskId);
    const unavailable = (reason: "excluded" | "unavailable") =>
      retainedReviewAnchorReadSchema.parse({
        data: { taskId, anchorId, state: "unavailable", reason },
        observedAt: Date.now(),
      });
    if (
      !policy ||
      policy.projectId !== task.projectId ||
      policy.taskVersion !== Number(task.version)
    )
      return unavailable("unavailable");
    const retained = this.service
      .retainedEvidence()
      .reviewAnchor(taskId, anchorId);
    if (!retained) throw new OperatorApiError(404, "not-found");
    const { anchor, bytes } = retained;
    const originRoot = await this.retainedAnchorOriginRoot(
      taskId,
      anchor.repositoryId,
      retained.originRoot,
    );
    if (!originRoot) return unavailable("unavailable");
    const latestPath = await this.retainedPathUnavailable(
      policy,
      originRoot,
      anchor.repositoryId,
      anchor.path,
    );
    if (latestPath) return unavailable(latestPath);
    if (anchor.state === "gap" || !bytes) {
      const latest = await this.retainedEvidencePolicy(taskId);
      if (!this.sameRetainedPolicy(latest, policy))
        return unavailable("unavailable");
      try {
        return retainedReviewAnchorReadSchema.parse({
          data: {
            taskId,
            anchorId,
            state: "gap",
            status: "unavailable",
            anchor,
          },
          observedAt: Date.now(),
        });
      } catch {
        throw new OperatorApiError(503, "unavailable");
      }
    }
    const contentReason = await this.retainedItemUnavailable(
      {
        kind: "file",
        repositoryId: anchor.repositoryId,
        path: anchor.path,
        ...(anchor.mime ? { mime: anchor.mime } : {}),
      },
      bytes,
      originRoot,
      policy,
    );
    if (contentReason) return unavailable(contentReason);
    if (
      bytes.byteLength !== anchor.size ||
      createHash("sha256").update(bytes).digest("hex") !== anchor.excerptSha256
    )
      return unavailable("unavailable");
    const preview = previewRetainedBytes(bytes, anchor.mime ?? "");
    if (!preview) return unavailable("unavailable");
    const status = await this.retainedAnchorStatus(
      anchor,
      bytes,
      policy,
      originRoot,
    );
    if (status === "excluded") return unavailable("excluded");
    if (status === "unavailable") return unavailable("unavailable");
    const latest = await this.retainedEvidencePolicy(taskId);
    if (!this.sameRetainedPolicy(latest, policy))
      return unavailable("unavailable");
    try {
      return retainedReviewAnchorReadSchema.parse({
        data: {
          taskId,
          anchorId,
          state: "available",
          status,
          anchor,
          preview,
        },
        observedAt: Date.now(),
      });
    } catch {
      throw new OperatorApiError(503, "unavailable");
    }
  }
  private comparisonRead(
    data: z.input<typeof workspaceComparisonReadSchema>["data"],
  ) {
    try {
      return workspaceComparisonReadSchema.parse({
        data,
        observedAt: Date.now(),
      });
    } catch {
      throw new OperatorApiError(503, "unavailable");
    }
  }
  private comparisonResponse(
    taskId: string,
    target: "branch" | "uncommitted" | "last-turn",
    comparison:
      | WorkspaceComparisonSnapshot
      | NonNullable<WorkspaceTurnCaptureRecord["comparison"]>,
  ) {
    if (comparison.state === "available")
      return this.comparisonRead({
        taskId,
        target,
        state: "available",
        comparisonId: comparison.comparisonId,
        comparison,
      });
    if (comparison.state === "gap")
      return this.comparisonRead({
        taskId,
        target,
        state: "gap",
        comparisonId: comparison.comparisonId,
        comparison,
        ...(comparison.reason ? { reason: comparison.reason } : {}),
      });
    return this.comparisonRead({
      taskId,
      target,
      state: "unavailable",
      comparisonId: comparison.comparisonId,
      comparison,
      reason: comparison.reason ?? "comparison-unavailable",
      ...(comparison.target === "branch"
        ? { availableBaseBranches: comparison.availableBaseBranches }
        : {}),
    });
  }
  private pendingTurnProjection(
    capture: WorkspaceTurnCaptureRecord,
    includeComparison = true,
  ) {
    const {
      before,
      after,
      sides: _sides,
      comparison,
      ...identityAndState
    } = capture;
    return {
      ...identityAndState,
      ...(includeComparison && comparison ? { comparison } : {}),
      captureState:
        capture.captureState === "finished"
          ? "unsettled"
          : capture.captureState,
      ...(before
        ? { beforeState: before.state, beforeObservedAt: before.observedAt }
        : {}),
      ...(after
        ? { afterState: after.state, afterObservedAt: after.observedAt }
        : {}),
    };
  }
  private async storedComparisonVisible(
    initial: WorkspaceInspectionCurrent,
    comparison:
      | WorkspaceComparisonSnapshot
      | NonNullable<WorkspaceTurnCaptureRecord["comparison"]>,
  ) {
    if (comparison.taskId !== initial.taskId) return false;
    const repositoryTarget =
      comparison.target === "turn" ? undefined : comparison.repositoryId;
    const references: WorkspaceInspectionPathReference[] = [];
    for (const entry of comparison.entries) {
      let repositoryId = entry.repositoryId;
      if (repositoryId === undefined && repositoryTarget !== undefined)
        repositoryId = repositoryTarget;
      if (repositoryId === undefined) {
        const anchorRepositoryIds = new Set(
          entry.hunks.flatMap((hunk) =>
            [hunk.leftAnchor, hunk.rightAnchor]
              .filter((anchor) => anchor !== undefined)
              .map((anchor) => anchor.repositoryId),
          ),
        );
        if (anchorRepositoryIds.size !== 1) return false;
        const inferredRepositoryId = anchorRepositoryIds.values().next()
          .value as string | null | undefined;
        if (inferredRepositoryId === undefined) return false;
        repositoryId = inferredRepositoryId;
      }
      if (repositoryTarget !== undefined && repositoryId !== repositoryTarget)
        return false;
      const scope =
        repositoryId === null
          ? ({ kind: "workspace" } as const)
          : ({ kind: "repository", repositoryId } as const);
      const paths = new Set<string>([
        entry.path,
        ...(entry.previousPath ? [entry.previousPath] : []),
        ...entry.hunks.flatMap((hunk) =>
          [hunk.leftAnchor, hunk.rightAnchor]
            .filter((anchor) => anchor !== undefined)
            .map((anchor) => {
              if (anchor.repositoryId !== repositoryId) return "";
              return anchor.path;
            }),
        ),
      ]);
      if (paths.has("")) return false;
      for (const path of paths)
        references.push({ scope, path: path.split("/") });
    }
    return !(await workspaceInspectionPathsExcluded(
      initial.taskId,
      references,
      initial,
      () => this.workspaceInspectionCurrent(initial.taskId),
    ));
  }
  async readWorkspaceComparison(taskId: string, untrustedRequest: unknown) {
    const request =
      workspaceComparisonReadRequestSchema.parse(untrustedRequest);
    this.requireTask(taskId);
    const initial = await this.workspaceInspectionCurrent(taskId);
    const taskVersion = initial.taskVersion;
    const visibility = initial.visibility;
    const stillVisible = async () => {
      const current = await this.workspaceInspectionCurrent(taskId);
      return (
        current.taskVersion === taskVersion && current.visibility === visibility
      );
    };
    const unavailable = (
      target: "branch" | "uncommitted" | "last-turn",
      reason: string,
      comparisonId?: string,
      availableBaseBranches?: readonly string[],
    ) =>
      this.comparisonRead({
        taskId,
        target,
        state: "unavailable",
        reason,
        ...(comparisonId ? { comparisonId } : {}),
        ...(availableBaseBranches
          ? { availableBaseBranches: [...availableBaseBranches] }
          : {}),
      });

    if ("comparisonId" in request) {
      const target = request.target;
      if (target === "last-turn") {
        const slots = this.service.workspaceTurnCaptureSlots(taskId);
        if (slots.pending?.comparisonId === request.comparisonId) {
          if (!(await stillVisible()))
            throw new OperatorApiError(503, "unavailable");
          const includePendingComparison =
            !slots.pending.comparison ||
            (await this.storedComparisonVisible(
              initial,
              slots.pending.comparison,
            ));
          const includeLatestFinished =
            !slots.latestFinished?.comparison ||
            (await this.storedComparisonVisible(
              initial,
              slots.latestFinished.comparison,
            ));
          const latestSlots = this.service.workspaceTurnCaptureSlots(taskId);
          if (latestSlots.pending?.comparisonId !== request.comparisonId)
            return unavailable(
              target,
              "comparison-stale",
              request.comparisonId,
            );
          const includeLatestStillCurrent =
            slots.latestFinished?.comparisonId ===
            latestSlots.latestFinished?.comparisonId;
          const includeStoredComparisons =
            includePendingComparison && includeLatestFinished;
          return this.comparisonRead({
            taskId,
            target,
            state: "unsettled",
            pending: this.pendingTurnProjection(
              slots.pending,
              includeStoredComparisons,
            ),
            ...(slots.latestFinished?.comparison &&
            includeStoredComparisons &&
            includeLatestStillCurrent
              ? { latestFinished: slots.latestFinished.comparison }
              : {}),
          });
        }
        const finished = slots.latestFinished;
        if (
          finished?.comparisonId === request.comparisonId &&
          finished.comparison
        ) {
          if (!(await stillVisible()))
            throw new OperatorApiError(503, "unavailable");
          if (
            !(await this.storedComparisonVisible(initial, finished.comparison))
          )
            return unavailable(
              target,
              "comparison-unavailable",
              request.comparisonId,
            );
          if (
            this.service.workspaceTurnCaptureSlots(taskId).latestFinished
              ?.comparisonId !== request.comparisonId
          )
            return unavailable(
              target,
              "comparison-stale",
              request.comparisonId,
            );
          return this.comparisonResponse(taskId, target, finished.comparison);
        }
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        return unavailable(
          target,
          "comparison-unavailable",
          request.comparisonId,
        );
      }
      const exported = this.service.workspaceComparisonById(
        taskId,
        request.comparisonId,
      );
      const comparison = exported?.comparison;
      if (
        !comparison ||
        comparison.target !== target ||
        !initial.binding?.repositories.some(
          (repository) => repository.repositoryId === comparison.repositoryId,
        )
      ) {
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        return unavailable(
          target,
          "comparison-unavailable",
          request.comparisonId,
        );
      }
      if (!(await stillVisible()))
        throw new OperatorApiError(503, "unavailable");
      if (!(await this.storedComparisonVisible(initial, comparison)))
        return unavailable(
          target,
          "comparison-unavailable",
          request.comparisonId,
        );
      const stillCurrent = this.service.workspaceComparisonById(
        taskId,
        request.comparisonId,
      );
      if (
        !stillCurrent ||
        stillCurrent.comparison.comparisonId !== comparison.comparisonId ||
        stillCurrent.comparison.target !== target
      )
        return unavailable(target, "comparison-stale", request.comparisonId);
      return this.comparisonResponse(taskId, target, comparison);
    }

    if (request.target === "last-turn") {
      const slots = this.service.workspaceTurnCaptureSlots(taskId);
      if (slots.pending) {
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        const includePendingComparison =
          !slots.pending.comparison ||
          (await this.storedComparisonVisible(
            initial,
            slots.pending.comparison,
          ));
        const includeLatestFinished =
          !slots.latestFinished?.comparison ||
          (await this.storedComparisonVisible(
            initial,
            slots.latestFinished.comparison,
          ));
        const latestSlots = this.service.workspaceTurnCaptureSlots(taskId);
        if (latestSlots.pending?.comparisonId !== slots.pending.comparisonId)
          return unavailable("last-turn", "capture-unavailable");
        const includeLatestStillCurrent =
          slots.latestFinished?.comparisonId ===
          latestSlots.latestFinished?.comparisonId;
        const includeStoredComparisons =
          includePendingComparison && includeLatestFinished;
        return this.comparisonRead({
          taskId,
          target: "last-turn",
          state: "unsettled",
          pending: this.pendingTurnProjection(
            slots.pending,
            includeStoredComparisons,
          ),
          ...(slots.latestFinished?.comparison &&
          includeStoredComparisons &&
          includeLatestStillCurrent
            ? { latestFinished: slots.latestFinished.comparison }
            : {}),
        });
      }
      if (slots.latestFinished?.comparison) {
        if (!(await stillVisible()))
          throw new OperatorApiError(503, "unavailable");
        if (
          !(await this.storedComparisonVisible(
            initial,
            slots.latestFinished.comparison,
          ))
        )
          return unavailable(
            "last-turn",
            "capture-unavailable",
            slots.latestFinished.comparisonId,
          );
        if (
          this.service.workspaceTurnCaptureSlots(taskId).latestFinished
            ?.comparisonId !== slots.latestFinished.comparisonId
        )
          return unavailable("last-turn", "capture-unavailable");
        return this.comparisonResponse(
          taskId,
          "last-turn",
          slots.latestFinished.comparison,
        );
      }
      if (!(await stillVisible()))
        throw new OperatorApiError(503, "unavailable");
      return unavailable("last-turn", "capture-unavailable");
    }

    const current = initial.binding;
    if (
      !current ||
      current.state !== "ready" ||
      !current.repositories.some(
        (repository) => repository.repositoryId === request.repositoryId,
      )
    ) {
      return unavailable(request.target, "repository-unavailable");
    }
    const existing = this.service.currentWorkspaceComparison(
      taskId,
      request.repositoryId,
      request.target,
    );
    const snapshot = existing?.comparison;
    const selectionMatches = snapshot
      ? request.target === "branch"
        ? snapshot.target === "branch" &&
          (request.baseBranch === undefined
            ? snapshot.reason === "base-branch-required"
            : snapshot.baseline?.branch === request.baseBranch)
        : snapshot.target === "uncommitted" &&
          snapshot.changeSet === (request.changeSet ?? "all")
      : false;
    if (snapshot && !request.refresh && selectionMatches) {
      if (!(await this.storedComparisonVisible(initial, snapshot)))
        return unavailable(
          request.target,
          "comparison-unavailable",
          snapshot.comparisonId,
        );
      const stillCurrent = this.service.currentWorkspaceComparison(
        taskId,
        request.repositoryId,
        request.target,
      );
      if (stillCurrent?.comparison.comparisonId !== snapshot.comparisonId)
        return unavailable(
          request.target,
          "comparison-stale",
          snapshot.comparisonId,
        );
      return this.comparisonResponse(taskId, request.target, snapshot);
    }
    if (
      request.target === "branch" &&
      request.baseBranch === undefined &&
      snapshot &&
      (snapshot.target !== "branch" ||
        snapshot.reason !== "base-branch-required") &&
      !request.refresh
    ) {
      return unavailable(
        "branch",
        "base-branch-required",
        undefined,
        snapshot && "availableBaseBranches" in snapshot
          ? snapshot.availableBaseBranches
          : [],
      );
    }

    const sideContent = new Map<number, WorkspaceComparisonSideContent>();
    const comparison = await compareRepository(
      {
        taskId,
        repositoryId: request.repositoryId,
        target: request.target,
        ...(request.target === "branch" && request.baseBranch
          ? { baseBranch: request.baseBranch }
          : {}),
        ...(request.target === "uncommitted" && request.changeSet
          ? { changeSet: request.changeSet }
          : {}),
      },
      () => this.workspaceInspectionCurrent(taskId),
      {
        captureSideContent: (entryIndex, side, text) => {
          const value = sideContent.get(entryIndex) ?? { entryIndex };
          if (side === "left") value.leftText = text;
          else value.rightText = text;
          sideContent.set(entryIndex, value);
        },
      },
    );
    if (!(await stillVisible())) throw new OperatorApiError(503, "unavailable");
    if (!(await this.storedComparisonVisible(initial, comparison)))
      return unavailable(
        request.target,
        "comparison-unavailable",
        comparison.comparisonId,
      );
    this.service.replaceWorkspaceComparison(
      comparison,
      [...sideContent.values()].sort(
        (left, right) => left.entryIndex - right.entryIndex,
      ),
    );
    return this.comparisonResponse(taskId, request.target, comparison);
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
  private workspaceSnapshot(taskIds: readonly string[]) {
    return new Map(
      taskIds.map((id) => [id, this.service.taskWorkspaceVisibility(id)]),
    );
  }
  private requireWorkspaceSnapshot(snapshot: ReadonlyMap<string, string>) {
    for (const [id, fingerprint] of snapshot)
      if (this.service.taskWorkspaceVisibility(id) !== fingerprint)
        throw new OperatorApiError(503, "unavailable");
  }
  async readProject(projectId: string) {
    const p = this.requireProject(projectId),
      rows = this.domain().tasks(projectId),
      snapshot = this.workspaceSnapshot(rows.map((t) => String(t.id))),
      excluded = await this.exclusions(projectId);
    const response = {
      data: {
        project: this.project(p, excluded),
        profiles: this.profiles(excluded),
        tasks: await Promise.all(
          rows.map(async (t) => ({
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
    };
    this.requireWorkspaceSnapshot(snapshot);
    return projectSchema.parse(response);
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
    add(
      "question",
      view.questions.filter(
        (i) =>
          i.status === "open" ||
          view.runtimeQuestions?.some(
            (q) =>
              q.interactionId === i.interactionId &&
              q.deliveryState !== "confirmed",
          ),
      ).length,
    );
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
    const page = catalog.slice(index + 1, index + 1 + query.limit),
      snapshot = this.workspaceSnapshot(page.map((t) => t.id)),
      tasks = await Promise.all(page.map((t) => this.taskSummary(t.id)));
    this.requireWorkspaceSnapshot(snapshot);
    return taskListPageSchema.parse({
      data: {
        tasks,
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
    const snapshot = this.workspaceSnapshot(
      catalog.filter((t) => t.projectId === projectId).map((t) => t.id),
    );
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
    this.requireWorkspaceSnapshot(snapshot);
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
  private intactQuestion(
    value: unknown,
    excluded: readonly string[] | undefined,
  ): boolean {
    if (!excluded) return false;
    const serialized = JSON.stringify(value);
    if (excluded.some((v) => v.length > 0 && serialized.includes(v)))
      return false;
    const visit = (v: unknown): boolean =>
      typeof v === "string"
        ? this.exact(v, excluded) === v
        : Array.isArray(v)
          ? v.every(visit)
          : v !== null && typeof v === "object"
            ? Object.entries(v).every(([k, entry]) => visit(k) && visit(entry))
            : true;
    return visit(value);
  }
  async readQuestion(taskId: string, interactionId: string) {
    uuid.parse(interactionId);
    const visibility = this.visibilityToken(),
      workspaceVisibility = this.service.taskWorkspaceVisibility(taskId),
      task = this.requireTask(taskId),
      excluded = await this.exclusions(String(task.projectId), taskId);
    const view = this.coordination(),
      v = view.readTask(taskId),
      interaction = v.questions.find((q) => q.interactionId === interactionId);
    if (!interaction) throw new OperatorApiError(404, "not-found");
    const own = view.questionForm(interactionId),
      native = v.runtimeQuestions?.find(
        (q) => q.interactionId === interactionId,
      );
    const source = native ? "native" : own ? "ensemble" : "plain";
    const form =
      own?.form ??
      (native
        ? nativeQuestionForm(native.request.questions)
        : questionFormSchema.parse({
            version: 1,
            questions: [
              {
                id: "answer",
                kind: "free-text",
                label: "Answer",
                description: interaction.prompt,
                required: true,
                minLength: 1,
              },
            ],
          }));
    let answers: QuestionAnswers | null = own?.answers ?? null;
    if (native?.answers)
      answers = Object.fromEntries(
        native.request.questions.map((q) => {
          const text = native.answers?.[q.id]?.answers[0] ?? "",
            index = q.options.findIndex((o) => o.label === text);
          return [
            q.id,
            {
              optionIds: index < 0 ? [] : [String(index)],
              text: index < 0 ? text : "",
            },
          ];
        }),
      );
    if (source === "plain" && interaction.response !== null)
      answers = { answer: { optionIds: [], text: interaction.response } };
    const intact =
      this.intactQuestion(form, excluded) &&
      this.intactQuestion(answers, excluded);
    const unavailable =
      (own?.requestState !== undefined && own.requestState !== "available") ||
      native?.requestState === "unavailable";
    const status = !intact
      ? "unavailable"
      : interaction.status === "answered"
        ? "recorded"
        : unavailable
          ? own?.requestState === "cancelled"
            ? "cancelled"
            : "unsupported"
          : !native && !view.ownQuestionEligibility(interactionId)
            ? "stale"
            : "pending";
    if (
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId) ||
      this.requireTask(taskId).version !== task.version
    )
      throw new OperatorApiError(503, "unavailable");
    return questionReadSchema.parse({
      data: {
        taskId,
        interactionId,
        requestingAssignmentId: interaction.requestingAssignmentId,
        conversationRevision: interaction.conversationRevision,
        revision: interaction.revision,
        source,
        status,
        form: intact ? form : null,
        answers: intact ? answers : null,
        reason: !intact
          ? "Exact question unavailable under current privacy coverage"
          : unavailable && status === "recorded"
            ? "Answer recorded. Request closed; the retained answer is read-only."
            : unavailable
              ? "Request is unavailable; no answer can be submitted"
              : null,
        deliveryState:
          native?.deliveryState ??
          (answers ? "Recorded; admission remains subject to holds" : null),
      },
      observedAt: Date.now(),
    });
  }
  async readInbox(params = new URLSearchParams()) {
    if (
      [...params.keys()].some((k) => k !== "cursor") ||
      params.getAll("cursor").length > 1
    )
      throw new OperatorApiError(400, "invalid-input");
    const visibility = this.visibilityToken(),
      items: InboxItem[] = [];
    const catalog = this.domain().taskCatalog();
    if (catalog.length > 10000) throw new OperatorApiError(503, "unavailable");
    const tasks = catalog.map((t) => this.requireTask(t.id)),
      snapshot = this.workspaceSnapshot(catalog.map((t) => t.id));
    let unavailable = false;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const taskId = String(task.id);
      try {
        const summary = await this.taskSummary(taskId),
          view = this.coordination().readTask(taskId),
          excluded = await this.exclusions(String(task.projectId), taskId);
        if (!excluded) unavailable = true;
        const base = {
          taskId,
          projectId: String(task.projectId),
          projectName: summary.project.name,
          taskTitle: summary.title,
          evidence: `/app/tasks/${taskId}#history`,
        };
        if (
          summary.attention.codes.some((code) =>
            [
              "execution-uncertain",
              "unresolved-result",
              "completion-rejected",
              "lead-review",
            ].includes(code),
          )
        )
          items.push({
            ...base,
            id: `intervention:${taskId}`,
            kind: "intervention",
            urgency: 0,
            createdAt: null,
            requestingAssignmentId: null,
            requesterName: null,
            interactionId: null,
            revision: null,
            reason:
              "Recorded intervention requires exact recovery or review; responsibility unknown",
            destination: `/app/tasks/${taskId}`,
            conversation: null,
          });
        for (const q of [...view.questions, ...view.approvals]) {
          const native = view.runtimeQuestions?.find(
            (n) => n.interactionId === q.interactionId,
          );
          if (
            q.status !== "open" &&
            (!native || native.deliveryState === "confirmed")
          )
            continue;
          const requester = this.domain()
            .assignments(taskId)
            .find((a) => a.id === q.requestingAssignmentId);
          const name = requester
            ? this.safe(
                this.domain().profile(String(requester.profileId)).name,
                excluded,
              )
            : null;
          items.push({
            ...base,
            id: q.interactionId,
            kind: q.kind,
            urgency: 1,
            createdAt: q.createdAt * 1000, // coordination SQLite timestamps are unix seconds.
            requestingAssignmentId: q.requestingAssignmentId,
            requesterName: name,
            interactionId: q.interactionId,
            revision: q.revision,
            reason:
              q.kind === "approval"
                ? "Review exact approval material"
                : native && q.status === "answered"
                  ? "Answer recorded; native delivery remains unresolved"
                  : "Operator answer requested",
            destination:
              q.kind === "question"
                ? `/app/tasks/${taskId}?request=${q.interactionId}`
                : `/coordination/task/${taskId}#${q.interactionId}`,
            conversation: `/app/tasks/${taskId}?assignment=${q.requestingAssignmentId}#history`,
          });
        }
        if (this.requireTask(taskId).version !== task.version)
          throw new OperatorApiError(503, "unavailable");
      } catch (error) {
        if (error instanceof OperatorApiError) throw error;
        unavailable = true;
      }
      if (i % 20 === 19) await yieldTraversal();
    }
    if (visibility !== this.visibilityToken())
      throw new OperatorApiError(503, "unavailable");
    this.requireWorkspaceSnapshot(snapshot);
    for (const task of tasks) {
      const current = this.requireTask(String(task.id));
      if (
        current.version !== task.version ||
        current.projectId !== task.projectId
      )
        throw new OperatorApiError(503, "unavailable");
    }
    items.sort(
      (a, b) =>
        a.urgency - b.urgency ||
        (a.createdAt ?? Number.MAX_SAFE_INTEGER) -
          (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(items))
      .digest("hex")
      .slice(0, 24);
    const cursor = params.get("cursor");
    let offset = 0;
    if (cursor) {
      const match = cursor.match(/^([a-f0-9]{24}):([0-9]+)$/);
      if (!match || match[1] !== fingerprint)
        throw new OperatorApiError(409, "conflict");
      offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length)
        throw new OperatorApiError(400, "invalid-input");
    }
    const next =
      offset + 100 < items.length ? `${fingerprint}:${offset + 100}` : null;
    return inboxReadSchema.parse({
      data: {
        items: items.slice(offset, offset + 100),
        nextCursor: next,
        complete: next === null && !unavailable,
        unavailable,
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
    const workspaceVisibility = this.service.taskWorkspaceVisibility(taskId);
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
      ...(m.questionAnswers && this.intactQuestion(m.questionAnswers, excluded)
        ? { questionAnswers: m.questionAnswers }
        : {}),
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
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId) ||
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
          const workspaceVisibility = this.service.taskWorkspaceVisibility(
            String(task.id),
          );
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
            workspaceVisibility !==
              this.service.taskWorkspaceVisibility(String(task.id)) ||
            this.requireTask(String(task.id)).version !== task.version
          )
            throw new OperatorApiError(503, "unavailable");
          return assignmentHistorySchema.parse({
            data: {
              ...history,
              visibilityRevision: createHash("sha256")
                .update(`${visibility}:${task.version}:${workspaceVisibility}`)
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
    const workspaceVisibility = this.service.taskWorkspaceVisibility(taskId);
    const t = this.requireTask(taskId),
      excluded = await this.exclusions(String(t.projectId), taskId);
    const data = await this.reviewProjection(taskId, excluded, selection);
    if (
      visibility !== this.visibilityToken() ||
      workspaceVisibility !== this.service.taskWorkspaceVisibility(taskId) ||
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
      versions = new Map<string, number>(),
      workspaceVisibilities = new Map<string, string>();
    let omittedCount = 0;
    for (const row of page) {
      try {
        const taskId = String(row.taskId),
          t = this.requireTask(taskId),
          p = this.requireProject(String(t.projectId)),
          workspaceVisibility = this.service.taskWorkspaceVisibility(taskId),
          snapshot = workspaceVisibilities.has(taskId)
            ? workspaceVisibilities.get(taskId)!
            : (workspaceVisibilities.set(taskId, workspaceVisibility),
              workspaceVisibility),
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
        if (snapshot !== this.service.taskWorkspaceVisibility(taskId)) {
          omittedCount++;
          continue;
        }
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
          workspaceVisibilities.get(m.taskId) !==
            this.service.taskWorkspaceVisibility(m.taskId) ||
          String(current.projectId) !== m.projectId ||
          (query.projectId && String(current.projectId) !== query.projectId)
        )
          return false;
        this.requireProject(m.projectId);
        if (!eligibleRecords.has(m.recordId)) return false;
        const currentRecord = this.service
          .taskReview()
          .isCurrentSearchRecord(m.taskId, m.sourceId, m.resultId);
        m.historical = !currentRecord;
        return query.historical || currentRecord;
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
    const owner = this.service.taskReview().artifactOwner(taskId, artifactId);
    if (owner) {
      const manifest = this.service
        .retainedEvidence()
        .result(taskId, owner.resultId);
      if (manifest) {
        const item = manifest.items.find(
          (candidate) => candidate.artifactId === artifactId,
        );
        if (
          !item ||
          item.state !== "available" ||
          item.source !== "artifact-file"
        )
          throw new OperatorApiError(503, "unavailable");
        const response = await this.readRetainedEvidenceItem(
          taskId,
          owner.resultId,
          item.itemId,
        );
        const data = response.data;
        if (
          data.state !== "available" ||
          data.item.artifactId !== artifactId ||
          data.item.source !== "artifact-file"
        )
          throw new OperatorApiError(503, "unavailable");
        const body =
          data.preview.kind === "text"
            ? Buffer.from(data.preview.text, "utf8")
            : Buffer.from(data.preview.data, "base64");
        if (
          body.byteLength !== data.item.size ||
          createHash("sha256").update(body).digest("hex") !== data.item.sha256
        )
          throw new OperatorApiError(503, "unavailable");
        return { body, type: data.preview.mime };
      }
    }
    try {
      return await previewRecordedArtifact(async () => {
        const visibility = this.visibilityToken();
        const workspaceVisibility =
          this.service.taskWorkspaceVisibility(taskId);
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
          workspaceVisibility !==
            this.service.taskWorkspaceVisibility(taskId) ||
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
            workspaceVisibility,
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
      taskRows = new Map(
        projects.map((p) => [String(p.id), d.tasks(String(p.id))]),
      ),
      snapshot = this.workspaceSnapshot(
        [...taskRows.values()].flatMap((rows) => rows.map((t) => String(t.id))),
      ),
      excluded = await this.exclusions(),
      limits = this.service.capacityLimits(projects.map((p) => String(p.id)));
    const response = {
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
                (taskRows.get(id) ?? []).map(async (t) => {
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
    };
    this.requireWorkspaceSnapshot(snapshot);
    return runtimeSettingsSchema.parse(response);
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
      snapshot = this.workspaceSnapshot([taskId]),
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
    this.requireWorkspaceSnapshot(snapshot);
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
      if (
        type === "question.form.answer" ||
        type === "question.native.answer"
      ) {
        if (c.type === "question.form.answer") {
          const prior = view.recordedQuestionFormAnswer({
            taskId: c.taskId,
            key: c.key,
            interactionId: c.interactionId,
            expectedRevision: c.expectedRevision,
            answers: c.answers,
          });
          if (prior)
            return commandReceiptSchema.parse({
              kind: "coordination",
              key: c.key,
              recorded: true,
              eventId: prior.eventId,
              taskId: prior.taskId,
              recipientAssignmentId: prior.recipientAssignmentId,
              eventType: prior.eventType,
              createdAt: prior.createdAt,
            });
        }
        if (c.type === "question.native.answer") {
          const { type: _type, ...input } = c;
          const prior = view.recordedRuntimeQuestionAnswer(input);
          if (prior)
            return commandReceiptSchema.parse({
              kind: "native-question",
              key: c.key,
              taskId: c.taskId,
              ...prior,
            });
        }
        const current = await this.readQuestion(c.taskId, c.interactionId);
        if (!current.data.form) throw new OperatorApiError(403, "forbidden");
        if (type === "question.native.answer") {
          const receipt = await view.answerRuntimeQuestion(
            command as Parameters<typeof view.answerRuntimeQuestion>[0],
          );
          return commandReceiptSchema.parse({
            kind: "native-question",
            key: c.key,
            taskId: c.taskId,
            ...receipt,
          });
        }
        const receipt = await view.answerQuestionForm(
          command as Parameters<typeof view.answerQuestionForm>[0],
        );
        return commandReceiptSchema.parse({
          kind: "coordination",
          key: c.key,
          recorded: true,
          ...receipt,
        });
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
