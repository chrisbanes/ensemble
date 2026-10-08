import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReviewMetadata } from "../core/task-review.js";
import {
  emptyRetainedEvidenceCandidate,
  retainedEvidenceLimits,
  type RetainedEvidenceStore,
  type RetainedEvidenceCandidate,
  type RetainedEvidenceIdentity,
  type RetainedEvidenceItemInput,
  type RetainedReviewAnchorCandidate,
  type RetainedEvidenceSourceObservation,
} from "../core/retained-evidence.js";
import { sanitizeConversationText } from "./conversation-history.js";
import type {
  WorkspaceComparisonEntry,
  WorkspaceComparisonExport,
  WorkspaceComparisonSideContent,
  WorkspaceTurnCaptureRecord,
} from "./workspace-comparison.js";
import {
  previewWorkspaceFile,
  workspaceInspectionPathExcluded,
  type WorkspaceInspectionCurrent,
  type WorkspaceInspectionScope,
} from "./workspace-inspection.js";
import type { TaskWorkspaceBinding } from "./workspaces.js";
import { z } from "zod";

const reviewAnchorSelectionSchema = z
  .object({
    taskId: z.string().uuid(),
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    sourceKind: z.enum([
      "workspace-file",
      "comparison-side",
      "result-evidence",
    ]),
    context: z.enum(["workspace", "branch", "uncommitted", "turn", "result"]),
    comparisonId: z.string().uuid().optional(),
    resultId: z.string().uuid().optional(),
    resultItemId: z.string().uuid().optional(),
    workId: z.string().min(1).max(512).optional(),
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    side: z.enum(["file", "left", "right"]),
    startLine: z.number().int().positive().safe(),
    endLine: z.number().int().positive().safe(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((selection, ctx) => {
    if (selection.endLine < selection.startLine)
      ctx.addIssue({ code: "custom", message: "invalid-anchor-range" });
    if (
      (selection.sourceKind === "workspace-file" &&
        (selection.context !== "workspace" ||
          selection.side !== "file" ||
          selection.comparisonId !== undefined ||
          selection.resultItemId !== undefined)) ||
      (selection.sourceKind === "comparison-side" &&
        (!(["branch", "uncommitted", "turn"] as const).includes(
          selection.context as "branch" | "uncommitted" | "turn",
        ) ||
          selection.side === "file" ||
          selection.comparisonId === undefined ||
          selection.resultItemId !== undefined)) ||
      (selection.sourceKind === "result-evidence" &&
        (selection.context !== "result" ||
          selection.side !== "file" ||
          selection.resultId === undefined ||
          selection.resultItemId === undefined ||
          selection.comparisonId !== undefined ||
          selection.workId === undefined))
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-source-context-mismatch",
      });
    if (
      selection.context === "turn" &&
      (!selection.workId || !selection.threadId || !selection.turnId)
    )
      ctx.addIssue({
        code: "custom",
        message: "turn-anchor-identity-required",
      });
    if (
      selection.resultId !== undefined &&
      selection.sourceKind !== "result-evidence" &&
      !selection.workId
    )
      ctx.addIssue({
        code: "custom",
        message: "result-anchor-work-identity-required",
      });
  });

export const retainedReviewAnchorStageRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    operationId: z.string().uuid(),
    anchors: z.array(reviewAnchorSelectionSchema).max(32),
  })
  .strict()
  .superRefine((request, ctx) => {
    for (const [index, anchor] of request.anchors.entries())
      if (anchor.taskId !== request.taskId)
        ctx.addIssue({
          code: "custom",
          path: ["anchors", index, "taskId"],
          message: "anchor-task-mismatch",
        });
  });
export type RetainedReviewAnchorSelection = z.infer<
  typeof reviewAnchorSelectionSchema
>;
export type RetainedReviewAnchorStageRequest = z.infer<
  typeof retainedReviewAnchorStageRequestSchema
>;

export interface CaptureRetainedReviewAnchorInput {
  selection: RetainedReviewAnchorSelection;
  identity: Pick<RetainedEvidenceIdentity, "taskId" | "captureTaskVersion">;
  currentWorkspace: () => Promise<WorkspaceInspectionCurrent>;
  currentPolicy: () => Promise<RetainedEvidenceCapturePolicy | undefined>;
  exportComparison: (
    comparisonId: string,
  ) => WorkspaceComparisonExport | undefined;
  comparisonOwner: (comparisonId: string) => string | undefined;
  retainedEvidence: RetainedEvidenceStore;
}

export interface RetainedEvidenceCapturePolicy {
  taskVersion: number;
  fingerprint: string;
  excluded: readonly string[];
  authorizedRepositoryIds: readonly string[];
}

export interface CaptureRetainedResultEvidenceInput {
  identity: RetainedEvidenceIdentity;
  review: ReviewMetadata | undefined;
  currentWorkspace: () => Promise<WorkspaceInspectionCurrent>;
  currentPolicy: () => Promise<RetainedEvidenceCapturePolicy | undefined>;
  turnCaptures: {
    latestFinished?: WorkspaceTurnCaptureRecord;
    pending?: WorkspaceTurnCaptureRecord;
  };
  exportComparison: (
    comparisonId: string,
  ) => WorkspaceComparisonExport | undefined;
}

type FileLocation = {
  scope: WorkspaceInspectionScope;
  path: string[];
  originRoot: string;
  repositoryId: string | null;
};

const validRelativePath = (path: string): string[] | undefined => {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\\")
  )
    return undefined;
  const segments = path.split("/");
  if (
    segments.length > 32 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /\p{Cc}/u.test(segment) ||
        Buffer.from(segment, "utf8").toString("utf8") !== segment,
    ) ||
    Buffer.byteLength(path, "utf8") > 2048
  )
    return undefined;
  return segments;
};

const rootLocation = (
  binding: TaskWorkspaceBinding | undefined,
  path: string,
  repositoryId?: string | null,
  inferSingleRepository = false,
): FileLocation | undefined => {
  const segments = validRelativePath(path);
  if (!segments || !binding) return undefined;
  if (repositoryId) {
    const repository = binding.repositories.find(
      (item) => item.repositoryId === repositoryId,
    );
    if (!repository) return undefined;
    return {
      scope: { kind: "repository", repositoryId },
      path: segments,
      originRoot: repository.workspacePath,
      repositoryId,
    };
  }
  if (
    repositoryId === undefined &&
    inferSingleRepository &&
    binding.repositories.length === 1
  ) {
    const repository = binding.repositories[0];
    if (!repository) return undefined;
    return {
      scope: { kind: "repository", repositoryId: repository.repositoryId },
      path: segments,
      originRoot: repository.workspacePath,
      repositoryId: repository.repositoryId,
    };
  }
  const repository = binding.repositories.find((item) => {
    const mount = relative(binding.path, item.workspacePath);
    return (
      mount &&
      !mount.startsWith("../") &&
      mount !== ".." &&
      !mount.includes("/") &&
      segments[0] === mount
    );
  });
  if (repository) {
    const mount = relative(binding.path, repository.workspacePath);
    const remainder = segments.slice(1);
    if (remainder.length === 0) return undefined;
    return {
      scope: { kind: "repository", repositoryId: repository.repositoryId },
      path: remainder,
      originRoot: repository.workspacePath,
      repositoryId: repository.repositoryId,
    };
  }
  return {
    scope: { kind: "workspace" },
    path: segments,
    originRoot: binding.path,
    repositoryId: null,
  };
};

const selectedCapture = (
  captures: CaptureRetainedResultEvidenceInput["turnCaptures"],
  identity: RetainedEvidenceIdentity,
) => {
  const matches = (capture: WorkspaceTurnCaptureRecord | undefined) =>
    Boolean(
      capture &&
        capture.identity.taskId === identity.taskId &&
        capture.identity.workId === identity.workId &&
        capture.identity.workRevision === identity.workRevision &&
        capture.identity.requestSequence === identity.requestSequence &&
        capture.identity.assignmentId === identity.assignmentId &&
        capture.identity.assignmentVersion === identity.assignmentVersion &&
        capture.identity.instructionsRevision ===
          identity.instructionsRevision &&
        capture.identity.profileRevision === identity.profileRevision &&
        capture.identity.profileId === identity.profileId &&
        capture.threadId === identity.threadId &&
        capture.turnId === identity.turnId,
    );
  if (matches(captures.pending)) return captures.pending;
  if (matches(captures.latestFinished)) return captures.latestFinished;
  return undefined;
};

const observationFor = (
  capture: WorkspaceTurnCaptureRecord | undefined,
  exported: WorkspaceComparisonExport | undefined,
): RetainedEvidenceSourceObservation => {
  if (!capture)
    return {
      comparisonId: null,
      captureState: "missing",
      outcome: null,
      observedAt: null,
    };
  const state = exported?.captureState ?? capture.captureState;
  return {
    comparisonId: capture.comparisonId,
    captureState:
      state === "finished" || state === "pending" || state === "unsettled"
        ? state
        : "unsettled",
    outcome:
      exported?.comparison.target === "turn"
        ? exported.comparison.outcome
        : capture.outcome,
    observedAt:
      exported?.comparison.target === "turn"
        ? exported.comparison.observedAt
        : capture.observedAt,
  };
};

const gapItem = (
  input: Pick<
    RetainedEvidenceItemInput,
    "kind" | "source" | "sourceIndex" | "capturedAt" | "observedAt"
  > & { repositoryId?: string | null; artifactId?: string },
  reason: NonNullable<RetainedEvidenceItemInput["reason"]>,
): RetainedEvidenceItemInput => ({
  itemId: randomUUID(),
  kind: input.kind,
  state: "gap",
  reason,
  source: input.source,
  sourceIndex: input.sourceIndex,
  repositoryId: null,
  path: null,
  originRoot: null,
  ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  size: 0,
  capturedAt: input.capturedAt,
  observedAt: input.observedAt,
  provenance: {},
});

export function failedRetainedResultEvidenceCandidate(
  identity: RetainedEvidenceIdentity,
  review: ReviewMetadata | undefined,
): RetainedEvidenceCandidate {
  const candidate = emptyRetainedEvidenceCandidate(identity);
  const capturedAt = candidate.capturedAt;
  const items: RetainedEvidenceItemInput[] = [];
  for (const [index, artifact] of (review?.artifacts ?? []).entries())
    if (artifact.file)
      items.push(
        gapItem(
          {
            kind: "file",
            source: "artifact-file",
            sourceIndex: index,
            capturedAt,
            observedAt: null,
            artifactId: artifact.artifactId,
          },
          "unavailable",
        ),
      );
  for (const [index] of (review?.changes?.files ?? []).entries()) {
    items.push(
      gapItem(
        {
          kind: "file",
          source: "change-file",
          sourceIndex: index,
          capturedAt,
          observedAt: null,
        },
        "unavailable",
      ),
    );
    items.push(
      gapItem(
        {
          kind: "diff",
          source: "observed-diff",
          sourceIndex: index,
          capturedAt,
          observedAt: null,
        },
        "comparison-unavailable",
      ),
    );
  }
  candidate.items = items;
  return candidate;
}

const readReason = (
  state: string,
  metadataReason?: string,
): NonNullable<RetainedEvidenceItemInput["reason"]> => {
  if (state === "excluded") return "excluded";
  if (state === "conflict") return "changing";
  if (state === "missing") return "missing";
  if (metadataReason === "too-large") return "too-large";
  if (metadataReason === "binary-content") return "binary";
  if (metadataReason === "unsupported-format") return "unsupported";
  if (metadataReason === "invalid-content") return "invalid-content";
  if (metadataReason === "multiple-links") return "too-many-links";
  return "unavailable";
};

const lineCount = (text: string) => {
  if (!text) return 0;
  let lines = 0;
  for (const character of text) if (character === "\n") lines++;
  return text.endsWith("\n") ? lines : lines + 1;
};

function canonicalMaterial(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalMaterial).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalMaterial(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function retainedReviewAnchorMaterialHash(
  request: RetainedReviewAnchorStageRequest,
): string {
  return createHash("sha256").update(canonicalMaterial(request)).digest("hex");
}

function anchorLineRange(
  bytes: Buffer,
  startLine: number,
  endLine: number,
): { bytes: Buffer; byteStart: number; byteEnd: number } | undefined {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a) {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < bytes.length) ranges.push({ start, end: bytes.length });
  if (endLine > ranges.length) return undefined;
  const byteStart = ranges[startLine - 1]?.start;
  const byteEnd = ranges[endLine - 1]?.end;
  if (byteStart === undefined || byteEnd === undefined) return undefined;
  return {
    bytes: Buffer.from(bytes.subarray(byteStart, byteEnd)),
    byteStart,
    byteEnd,
  };
}

const anchorReasonForPreview = (state: string): "missing" | "unavailable" =>
  state === "missing" ? "missing" : "unavailable";

function gapReviewAnchorCandidate(
  selection: RetainedReviewAnchorSelection,
  reason: NonNullable<RetainedReviewAnchorCandidate["reason"]>,
  observedAt: number | null,
  capturedAt = Date.now(),
): RetainedReviewAnchorCandidate {
  return {
    anchorId: randomUUID(),
    taskId: selection.taskId,
    repositoryId: selection.repositoryId,
    path: selection.path,
    sourceKind: selection.sourceKind,
    context: selection.context,
    ...(selection.comparisonId ? { comparisonId: selection.comparisonId } : {}),
    ...(selection.resultId ? { resultId: selection.resultId } : {}),
    ...(selection.resultItemId ? { resultItemId: selection.resultItemId } : {}),
    ...(selection.workId ? { workId: selection.workId } : {}),
    ...(selection.threadId ? { threadId: selection.threadId } : {}),
    ...(selection.turnId ? { turnId: selection.turnId } : {}),
    side: selection.side,
    startLine: selection.startLine,
    endLine: selection.endLine,
    claimedSha256: selection.contentSha256,
    state: "gap",
    reason,
    size: 0,
    capturedAt,
    observedAt,
  };
}

function availableReviewAnchorCandidate(
  selection: RetainedReviewAnchorSelection,
  sourceBytes: Buffer,
  mime: string,
  observedAt: number,
  originRoot: string,
): RetainedReviewAnchorCandidate {
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceSha256 !== selection.contentSha256)
    throw new Error("Review anchor content changed");
  const selected = anchorLineRange(
    sourceBytes,
    selection.startLine,
    selection.endLine,
  );
  if (!selected) throw new Error("Review anchor range is invalid");
  const excerptSha256 = createHash("sha256")
    .update(selected.bytes)
    .digest("hex");
  return {
    anchorId: randomUUID(),
    taskId: selection.taskId,
    repositoryId: selection.repositoryId,
    path: selection.path,
    originRoot,
    sourceKind: selection.sourceKind,
    context: selection.context,
    ...(selection.comparisonId ? { comparisonId: selection.comparisonId } : {}),
    ...(selection.resultId ? { resultId: selection.resultId } : {}),
    ...(selection.resultItemId ? { resultItemId: selection.resultItemId } : {}),
    ...(selection.workId ? { workId: selection.workId } : {}),
    ...(selection.threadId ? { threadId: selection.threadId } : {}),
    ...(selection.turnId ? { turnId: selection.turnId } : {}),
    side: selection.side,
    startLine: selection.startLine,
    endLine: selection.endLine,
    sourceSha256,
    excerptSha256,
    byteStart: selected.byteStart,
    byteEnd: selected.byteEnd,
    mime,
    state: "available",
    size: selected.bytes.byteLength,
    capturedAt: Date.now(),
    observedAt,
    bytes: new Uint8Array(selected.bytes),
  };
}

function textFromBytes(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
}

function reviewPathSegments(path: string): string[] | undefined {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\\") ||
    Buffer.byteLength(path, "utf8") > 2048
  )
    return undefined;
  const segments = path.split("/");
  if (
    segments.length > 32 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /\p{Cc}/u.test(segment) ||
        Buffer.from(segment, "utf8").toString("utf8") !== segment,
    )
  )
    return undefined;
  return segments;
}

function anchorOriginRoot(
  binding: TaskWorkspaceBinding,
  repositoryId: string | null,
): string {
  if (!repositoryId) return binding.path;
  const root = binding.repositories.find(
    (repository) => repository.repositoryId === repositoryId,
  )?.workspacePath;
  if (!root) throw new Error("Review anchor repository binding mismatch");
  return root;
}

function privateReviewPath(segments: readonly string[]): boolean {
  return segments.some((segment) => {
    const name = segment.normalize("NFC").toLocaleLowerCase("und");
    return (
      name === ".git" ||
      name === ".ssh" ||
      name === ".aws" ||
      name === ".gnupg" ||
      name === ".netrc" ||
      name === ".npmrc" ||
      name === ".pypirc" ||
      name === ".env" ||
      name.startsWith(".env.") ||
      name.endsWith(".pem") ||
      name.endsWith(".key")
    );
  });
}

async function assertReviewAnchorPathAllowed(
  taskId: string,
  repositoryId: string | null,
  path: string,
  currentWorkspace: () => Promise<WorkspaceInspectionCurrent>,
  policy: RetainedEvidenceCapturePolicy,
  originRoot?: string,
): Promise<"ready" | "unavailable"> {
  const segments = reviewPathSegments(path);
  if (!segments) throw new Error("Unsafe review anchor path");
  if (
    (repositoryId && !policy.authorizedRepositoryIds.includes(repositoryId)) ||
    sanitizeConversationText(path, policy.excluded) !== path ||
    privateReviewPath(segments)
  )
    throw new Error("Review anchor path is excluded");
  const current = await currentWorkspace();
  if (current.taskId !== taskId)
    throw new Error("Review anchor task binding changed");
  if (current.binding?.state === "ready") {
    const scope: WorkspaceInspectionScope = repositoryId
      ? { kind: "repository", repositoryId }
      : { kind: "workspace" };
    if (
      await workspaceInspectionPathExcluded(
        taskId,
        scope,
        segments,
        currentWorkspace,
      )
    )
      throw new Error("Review anchor path is excluded");
    return "ready";
  }
  if (originRoot && isAbsolute(originRoot)) {
    const target = resolve(originRoot, ...segments);
    if (
      target !== originRoot &&
      !target.startsWith(`${resolve(originRoot)}${sep}`)
    )
      throw new Error("Unsafe retained review anchor path");
    for (const excluded of policy.excluded) {
      if (!isAbsolute(excluded)) continue;
      const resolved = resolve(excluded);
      if (target === resolved || target.startsWith(`${resolved}${sep}`))
        throw new Error("Review anchor path is excluded");
    }
    return "ready";
  }
  return "unavailable";
}

function validateOptionalResultBinding(
  selection: RetainedReviewAnchorSelection,
  store: RetainedEvidenceStore,
  sourceSha256: string,
  comparisonId?: string,
  comparison?: WorkspaceComparisonExport["comparison"],
) {
  if (!selection.resultId) return;
  const manifest = store.result(selection.taskId, selection.resultId);
  if (
    !manifest ||
    manifest.workId !== selection.workId ||
    manifest.taskId !== selection.taskId ||
    (selection.threadId !== undefined &&
      manifest.threadId !== selection.threadId) ||
    (selection.turnId !== undefined && manifest.turnId !== selection.turnId)
  )
    throw new Error("Review anchor result binding mismatch");

  if (selection.sourceKind === "comparison-side") {
    if (
      comparisonId === undefined ||
      comparison === undefined ||
      comparison.target !== "turn" ||
      manifest.sourceObservation.comparisonId !== comparisonId ||
      comparison.comparisonId !== comparisonId ||
      comparison.taskId !== manifest.taskId ||
      comparison.taskVersion !== manifest.taskVersion ||
      comparison.workId !== manifest.workId ||
      comparison.workRevision !== manifest.workRevision ||
      comparison.requestSequence !== manifest.requestSequence ||
      comparison.assignmentId !== manifest.assignmentId ||
      comparison.assignmentVersion !== manifest.assignmentVersion ||
      comparison.instructionsRevision !== manifest.instructionsRevision ||
      comparison.profileRevision !== manifest.profileRevision ||
      comparison.profileId !== manifest.profileId ||
      comparison.threadId !== manifest.threadId ||
      comparison.turnId !== manifest.turnId
    )
      throw new Error("Review anchor result binding mismatch");
    return;
  }

  if (
    selection.sourceKind !== "workspace-file" ||
    !manifest.items.some(
      (item) =>
        item.state === "available" &&
        item.kind === "file" &&
        item.path === selection.path &&
        item.repositoryId === selection.repositoryId &&
        item.sha256 === sourceSha256,
    )
  )
    throw new Error("Review anchor result binding mismatch");
}

export async function captureRetainedReviewAnchor(
  input: CaptureRetainedReviewAnchorInput,
): Promise<RetainedReviewAnchorCandidate> {
  const selection = reviewAnchorSelectionSchema.parse(input.selection);
  if (selection.taskId !== input.identity.taskId)
    throw new Error("Review anchor task binding mismatch");
  const capturedAt = Date.now();
  const policy = await input.currentPolicy();
  if (!policy) throw new Error("Review anchor policy is unavailable");
  if (policy.taskVersion !== input.identity.captureTaskVersion)
    throw new Error("Review anchor task version changed");
  if (
    (selection.repositoryId &&
      !policy.authorizedRepositoryIds.includes(selection.repositoryId)) ||
    sanitizeConversationText(selection.path, policy.excluded) !== selection.path
  )
    throw new Error("Review anchor path is excluded");

  if (selection.sourceKind === "result-evidence") {
    const manifest = input.retainedEvidence.result(
      selection.taskId,
      selection.resultId as string,
    );
    const record = manifest?.items.find(
      (item) => item.itemId === selection.resultItemId,
    );
    if (
      !manifest ||
      !record ||
      manifest.taskId !== selection.taskId ||
      manifest.workId !== selection.workId ||
      record.state !== "available" ||
      record.kind !== "file" ||
      record.path !== selection.path ||
      record.repositoryId !== selection.repositoryId ||
      record.sha256 !== selection.contentSha256
    )
      throw new Error("Review anchor result source mismatch");
    const content = input.retainedEvidence.item(
      selection.taskId,
      selection.resultId as string,
      selection.resultItemId as string,
    );
    if (!content)
      throw new Error("Review anchor result content is unavailable");
    const allowed = await assertReviewAnchorPathAllowed(
      selection.taskId,
      selection.repositoryId,
      selection.path,
      input.currentWorkspace,
      policy,
      content.originRoot,
    );
    if (allowed !== "ready")
      return gapReviewAnchorCandidate(
        selection,
        "unavailable",
        null,
        capturedAt,
      );
    const [currentPolicy, currentWorkspace] = await Promise.all([
      input.currentPolicy(),
      input.currentWorkspace(),
    ]);
    if (
      !currentPolicy ||
      currentPolicy.taskVersion !== input.identity.captureTaskVersion ||
      currentPolicy.fingerprint !== policy.fingerprint ||
      currentWorkspace.taskVersion !== input.identity.captureTaskVersion
    )
      throw new Error("Review anchor policy changed during capture");
    const sourceText = textFromBytes(content.bytes);
    if (
      !sourceText ||
      !content.item.mime?.startsWith("text/") ||
      createHash("sha256").update(content.bytes).digest("hex") !==
        selection.contentSha256
    )
      throw new Error("Review anchor result content is invalid");
    return availableReviewAnchorCandidate(
      selection,
      content.bytes,
      content.item.mime,
      content.item.observedAt ?? content.item.capturedAt,
      content.originRoot,
    );
  }

  if (selection.sourceKind === "workspace-file") {
    const workspace = await input.currentWorkspace();
    if (
      workspace.taskVersion !== input.identity.captureTaskVersion ||
      policy.taskVersion !== input.identity.captureTaskVersion ||
      workspace.binding?.state !== "ready"
    )
      return gapReviewAnchorCandidate(
        selection,
        "unavailable",
        null,
        capturedAt,
      );
    const segments = reviewPathSegments(selection.path);
    if (!segments) throw new Error("Unsafe review anchor path");
    let scope: WorkspaceInspectionScope;
    let previewPath = segments;
    if (selection.repositoryId) {
      scope = { kind: "repository", repositoryId: selection.repositoryId };
    } else {
      scope = { kind: "workspace" };
      const repository = workspace.binding.repositories.find((item) => {
        const mount = relative(
          workspace.binding?.path ?? "",
          item.workspacePath,
        );
        return (
          mount &&
          !mount.startsWith("../") &&
          mount !== ".." &&
          !mount.includes("/") &&
          segments[0] === mount
        );
      });
      if (repository)
        throw new Error("Workspace anchor path must use repository identity");
    }
    if (
      await workspaceInspectionPathExcluded(
        selection.taskId,
        scope,
        previewPath,
        input.currentWorkspace,
      )
    )
      throw new Error("Review anchor path is excluded");
    const preview = await previewWorkspaceFile(
      { taskId: selection.taskId, scope, path: previewPath, showIgnored: true },
      input.currentWorkspace,
    );
    if (preview.state !== "ready" || preview.preview?.kind !== "text")
      return gapReviewAnchorCandidate(
        selection,
        anchorReasonForPreview(preview.state),
        preview.observedAt,
        capturedAt,
      );
    const sourceBytes = Buffer.from(preview.preview.text, "utf8");
    if (
      preview.preview.size !== sourceBytes.byteLength ||
      createHash("sha256").update(sourceBytes).digest("hex") !==
        preview.preview.sha256
    )
      throw new Error("Review anchor file observation is inconsistent");
    validateOptionalResultBinding(
      selection,
      input.retainedEvidence,
      preview.preview.sha256,
    );
    const latestPolicy = await input.currentPolicy();
    const latestWorkspace = await input.currentWorkspace();
    if (
      !latestPolicy ||
      latestPolicy.taskVersion !== input.identity.captureTaskVersion ||
      latestPolicy.fingerprint !== policy.fingerprint ||
      latestWorkspace.taskVersion !== workspace.taskVersion ||
      latestWorkspace.visibility !== workspace.visibility
    )
      throw new Error("Review anchor binding changed during capture");
    return availableReviewAnchorCandidate(
      selection,
      sourceBytes,
      preview.preview.mime,
      preview.observedAt,
      anchorOriginRoot(workspace.binding, selection.repositoryId),
    );
  }

  const exported = input.exportComparison(selection.comparisonId as string);
  if (!exported) {
    const owner = input.comparisonOwner(selection.comparisonId as string);
    if (owner && owner !== selection.taskId)
      throw new Error("Review anchor comparison identity mismatch");
    return gapReviewAnchorCandidate(
      selection,
      "comparison-unavailable",
      null,
      capturedAt,
    );
  }
  const comparison = exported.comparison;
  if (
    comparison.taskId !== selection.taskId ||
    comparison.comparisonId !== selection.comparisonId
  )
    throw new Error("Review anchor comparison identity mismatch");
  if (comparison.target !== selection.context)
    throw new Error("Review anchor comparison context mismatch");
  if (
    (selection.context === "turn" &&
      (exported.captureState !== "finished" ||
        comparison.target !== "turn" ||
        comparison.state !== "available" ||
        comparison.outcome !== "completed")) ||
    (selection.context !== "turn" && comparison.state !== "available")
  )
    return gapReviewAnchorCandidate(
      selection,
      exported.captureState === "pending" ||
        exported.captureState === "unsettled"
        ? "comparison-unsettled"
        : "comparison-unavailable",
      comparison.observedAt,
      capturedAt,
    );
  if (selection.context === "turn") {
    if (
      comparison.target !== "turn" ||
      comparison.workId !== selection.workId ||
      comparison.threadId !== selection.threadId ||
      comparison.turnId !== selection.turnId
    )
      throw new Error("Review anchor turn identity mismatch");
  }

  const entryMatches = comparison.entries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => {
      const expectedPath =
        selection.side === "left"
          ? (entry.previousPath ?? entry.path)
          : entry.path;
      const expectedRepository =
        comparison.target === "turn"
          ? (entry.repositoryId ?? null)
          : comparison.repositoryId;
      return (
        expectedPath === selection.path &&
        expectedRepository === selection.repositoryId
      );
    });
  if (entryMatches.length !== 1)
    throw new Error("Review anchor comparison source mismatch");
  const { entry, entryIndex } = entryMatches[0] as {
    entry: WorkspaceComparisonEntry;
    entryIndex: number;
  };
  const currentWorkspace = await input.currentWorkspace();
  if (
    currentWorkspace.taskVersion !== input.identity.captureTaskVersion ||
    policy.taskVersion !== input.identity.captureTaskVersion ||
    currentWorkspace.binding?.state !== "ready"
  )
    return gapReviewAnchorCandidate(
      selection,
      "unavailable",
      comparison.observedAt,
      capturedAt,
    );
  const entryPaths = [
    entry.path,
    ...(entry.previousPath ? [entry.previousPath] : []),
  ];
  for (const path of entryPaths) {
    const segments = reviewPathSegments(path);
    if (!segments) throw new Error("Unsafe review comparison path");
    if (
      await workspaceInspectionPathExcluded(
        selection.taskId,
        selection.repositoryId
          ? { kind: "repository", repositoryId: selection.repositoryId }
          : { kind: "workspace" },
        segments,
        input.currentWorkspace,
      )
    )
      throw new Error("Review comparison path is excluded");
  }
  const side = sideMap(exported.sides).get(entryIndex);
  const sideText = exactSideText(
    entry,
    selection.side as "left" | "right",
    side,
  );
  const metadata = entry[selection.side as "left" | "right"];
  if (
    entry.state !== "text" ||
    !sideText ||
    !metadata ||
    metadata.sha256 !== selection.contentSha256 ||
    metadata.lineCount !== lineCount(sideText)
  )
    throw new Error("Review anchor side or range is invalid");
  validateOptionalResultBinding(
    selection,
    input.retainedEvidence,
    metadata.sha256,
    selection.comparisonId,
    comparison,
  );
  const latestPolicy = await input.currentPolicy();
  const latestWorkspace = await input.currentWorkspace();
  if (
    !latestPolicy ||
    latestPolicy.taskVersion !== input.identity.captureTaskVersion ||
    latestPolicy.fingerprint !== policy.fingerprint ||
    latestWorkspace.taskVersion !== currentWorkspace.taskVersion ||
    latestWorkspace.visibility !== currentWorkspace.visibility
  )
    throw new Error("Review anchor binding changed during capture");
  const bytes = Buffer.from(sideText, "utf8");
  return availableReviewAnchorCandidate(
    selection,
    bytes,
    "text/plain; charset=utf-8",
    comparison.observedAt,
    anchorOriginRoot(currentWorkspace.binding, selection.repositoryId),
  );
}

const sideMap = (sides: readonly WorkspaceComparisonSideContent[]) =>
  new Map(sides.map((side) => [side.entryIndex, side]));

function exactSideText(
  entry: WorkspaceComparisonEntry,
  side: "left" | "right",
  content: WorkspaceComparisonSideContent | undefined,
): string | undefined {
  const metadata = entry[side];
  if (!metadata) return undefined;
  const text = side === "left" ? content?.leftText : content?.rightText;
  if (
    text === undefined ||
    !metadata.sha256 ||
    metadata.size !== Buffer.byteLength(text, "utf8") ||
    createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") !==
      metadata.sha256 ||
    metadata.lineCount !== lineCount(text)
  )
    return undefined;
  return text;
}

async function diffPayload(
  entry: WorkspaceComparisonEntry,
  entryIndex: number,
  sides: readonly WorkspaceComparisonSideContent[],
  comparisonId: string,
  taskId: string,
  currentWorkspace: () => Promise<WorkspaceInspectionCurrent>,
  policy: RetainedEvidenceCapturePolicy,
) {
  if (entry.state !== "text" || entry.diff === undefined)
    return { reason: "comparison-unavailable" as const };
  if (!entry.path || validRelativePath(entry.path) === undefined)
    return { reason: "unsafe-path" as const };
  const repositoryId = entry.repositoryId ?? null;
  if (repositoryId && !policy.authorizedRepositoryIds.includes(repositoryId))
    return { reason: "excluded" as const };
  const scope: WorkspaceInspectionScope = repositoryId
    ? { kind: "repository", repositoryId }
    : { kind: "workspace" };
  const paths = [
    entry.path,
    ...(entry.previousPath ? [entry.previousPath] : []),
  ];
  if (entry.previousPath && validRelativePath(entry.previousPath) === undefined)
    return { reason: "unsafe-path" as const };
  for (const path of paths)
    if (
      await workspaceInspectionPathExcluded(
        taskId,
        scope,
        validRelativePath(path) ?? [],
        currentWorkspace,
      )
    )
      return { reason: "excluded" as const };

  const content = sideMap(sides).get(entryIndex);
  const leftText = exactSideText(entry, "left", content);
  const rightText = exactSideText(entry, "right", content);
  const leftAbsent = entry.left === undefined && entry.change === "added";
  const rightAbsent = entry.right === undefined && entry.change === "deleted";
  const hasValidSides =
    (leftAbsent || leftText !== undefined) &&
    (rightAbsent || rightText !== undefined) &&
    (entry.change === "added"
      ? leftAbsent && !rightAbsent && rightText !== undefined
      : true) &&
    (entry.change === "deleted"
      ? rightAbsent && !leftAbsent && leftText !== undefined
      : true) &&
    (entry.change === "modified" || entry.change === "renamed"
      ? leftText !== undefined && rightText !== undefined
      : true);
  if (!hasValidSides) return { reason: "source-mismatch" as const };
  const sideTexts = [leftText, rightText].filter(
    (text): text is string => text !== undefined,
  );
  if (
    sideTexts.some(
      (text) => sanitizeConversationText(text, policy.excluded) !== text,
    )
  )
    return { reason: "excluded" as const };
  const payload = {
    version: 1,
    comparisonId,
    entryIndex,
    repositoryId,
    path: entry.path,
    ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
    change: entry.change,
    left: leftAbsent
      ? { state: "absent" as const }
      : { state: "text" as const, content: entry.left, text: leftText },
    right: rightAbsent
      ? { state: "absent" as const }
      : { state: "text" as const, content: entry.right, text: rightText },
    diff: entry.diff,
    hunks: entry.hunks,
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.byteLength > retainedEvidenceLimits.maxDiffBytes)
    return { reason: "too-large" as const };
  if (
    sanitizeConversationText(bytes.toString("utf8"), policy.excluded) !==
    bytes.toString("utf8")
  )
    return { reason: "excluded" as const };
  return {
    bytes,
    repositoryId,
    path: entry.path,
    previousPath: entry.previousPath,
  };
}

function comparisonMatches(
  capture: WorkspaceTurnCaptureRecord,
  exported: WorkspaceComparisonExport | undefined,
  identity: RetainedEvidenceIdentity,
) {
  if (
    !exported ||
    exported.captureState !== "finished" ||
    capture.captureState !== "finished"
  )
    return false;
  const comparison = exported.comparison;
  return (
    comparison.target === "turn" &&
    comparison.state !== "unavailable" &&
    comparison.outcome === "completed" &&
    comparison.taskId === identity.taskId &&
    comparison.taskVersion === identity.taskVersion &&
    comparison.comparisonId === capture.comparisonId &&
    comparison.workId === identity.workId &&
    comparison.workRevision === identity.workRevision &&
    comparison.requestSequence === identity.requestSequence &&
    comparison.assignmentId === identity.assignmentId &&
    comparison.assignmentVersion === identity.assignmentVersion &&
    comparison.instructionsRevision === identity.instructionsRevision &&
    comparison.profileRevision === identity.profileRevision &&
    comparison.profileId === identity.profileId &&
    comparison.threadId === identity.threadId &&
    comparison.turnId === identity.turnId
  );
}

export async function captureRetainedResultEvidence(
  input: CaptureRetainedResultEvidenceInput,
): Promise<RetainedEvidenceCandidate> {
  const { identity, review } = input;
  const capturedAt = Date.now();
  const metadata = review;
  const fileReferences = (metadata?.artifacts ?? []).filter(
    (artifact) => artifact.file !== undefined,
  );
  const changeReferences = metadata?.changes?.files ?? [];
  let capture =
    changeReferences.length > 0
      ? selectedCapture(input.turnCaptures, identity)
      : undefined;
  let exported: WorkspaceComparisonExport | undefined;
  if (capture) {
    try {
      exported = input.exportComparison(capture.comparisonId);
    } catch {
      exported = undefined;
    }
  }
  const sourceObservation = observationFor(capture, exported);
  const exactComparison =
    capture && comparisonMatches(capture, exported, identity)
      ? exported
      : undefined;
  const observation = exactComparison
    ? observationFor(capture, exactComparison)
    : sourceObservation;
  const base = emptyRetainedEvidenceCandidate(identity, sourceObservation);
  base.capturedAt = capturedAt;
  const items: RetainedEvidenceItemInput[] = [];
  let workspace: WorkspaceInspectionCurrent | undefined;
  let policy: RetainedEvidenceCapturePolicy | undefined;
  try {
    [workspace, policy] = await Promise.all([
      input.currentWorkspace(),
      input.currentPolicy(),
    ]);
  } catch {
    workspace = undefined;
    policy = undefined;
  }
  const binding = workspace?.binding;
  const addFile = async (
    source: "artifact-file" | "change-file",
    sourceIndex: number,
    path: string,
    repositoryId?: string | null,
    artifact?: ReviewMetadata["artifacts"][number],
    inferSingleRepository = false,
  ) => {
    const location = rootLocation(
      binding,
      path,
      repositoryId,
      inferSingleRepository,
    );
    const baseItem = {
      kind: "file" as const,
      source,
      sourceIndex,
      capturedAt,
      observedAt: null,
      ...(artifact ? { artifactId: artifact.artifactId } : {}),
    };
    if (!location) {
      items.push(gapItem(baseItem, binding ? "unsafe-path" : "unavailable"));
      return;
    }
    if (
      location.repositoryId &&
      policy &&
      !policy.authorizedRepositoryIds.includes(location.repositoryId)
    ) {
      items.push(gapItem(baseItem, "excluded"));
      return;
    }
    if (!policy || !workspace) {
      items.push(gapItem(baseItem, "unavailable"));
      return;
    }
    if (
      workspace.taskId !== identity.taskId ||
      workspace.taskVersion !== identity.captureTaskVersion ||
      policy.taskVersion !== identity.captureTaskVersion
    ) {
      items.push(gapItem(baseItem, "binding-changed"));
      return;
    }
    if (artifact && artifact.availability !== "available") {
      items.push(
        gapItem(
          baseItem,
          artifact.availability === "redacted" ? "excluded" : "unavailable",
        ),
      );
      return;
    }
    let preview: Awaited<ReturnType<typeof previewWorkspaceFile>>;
    try {
      preview = await previewWorkspaceFile(
        {
          taskId: identity.taskId,
          scope: location.scope,
          path: location.path,
          showIgnored: true,
        },
        input.currentWorkspace,
        { captureContentHash: true },
      );
    } catch {
      items.push(gapItem(baseItem, "unavailable"));
      return;
    }
    if (preview.state !== "ready" || !preview.preview) {
      items.push(
        gapItem(
          { ...baseItem, observedAt: preview.observedAt },
          readReason(preview.state, preview.metadata?.reason),
        ),
      );
      return;
    }
    let bytes: Buffer;
    if (preview.preview.kind === "text") {
      if (
        sanitizeConversationText(preview.preview.text, policy.excluded) !==
        preview.preview.text
      ) {
        items.push(
          gapItem({ ...baseItem, observedAt: preview.observedAt }, "excluded"),
        );
        return;
      }
      bytes = Buffer.from(preview.preview.text, "utf8");
    } else {
      bytes = Buffer.from(preview.preview.data, "base64");
    }
    if (
      bytes.byteLength !== preview.preview.size ||
      createHash("sha256").update(bytes).digest("hex") !==
        preview.preview.sha256 ||
      (artifact &&
        (artifact.file?.sha256 !== preview.preview.sha256 ||
          artifact.file.size !== preview.preview.size ||
          artifact.file.mime !== preview.preview.mime))
    ) {
      items.push(
        gapItem(
          { ...baseItem, observedAt: preview.observedAt },
          "invalid-content",
        ),
      );
      return;
    }
    items.push({
      itemId: randomUUID(),
      kind: "file",
      state: "available",
      source,
      sourceIndex,
      repositoryId: location.repositoryId,
      path: location.path.join("/"),
      originRoot: location.originRoot,
      ...(artifact ? { artifactId: artifact.artifactId } : {}),
      mime: preview.preview.mime,
      sha256: preview.preview.sha256,
      size: bytes.byteLength,
      capturedAt,
      observedAt: preview.observedAt,
      provenance: artifact
        ? { role: artifact.role, revision: artifact.revision }
        : { changeFileIndex: sourceIndex },
      bytes: Uint8Array.from(bytes),
    });
  };

  for (const [index, artifact] of fileReferences.entries()) {
    const originalIndex = (metadata?.artifacts ?? []).indexOf(artifact);
    if (!artifact.file) continue;
    await addFile(
      "artifact-file",
      originalIndex >= 0 ? originalIndex : index,
      artifact.file.relativePath,
      null,
      artifact,
    );
  }
  for (const [index, path] of changeReferences.entries()) {
    const normalized = validRelativePath(path)?.join("/");
    const selected = exactComparison?.comparison.entries
      .map((entry, entryIndex) => ({ entry, entryIndex }))
      .filter(
        ({ entry }) =>
          entry.path === normalized || entry.previousPath === normalized,
      );
    if (selected?.length === 1) {
      const entry = selected[0]?.entry;
      if (entry)
        await addFile(
          "change-file",
          index,
          entry.path,
          entry.repositoryId ?? null,
        );
      continue;
    }
    await addFile("change-file", index, path, undefined, undefined, true);
  }
  const diffItems: RetainedEvidenceItemInput[] = [];
  let diffBytes = 0;
  for (const [index, path] of changeReferences.entries()) {
    const baseItem = {
      kind: "diff" as const,
      source: "observed-diff" as const,
      sourceIndex: index,
      capturedAt,
      observedAt: observation.observedAt,
    };
    if (
      !workspace ||
      !policy ||
      workspace.taskId !== identity.taskId ||
      workspace.taskVersion !== identity.captureTaskVersion ||
      policy.taskVersion !== identity.captureTaskVersion
    ) {
      diffItems.push(gapItem(baseItem, "binding-changed"));
      continue;
    }
    if (!exactComparison || exactComparison.comparison.target !== "turn") {
      const reason =
        observation.captureState === "pending" ||
        observation.captureState === "unsettled"
          ? "comparison-unsettled"
          : "comparison-unavailable";
      diffItems.push(gapItem(baseItem, reason));
      continue;
    }
    const entries = exactComparison.comparison.entries;
    const pathSegments = validRelativePath(path);
    if (!pathSegments) {
      diffItems.push(gapItem(baseItem, "unsafe-path"));
      continue;
    }
    const bindingForPath = workspace?.binding;
    const mountRepo = bindingForPath?.repositories.find((repository) => {
      const mount = relative(bindingForPath.path, repository.workspacePath);
      return mount && !mount.includes("/") && pathSegments[0] === mount;
    });
    const candidatePath = mountRepo ? pathSegments.slice(1).join("/") : path;
    const repoFromMount = mountRepo?.repositoryId;
    const matches = entries
      .map((entry, entryIndex) => ({ entry, entryIndex }))
      .filter(
        ({ entry }) =>
          entry.path === candidatePath || entry.previousPath === candidatePath,
      )
      .filter(({ entry }) =>
        repoFromMount ? entry.repositoryId === repoFromMount : true,
      );
    if (matches.length !== 1) {
      diffItems.push(
        gapItem(
          baseItem,
          matches.length === 0 ? "source-mismatch" : "source-mismatch",
        ),
      );
      continue;
    }
    const selected = matches[0];
    if (!selected) {
      diffItems.push(gapItem(baseItem, "source-mismatch"));
      continue;
    }
    const value = await diffPayload(
      selected.entry,
      selected.entryIndex,
      exactComparison.sides,
      observation.comparisonId ?? "",
      identity.taskId,
      input.currentWorkspace,
      policy ?? {
        taskVersion: identity.captureTaskVersion,
        fingerprint: "",
        excluded: [],
        authorizedRepositoryIds: [],
      },
    );
    if (!("bytes" in value)) {
      diffItems.push(gapItem(baseItem, value.reason));
      continue;
    }
    if (
      diffBytes + value.bytes.byteLength >
      retainedEvidenceLimits.maxDiffBytes
    ) {
      diffItems.push(gapItem(baseItem, "too-large"));
      continue;
    }
    diffBytes += value.bytes.byteLength;
    const repoRoot = value.repositoryId
      ? binding?.repositories.find(
          (repo) => repo.repositoryId === value.repositoryId,
        )?.workspacePath
      : binding?.path;
    if (!value.path || !repoRoot) {
      diffItems.push(gapItem(baseItem, "unavailable"));
      continue;
    }
    diffItems.push({
      itemId: randomUUID(),
      kind: "diff",
      state: "available",
      source: "observed-diff",
      sourceIndex: index,
      repositoryId: value.repositoryId ?? null,
      path: value.path,
      originRoot: repoRoot,
      mime: "application/vnd.ensemble.workspace-diff+json",
      sha256: createHash("sha256").update(value.bytes).digest("hex"),
      size: value.bytes.byteLength,
      capturedAt,
      observedAt: observation.observedAt,
      provenance: {
        comparisonId: observation.comparisonId ?? "",
        entryIndex: selected.entryIndex,
        change: selected.entry.change,
        ...(value.previousPath ? { previousPath: value.previousPath } : {}),
      },
      bytes: Uint8Array.from(value.bytes),
    });
  }
  items.push(...diffItems);

  try {
    const finalPolicy = await input.currentPolicy();
    if (
      !policy ||
      !finalPolicy ||
      finalPolicy.taskVersion !== identity.captureTaskVersion ||
      finalPolicy.fingerprint !== policy.fingerprint
    ) {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item?.state === "available")
          items[index] = gapItem(
            {
              kind: item.kind,
              source: item.source,
              sourceIndex: item.sourceIndex,
              capturedAt: item.capturedAt,
              observedAt: item.observedAt,
              ...(item.artifactId ? { artifactId: item.artifactId } : {}),
            },
            "binding-changed",
          );
      }
    }
  } catch {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item?.state === "available")
        items[index] = gapItem(
          {
            kind: item.kind,
            source: item.source,
            sourceIndex: item.sourceIndex,
            capturedAt: item.capturedAt,
            observedAt: item.observedAt,
            ...(item.artifactId ? { artifactId: item.artifactId } : {}),
          },
          "unavailable",
        );
    }
  }
  base.sourceObservation = observation;
  base.items = items;
  return base;
}
