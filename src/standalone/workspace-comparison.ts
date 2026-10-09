import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  inspectionLimits,
  listWorkspaceDirectory,
  previewWorkspaceFile,
  type WorkspaceInspectionCurrent,
  type WorkspaceInspectionScope,
  workspaceInspectionPathExcluded,
  workspaceInspectionRootGuard,
} from "./workspace-inspection.js";

export const workspaceComparisonLimits = Object.freeze({
  maxEntriesScanned: 4096,
  maxEntriesReturned: 256,
  maxFileBytes: inspectionLimits.maxTextBytes,
  maxTotalBytes: 8 * 1024 * 1024,
  maxGitOutputBytes: 2 * 1024 * 1024,
  maxDiffOutputBytes: 1024 * 1024,
  maxLinesPerSide: 2048,
  maxDiffOperations: 4_000_000,
  maxDurationMs: 5_000,
  gitTimeoutMs: 1_500,
});

const maxFilterDriverNames = 64;
const maxFilterDriverNameBytes = 64;
const maxFilterConfigBytes = 16 * 1024;

export type WorkspaceComparisonTarget = "branch" | "uncommitted";
export type WorkspaceComparisonContext =
  | "branch"
  | "uncommitted"
  | "turn"
  | "result";
export type WorkspaceComparisonSide = "left" | "right";

export interface WorkspaceComparisonAnchor {
  taskId: string;
  repositoryId: string | null;
  path: string;
  comparisonId: string;
  context: WorkspaceComparisonContext;
  workId?: string;
  resultId?: string;
  threadId?: string;
  turnId?: string;
  side: WorkspaceComparisonSide;
  startLine: number;
  endLine: number;
  contentSha256: string;
}

export interface WorkspaceComparisonHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
  leftAnchor?: WorkspaceComparisonAnchor;
  rightAnchor?: WorkspaceComparisonAnchor;
}

export interface WorkspaceComparisonContent {
  sha256?: string;
  objectId?: string;
  size: number | null;
  lineCount: number | null;
  modifiedAt?: number | null;
}

export type WorkspaceComparisonEntryState =
  | "text"
  | "binary"
  | "unsupported"
  | "gap";

export interface WorkspaceComparisonEntry {
  path: string;
  repositoryId?: string | null;
  previousPath?: string;
  change: "added" | "modified" | "deleted" | "renamed" | "type-changed";
  changeSet?: "branch" | "staged" | "unstaged";
  state: WorkspaceComparisonEntryState;
  diff?: string;
  left?: WorkspaceComparisonContent;
  right?: WorkspaceComparisonContent;
  hunks: WorkspaceComparisonHunk[];
  reason?:
    | "too-large"
    | "invalid-text"
    | "unsupported-format"
    | "changing"
    | "unavailable"
    | "output-limit"
    | "time-limit";
}

export interface WorkspaceComparisonSnapshot {
  comparisonId: string;
  taskId: string;
  repositoryId: string;
  target: WorkspaceComparisonTarget;
  changeSet?: "all" | "staged" | "unstaged";
  state: "available" | "unavailable" | "gap";
  observedAt: number;
  baseline?: {
    kind: "merge-base" | "head";
    branch?: string;
    commit: string;
  };
  availableBaseBranches: string[];
  entries: WorkspaceComparisonEntry[];
  truncated: boolean;
  reason?:
    | "workspace-unavailable"
    | "repository-unavailable"
    | "base-branch-required"
    | "base-branch-unavailable"
    | "no-merge-base"
    | "head-unavailable"
    | "git-failed"
    | "time-limit"
    | "output-limit"
    | "unsafe-path"
    | "workspace-changed";
}

export interface WorkspaceComparisonSideContent {
  entryIndex: number;
  leftText?: string;
  rightText?: string;
}

export interface WorkspaceComparisonExport {
  comparison: WorkspaceComparisonSnapshot | WorkspaceTurnComparisonSnapshot;
  sides: WorkspaceComparisonSideContent[];
  captureState?: "pending" | "unsettled" | "finished";
}

export interface WorkspaceTurnWorkIdentity {
  taskId: string;
  /** Task revision admitted by this exact turn request. */
  taskVersion: number;
  workId: string;
  workRevision: number;
  requestSequence: number;
  assignmentId: string;
  assignmentVersion: number;
  instructionsRevision: number;
  profileRevision: number;
  profileId: string;
}

export interface WorkspaceTurnFileSnapshot {
  repositoryId: string | null;
  path: string;
  state: "text" | "binary" | "unsupported" | "gap";
  content: WorkspaceComparisonContent;
  text?: string;
  reason?: WorkspaceComparisonEntry["reason"];
  kind: "file" | "symlink" | "other";
}

export interface WorkspaceTurnObservation {
  observedAt: number;
  state: "available" | "gap";
  reason?: WorkspaceComparisonSnapshot["reason"] | "unsupported-content";
  files: WorkspaceTurnFileSnapshot[];
  truncated: boolean;
}

export interface WorkspaceTurnComparisonSnapshot {
  comparisonId: string;
  taskId: string;
  target: "turn";
  state: "available" | "gap" | "unavailable";
  outcome: "completed" | "failed" | "unknown";
  startedAt: number;
  beforeObservedAt?: number;
  observedAt: number;
  taskVersion: number;
  workId: string;
  workRevision: number;
  requestSequence: number;
  assignmentId: string;
  assignmentVersion: number;
  instructionsRevision: number;
  profileRevision: number;
  profileId: string;
  threadId?: string;
  turnId?: string;
  entries: WorkspaceComparisonEntry[];
  truncated: boolean;
  reason?: WorkspaceTurnObservation["reason"];
}

export interface WorkspaceTurnCaptureRecord {
  comparisonId: string;
  identity: WorkspaceTurnWorkIdentity;
  captureState: "pending" | "unsettled" | "finished";
  outcome: "running" | "completed" | "failed" | "unknown";
  startedAt: number;
  observedAt: number;
  threadId?: string;
  turnId?: string;
  before?: WorkspaceTurnObservation;
  after?: WorkspaceTurnObservation;
  comparison?: WorkspaceTurnComparisonSnapshot;
  sides?: WorkspaceComparisonSideContent[];
  reason?: WorkspaceTurnCaptureReason;
}

export type WorkspaceTurnCaptureReason =
  | WorkspaceTurnObservation["reason"]
  | "runtime-uncertain"
  | "turn-unbound"
  | "callback-unfinished"
  | "capture-store-failed";

export interface CompareRepositoryRequest {
  taskId: string;
  repositoryId: string;
  target: WorkspaceComparisonTarget;
  /** Only a user-selected local branch may be supplied; refs are never inferred. */
  baseBranch?: string;
  changeSet?: "all" | "staged" | "unstaged";
}

export interface CompareRepositoryOptions {
  /** Test-only executable override; production always resolves the `git` command. */
  gitExecutable?: string;
  /** Test-only shortened total and child deadlines. */
  timeoutMs?: number;
  gitTimeoutMs?: number;
  /** Test-only observation after a successful Git read; receives no paths/output. */
  afterGitRead?: () => Promise<void>;
  /** Test-only observation after a safe working file handle is opened. */
  afterWorkingFileOpen?: (path: string) => Promise<void>;
  /** Internal bounded handoff of exact text sides to SQLite, never to the API response. */
  captureSideContent?: (
    entryIndex: number,
    side: WorkspaceComparisonSide,
    text: string,
  ) => void;
}

type RawChange = {
  oldMode: string;
  newMode: string;
  oldObject: string;
  newObject: string;
  status: string;
  oldPath: string;
  newPath: string;
};
type ComparisonChangeSet = NonNullable<WorkspaceComparisonEntry["changeSet"]>;

type GitRead =
  | { ok: true; output: Buffer }
  | {
      ok: false;
      reason: "failed" | "timed-out" | "output-limit" | "unsettled";
      exitCode?: number | null;
      output?: Buffer;
    };

type ContentObservation = {
  state: "text" | "binary" | "unsupported" | "gap";
  text?: string;
  content: WorkspaceComparisonContent;
  reason?: WorkspaceComparisonEntry["reason"];
};

const zeroObjectId = /^0+$/;
const validObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const unsupportedExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".svg",
]);
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopOwnedChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    // The exact child may already have closed.
  }
  if (await waitForExit(child, 50)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    // The exact child may already have closed.
  }
  return waitForExit(child, 250);
}

async function readGit(
  root: string,
  args: readonly string[],
  startedAt: number,
  options: CompareRepositoryOptions,
  configOverrides: readonly string[] = [],
): Promise<GitRead> {
  const remaining =
    (options.timeoutMs ?? workspaceComparisonLimits.maxDurationMs) -
    (Date.now() - startedAt);
  if (remaining <= 0) return { ok: false, reason: "timed-out" };
  const timeoutMs = Math.max(
    1,
    Math.min(
      options.gitTimeoutMs ?? workspaceComparisonLimits.gitTimeoutMs,
      remaining,
    ),
  );
  return await new Promise((resolveRead) => {
    let child: ChildProcess;
    try {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(environment))
        if (key.startsWith("GIT_")) delete environment[key];
      environment.GIT_ALLOW_PROTOCOL = "";
      environment.GIT_NO_LAZY_FETCH = "1";
      environment.GIT_OPTIONAL_LOCKS = "0";
      environment.GIT_TERMINAL_PROMPT = "0";
      child = spawn(
        options.gitExecutable ?? "git",
        [
          "-C",
          root,
          "--no-replace-objects",
          "-c",
          "core.fsmonitor=false",
          ...configOverrides,
          ...args,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: environment,
        },
      );
    } catch {
      resolveRead({ ok: false, reason: "failed" });
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stdoutBytes = 0;
    let settled = false;
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    let failure: "timed-out" | "output-limit" | "failed" | undefined;
    const finish = (result: GitRead) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRead(result);
    };
    const stop = async (reason: "timed-out" | "output-limit" | "failed") => {
      if (stopping || settled) return;
      stopping = true;
      failure = reason;
      const exited = await stopOwnedChild(child);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ ok: false, reason: exited ? reason : "unsettled" });
    };
    child.once("error", () => void stop("failed"));
    child.once("close", (code) => {
      if (stopping || settled) return;
      if (failure || code !== 0) {
        finish({
          ok: false,
          reason: failure ?? "failed",
          ...(failure === undefined
            ? { exitCode: code, output: Buffer.concat(chunks, stdoutBytes) }
            : {}),
        });
        return;
      }
      finish({ ok: true, output: Buffer.concat(chunks, stdoutBytes) });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      stdoutBytes += chunk.length;
      if (outputBytes > workspaceComparisonLimits.maxGitOutputBytes) {
        void stop("output-limit");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > workspaceComparisonLimits.maxGitOutputBytes)
        void stop("output-limit");
    });
    timer = setTimeout(() => void stop("timed-out"), timeoutMs);
  });
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    for (const character of text) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        (codePoint < 0x20 &&
          codePoint !== 0x09 &&
          codePoint !== 0x0a &&
          codePoint !== 0x0d) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      )
        return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function pathSegments(path: string): string[] | undefined {
  if (!path || path.startsWith("/") || path.includes("\\")) return undefined;
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0") ||
        segment.includes("\ufffd") ||
        /\p{Cc}/u.test(segment) ||
        Buffer.from(segment, "utf8").toString("utf8") !== segment,
    )
  )
    return undefined;
  return segments;
}

function parseRawChanges(output: Buffer): RawChange[] | undefined {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return undefined;
  }
  const fields = decoded.split("\0");
  if (fields.at(-1) !== "") return undefined;
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length - 1; ) {
    const header = fields[index++];
    if (!header) return undefined;
    const match =
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/.exec(header);
    if (!match) return undefined;
    const status = match[5];
    const firstPath = fields[index++];
    if (!status || firstPath === undefined || firstPath === "")
      return undefined;
    const renameOrCopy = status.startsWith("R") || status.startsWith("C");
    const secondPath = renameOrCopy ? fields[index++] : firstPath;
    if (secondPath === undefined || secondPath === "") return undefined;
    const oldSegments = pathSegments(firstPath);
    const newSegments = pathSegments(secondPath);
    if (!oldSegments || !newSegments) return undefined;
    changes.push({
      oldMode: match[1]!,
      newMode: match[2]!,
      oldObject: match[3]!,
      newObject: match[4]!,
      status,
      oldPath: firstPath,
      newPath: secondPath,
    });
  }
  return changes;
}

function parseNulPaths(output: Buffer): string[] | undefined {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      output.subarray(0, -1),
    );
  } catch {
    return undefined;
  }
  const paths = decoded.split("\0");
  return paths.every((path) => pathSegments(path) !== undefined)
    ? paths
    : undefined;
}

type FilterDriverRead =
  | { ok: true; drivers: string[] }
  | { ok: false; reason: "git-failed" | "output-limit" };

function parseFilterDriverNames(output: Buffer): FilterDriverRead {
  if (output.length > maxFilterConfigBytes)
    return { ok: false, reason: "output-limit" };
  if (output.length === 0) return { ok: true, drivers: [] };
  if (output.at(-1) !== 0) return { ok: false, reason: "git-failed" };
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return { ok: false, reason: "git-failed" };
  }
  const keys = decoded.split("\0");
  if (keys.pop() !== "" || keys.length > maxFilterDriverNames * 2)
    return { ok: false, reason: "output-limit" };
  const drivers = new Set<string>();
  for (const key of keys) {
    const match = /^filter\.([A-Za-z0-9_-]{1,64})\.(?:clean|process)$/i.exec(
      key,
    );
    if (
      !match?.[1] ||
      Buffer.byteLength(match[1], "utf8") > maxFilterDriverNameBytes
    )
      return { ok: false, reason: "git-failed" };
    drivers.add(match[1]);
    if (drivers.size > maxFilterDriverNames)
      return { ok: false, reason: "output-limit" };
  }
  return { ok: true, drivers: [...drivers].sort() };
}

function changeKind(status: string): WorkspaceComparisonEntry["change"] {
  if (status.startsWith("R") || status.startsWith("C")) return "renamed";
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "T") return "type-changed";
  return "modified";
}

function contentIdentity(bytes: Buffer, modifiedAt?: number | null) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    lineCount: null,
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
  } satisfies WorkspaceComparisonContent;
}

function sideFromBytes(
  bytes: Buffer,
  objectId: string,
  path: string,
  modifiedAt?: number | null,
): ContentObservation {
  const identity = {
    ...contentIdentity(bytes, modifiedAt),
    objectId,
  };
  if (unsupportedExtensions.has(extname(path).toLowerCase()))
    return {
      state: "unsupported",
      content: { ...identity, lineCount: null },
      reason: "unsupported-format",
    };
  const text = decodeUtf8(bytes);
  if (text === undefined)
    return {
      state: "binary",
      content: { ...identity, lineCount: null },
    };
  return {
    state: "text",
    text,
    content: { ...identity, lineCount: splitLines(text).length },
  };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function baseEntry(
  status: string,
  newPath: string,
  oldPath: string,
  changeSet?: ComparisonChangeSet,
): Pick<WorkspaceComparisonEntry, "path" | "change" | "changeSet"> & {
  previousPath?: string;
} {
  const change = changeKind(status);
  return {
    path: newPath,
    change,
    ...(changeSet === undefined ? {} : { changeSet }),
    ...(change === "renamed" && oldPath !== newPath
      ? { previousPath: oldPath }
      : {}),
  };
}

function splitPatchLine(line: string): { text: string; terminated: boolean } {
  return line.endsWith("\n")
    ? { text: line.slice(0, -1), terminated: true }
    : { text: line, terminated: false };
}

function unifiedHunks(
  beforeText: string,
  afterText: string,
):
  | Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      patch: string;
      oldChanged?: [number, number];
      newChanged?: [number, number];
    }>
  | undefined {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  if (
    before.length > workspaceComparisonLimits.maxLinesPerSide ||
    after.length > workspaceComparisonLimits.maxLinesPerSide
  )
    return undefined;
  const width = after.length + 1;
  const cells = (before.length + 1) * width;
  if (cells > workspaceComparisonLimits.maxDiffOperations + width)
    return undefined;
  const lcs = new Uint16Array(cells);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const index = i * width + j;
      lcs[index] =
        before[i] === after[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lcs[(i + 1) * width + j] ?? 0,
              lcs[i * width + j + 1] ?? 0,
            );
    }
  }
  type Operation = {
    kind: "same" | "delete" | "add";
    text: string;
    oldLine?: number;
    newLine?: number;
  };
  const operations: Operation[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      operations.push({
        kind: "same",
        text: before[i]!,
        oldLine: i + 1,
        newLine: j + 1,
      });
      i++;
      j++;
    } else if (
      i < before.length &&
      (j >= after.length ||
        (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      operations.push({ kind: "delete", text: before[i]!, oldLine: i + 1 });
      i++;
    } else {
      operations.push({ kind: "add", text: after[j]!, newLine: j + 1 });
      j++;
    }
  }
  const changedIndexes = operations.flatMap((operation, index) =>
    operation.kind === "same" ? [] : [index],
  );
  if (changedIndexes.length === 0) return [];
  const groups: Array<[number, number]> = [];
  for (const changed of changedIndexes) {
    const start = Math.max(0, changed - 3);
    const end = Math.min(operations.length, changed + 4);
    const last = groups.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else groups.push([start, end]);
  }
  return groups.map(([from, to]) => {
    const selected = operations.slice(from, to);
    const first = selected[0];
    const prefix = operations.slice(0, from);
    const oldBefore = prefix.filter(
      (operation) => operation.kind !== "add",
    ).length;
    const newBefore = prefix.filter(
      (operation) => operation.kind !== "delete",
    ).length;
    const oldStart =
      oldBefore +
      (selected.some((operation) => operation.kind !== "add") ? 1 : 0);
    const newStart =
      newBefore +
      (selected.some((operation) => operation.kind !== "delete") ? 1 : 0);
    const oldLines = selected.filter(
      (operation) => operation.kind !== "add",
    ).length;
    const newLines = selected.filter(
      (operation) => operation.kind !== "delete",
    ).length;
    let oldChangedStart: number | undefined;
    let oldChangedEnd: number | undefined;
    let newChangedStart: number | undefined;
    let newChangedEnd: number | undefined;
    let patch = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n`;
    for (const operation of selected) {
      const marker =
        operation.kind === "same"
          ? " "
          : operation.kind === "delete"
            ? "-"
            : "+";
      const line = splitPatchLine(operation.text);
      patch += `${marker}${line.text}\n`;
      if (!line.terminated) patch += "\\ No newline at end of file\n";
      if (operation.kind === "delete") {
        oldChangedStart ??= operation.oldLine;
        oldChangedEnd = operation.oldLine;
      } else if (operation.kind === "add") {
        newChangedStart ??= operation.newLine;
        newChangedEnd = operation.newLine;
      }
    }
    return {
      oldStart: first ? oldStart : 0,
      oldLines,
      newStart,
      newLines,
      patch,
      ...(oldChangedStart && oldChangedEnd
        ? { oldChanged: [oldChangedStart, oldChangedEnd] as [number, number] }
        : {}),
      ...(newChangedStart && newChangedEnd
        ? { newChanged: [newChangedStart, newChangedEnd] as [number, number] }
        : {}),
    };
  });
}

function snapshot(
  request: CompareRepositoryRequest,
  state: WorkspaceComparisonSnapshot["state"],
  reason?: WorkspaceComparisonSnapshot["reason"],
): WorkspaceComparisonSnapshot {
  return {
    comparisonId: randomUUID(),
    taskId: request.taskId,
    repositoryId: request.repositoryId,
    target: request.target,
    ...(request.target === "uncommitted"
      ? { changeSet: request.changeSet ?? "all" }
      : {}),
    state,
    observedAt: Date.now(),
    availableBaseBranches: [],
    entries: [],
    truncated: false,
    ...(reason === undefined ? {} : { reason }),
  };
}

function bindingFingerprint(current: WorkspaceInspectionCurrent): string {
  return JSON.stringify({
    taskId: current.taskId,
    taskVersion: current.taskVersion,
    visibility: current.visibility,
    controlPaths: current.controlPaths,
    binding: current.binding
      ? {
          workspaceId: current.binding.workspaceId,
          path: current.binding.path,
          state: current.binding.state,
          gitUncertain: current.binding.gitUncertain,
          repositories: current.binding.repositories.map((repository) => [
            repository.repositoryId,
            repository.sourcePath,
            repository.workspacePath,
            repository.ref,
            repository.gitCommonDir,
            repository.commit,
          ]),
        }
      : null,
  });
}

function gitFailureReason(
  reason: Exclude<GitRead, { ok: true }>["reason"],
): NonNullable<WorkspaceComparisonSnapshot["reason"]> {
  if (reason === "timed-out" || reason === "unsettled") return "time-limit";
  if (reason === "output-limit") return "output-limit";
  return "git-failed";
}

function privateMode(mode: string): boolean {
  return mode === "120000" || mode === "160000";
}

function fileStateFromPreview(
  preview: Awaited<ReturnType<typeof previewWorkspaceFile>>,
): ContentObservation {
  const metadata = preview.metadata;
  if (preview.state === "ready" && preview.preview?.kind === "text") {
    const text = preview.preview.text;
    return {
      state: "text",
      text,
      content: {
        sha256: preview.preview.sha256,
        size: preview.preview.size,
        lineCount: splitLines(text).length,
        ...(metadata?.modifiedAt === undefined
          ? {}
          : { modifiedAt: metadata.modifiedAt }),
      },
    };
  }
  if (preview.state === "ready" && preview.preview?.kind === "base64")
    return {
      state: "unsupported",
      content: {
        sha256: preview.preview.sha256,
        size: preview.preview.size,
        lineCount: null,
        ...(metadata?.modifiedAt === undefined
          ? {}
          : { modifiedAt: metadata.modifiedAt }),
      },
      reason: "unsupported-format",
    };
  if (metadata?.kind === "symlink" || metadata?.kind === "other")
    return {
      state: "unsupported",
      content: {
        ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
        size: metadata.size,
        lineCount: null,
        ...(metadata.modifiedAt === undefined
          ? {}
          : { modifiedAt: metadata.modifiedAt }),
      },
      reason: "unsupported-format",
    };
  if (preview.state === "metadata-only") {
    if (metadata?.reason === "binary-content")
      return {
        state: "binary",
        content: {
          ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
          size: metadata.size,
          lineCount: null,
          ...(metadata.modifiedAt === undefined
            ? {}
            : { modifiedAt: metadata.modifiedAt }),
        },
      };
    if (
      metadata?.reason === "unsupported-format" ||
      metadata?.reason === "invalid-content" ||
      metadata?.reason === "image-dimensions-exceed-limit"
    )
      return {
        state: "unsupported",
        content: {
          ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
          size: metadata.size,
          lineCount: null,
          ...(metadata.modifiedAt === undefined
            ? {}
            : { modifiedAt: metadata.modifiedAt }),
        },
        reason: "unsupported-format",
      };
    if (metadata?.reason === "too-large")
      return {
        state: "gap",
        content: {
          ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
          size: metadata.size,
          lineCount: null,
          ...(metadata.modifiedAt === undefined
            ? {}
            : { modifiedAt: metadata.modifiedAt }),
        },
        reason: "too-large",
      };
  }
  return {
    state: "gap",
    content: {
      ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
      size: metadata?.size ?? null,
      lineCount: null,
      ...(metadata?.modifiedAt === undefined
        ? {}
        : { modifiedAt: metadata.modifiedAt }),
    },
    reason: preview.state === "conflict" ? "changing" : "unavailable",
  };
}

function observationFromObjectSize(
  objectId: string,
  size: number,
  path: string,
  mode: string,
): ContentObservation {
  const content: WorkspaceComparisonContent = {
    objectId,
    size,
    lineCount: null,
  };
  if (
    privateMode(mode) ||
    unsupportedExtensions.has(extname(path).toLowerCase())
  )
    return {
      state: "unsupported",
      content,
      reason: "unsupported-format",
    };
  return { state: "gap", content, reason: "too-large" };
}

function entryForObservations(
  taskId: string,
  repositoryId: string | null,
  comparisonId: string,
  context: WorkspaceComparisonContext,
  raw: RawChange,
  changeSet: ComparisonChangeSet | undefined,
  left: ContentObservation | undefined,
  right: ContentObservation | undefined,
  turnIdentity?: {
    workId: string;
    threadId?: string;
    turnId?: string;
  },
): WorkspaceComparisonEntry {
  const base = baseEntry(raw.status, raw.newPath, raw.oldPath, changeSet);
  const entry: WorkspaceComparisonEntry = {
    ...base,
    repositoryId,
    state: "text",
    hunks: [],
    ...(left ? { left: left.content } : {}),
    ...(right ? { right: right.content } : {}),
  };
  if (raw.status === "U" || raw.status === "X" || raw.status === "B") {
    entry.state = "gap";
    entry.reason = "unavailable";
    return entry;
  }
  if (left?.state === "gap" || right?.state === "gap") {
    entry.state = "gap";
    const reason = left?.state === "gap" ? left.reason : right?.reason;
    if (reason !== undefined) entry.reason = reason;
    return entry;
  }
  if (left?.state === "unsupported" || right?.state === "unsupported") {
    entry.state = "unsupported";
    entry.reason = "unsupported-format";
    return entry;
  }
  if (left?.state === "binary" || right?.state === "binary") {
    entry.state = "binary";
    return entry;
  }
  const leftText = left?.text ?? "";
  const rightText = right?.text ?? "";
  const hunks = unifiedHunks(leftText, rightText);
  if (!hunks) {
    entry.state = "gap";
    entry.reason = "output-limit";
    return entry;
  }
  const leftPath = raw.oldPath;
  const rightPath = raw.newPath;
  entry.hunks = hunks.map((hunk) => {
    const leftAnchor =
      hunk.oldChanged && left?.content.sha256
        ? {
            taskId,
            repositoryId,
            path: leftPath,
            comparisonId,
            context,
            ...(context === "turn" && turnIdentity
              ? {
                  workId: turnIdentity.workId,
                  ...(turnIdentity.threadId
                    ? { threadId: turnIdentity.threadId }
                    : {}),
                  ...(turnIdentity.turnId
                    ? { turnId: turnIdentity.turnId }
                    : {}),
                }
              : {}),
            side: "left" as const,
            startLine: hunk.oldChanged[0],
            endLine: hunk.oldChanged[1],
            contentSha256: left.content.sha256,
          }
        : undefined;
    const rightAnchor =
      hunk.newChanged && right?.content.sha256
        ? {
            taskId,
            repositoryId,
            path: rightPath,
            comparisonId,
            context,
            ...(context === "turn" && turnIdentity
              ? {
                  workId: turnIdentity.workId,
                  ...(turnIdentity.threadId
                    ? { threadId: turnIdentity.threadId }
                    : {}),
                  ...(turnIdentity.turnId
                    ? { turnId: turnIdentity.turnId }
                    : {}),
                }
              : {}),
            side: "right" as const,
            startLine: hunk.newChanged[0],
            endLine: hunk.newChanged[1],
            contentSha256: right.content.sha256,
          }
        : undefined;
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      patch: hunk.patch,
      ...(leftAnchor ? { leftAnchor } : {}),
      ...(rightAnchor ? { rightAnchor } : {}),
    };
  });
  const header = `--- a/${leftPath}\n+++ b/${rightPath}\n`;
  entry.diff = hunks.length
    ? header + hunks.map((hunk) => hunk.patch).join("")
    : "";
  if (
    Buffer.byteLength(entry.diff, "utf8") >
    workspaceComparisonLimits.maxDiffOutputBytes
  ) {
    entry.state = "gap";
    entry.reason = "output-limit";
    delete entry.diff;
    entry.hunks = [];
  }
  return entry;
}

function rawForUntracked(path: string): RawChange {
  return {
    oldMode: "000000",
    newMode: "100644",
    oldObject: "0".repeat(40),
    newObject: "0".repeat(40),
    status: "A",
    oldPath: path,
    newPath: path,
  };
}

/**
 * Read one bounded local comparison. The repository ref stored on the task
 * binding is intentionally not treated as a base-branch selection.
 */
export async function compareRepository(
  request: CompareRepositoryRequest,
  current: () => Promise<WorkspaceInspectionCurrent>,
  options: CompareRepositoryOptions = {},
): Promise<WorkspaceComparisonSnapshot> {
  if (
    !request.taskId ||
    !request.repositoryId ||
    (request.target !== "branch" && request.target !== "uncommitted") ||
    (request.target === "branch" && request.changeSet !== undefined) ||
    (request.target === "uncommitted" &&
      request.changeSet !== undefined &&
      !["all", "staged", "unstaged"].includes(request.changeSet))
  )
    throw new Error("invalid-comparison-request");

  const result = snapshot(request, "unavailable", "workspace-unavailable");
  const startedAt = Date.now();
  let initial: WorkspaceInspectionCurrent;
  try {
    initial = await current();
  } catch {
    return result;
  }
  const binding = initial.binding;
  if (
    !binding ||
    binding.taskId !== request.taskId ||
    binding.state !== "ready"
  )
    return result;
  const repositories = binding.repositories.filter(
    (repository) => repository.repositoryId === request.repositoryId,
  );
  if (repositories.length !== 1) {
    result.reason = "repository-unavailable";
    return result;
  }
  const repository = repositories[0];
  if (!repository) {
    result.reason = "repository-unavailable";
    return result;
  }
  const scope: WorkspaceInspectionScope = {
    kind: "repository",
    repositoryId: request.repositoryId,
  };
  const fingerprint = bindingFingerprint(initial);
  const stillCurrent = await workspaceInspectionRootGuard(
    request.taskId,
    scope,
    initial,
    current,
    (latest) => bindingFingerprint(latest) === fingerprint,
  );
  if (!stillCurrent) {
    result.reason = "workspace-unavailable";
    return result;
  }

  const run = async (
    args: readonly string[],
    expectedFailure?: {
      reason: NonNullable<WorkspaceComparisonSnapshot["reason"]>;
      exitCode: number;
    },
    configOverrides: readonly string[] = [],
    emptyOutputExitCode?: number,
  ): Promise<Buffer | undefined> => {
    if (!(await stillCurrent())) {
      result.state = "gap";
      result.reason = "workspace-changed";
      return undefined;
    }
    let read = await readGit(
      repository.workspacePath,
      args,
      startedAt,
      options,
      configOverrides,
    );
    if (
      !read.ok &&
      read.reason === "failed" &&
      read.exitCode === emptyOutputExitCode &&
      read.output?.length === 0
    )
      read = { ok: true, output: read.output ?? Buffer.alloc(0) };
    if (!read.ok) {
      if (
        read.reason === "failed" &&
        expectedFailure &&
        read.exitCode === expectedFailure.exitCode
      ) {
        result.state = "unavailable";
        result.reason = expectedFailure.reason;
        return undefined;
      }
      result.state = "gap";
      result.reason = gitFailureReason(read.reason);
      return undefined;
    }
    try {
      await options.afterGitRead?.();
    } catch {
      result.state = "gap";
      result.reason = "git-failed";
      return undefined;
    }
    if (!(await stillCurrent())) {
      result.state = "gap";
      result.reason = "workspace-changed";
      return undefined;
    }
    return read.output;
  };

  const readFilterDrivers = async (): Promise<string[] | undefined> => {
    const output = await run(
      [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|process)$",
      ],
      undefined,
      [],
      1,
    );
    if (!output) return undefined;
    const parsed = parseFilterDriverNames(output);
    if (!parsed.ok) {
      result.state = "gap";
      result.reason = parsed.reason;
      return undefined;
    }
    return parsed.drivers;
  };

  const runWorkingTreeDiff = async (
    args: readonly string[],
  ): Promise<Buffer | undefined> => {
    const before = await readFilterDrivers();
    if (!before) return undefined;
    const configOverrides = before.flatMap((driver) => [
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.process=`,
      "-c",
      `filter.${driver}.required=false`,
    ]);
    const output = await run(args, undefined, configOverrides);
    if (!output) return undefined;
    const after = await readFilterDrivers();
    if (!after) return undefined;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      result.state = "gap";
      result.reason = "workspace-changed";
      return undefined;
    }
    return output;
  };

  const refs = await run([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (!refs) return result;
  let branchText: string;
  try {
    branchText = new TextDecoder("utf-8", { fatal: true }).decode(refs);
  } catch {
    result.state = "gap";
    result.reason = "unsafe-path";
    return result;
  }
  const branches = branchText.split("\n").filter(Boolean);
  if (branches.length > workspaceComparisonLimits.maxEntriesScanned) {
    result.state = "gap";
    result.reason = "output-limit";
    return result;
  }
  result.availableBaseBranches = branches;

  let baselineCommit: string;
  let observedHeadCommit: string;
  let selectedBranchCommit: string | undefined;
  if (request.target === "branch") {
    const selected = request.baseBranch;
    if (!selected) {
      result.reason = "base-branch-required";
      return result;
    }
    if (!branches.includes(selected)) {
      result.reason = "base-branch-unavailable";
      return result;
    }
    const checked = await run(["check-ref-format", "--branch", selected]);
    if (!checked) return result;
    const branchCommitRaw = await run(
      [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/heads/${selected}^{commit}`,
      ],
      { reason: "base-branch-unavailable", exitCode: 128 },
    );
    if (!branchCommitRaw) return result;
    const branchCommit = branchCommitRaw.toString("ascii").trim();
    if (!validObjectId.test(branchCommit)) {
      result.reason = "base-branch-unavailable";
      return result;
    }
    selectedBranchCommit = branchCommit;
    const headRaw = await run(
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      { reason: "head-unavailable", exitCode: 128 },
    );
    if (!headRaw) {
      result.reason = "head-unavailable";
      return result;
    }
    const head = headRaw.toString("ascii").trim();
    if (!validObjectId.test(head)) {
      result.reason = "head-unavailable";
      return result;
    }
    observedHeadCommit = head;
    const mergeBase = await run(["merge-base", branchCommit, head], {
      reason: "no-merge-base",
      exitCode: 1,
    });
    if (!mergeBase) {
      return result;
    }
    baselineCommit = mergeBase.toString("ascii").trim();
    if (!validObjectId.test(baselineCommit)) {
      result.reason = "no-merge-base";
      return result;
    }
    result.baseline = {
      kind: "merge-base",
      branch: selected,
      commit: baselineCommit,
    };
  } else {
    const headRaw = await run(
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      { reason: "head-unavailable", exitCode: 128 },
    );
    if (!headRaw) {
      result.reason = "head-unavailable";
      return result;
    }
    baselineCommit = headRaw.toString("ascii").trim();
    if (!validObjectId.test(baselineCommit)) {
      result.reason = "head-unavailable";
      return result;
    }
    observedHeadCommit = baselineCommit;
    result.baseline = { kind: "head", commit: baselineCommit };
  }

  const indexBefore = await run(["ls-files", "--stage", "-z"]);
  if (!indexBefore) return result;

  const allChanges: Array<{ raw: RawChange; changeSet: ComparisonChangeSet }> =
    [];
  const untrackedPaths: string[] = [];
  if (request.target === "branch") {
    const output = await runWorkingTreeDiff([
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      "--find-renames=50%",
      "--no-ext-diff",
      "--no-textconv",
      baselineCommit,
      "--",
    ]);
    if (!output) return result;
    const changes = parseRawChanges(output);
    if (!changes) {
      result.state = "gap";
      result.reason = "unsafe-path";
      return result;
    }
    allChanges.push(
      ...changes.map((raw) => ({ raw, changeSet: "branch" as const })),
    );
    const untrackedOutput = await run([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (!untrackedOutput) return result;
    const paths = parseNulPaths(untrackedOutput);
    if (!paths) {
      result.state = "gap";
      result.reason = "unsafe-path";
      return result;
    }
    untrackedPaths.push(...paths);
  } else {
    const changeSet = request.changeSet ?? "all";
    if (changeSet !== "unstaged") {
      const stagedOutput = await run([
        "diff",
        "--cached",
        "--raw",
        "-z",
        "--no-abbrev",
        "--find-renames=50%",
        "--no-ext-diff",
        "--no-textconv",
        "--",
      ]);
      if (!stagedOutput) return result;
      const staged = parseRawChanges(stagedOutput);
      if (!staged) {
        result.state = "gap";
        result.reason = "unsafe-path";
        return result;
      }
      allChanges.push(
        ...staged.map((raw) => ({ raw, changeSet: "staged" as const })),
      );
    }
    if (changeSet !== "staged") {
      const unstagedOutput = await runWorkingTreeDiff([
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--find-renames=50%",
        "--no-ext-diff",
        "--no-textconv",
        "--",
      ]);
      if (!unstagedOutput) return result;
      const unstaged = parseRawChanges(unstagedOutput);
      if (!unstaged) {
        result.state = "gap";
        result.reason = "unsafe-path";
        return result;
      }
      allChanges.push(
        ...unstaged.map((raw) => ({ raw, changeSet: "unstaged" as const })),
      );
      const untrackedOutput = await run([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      if (!untrackedOutput) return result;
      const paths = parseNulPaths(untrackedOutput);
      if (!paths) {
        result.state = "gap";
        result.reason = "unsafe-path";
        return result;
      }
      untrackedPaths.push(...paths);
    }
  }

  if (
    allChanges.length + untrackedPaths.length >
    workspaceComparisonLimits.maxEntriesScanned
  ) {
    result.state = "gap";
    result.reason = "output-limit";
    return result;
  }
  allChanges.push(
    ...untrackedPaths.map((path) => ({
      raw: rawForUntracked(path),
      changeSet:
        request.target === "branch"
          ? ("branch" as const)
          : ("unstaged" as const),
    })),
  );

  let totalBytes = 0;
  let diffBytes = 0;
  const workingObservations = new Map<string, ContentObservation>();
  const objectCache = new Map<string, ContentObservation>();
  const isGap = () => result.state === "gap";
  const readObject = async (
    objectId: string,
    path: string,
    mode: string,
  ): Promise<ContentObservation | undefined> => {
    if (zeroObjectId.test(objectId)) return undefined;
    if (!validObjectId.test(objectId)) {
      result.state = "gap";
      result.reason = "git-failed";
      return undefined;
    }
    const cacheKey = `${objectId}\0${mode}\0${extname(path).toLowerCase()}`;
    const cached = objectCache.get(cacheKey);
    if (cached) return cached;
    if (
      privateMode(mode) ||
      unsupportedExtensions.has(extname(path).toLowerCase())
    ) {
      const sizeOutput = await run(["cat-file", "-s", objectId]);
      if (!sizeOutput) return undefined;
      const size = Number(sizeOutput.toString("ascii").trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        result.state = "gap";
        result.reason = "git-failed";
        return undefined;
      }
      const observation = observationFromObjectSize(objectId, size, path, mode);
      objectCache.set(cacheKey, observation);
      return observation;
    }
    const sizeOutput = await run(["cat-file", "-s", objectId]);
    if (!sizeOutput) return undefined;
    const size = Number(sizeOutput.toString("ascii").trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      result.state = "gap";
      result.reason = "git-failed";
      return undefined;
    }
    if (
      size > workspaceComparisonLimits.maxFileBytes ||
      totalBytes + size > workspaceComparisonLimits.maxTotalBytes
    ) {
      const observation: ContentObservation = {
        state: "gap",
        content: { objectId, size, lineCount: null },
        reason: "too-large",
      };
      objectCache.set(cacheKey, observation);
      return observation;
    }
    const blob = await run(["cat-file", "blob", objectId]);
    if (!blob) return undefined;
    if (blob.length !== size) {
      const observation: ContentObservation = {
        state: "gap",
        content: { objectId, size, lineCount: null },
        reason: "changing",
      };
      objectCache.set(cacheKey, observation);
      return observation;
    }
    totalBytes += blob.length;
    const observation = sideFromBytes(blob, objectId, path);
    objectCache.set(cacheKey, observation);
    return observation;
  };

  const readWorking = async (path: string): Promise<ContentObservation> => {
    const segments = pathSegments(path);
    if (!segments) {
      result.state = "gap";
      result.reason = "unsafe-path";
      return {
        state: "gap",
        content: { size: null, lineCount: null },
        reason: "unavailable",
      };
    }
    if (
      await workspaceInspectionPathExcluded(
        request.taskId,
        scope,
        segments,
        current,
      )
    ) {
      result.state = "gap";
      result.reason = "unsafe-path";
      return {
        state: "gap",
        content: { size: null, lineCount: null },
        reason: "unavailable",
      };
    }
    const preview = await previewWorkspaceFile(
      {
        taskId: request.taskId,
        scope,
        path: segments,
        showIgnored: true,
      },
      current,
      {
        captureContentHash: true,
        ...(options.afterWorkingFileOpen
          ? { afterFileOpen: options.afterWorkingFileOpen }
          : {}),
      },
    );
    const observation = fileStateFromPreview(preview);
    workingObservations.set(path, observation);
    if (observation.content.size !== null) {
      if (
        observation.content.size > workspaceComparisonLimits.maxFileBytes ||
        totalBytes + observation.content.size >
          workspaceComparisonLimits.maxTotalBytes
      ) {
        observation.state = "gap";
        delete observation.text;
        observation.reason = "too-large";
      } else {
        totalBytes += observation.content.size;
      }
    }
    return observation;
  };

  for (const { raw, changeSet } of allChanges) {
    if (result.entries.length >= workspaceComparisonLimits.maxEntriesReturned) {
      result.truncated = true;
      break;
    }
    const oldSegments = pathSegments(raw.oldPath);
    const newSegments = pathSegments(raw.newPath);
    if (!oldSegments || !newSegments) {
      result.state = "gap";
      result.reason = "unsafe-path";
      return result;
    }
    const oldExcluded = await workspaceInspectionPathExcluded(
      request.taskId,
      scope,
      oldSegments,
      current,
    );
    const newExcluded = await workspaceInspectionPathExcluded(
      request.taskId,
      scope,
      newSegments,
      current,
    );
    if (oldExcluded || newExcluded) {
      if (!(await stillCurrent())) {
        result.state = "gap";
        result.reason = "workspace-changed";
        return result;
      }
      continue;
    }
    if (!(await stillCurrent())) {
      result.state = "gap";
      result.reason = "workspace-changed";
      return result;
    }

    const change = changeKind(raw.status);
    const beforePath = raw.oldPath;
    const afterPath = raw.newPath;
    const left =
      change === "added"
        ? undefined
        : await readObject(raw.oldObject, beforePath, raw.oldMode);
    if (isGap()) return result;
    let right: ContentObservation | undefined;
    if (change !== "deleted") {
      if (changeSet === "staged")
        right = await readObject(raw.newObject, afterPath, raw.newMode);
      else right = await readWorking(afterPath);
    }
    if (isGap()) return result;
    const entry = entryForObservations(
      request.taskId,
      request.repositoryId,
      result.comparisonId,
      request.target === "branch" ? "branch" : "uncommitted",
      raw,
      changeSet,
      left,
      right,
    );
    if (entry.state === "gap") {
      result.state = "gap";
      result.reason =
        entry.reason === "too-large" || entry.reason === "output-limit"
          ? "output-limit"
          : entry.reason === "changing"
            ? "workspace-changed"
            : entry.reason === "unavailable"
              ? "workspace-unavailable"
              : "time-limit";
    }
    if (entry.diff) {
      diffBytes += Buffer.byteLength(entry.diff, "utf8");
      if (diffBytes > workspaceComparisonLimits.maxDiffOutputBytes) {
        entry.state = "gap";
        entry.reason = "output-limit";
        delete entry.diff;
        entry.hunks = [];
        result.state = "gap";
        result.reason = "output-limit";
      }
    }
    const entryIndex = result.entries.length;
    if (left?.state === "text" && left.text !== undefined)
      options.captureSideContent?.(entryIndex, "left", left.text);
    if (right?.state === "text" && right.text !== undefined)
      options.captureSideContent?.(entryIndex, "right", right.text);
    result.entries.push(entry);
    if (result.state === "gap") return result;
  }

  for (const [path, expected] of workingObservations) {
    const segments = pathSegments(path);
    if (!segments) {
      result.state = "gap";
      result.reason = "unsafe-path";
      return result;
    }
    const excluded = await workspaceInspectionPathExcluded(
      request.taskId,
      scope,
      segments,
      current,
    );
    if (excluded) {
      if (!(await stillCurrent())) {
        result.state = "gap";
        result.reason = "workspace-changed";
      } else {
        result.state = "gap";
        result.reason = "unsafe-path";
      }
      return result;
    }
    const latest = fileStateFromPreview(
      await previewWorkspaceFile(
        {
          taskId: request.taskId,
          scope,
          path: segments,
          showIgnored: true,
        },
        current,
        { captureContentHash: true },
      ),
    );
    if (
      latest.state !== expected.state ||
      latest.content.sha256 !== expected.content.sha256 ||
      latest.content.size !== expected.content.size ||
      latest.content.modifiedAt !== expected.content.modifiedAt
    ) {
      result.state = "gap";
      result.reason = "workspace-changed";
      return result;
    }
  }

  const indexAfter = await run(["ls-files", "--stage", "-z"]);
  if (!indexAfter) return result;
  if (!indexBefore.equals(indexAfter)) {
    result.state = "gap";
    result.reason = "workspace-changed";
    return result;
  }
  const finalHead = await run([
    "rev-parse",
    "--verify",
    "--end-of-options",
    "HEAD^{commit}",
  ]);
  if (!finalHead) return result;
  if (finalHead.toString("ascii").trim() !== observedHeadCommit) {
    result.state = "gap";
    result.reason = "workspace-changed";
    return result;
  }
  if (selectedBranchCommit !== undefined) {
    const branchRef = await run([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${request.baseBranch}^{commit}`,
    ]);
    if (!branchRef) return result;
    if (branchRef.toString("ascii").trim() !== selectedBranchCommit) {
      result.state = "gap";
      result.reason = "workspace-changed";
      return result;
    }
  }

  result.state = result.truncated ? "gap" : "available";
  if (result.truncated) result.reason = "output-limit";
  result.observedAt = Date.now();
  if (
    Date.now() - startedAt >
    (options.timeoutMs ?? workspaceComparisonLimits.maxDurationMs)
  ) {
    result.state = "gap";
    result.reason = "time-limit";
  }
  if (!(await stillCurrent())) {
    result.state = "gap";
    result.reason = "workspace-changed";
  }
  return result;
}

type TurnObservationScope = WorkspaceInspectionScope;

interface ObservedDirectory {
  scope: TurnObservationScope;
  path: string[];
  entries: string;
}

/** Capture a bounded, safe file observation for one admitted task workspace. */
export async function observeWorkspaceTurn(
  taskId: string,
  current: () => Promise<WorkspaceInspectionCurrent>,
  options: CompareRepositoryOptions = {},
): Promise<WorkspaceTurnObservation> {
  const startedAt = Date.now();
  const observation: WorkspaceTurnObservation = {
    observedAt: startedAt,
    state: "available",
    files: [],
    truncated: false,
  };
  const markGap = (reason: NonNullable<WorkspaceTurnObservation["reason"]>) => {
    observation.state = "gap";
    observation.reason ??= reason;
  };
  let initial: WorkspaceInspectionCurrent;
  try {
    initial = await current();
  } catch {
    markGap("workspace-unavailable");
    observation.observedAt = Date.now();
    return observation;
  }
  const binding = initial.binding;
  if (
    initial.taskId !== taskId ||
    !binding ||
    binding.taskId !== taskId ||
    binding.state !== "ready"
  ) {
    markGap("workspace-unavailable");
    observation.observedAt = Date.now();
    return observation;
  }
  const fingerprint = bindingFingerprint(initial);
  const scopes: TurnObservationScope[] = [
    { kind: "workspace" },
    ...binding.repositories.map((repository) => ({
      kind: "repository" as const,
      repositoryId: repository.repositoryId,
    })),
  ];
  const directories: ObservedDirectory[] = [];
  let scannedEntries = 0;
  let totalBytes = 0;
  const stillCurrent = async () => {
    try {
      return bindingFingerprint(await current()) === fingerprint;
    } catch {
      return false;
    }
  };
  const entrySignature = (
    entries: readonly {
      kind: string;
      name?: string;
      size: number | null;
      modifiedAt: number | null;
      ignored: boolean | null;
    }[],
  ) =>
    JSON.stringify(
      entries.map(({ kind, name, size, modifiedAt, ignored }) => [
        kind,
        name,
        size,
        modifiedAt,
        ignored,
      ]),
    );

  for (const scope of scopes) {
    const visit = async (path: string[]): Promise<void> => {
      if (
        Date.now() - startedAt >
        (options.timeoutMs ?? workspaceComparisonLimits.maxDurationMs)
      ) {
        observation.truncated = true;
        markGap("time-limit");
        return;
      }
      if (!(await stillCurrent())) {
        markGap("workspace-changed");
        return;
      }
      const listing = await listWorkspaceDirectory(
        { taskId, scope, path, showIgnored: false },
        current,
      );
      if (listing.state !== "ready" || listing.ignoreStatus === "incomplete") {
        markGap("workspace-unavailable");
        return;
      }
      directories.push({
        scope,
        path,
        entries: entrySignature(listing.entries),
      });
      if (listing.truncated) {
        observation.truncated = true;
        markGap("output-limit");
      }
      for (const entry of listing.entries) {
        scannedEntries++;
        if (scannedEntries > workspaceComparisonLimits.maxEntriesScanned) {
          observation.truncated = true;
          markGap("output-limit");
          return;
        }
        if (entry.kind === "repository") continue;
        const segments = [...path, entry.name];
        const relativePath = segments.join("/");
        if (entry.kind === "directory") {
          await visit(segments);
          if (observation.truncated && observation.reason === "time-limit")
            return;
          continue;
        }
        if (
          observation.files.length >=
          workspaceComparisonLimits.maxEntriesReturned
        ) {
          observation.truncated = true;
          markGap("output-limit");
          return;
        }
        const repositoryId =
          scope.kind === "repository" ? scope.repositoryId : null;
        if (
          await workspaceInspectionPathExcluded(
            taskId,
            scope,
            segments,
            current,
          )
        ) {
          markGap("unsafe-path");
          continue;
        }
        const baseContent: WorkspaceComparisonContent = {
          size: entry.size,
          lineCount: null,
          modifiedAt: entry.modifiedAt,
        };
        if (entry.kind !== "file") {
          observation.files.push({
            repositoryId,
            path: relativePath,
            state: "unsupported",
            content: baseContent,
            reason: "unsupported-format",
            kind: entry.kind,
          });
          continue;
        }
        if (unsupportedExtensions.has(extname(entry.name).toLowerCase())) {
          observation.files.push({
            repositoryId,
            path: relativePath,
            state: "unsupported",
            content: baseContent,
            reason: "unsupported-format",
            kind: "file",
          });
          continue;
        }
        if (
          entry.size === null ||
          entry.size > workspaceComparisonLimits.maxFileBytes ||
          totalBytes + entry.size > workspaceComparisonLimits.maxTotalBytes
        ) {
          observation.files.push({
            repositoryId,
            path: relativePath,
            state: "gap",
            content: baseContent,
            reason: "too-large",
            kind: "file",
          });
          markGap("output-limit");
          continue;
        }
        const preview = await previewWorkspaceFile(
          { taskId, scope, path: segments, showIgnored: false },
          current,
          {
            captureContentHash: true,
            ...(options.afterWorkingFileOpen
              ? { afterFileOpen: options.afterWorkingFileOpen }
              : {}),
          },
        );
        const file = fileStateFromPreview(preview);
        const content = { ...file.content };
        if (content.size !== null) {
          if (
            content.size > workspaceComparisonLimits.maxFileBytes ||
            totalBytes + content.size > workspaceComparisonLimits.maxTotalBytes
          ) {
            file.state = "gap";
            delete file.text;
            file.reason = "too-large";
            markGap("output-limit");
          } else {
            totalBytes += content.size;
          }
        }
        const captured: WorkspaceTurnFileSnapshot = {
          repositoryId,
          path: relativePath,
          state: file.state,
          content,
          ...(file.text === undefined ? {} : { text: file.text }),
          ...(file.reason === undefined ? {} : { reason: file.reason }),
          kind:
            preview.metadata?.kind === "symlink"
              ? "symlink"
              : preview.metadata?.kind === "other"
                ? "other"
                : "file",
        };
        observation.files.push(captured);
        if (file.state === "gap")
          markGap(
            file.reason === "changing"
              ? "workspace-changed"
              : "workspace-unavailable",
          );
        if (!(await stillCurrent())) markGap("workspace-changed");
      }
    };
    await visit([]);
    if (observation.truncated && observation.reason === "time-limit") break;
  }

  for (const directory of directories) {
    if (
      Date.now() - startedAt >
      (options.timeoutMs ?? workspaceComparisonLimits.maxDurationMs)
    ) {
      observation.truncated = true;
      markGap("time-limit");
      break;
    }
    const latest = await listWorkspaceDirectory(
      {
        taskId,
        scope: directory.scope,
        path: directory.path,
        showIgnored: false,
      },
      current,
    );
    if (
      latest.state !== "ready" ||
      latest.ignoreStatus === "incomplete" ||
      entrySignature(latest.entries) !== directory.entries
    ) {
      markGap("workspace-changed");
      break;
    }
  }
  if (!(await stillCurrent())) markGap("workspace-changed");
  observation.files.sort((a, b) =>
    `${a.repositoryId ?? ""}\0${a.path}`.localeCompare(
      `${b.repositoryId ?? ""}\0${b.path}`,
    ),
  );
  observation.observedAt = Date.now();
  return observation;
}

/** Build immutable side/range anchors from two observations of one actual turn. */
export function compareWorkspaceTurnObservations(
  identity: WorkspaceTurnWorkIdentity & { threadId?: string; turnId?: string },
  comparisonId: string,
  startedAt: number,
  before: WorkspaceTurnObservation,
  after: WorkspaceTurnObservation,
  outcome: WorkspaceTurnComparisonSnapshot["outcome"],
  captureSideContent?: (
    entryIndex: number,
    side: WorkspaceComparisonSide,
    text: string,
  ) => void,
): WorkspaceTurnComparisonSnapshot {
  const previous = new Map(
    before.files.map((file) => [
      `${file.repositoryId ?? ""}\0${file.path}`,
      file,
    ]),
  );
  const current = new Map(
    after.files.map((file) => [
      `${file.repositoryId ?? ""}\0${file.path}`,
      file,
    ]),
  );
  const entries: WorkspaceComparisonEntry[] = [];
  let totalDiffBytes = 0;
  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const leftFile = previous.get(key);
    const rightFile = current.get(key);
    if (
      leftFile &&
      rightFile &&
      ((leftFile.content.sha256 !== undefined &&
        leftFile.content.sha256 === rightFile.content.sha256) ||
        (leftFile.content.sha256 === undefined &&
          rightFile.content.sha256 === undefined &&
          leftFile.state === rightFile.state &&
          leftFile.content.size === rightFile.content.size &&
          leftFile.content.modifiedAt === rightFile.content.modifiedAt))
    )
      continue;
    const file = rightFile ?? leftFile;
    if (!file) continue;
    const path = file.path;
    const segments = pathSegments(path);
    if (!segments) continue;
    const raw: RawChange = {
      oldMode: leftFile ? "100644" : "000000",
      newMode: rightFile ? "100644" : "000000",
      oldObject: leftFile?.content.sha256 ?? "0".repeat(40),
      newObject: rightFile?.content.sha256 ?? "0".repeat(40),
      status: leftFile && rightFile ? "M" : leftFile ? "D" : "A",
      oldPath: leftFile?.path ?? path,
      newPath: rightFile?.path ?? path,
    };
    const left: ContentObservation | undefined = leftFile
      ? {
          state: leftFile.state,
          content: leftFile.content,
          ...(leftFile.text === undefined ? {} : { text: leftFile.text }),
          ...(leftFile.reason === undefined ? {} : { reason: leftFile.reason }),
        }
      : undefined;
    const right: ContentObservation | undefined = rightFile
      ? {
          state: rightFile.state,
          content: rightFile.content,
          ...(rightFile.text === undefined ? {} : { text: rightFile.text }),
          ...(rightFile.reason === undefined
            ? {}
            : { reason: rightFile.reason }),
        }
      : undefined;
    const entry = entryForObservations(
      identity.taskId,
      file.repositoryId,
      comparisonId,
      "turn",
      raw,
      undefined,
      left,
      right,
      identity,
    );
    if (entry.diff) {
      totalDiffBytes += Buffer.byteLength(entry.diff, "utf8");
      if (totalDiffBytes > workspaceComparisonLimits.maxDiffOutputBytes) {
        entry.state = "gap";
        entry.reason = "output-limit";
        delete entry.diff;
        entry.hunks = [];
      }
    }
    const entryIndex = entries.length;
    if (leftFile?.text !== undefined)
      captureSideContent?.(entryIndex, "left", leftFile.text);
    if (rightFile?.text !== undefined)
      captureSideContent?.(entryIndex, "right", rightFile.text);
    entries.push(entry);
  }
  const reason = before.reason ?? after.reason;
  return {
    comparisonId,
    taskId: identity.taskId,
    target: "turn",
    state:
      before.state === "gap" ||
      after.state === "gap" ||
      entries.some((entry) => entry.state === "gap")
        ? "gap"
        : "available",
    outcome,
    startedAt,
    beforeObservedAt: before.observedAt,
    observedAt: after.observedAt,
    taskVersion: identity.taskVersion,
    workId: identity.workId,
    workRevision: identity.workRevision,
    requestSequence: identity.requestSequence,
    assignmentId: identity.assignmentId,
    assignmentVersion: identity.assignmentVersion,
    instructionsRevision: identity.instructionsRevision,
    profileRevision: identity.profileRevision,
    profileId: identity.profileId,
    ...(identity.threadId ? { threadId: identity.threadId } : {}),
    ...(identity.turnId ? { turnId: identity.turnId } : {}),
    entries,
    truncated: before.truncated || after.truncated,
    ...(reason === undefined ? {} : { reason }),
  };
}
