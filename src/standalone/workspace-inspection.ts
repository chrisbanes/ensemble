import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { TaskWorkspaceBinding } from "./workspaces.js";

export const inspectionLimits = Object.freeze({
  maxPathSegments: 32,
  maxPathBytes: 2048,
  maxEntriesScanned: 4096,
  maxEntriesReturned: 256,
  maxTextBytes: 1024 * 1024,
  maxImageOrPdfBytes: 8 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  maxPdfDisplayedPages: 10,
});

const gitIgnoreTimeoutMs = 2_000;
const gitIgnoreOutputBytes = 1024 * 1024;
const gitIgnoreInputBytes = 2 * 1024 * 1024;
const childTerminationGraceMs = 100;
const childTerminationObservationMs = 500;
const repositoryFreeClutter = new Set([
  ".ds_store",
  "node_modules",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "coverage",
]);

export type WorkspaceInspectionScope =
  | { kind: "workspace" }
  | { kind: "repository"; repositoryId: string };

export interface WorkspaceInspectionCurrent {
  taskId: string;
  taskVersion: number;
  visibility: string;
  binding?: TaskWorkspaceBinding;
  controlPaths: readonly string[];
}

export interface WorkspaceInspectionPathReference {
  scope: WorkspaceInspectionScope;
  path: readonly string[];
}

export interface WorkspaceInspectionRequest {
  taskId: string;
  scope: WorkspaceInspectionScope;
  path?: readonly string[];
  showIgnored: boolean;
}

export interface WorkspaceInspectionOptions {
  /** Test-only executable override; production always resolves the `git` command. */
  gitExecutable?: string;
  /** Test-only shortened Git ignore deadline. */
  gitIgnoreTimeoutMs?: number;
  /** Test-only observation of a directory after the safe root was opened. */
  afterDirectoryOpen?: (path: string) => Promise<void>;
  /** Test-only observation after an exact no-follow file handle was opened. */
  afterFileOpen?: (path: string) => Promise<void>;
  /** Internal comparison identity; hashes only bytes already read by this boundary. */
  captureContentHash?: boolean;
}

export class WorkspaceInspectionInputError extends Error {
  constructor() {
    super("invalid-input");
    this.name = "WorkspaceInspectionInputError";
  }
}

export type WorkspaceInspectionEntry =
  | {
      kind: "repository";
      repositoryId: string;
      size: null;
      modifiedAt: null;
      ignored: false;
    }
  | {
      kind: "file" | "directory" | "symlink" | "other";
      name: string;
      size: number | null;
      modifiedAt: number | null;
      ignored: boolean | null;
    };

export interface WorkspaceDirectoryListing {
  taskId: string;
  workspaceId: string | null;
  scope: WorkspaceInspectionScope;
  path: string[];
  state:
    | "ready"
    | "missing"
    | "provisioning"
    | "held"
    | "archiving"
    | "archived"
    | "excluded"
    | "ignored"
    | "conflict"
    | "unavailable";
  entries: WorkspaceInspectionEntry[];
  truncated: boolean;
  ignoreStatus: "known" | "not-applicable" | "incomplete";
  observedAt: number;
}

export type WorkspacePreviewData =
  | {
      kind: "text";
      mime: string;
      text: string;
      sha256: string;
      size: number;
    }
  | {
      kind: "base64";
      mime:
        | "image/png"
        | "image/jpeg"
        | "image/gif"
        | "image/webp"
        | "application/pdf";
      data: string;
      sha256: string;
      size: number;
      width?: number;
      height?: number;
      maxDisplayedPages?: number;
    };

export interface WorkspaceFilePreview {
  taskId: string;
  workspaceId: string | null;
  scope: WorkspaceInspectionScope;
  path: string[];
  state: WorkspaceDirectoryListing["state"] | "metadata-only";
  observedAt: number;
  metadata?: {
    kind: "file" | "directory" | "symlink" | "other";
    size: number | null;
    modifiedAt: number | null;
    sha256?: string;
    ignored: boolean | null;
    reason?:
      | "unsupported-format"
      | "binary-content"
      | "invalid-content"
      | "too-large"
      | "multiple-links"
      | "image-dimensions-exceed-limit";
  };
  preview?: WorkspacePreviewData;
}

type Root = {
  path: string;
  binding: TaskWorkspaceBinding;
  repository?: TaskWorkspaceBinding["repositories"][number];
};

type IgnoreResult =
  | { complete: true; ignored: Set<string> }
  | { complete: false };

const within = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
};

const sameStat = (
  a: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    nlink?: number;
  },
  b: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    nlink?: number;
  },
) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  (a.nlink === undefined || b.nlink === undefined || a.nlink === b.nlink);

const safeSegments = (value: readonly string[] | undefined): string[] => {
  if (value !== undefined && !Array.isArray(value))
    throw new WorkspaceInspectionInputError();
  const segments = value ? [...value] : [];
  if (segments.length > inspectionLimits.maxPathSegments)
    throw new WorkspaceInspectionInputError();
  let bytes = 0;
  for (const [index, segment] of segments.entries()) {
    if (
      typeof segment !== "string" ||
      !segment ||
      segment === "." ||
      segment === ".." ||
      (index === 0 && /^[a-z]:/i.test(segment)) ||
      segment.includes("/") ||
      segment.includes("\\") ||
      /\p{Cc}/u.test(segment) ||
      Buffer.from(segment, "utf8").toString("utf8") !== segment
    )
      throw new WorkspaceInspectionInputError();
    bytes += Buffer.byteLength(segment, "utf8") + (bytes ? 1 : 0);
  }
  if (bytes > inspectionLimits.maxPathBytes)
    throw new WorkspaceInspectionInputError();
  return segments;
};

const privateComponent = (component: string) => {
  const name = component.normalize("NFC").toLocaleLowerCase("und");
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
};

const normalizedFilesystemPath = (path: string) =>
  resolve(path)
    .split(sep)
    .map((part) => part.normalize("NFC").toLocaleLowerCase("und"))
    .join(sep);

const withinNormalized = (root: string, candidate: string) =>
  within(normalizedFilesystemPath(root), normalizedFilesystemPath(candidate));

type CanonicalPath = { path: string; complete: boolean };

async function canonicalPathWithExistingParent(
  path: string,
): Promise<CanonicalPath | undefined> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return {
        path: resolve(await realpath(current), ...suffix),
        complete: suffix.length === 0,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function createPathExclusion(
  root: string,
  controlPaths: readonly string[],
) {
  const absoluteRoot = resolve(root);
  const canonicalRoot = await canonicalPathWithExistingParent(absoluteRoot);
  const allControls = await Promise.all(
    controlPaths.filter(Boolean).map(async (path) => {
      const absolutePath = resolve(path);
      return {
        path: absolutePath,
        canonical: await canonicalPathWithExistingParent(absolutePath),
      };
    }),
  );
  const controls = allControls.filter(
    (control) =>
      within(absoluteRoot, control.path) ||
      withinNormalized(absoluteRoot, control.path) ||
      (canonicalRoot?.complete === true &&
        control.canonical?.complete === true &&
        within(canonicalRoot.path, control.canonical.path)),
  );
  return async (
    path: string,
    options: { fromDirectoryEntry?: boolean } = {},
  ) => {
    const absolutePath = resolve(path);
    if (!within(absoluteRoot, absolutePath)) return true;
    const local = relative(absoluteRoot, absolutePath);
    if ((local ? local.split(sep) : []).some(privateComponent)) return true;
    if (
      controls.some(
        (control) =>
          within(absoluteRoot, control.path) &&
          within(control.path, absolutePath),
      )
    )
      return true;

    let candidate = options.fromDirectoryEntry
      ? { path: absolutePath, complete: true }
      : await canonicalPathWithExistingParent(absolutePath);
    if (!candidate) return true;
    for (const control of controls) {
      if (!control.canonical) {
        if (
          withinNormalized(absoluteRoot, control.path) &&
          withinNormalized(control.path, absolutePath)
        )
          return true;
        continue;
      }
      if (
        control.canonical.complete &&
        within(control.canonical.path, candidate.path)
      )
        return true;
    }
    const possibleAliases = controls.some(
      (control) =>
        withinNormalized(absoluteRoot, control.path) &&
        withinNormalized(control.path, absolutePath),
    );
    if (options.fromDirectoryEntry && possibleAliases) {
      candidate = await canonicalPathWithExistingParent(absolutePath);
      if (!candidate) return true;
      for (const control of controls) {
        if (!control.canonical) {
          if (
            withinNormalized(absoluteRoot, control.path) &&
            withinNormalized(control.path, absolutePath)
          )
            return true;
          continue;
        }
        if (
          control.canonical.complete &&
          within(control.canonical.path, candidate.path)
        )
          return true;
      }
    }
    // If the candidate does not exist, retain conservative normalized matching.
    return (
      !candidate.complete &&
      controls.some(
        (control) =>
          withinNormalized(absoluteRoot, control.path) &&
          withinNormalized(control.path, absolutePath),
      )
    );
  };
}

const privateSegmentsExcluded = (segments: readonly string[]) =>
  segments.some(privateComponent);

/**
 * Fail-closed path gate for comparison code that reads immutable Git objects.
 * Working-tree bytes must still go through previewWorkspaceFile, which also
 * applies the no-follow and stable-file checks.
 */
export async function workspaceInspectionPathExcluded(
  taskId: string,
  scope: WorkspaceInspectionScope,
  path: readonly string[],
  current: () => Promise<WorkspaceInspectionCurrent>,
): Promise<boolean> {
  const segments = safeSegments(path);
  if (
    !taskId ||
    !scope ||
    (scope.kind !== "workspace" &&
      (scope.kind !== "repository" || !scope.repositoryId))
  )
    throw new WorkspaceInspectionInputError();
  if (privateSegmentsExcluded(segments)) return true;
  try {
    const initial = await current();
    if (initial.taskId !== taskId) return true;
    const root = currentRoot(initial, scope);
    if (!root || root.binding.state !== "ready") return true;
    if (scope.kind === "workspace") {
      const repositories = repositoryWorkspaceNames(root.binding);
      if (!repositories) return true;
      const firstSegment = segments[0];
      if (firstSegment !== undefined && repositories.has(firstSegment))
        return true;
    }
    const excluded = await createPathExclusion(root.path, initial.controlPaths);
    if (await excluded(root.path)) return true;
    const target = resolve(root.path, ...segments);
    if (!within(root.path, target) || (await excluded(target))) return true;
    const parent = await validateDirectory(root, segments.slice(0, -1));
    const repositories =
      scope.kind === "workspace"
        ? await validateBoundRepositories(root.binding)
        : undefined;
    return !(await sameObservation(
      current,
      initial,
      taskId,
      root,
      segments.slice(0, -1),
      parent,
      repositories,
    ));
  } catch {
    return true;
  }
}

/** Recheck a retained relative path against today's private/control-path rules without reading it. */
export async function retainedPathExcluded(
  originRoot: string,
  path: readonly string[],
  controlPaths: readonly string[],
): Promise<boolean> {
  try {
    const segments = safeSegments(path);
    if (!isAbsolute(originRoot) || segments.length === 0) return true;
    const root = resolve(originRoot);
    if (root.split(sep).some(privateComponent)) return true;
    const excluded = await createPathExclusion(root, controlPaths);
    return excluded(resolve(root, ...segments));
  } catch {
    return true;
  }
}

/**
 * Revalidate a bounded set of paths under one current binding and privacy
 * snapshot. Stored comparison responses can contain many hunks for the same
 * file; checking them as one observation avoids repeating binding validation
 * for every range while still checking the current binding and roots before
 * returning any stored path or patch.
 */
export async function workspaceInspectionPathsExcluded(
  taskId: string,
  references: readonly WorkspaceInspectionPathReference[],
  initial: WorkspaceInspectionCurrent,
  current: () => Promise<WorkspaceInspectionCurrent>,
): Promise<boolean> {
  if (!taskId || initial.taskId !== taskId) return true;
  if (!references.length) {
    try {
      const latest = await current();
      return (
        latest.taskId !== taskId ||
        workspaceInspectionBindingIdentity(latest) !==
          workspaceInspectionBindingIdentity(initial)
      );
    } catch {
      return true;
    }
  }

  type ScopeSnapshot = {
    scope: WorkspaceInspectionScope;
    root: Root;
    excluded: Awaited<ReturnType<typeof createPathExclusion>>;
    directory: Awaited<ReturnType<typeof validateDirectory>>;
  };
  const scopes = new Map<string, ScopeSnapshot>();
  const paths = new Map<
    string,
    { scope: ScopeSnapshot; segments: string[]; target: string }
  >();
  const directories = new Map<
    string,
    {
      root: Root;
      segments: string[];
      snapshot: Awaited<ReturnType<typeof validateDirectory>>;
    }
  >();

  try {
    if (!initial.binding || initial.binding.state !== "ready") return true;
    for (const reference of references) {
      const segments = safeSegments(reference.path);
      if (privateSegmentsExcluded(segments)) return true;
      const scopeKey =
        reference.scope.kind === "workspace"
          ? "workspace"
          : JSON.stringify(["repository", reference.scope.repositoryId]);
      let scope = scopes.get(scopeKey);
      if (!scope) {
        const root = currentRoot(initial, reference.scope);
        if (!root || root.binding.state !== "ready") return true;
        if (reference.scope.kind === "workspace") {
          const repositories = repositoryWorkspaceNames(root.binding);
          if (!repositories) return true;
          if (segments[0] !== undefined && repositories.has(segments[0]))
            return true;
        }
        const excluded = await createPathExclusion(
          root.path,
          initial.controlPaths,
        );
        if (await excluded(root.path)) return true;
        scope = {
          scope: reference.scope,
          root,
          excluded,
          directory: await validateDirectory(root, []),
        };
        scopes.set(scopeKey, scope);
      }
      if (
        reference.scope.kind === "workspace" &&
        segments[0] !== undefined &&
        repositoryWorkspaceNames(scope.root.binding)?.has(segments[0])
      )
        return true;
      const target = resolve(scope.root.path, ...segments);
      if (!within(scope.root.path, target) || (await scope.excluded(target)))
        return true;
      const pathKey = JSON.stringify([scopeKey, segments]);
      if (!paths.has(pathKey)) paths.set(pathKey, { scope, segments, target });
    }

    for (const { scope, segments } of paths.values()) {
      const parentSegments = segments.slice(0, -1);
      const directoryKey = JSON.stringify([scope.root.path, parentSegments]);
      if (!directories.has(directoryKey))
        directories.set(directoryKey, {
          root: scope.root,
          segments: parentSegments,
          snapshot: await validateDirectory(scope.root, parentSegments),
        });
    }

    for (const scope of scopes.values()) {
      if (
        !sameDirectorySnapshot(
          scope.directory,
          await validateDirectory(scope.root, []),
        )
      )
        return true;
    }
    for (const directory of directories.values()) {
      if (
        !sameDirectorySnapshot(
          directory.snapshot,
          await validateDirectory(directory.root, directory.segments),
        )
      )
        return true;
    }
    // This is deliberately the final await: it rechecks the stored binding,
    // task visibility and copied privacy policy after all path filesystem
    // observations, so an awaited stat cannot outlive the current gate.
    const latest = await current();
    if (
      latest.taskId !== taskId ||
      workspaceInspectionBindingIdentity(latest) !==
        workspaceInspectionBindingIdentity(initial)
    )
      return true;
    for (const scope of scopes.values()) {
      const latestRoot = currentRoot(latest, scope.scope);
      if (!latestRoot || latestRoot.path !== scope.root.path) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export const workspaceInspectionBindingIdentity = (
  current: WorkspaceInspectionCurrent,
) =>
  JSON.stringify({
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
            repository.gitCommonDir,
            repository.commit,
          ]),
        }
      : null,
  });

const currentRoot = (
  current: WorkspaceInspectionCurrent,
  scope: WorkspaceInspectionScope,
): Root | undefined => {
  const binding = current.binding;
  if (!binding || binding.taskId !== current.taskId) return undefined;
  if (scope.kind === "workspace") return { path: binding.path, binding };
  const matches = binding.repositories.filter(
    (item) => item.repositoryId === scope.repositoryId,
  );
  if (matches.length !== 1) return undefined;
  const repository = matches[0];
  if (!repository) return undefined;
  return { path: repository.workspacePath, binding, repository };
};

const repositoryWorkspaceNames = (binding: TaskWorkspaceBinding) => {
  const result = new Map<string, string>();
  const repositoryIds = new Set<string>();
  for (const repository of binding.repositories) {
    const relativePath = relative(binding.path, repository.workspacePath);
    if (
      !repository.repositoryId ||
      repositoryIds.has(repository.repositoryId) ||
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath.includes(sep)
    )
      return undefined;
    repositoryIds.add(repository.repositoryId);
    result.set(relativePath, repository.repositoryId);
  }
  return result;
};

const availabilityState = (
  current: WorkspaceInspectionCurrent,
  root: Root | undefined,
): WorkspaceDirectoryListing["state"] | undefined => {
  if (!current.binding) return "missing";
  if (!root) return "unavailable";
  return current.binding.state === "ready" ? undefined : current.binding.state;
};

const safeFsState = (error: unknown): WorkspaceDirectoryListing["state"] => {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
  if ((error as NodeJS.ErrnoException)?.code === "ELOOP") return "conflict";
  return "unavailable";
};

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
  child.kill("SIGTERM");
  if (await waitForExit(child, childTerminationGraceMs)) return true;
  child.kill("SIGKILL");
  return waitForExit(child, childTerminationObservationMs);
}

function checkGitIgnore(
  executable: string,
  repositoryPath: string,
  paths: readonly string[],
  timeoutMs: number,
): Promise<IgnoreResult> {
  const input = Buffer.concat(
    paths.map((path) => Buffer.from(`${path}\0`, "utf8")),
  );
  if (input.length > gitIgnoreInputBytes)
    return Promise.resolve({ complete: false });
  return new Promise((resolveResult) => {
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
        executable,
        [
          "-C",
          repositoryPath,
          "-c",
          "core.fsmonitor=false",
          "check-ignore",
          "-z",
          "--stdin",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: environment,
        },
      );
    } catch {
      resolveResult({ complete: false });
      return;
    }
    let stdout = Buffer.alloc(0);
    let outputBytes = 0;
    let exitObserved = false;
    let closeObserved = false;
    let exitCode: number | null = null;
    let failed = false;
    let stopped = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: IgnoreResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      void stopOwnedChild(child).finally(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ complete: false });
      });
    };
    child.once("error", () => {
      failed = true;
      stop();
    });
    child.once("exit", (code) => {
      exitObserved = true;
      exitCode = code;
    });
    child.once("close", (code) => {
      closeObserved = true;
      if (code !== null) exitCode = code;
      if (stopped) return;
      if (
        failed ||
        !exitObserved ||
        !closeObserved ||
        (exitCode !== 0 && exitCode !== 1)
      ) {
        finish({ complete: false });
        return;
      }
      const ignored = new Set<string>();
      if (stdout.length > 0 && stdout.at(-1) !== 0) {
        finish({ complete: false });
        return;
      }
      try {
        const allowed = new Set(paths);
        let start = 0;
        while (start < stdout.length) {
          const end = stdout.indexOf(0, start);
          if (end < 0) {
            finish({ complete: false });
            return;
          }
          const value = new TextDecoder("utf-8", { fatal: true }).decode(
            stdout.subarray(start, end),
          );
          if (!allowed.has(value)) {
            finish({ complete: false });
            return;
          }
          ignored.add(value);
          start = end + 1;
        }
        finish({ complete: true, ignored });
      } catch {
        finish({ complete: false });
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > gitIgnoreOutputBytes) {
        stop();
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > gitIgnoreOutputBytes) stop();
    });
    child.stdin?.on("error", () => {
      failed = true;
      stop();
    });
    timer = setTimeout(stop, timeoutMs);
    child.stdin?.end(input);
  });
}

type DirectoryIdentity = {
  path: string;
  canonical: string;
  stat: Stats;
};

async function validateRoot(root: Root): Promise<DirectoryIdentity> {
  if (!isAbsolute(root.path) || resolve(root.path) !== root.path)
    throw new Error("root");
  const stat = await lstat(root.path, { bigint: false });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("root");
  const canonical = await realpath(root.path);
  if (canonical !== root.path) throw new Error("root");
  return { path: root.path, stat, canonical };
}

async function validateDirectory(root: Root, segments: readonly string[]) {
  const identities = [await validateRoot(root)];
  let current = root.path;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!within(root.path, current)) throw new Error("path");
    const stat = await lstat(current, { bigint: false });
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("directory");
    const canonical = await realpath(current);
    if (canonical !== current) throw new Error("directory");
    identities.push({ path: current, stat, canonical });
  }
  return { path: current, identities };
}

const sameDirectorySnapshot = (
  a: Awaited<ReturnType<typeof validateDirectory>>,
  b: Awaited<ReturnType<typeof validateDirectory>>,
) =>
  a.path === b.path &&
  a.identities.length === b.identities.length &&
  a.identities.every((identity, index) => {
    const other = b.identities[index];
    return (
      other !== undefined &&
      identity.path === other.path &&
      identity.canonical === other.canonical &&
      sameStat(identity.stat, other.stat)
    );
  });

async function validateBoundRepositories(binding: TaskWorkspaceBinding) {
  const snapshots = new Map<string, DirectoryIdentity>();
  for (const repository of binding.repositories) {
    snapshots.set(
      repository.repositoryId,
      await validateRoot({
        path: repository.workspacePath,
        binding,
        repository,
      }),
    );
  }
  return snapshots;
}

const sameRepositorySnapshots = (
  a: Map<string, DirectoryIdentity>,
  b: Map<string, DirectoryIdentity>,
) =>
  a.size === b.size &&
  [...a].every(([repositoryId, identity]) => {
    const other = b.get(repositoryId);
    return (
      other !== undefined &&
      identity.path === other.path &&
      identity.canonical === other.canonical &&
      sameStat(identity.stat, other.stat)
    );
  });

async function ignoredPaths(
  root: Root,
  segments: readonly string[],
  options: WorkspaceInspectionOptions,
): Promise<IgnoreResult> {
  if (!root.repository || segments.length === 0)
    return { complete: true, ignored: new Set() };
  const prefixes = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  );
  return checkGitIgnore(
    options.gitExecutable ?? "git",
    root.path,
    prefixes,
    options.gitIgnoreTimeoutMs ?? gitIgnoreTimeoutMs,
  );
}

async function sameObservation(
  current: () => Promise<WorkspaceInspectionCurrent>,
  initial: WorkspaceInspectionCurrent,
  requestTaskId: string,
  root: Root,
  segments: readonly string[],
  directorySnapshot: Awaited<ReturnType<typeof validateDirectory>>,
  repositorySnapshots?: Map<string, DirectoryIdentity>,
): Promise<boolean> {
  try {
    const latest = await current();
    const latestDirectory = await validateDirectory(root, segments);
    const latestRepositories =
      repositorySnapshots === undefined
        ? undefined
        : await validateBoundRepositories(root.binding);
    return (
      latest.taskId === requestTaskId &&
      workspaceInspectionBindingIdentity(latest) ===
        workspaceInspectionBindingIdentity(initial) &&
      sameDirectorySnapshot(directorySnapshot, latestDirectory) &&
      (repositorySnapshots === undefined ||
        (latestRepositories !== undefined &&
          sameRepositorySnapshots(repositorySnapshots, latestRepositories)))
    );
  } catch {
    return false;
  }
}

/**
 * Capture the exact #779 managed-root identity for a sequence of read-only
 * Git operations. Each check rereads current task/binding/privacy state and
 * requires the same canonical root inode captured here.
 */
export async function workspaceInspectionRootGuard(
  taskId: string,
  scope: WorkspaceInspectionScope,
  initial: WorkspaceInspectionCurrent,
  current: () => Promise<WorkspaceInspectionCurrent>,
  additionalIdentityCheck?: (latest: WorkspaceInspectionCurrent) => boolean,
): Promise<(() => Promise<boolean>) | undefined> {
  if (initial.taskId !== taskId) return undefined;
  const root = currentRoot(initial, scope);
  if (!root || root.binding.state !== "ready") return undefined;
  if (scope.kind === "workspace" && !repositoryWorkspaceNames(root.binding))
    return undefined;
  try {
    const exclusion = await createPathExclusion(
      root.path,
      initial.controlPaths,
    );
    if (await exclusion(root.path)) return undefined;
    const directory = await validateDirectory(root, []);
    const repositories =
      scope.kind === "workspace"
        ? await validateBoundRepositories(root.binding)
        : undefined;
    if (
      !(await sameObservation(
        current,
        initial,
        taskId,
        root,
        [],
        directory,
        repositories,
      ))
    )
      return undefined;
    const identity = workspaceInspectionBindingIdentity(initial);
    return async () => {
      try {
        const latest = await current();
        if (
          latest.taskId !== taskId ||
          workspaceInspectionBindingIdentity(latest) !== identity ||
          (additionalIdentityCheck && !additionalIdentityCheck(latest))
        )
          return false;
        const latestExclusion = await createPathExclusion(
          root.path,
          latest.controlPaths,
        );
        if (await latestExclusion(root.path)) return false;
        const latestDirectory = await validateDirectory(root, []);
        const latestRepositories =
          repositories === undefined
            ? undefined
            : await validateBoundRepositories(root.binding);
        return (
          sameDirectorySnapshot(directory, latestDirectory) &&
          (repositories === undefined ||
            (latestRepositories !== undefined &&
              sameRepositorySnapshots(repositories, latestRepositories)))
        );
      } catch {
        return false;
      }
    };
  } catch {
    return undefined;
  }
}

const repositoryFreeIgnored = (segments: readonly string[]) =>
  segments.some((segment) => repositoryFreeClutter.has(segment.toLowerCase()));

const textMimes: Readonly<Record<string, string>> = Object.freeze({
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".tsx": "text/typescript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".sql": "application/sql; charset=utf-8",
  ".go": "text/x-go; charset=utf-8",
  ".rs": "text/x-rust; charset=utf-8",
  ".java": "text/x-java-source; charset=utf-8",
  ".kt": "text/x-kotlin; charset=utf-8",
  ".kts": "text/x-kotlin; charset=utf-8",
  ".swift": "text/x-swift; charset=utf-8",
  ".c": "text/x-c; charset=utf-8",
  ".h": "text/x-c; charset=utf-8",
  ".cpp": "text/x-c++; charset=utf-8",
  ".hpp": "text/x-c++; charset=utf-8",
  ".rb": "text/x-ruby; charset=utf-8",
  ".php": "text/x-php; charset=utf-8",
  ".gradle": "text/plain; charset=utf-8",
  ".properties": "text/plain; charset=utf-8",
});

const imageExtensionMime: Readonly<
  Record<string, WorkspacePreviewData["mime"]>
> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
});

type ImageInfo = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
};

function jpegDimensions(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00) return undefined;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (frameMarkers.has(marker)) {
      if (length < 7) return undefined;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function rasterInfo(bytes: Buffer): ImageInfo | undefined {
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return {
      mime: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)))
    return {
      mime: "image/gif",
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mime: "image/jpeg", ...jpeg };
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X")
      return {
        mime: "image/webp",
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (
      chunk === "VP8 " &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    )
      return {
        mime: "image/webp",
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return {
        mime: "image/webp",
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
  }
  return undefined;
}

const validText = (bytes: Buffer): string | undefined => {
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
};

/** Reapply the existing bounded preview checks to immutable retained bytes. */
export function previewRetainedBytes(
  bytes: Buffer,
  expectedMime: string,
): WorkspacePreviewData | undefined {
  if (bytes.byteLength > inspectionLimits.maxImageOrPdfBytes) return undefined;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedMime === "application/pdf") {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return undefined;
    return {
      kind: "base64",
      mime: "application/pdf",
      data: bytes.toString("base64"),
      sha256,
      size: bytes.byteLength,
      maxDisplayedPages: inspectionLimits.maxPdfDisplayedPages,
    };
  }
  if (expectedMime.startsWith("image/")) {
    if (bytes.byteLength > inspectionLimits.maxImageOrPdfBytes)
      return undefined;
    const raster = rasterInfo(bytes);
    if (
      !raster ||
      raster.mime !== expectedMime ||
      raster.width < 1 ||
      raster.height < 1 ||
      raster.width * raster.height > inspectionLimits.maxImagePixels
    )
      return undefined;
    return {
      kind: "base64",
      mime: raster.mime,
      data: bytes.toString("base64"),
      sha256,
      size: bytes.byteLength,
      width: raster.width,
      height: raster.height,
    };
  }
  if (
    !expectedMime.startsWith("text/") &&
    expectedMime !== "application/json; charset=utf-8" &&
    expectedMime !== "application/sql; charset=utf-8" &&
    expectedMime !== "application/vnd.ensemble.workspace-diff+json"
  )
    return undefined;
  if (bytes.byteLength > inspectionLimits.maxTextBytes) return undefined;
  const text = validText(bytes);
  if (
    text === undefined ||
    !Buffer.from(text, "utf8").equals(bytes) ||
    rasterInfo(bytes) !== undefined ||
    bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  )
    return undefined;
  return {
    kind: "text",
    mime: expectedMime,
    text,
    sha256,
    size: bytes.byteLength,
  };
}

export async function listWorkspaceDirectory(
  request: WorkspaceInspectionRequest,
  current: () => Promise<WorkspaceInspectionCurrent>,
  options: WorkspaceInspectionOptions = {},
): Promise<WorkspaceDirectoryListing> {
  const segments = safeSegments(request.path);
  if (
    !request.taskId ||
    !request.scope ||
    typeof request.showIgnored !== "boolean"
  )
    throw new WorkspaceInspectionInputError();
  if (
    request.scope.kind !== "workspace" &&
    (request.scope.kind !== "repository" || !request.scope.repositoryId)
  )
    throw new WorkspaceInspectionInputError();
  const observedAt = Date.now();
  const blank = (
    state: WorkspaceDirectoryListing["state"],
    identity?: WorkspaceInspectionCurrent,
    ignoreStatus: WorkspaceDirectoryListing["ignoreStatus"] = "not-applicable",
  ): WorkspaceDirectoryListing => ({
    taskId: request.taskId,
    workspaceId: identity?.binding?.workspaceId ?? null,
    scope: request.scope,
    path: state === "excluded" ? [] : segments,
    state,
    entries: [],
    truncated: false,
    ignoreStatus,
    observedAt,
  });

  if (privateSegmentsExcluded(segments)) return blank("excluded");
  const initial = await current();
  if (initial.taskId !== request.taskId) return blank("conflict", initial);
  const root = currentRoot(initial, request.scope);
  let pathExcluded: Awaited<ReturnType<typeof createPathExclusion>> | undefined;
  if (root) {
    pathExcluded = await createPathExclusion(root.path, initial.controlPaths);
    if (await pathExcluded(root.path)) return blank("excluded", initial);
    const absolutePath = resolve(root.path, ...segments);
    if (!within(root.path, absolutePath))
      throw new WorkspaceInspectionInputError();
    if (await pathExcluded(absolutePath)) return blank("excluded", initial);
  }
  const unavailable = availabilityState(initial, root);
  if (unavailable) return blank(unavailable, initial);
  if (root?.binding.state !== "ready") return blank("unavailable", initial);
  if (
    request.scope.kind === "repository" &&
    request.scope.repositoryId !== root.repository?.repositoryId
  )
    return blank("unavailable", initial);

  const absolutePath = resolve(root.path, ...segments);
  if (!within(root.path, absolutePath))
    throw new WorkspaceInspectionInputError();

  let repositoryNames: Map<string, string> | undefined;
  if (request.scope.kind === "workspace") {
    repositoryNames = repositoryWorkspaceNames(root.binding);
    if (!repositoryNames) return blank("unavailable", initial);
    const firstSegment = segments[0];
    if (firstSegment !== undefined && repositoryNames.has(firstSegment))
      return blank("conflict", initial);
  }

  let directorySnapshot: Awaited<ReturnType<typeof validateDirectory>>;
  let repositorySnapshots: Map<string, DirectoryIdentity> | undefined;
  try {
    directorySnapshot = await validateDirectory(root, segments);
    if (request.scope.kind === "workspace" && segments.length === 0)
      repositorySnapshots = await validateBoundRepositories(root.binding);
  } catch (error) {
    return blank(safeFsState(error), initial);
  }

  const ignoreStatus: WorkspaceDirectoryListing["ignoreStatus"] =
    root.repository ? "known" : "not-applicable";
  let requestedIgnored = new Set<string>();
  if (root.repository) {
    const result = await ignoredPaths(root, segments, options);
    if (!result.complete) return blank("unavailable", initial, "incomplete");
    requestedIgnored = result.ignored;
  }
  if (
    !(await sameObservation(
      current,
      initial,
      request.taskId,
      root,
      segments,
      directorySnapshot,
      repositorySnapshots,
    ))
  )
    return blank("conflict", initial, ignoreStatus);
  if (!request.showIgnored && requestedIgnored.size)
    return blank("ignored", initial, "known");
  if (
    !root.repository &&
    !request.showIgnored &&
    repositoryFreeIgnored(segments)
  )
    return blank("ignored", initial, ignoreStatus);

  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  const entries: WorkspaceInspectionEntry[] = [];
  let scanned = 0;
  let truncated = false;
  try {
    directory = await opendir(directorySnapshot.path);
    await options.afterDirectoryOpen?.(directorySnapshot.path);
    if (
      !(await sameObservation(
        current,
        initial,
        request.taskId,
        root,
        segments,
        directorySnapshot,
        repositorySnapshots,
      ))
    )
      return blank("conflict", initial, ignoreStatus);
    const repositoryMap = new Map<string, string>();
    if (request.scope.kind === "workspace" && segments.length === 0) {
      if (!repositoryNames) return blank("unavailable", initial, ignoreStatus);
      for (const [name, repositoryId] of repositoryNames)
        repositoryMap.set(name, repositoryId);
    }
    const candidatePaths: string[] = [];
    const candidateEntries: Array<{
      name: string;
      path: string;
      repositoryId?: string;
    }> = [];
    for await (const dirent of directory) {
      scanned++;
      if (scanned > inspectionLimits.maxEntriesScanned) {
        truncated = true;
        break;
      }
      const name = dirent.name;
      if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("\ufffd") ||
        name.includes("/") ||
        name.includes("\\") ||
        /\p{Cc}/u.test(name) ||
        Buffer.from(name, "utf8").toString("utf8") !== name
      ) {
        truncated = true;
        continue;
      }
      const path = resolve(directorySnapshot.path, name);
      if (await pathExcluded!(path, { fromDirectoryEntry: true })) continue;
      const repositoryId = repositoryMap.get(name);
      if (repositoryId !== undefined) {
        candidateEntries.push({
          name,
          path,
          repositoryId,
        });
        continue;
      }
      const relativePath = [...segments, name];
      if (
        !root.repository &&
        !request.showIgnored &&
        repositoryFreeIgnored(relativePath)
      )
        continue;
      candidateEntries.push({ name, path });
      if (root.repository)
        candidatePaths.push(relative(root.path, path).split(sep).join("/"));
    }

    let ignored = new Set<string>();
    if (root.repository && candidatePaths.length) {
      const result = await checkGitIgnore(
        options.gitExecutable ?? "git",
        root.path,
        candidatePaths,
        options.gitIgnoreTimeoutMs ?? gitIgnoreTimeoutMs,
      );
      if (!result.complete) return blank("unavailable", initial, "incomplete");
      ignored = result.ignored;
    }
    for (const candidate of candidateEntries) {
      let entry: WorkspaceInspectionEntry;
      if (candidate.repositoryId) {
        entry = {
          kind: "repository",
          repositoryId: candidate.repositoryId,
          size: null,
          modifiedAt: null,
          ignored: false,
        };
      } else {
        const relativePath = relative(root.path, candidate.path)
          .split(sep)
          .join("/");
        const isIgnored = ignored.has(relativePath);
        if (isIgnored && !request.showIgnored) continue;
        let stat: Stats;
        try {
          stat = await lstat(candidate.path);
        } catch {
          return blank("conflict", initial, ignoreStatus);
        }
        const kind = stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other";
        entry = {
          kind,
          name: candidate.name,
          size: stat.isFile() ? stat.size : null,
          modifiedAt: Number.isFinite(stat.mtimeMs)
            ? Math.trunc(stat.mtimeMs)
            : null,
          ignored: root.repository ? isIgnored : false,
        };
      }
      if (entries.length >= inspectionLimits.maxEntriesReturned) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } catch (error) {
    return blank(safeFsState(error), initial, ignoreStatus);
  } finally {
    await directory?.close().catch(() => undefined);
  }

  if (
    !(await sameObservation(
      current,
      initial,
      request.taskId,
      root,
      segments,
      directorySnapshot,
      repositorySnapshots,
    ))
  )
    return blank("conflict", initial, ignoreStatus);

  return {
    taskId: request.taskId,
    workspaceId: root.binding.workspaceId,
    scope: request.scope,
    path: segments,
    state: "ready",
    entries,
    truncated,
    ignoreStatus,
    observedAt,
  };
}

export async function previewWorkspaceFile(
  request: WorkspaceInspectionRequest,
  current: () => Promise<WorkspaceInspectionCurrent>,
  options: WorkspaceInspectionOptions = {},
): Promise<WorkspaceFilePreview> {
  const segments = safeSegments(request.path);
  if (
    !request.taskId ||
    !request.scope ||
    segments.length === 0 ||
    typeof request.showIgnored !== "boolean" ||
    (request.scope.kind !== "workspace" &&
      (request.scope.kind !== "repository" || !request.scope.repositoryId))
  )
    throw new WorkspaceInspectionInputError();

  const observedAt = Date.now();
  const blank = (
    state: WorkspaceFilePreview["state"],
    identity?: WorkspaceInspectionCurrent,
  ): WorkspaceFilePreview => ({
    taskId: request.taskId,
    workspaceId: identity?.binding?.workspaceId ?? null,
    scope: request.scope,
    path: state === "excluded" ? [] : segments,
    state,
    observedAt,
  });
  const metadataOnly = (
    identity: WorkspaceInspectionCurrent,
    stat: Stats,
    ignored: boolean | null,
    reason: Exclude<
      NonNullable<WorkspaceFilePreview["metadata"]>["reason"],
      undefined
    >,
    sha256?: string,
  ): WorkspaceFilePreview => ({
    ...blank("metadata-only", identity),
    metadata: {
      kind: "file",
      size: stat.size,
      modifiedAt: Number.isFinite(stat.mtimeMs)
        ? Math.trunc(stat.mtimeMs)
        : null,
      ...(options.captureContentHash && sha256 ? { sha256 } : {}),
      ignored,
      reason,
    },
  });

  if (privateSegmentsExcluded(segments)) return blank("excluded");
  const initial = await current();
  if (initial.taskId !== request.taskId) return blank("conflict", initial);
  const root = currentRoot(initial, request.scope);
  let pathExcluded: Awaited<ReturnType<typeof createPathExclusion>> | undefined;
  if (root) {
    pathExcluded = await createPathExclusion(root.path, initial.controlPaths);
    if (await pathExcluded(root.path)) return blank("excluded", initial);
    const targetPath = resolve(root.path, ...segments);
    if (!within(root.path, targetPath))
      throw new WorkspaceInspectionInputError();
    if (await pathExcluded(targetPath)) return blank("excluded", initial);
  }
  const unavailable = availabilityState(initial, root);
  if (unavailable) return blank(unavailable, initial);
  if (root?.binding.state !== "ready") return blank("unavailable", initial);

  const targetPath = resolve(root.path, ...segments);
  if (!within(root.path, targetPath)) throw new WorkspaceInspectionInputError();

  let repositoryNames: Map<string, string> | undefined;
  if (request.scope.kind === "workspace") {
    repositoryNames = repositoryWorkspaceNames(root.binding);
    if (!repositoryNames) return blank("unavailable", initial);
    const firstSegment = segments[0];
    if (firstSegment !== undefined && repositoryNames.has(firstSegment))
      return blank("conflict", initial);
  }

  const parentSegments = segments.slice(0, -1);
  let parentSnapshot: Awaited<ReturnType<typeof validateDirectory>>;
  try {
    parentSnapshot = await validateDirectory(root, parentSegments);
  } catch (error) {
    return blank(safeFsState(error), initial);
  }

  let ignored = false;
  if (root.repository) {
    const result = await ignoredPaths(root, segments, options);
    if (!result.complete) return blank("unavailable", initial);
    ignored = result.ignored.size > 0;
  } else {
    ignored = repositoryFreeIgnored(segments);
  }
  if (
    !(await sameObservation(
      current,
      initial,
      request.taskId,
      root,
      parentSegments,
      parentSnapshot,
    ))
  )
    return blank("conflict", initial);
  if (ignored && !request.showIgnored) return blank("ignored", initial);

  let before: Stats;
  try {
    before = await lstat(targetPath, { bigint: false });
  } catch (error) {
    return blank(safeFsState(error), initial);
  }
  if (before.isSymbolicLink() || !before.isFile())
    return (await sameObservation(
      current,
      initial,
      request.taskId,
      root,
      parentSegments,
      parentSnapshot,
    ))
      ? {
          ...blank("unavailable", initial),
          metadata: {
            kind: before.isSymbolicLink()
              ? "symlink"
              : before.isDirectory()
                ? "directory"
                : "other",
            size: null,
            modifiedAt: null,
            ignored,
          },
        }
      : blank("conflict", initial);

  const stableTarget = async () => {
    try {
      if (
        !(await sameObservation(
          current,
          initial,
          request.taskId,
          root,
          parentSegments,
          parentSnapshot,
        ))
      )
        return false;
      const nameStat = await lstat(targetPath, { bigint: false });
      return (
        nameStat.isFile() &&
        !nameStat.isSymbolicLink() &&
        sameStat(before, nameStat)
      );
    } catch {
      return false;
    }
  };

  const metadataIgnored = root.repository
    ? ignored
    : repositoryFreeIgnored(segments);
  if (before.nlink > 1) {
    if (!(await stableTarget())) return blank("conflict", initial);
    return {
      ...blank("unavailable", initial),
      metadata: {
        kind: "file",
        size: before.size,
        modifiedAt: Number.isFinite(before.mtimeMs)
          ? Math.trunc(before.mtimeMs)
          : null,
        ignored: metadataIgnored,
        reason: "multiple-links",
      },
    };
  }

  const fileName = segments.at(-1);
  if (fileName === undefined) return blank("unavailable", initial);
  const extension = extname(fileName).toLowerCase();
  const expectedMime = imageExtensionMime[extension];
  const knownTextMime = textMimes[extension];
  if (extension === ".svg") {
    if (!(await stableTarget())) return blank("conflict", initial);
    return metadataOnly(initial, before, metadataIgnored, "unsupported-format");
  }
  if (
    before.size > inspectionLimits.maxImageOrPdfBytes ||
    (knownTextMime !== undefined && before.size > inspectionLimits.maxTextBytes)
  ) {
    if (!(await stableTarget())) return blank("conflict", initial);
    return metadataOnly(initial, before, metadataIgnored, "too-large");
  }

  if (!(await stableTarget())) return blank("conflict", initial);
  let handle: FileHandle;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return blank(safeFsState(error), initial);
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      !sameStat(before, opened) ||
      !(await stableTarget())
    )
      return blank("conflict", initial);
    await options.afterFileOpen?.(targetPath);
    if (!(await stableTarget())) return blank("conflict", initial);

    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const part = await handle.read(buffer, used, buffer.length - used, used);
      if (part.bytesRead === 0) break;
      used += part.bytesRead;
    }
    const bytes = buffer.subarray(0, used);
    const finalHandle = await handle.stat();
    const finalName = await lstat(targetPath, { bigint: false });
    if (
      used !== before.size ||
      finalHandle.nlink > 1 ||
      finalName.isSymbolicLink() ||
      !finalName.isFile() ||
      !sameStat(opened, finalHandle) ||
      !sameStat(opened, finalName) ||
      !(await stableTarget())
    )
      return blank("conflict", initial);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const exactMime = (mime: WorkspacePreviewData["mime"]) =>
      expectedMime === undefined || expectedMime === mime;
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
      if (
        (expectedMime !== undefined && expectedMime !== "application/pdf") ||
        knownTextMime !== undefined
      )
        return metadataOnly(
          initial,
          before,
          metadataIgnored,
          "invalid-content",
          sha256,
        );
      return {
        ...blank("ready", initial),
        metadata: {
          kind: "file",
          size: before.size,
          modifiedAt: Number.isFinite(before.mtimeMs)
            ? Math.trunc(before.mtimeMs)
            : null,
          ignored: metadataIgnored,
        },
        preview: {
          kind: "base64",
          mime: "application/pdf",
          data: bytes.toString("base64"),
          sha256,
          size: bytes.length,
          maxDisplayedPages: inspectionLimits.maxPdfDisplayedPages,
        },
      };
    }

    const raster = rasterInfo(bytes);
    if (expectedMime?.startsWith("image/") || raster) {
      if (!raster || !exactMime(raster.mime) || knownTextMime !== undefined)
        return metadataOnly(
          initial,
          before,
          metadataIgnored,
          "invalid-content",
          sha256,
        );
      if (
        raster.width < 1 ||
        raster.height < 1 ||
        raster.width * raster.height > inspectionLimits.maxImagePixels
      )
        return metadataOnly(
          initial,
          before,
          metadataIgnored,
          "image-dimensions-exceed-limit",
          sha256,
        );
      return {
        ...blank("ready", initial),
        metadata: {
          kind: "file",
          size: before.size,
          modifiedAt: Number.isFinite(before.mtimeMs)
            ? Math.trunc(before.mtimeMs)
            : null,
          ignored: metadataIgnored,
        },
        preview: {
          kind: "base64",
          mime: raster.mime,
          data: bytes.toString("base64"),
          sha256,
          size: bytes.length,
          width: raster.width,
          height: raster.height,
        },
      };
    }
    if (expectedMime === "application/pdf")
      return metadataOnly(
        initial,
        before,
        metadataIgnored,
        "invalid-content",
        sha256,
      );
    if (expectedMime?.startsWith("image/"))
      return metadataOnly(
        initial,
        before,
        metadataIgnored,
        "invalid-content",
        sha256,
      );
    const text = validText(bytes);
    if (text === undefined)
      return metadataOnly(
        initial,
        before,
        metadataIgnored,
        "binary-content",
        sha256,
      );
    if (bytes.length > inspectionLimits.maxTextBytes)
      return metadataOnly(initial, before, metadataIgnored, "too-large");
    if (raster || bytes.subarray(0, 5).toString("ascii") === "%PDF-")
      return metadataOnly(
        initial,
        before,
        metadataIgnored,
        "invalid-content",
        sha256,
      );
    return {
      ...blank("ready", initial),
      metadata: {
        kind: "file",
        size: before.size,
        modifiedAt: Number.isFinite(before.mtimeMs)
          ? Math.trunc(before.mtimeMs)
          : null,
        ignored: metadataIgnored,
      },
      preview: {
        kind: "text",
        mime: knownTextMime ?? "text/plain; charset=utf-8",
        text,
        sha256,
        size: bytes.length,
      },
    };
  } catch {
    return blank("unavailable", initial);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
