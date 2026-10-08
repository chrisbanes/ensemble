import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { transaction, type Database } from "../core/store.js";

const maxGitOutputBytes = 1024 * 1024;
const maxTimerMs = 2_147_483_647;

const gitOperations = [
  "repository-identity",
  "ref-resolution",
  "checkout-validation",
  "worktree-add",
  "archive-status",
  "worktree-remove",
] as const;

type GitOperation = (typeof gitOperations)[number];
type GitFailureKind = "failed" | "timed-out" | "cancelled" | "output-limit";

const gitOperationTimeouts: Record<GitOperation, number> = {
  "repository-identity": 30_000,
  "ref-resolution": 30_000,
  "checkout-validation": 30_000,
  "worktree-add": 120_000,
  "archive-status": 120_000,
  "worktree-remove": 120_000,
};

const workspaceStateSchema = z.enum([
  "provisioning",
  "ready",
  "held",
  "archiving",
  "archived",
]);

const repositoryBindingSchema = z.object({
  repositoryId: z.string().min(1).max(512),
  sourcePath: z.string().min(1),
  workspacePath: z.string().min(1),
  ref: z.string().min(1).max(512),
  gitCommonDir: z.string().nullable(),
  commit: z.string().nullable(),
});

const taskWorkspaceSchema = z.object({
  taskId: z.string().min(1).max(512),
  workspaceId: z.string().uuid(),
  path: z.string().min(1),
  repositories: z.array(repositoryBindingSchema),
  state: workspaceStateSchema,
  reason: z.string().nullable(),
  gitUncertain: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const storedWorkspaceSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  repositories: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  gitUncertain: z.union([z.literal(0), z.literal(1)]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const repositoryInputSchema = z.object({
  repositoryId: z.string().trim().min(1).max(512),
  path: z.string().trim().min(1),
  ref: z.string().trim().min(1).max(512).optional(),
});

export type TaskWorkspaceRepositoryInput = z.infer<
  typeof repositoryInputSchema
>;

export type TaskWorkspaceRepository = z.infer<typeof repositoryBindingSchema>;

export type TaskWorkspaceBinding = z.infer<typeof taskWorkspaceSchema>;

export interface WorkspaceCleanupEvidence {
  deliveryConfirmed: boolean;
  writerOwnershipResolved: boolean;
  handoffsPreserved: boolean;
  reconciliationEvidencePreserved: boolean;
  workspaceContentsPreserved: boolean;
}

export type WorkspaceCleanupResult =
  | { outcome: "cleaned"; binding: TaskWorkspaceBinding }
  | { outcome: "retained"; binding: TaskWorkspaceBinding; reason: string };

export type WorkspaceManagerOptions = {
  /** Narrow path-access observer used to prove restored-root identity ordering. */
  beforePathAccess?: (path: string) => void;
  /** Test-only executable override; production always resolves the `git` command. */
  gitExecutable?: string;
  /** Test-only shortened per-operation deadlines. */
  gitTimeoutMs?: Partial<Record<GitOperation, number>>;
  /** Test-only bounds for exact-child termination and final stream observation. */
  gitTerminationGraceMs?: number;
  gitTerminationObservationMs?: number;
  /** Test-only safe child-lifecycle readback; never receives arguments or paths. */
  gitFailureObserver?: (failure: {
    operation: GitOperation;
    kind: GitFailureKind;
    childExitObserved: boolean;
    childExitSignal: NodeJS.Signals | null;
  }) => void;
};

/** The task-domain and writer-owner call seam; neither needs to own this storage. */
export interface TaskWorkspaceLifecycle {
  provision(
    taskId: string,
    repositories?: TaskWorkspaceRepositoryInput[],
  ): Promise<TaskWorkspaceBinding>;
  /** `reuseRecentIdentity` is for read-only inspection rechecks, never execution. */
  get(
    taskId: string,
    options?: { reuseRecentIdentity?: boolean },
  ): Promise<TaskWorkspaceBinding | undefined>;
  forExecution(taskId: string): Promise<TaskWorkspaceBinding>;
  archiveAndCleanup(
    taskId: string,
    evidence: WorkspaceCleanupEvidence,
    finalWriterCheck?: () => boolean,
  ): Promise<WorkspaceCleanupResult>;
}

export interface WorkspaceBindingStore {
  createOrGet(
    taskId: string,
    workspaceId: string,
    path: string,
    repositories: TaskWorkspaceRepository[],
  ): TaskWorkspaceBinding;
  get(taskId: string): TaskWorkspaceBinding | undefined;
  list(): TaskWorkspaceBinding[];
  bindRepository(
    taskId: string,
    repositoryId: string,
    gitCommonDir: string,
    commit: string,
  ): TaskWorkspaceBinding;
  update(
    taskId: string,
    state: TaskWorkspaceBinding["state"],
    reason: string | null,
  ): TaskWorkspaceBinding;
  markGitUncertain(taskId: string, reason: string): TaskWorkspaceBinding;
}

class WorkspaceGitError extends Error {
  readonly uncertain: boolean;

  constructor(
    readonly operation: GitOperation,
    readonly kind: GitFailureKind,
    readonly childExitObserved: boolean,
    readonly childExitSignal: NodeJS.Signals | null,
    childStarted: boolean,
  ) {
    super(`Workspace Git ${kind} during ${operation}`);
    this.name = "WorkspaceGitError";
    this.uncertain = kind !== "failed" || (childStarted && !childExitObserved);
  }
}

class WorkspaceManagerCancelledError extends Error {
  constructor() {
    super("Workspace manager is stopping");
    this.name = "WorkspaceManagerCancelledError";
  }
}

/** Call after Store.ensureHost; owns only the workspace-binding table. */
export class SqliteWorkspaceBindingStore implements WorkspaceBindingStore {
  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_workspace_bindings (
      taskId TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      repositories TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('provisioning','ready','held','archiving','archived')),
      reason TEXT,
      gitUncertain INTEGER NOT NULL DEFAULT 0 CHECK(gitUncertain IN (0,1)),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    const columns = this.db
      .prepare("PRAGMA table_info(task_workspace_bindings)")
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "gitUncertain"))
      this.db.exec(`ALTER TABLE task_workspace_bindings
        ADD COLUMN gitUncertain INTEGER NOT NULL DEFAULT 0
        CHECK(gitUncertain IN (0,1))`);
  }

  createOrGet(
    taskId: string,
    workspaceId: string,
    path: string,
    repositories: TaskWorkspaceRepository[],
  ): TaskWorkspaceBinding {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_workspace_bindings
          (taskId, workspaceId, path, repositories, state, reason, gitUncertain, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'provisioning', NULL, 0, ?, ?)`,
      )
      .run(taskId, workspaceId, path, JSON.stringify(repositories), now, now);
    return this.get(taskId) ?? this.invalidRow();
  }

  get(taskId: string): TaskWorkspaceBinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM task_workspace_bindings WHERE taskId = ?")
      .get(taskId);
    return row === undefined ? undefined : this.parseRow(row);
  }

  list(): TaskWorkspaceBinding[] {
    return this.db
      .prepare(
        "SELECT * FROM task_workspace_bindings ORDER BY createdAt, taskId",
      )
      .all()
      .map((row) => this.parseRow(row));
  }

  bindRepository(
    taskId: string,
    repositoryId: string,
    gitCommonDir: string,
    commit: string,
  ): TaskWorkspaceBinding {
    return transaction(this.db, () => {
      const binding = this.get(taskId);
      if (!binding) throw new Error(`No task workspace for ${taskId}`);
      const index = binding.repositories.findIndex(
        (repository) => repository.repositoryId === repositoryId,
      );
      if (index < 0) throw new Error(`Unknown repository ${repositoryId}`);
      const current = binding.repositories[index];
      if (!current) throw new Error(`Unknown repository ${repositoryId}`);
      if (current.gitCommonDir !== null) {
        if (current.gitCommonDir !== gitCommonDir)
          throw new Error(`Repository identity changed for ${repositoryId}`);
        return binding;
      }
      const repositories = [...binding.repositories];
      repositories[index] = { ...current, gitCommonDir, commit };
      this.db
        .prepare(
          "UPDATE task_workspace_bindings SET repositories = ?, updatedAt = ? WHERE taskId = ?",
        )
        .run(JSON.stringify(repositories), new Date().toISOString(), taskId);
      return this.get(taskId) ?? this.invalidRow();
    });
  }

  update(
    taskId: string,
    state: TaskWorkspaceBinding["state"],
    reason: string | null,
  ): TaskWorkspaceBinding {
    this.db
      .prepare(
        "UPDATE task_workspace_bindings SET state = ?, reason = ?, updatedAt = ? WHERE taskId = ?",
      )
      .run(state, reason, new Date().toISOString(), taskId);
    return this.get(taskId) ?? this.invalidRow();
  }

  markGitUncertain(taskId: string, reason: string): TaskWorkspaceBinding {
    this.db
      .prepare(
        "UPDATE task_workspace_bindings SET state = 'held', reason = ?, gitUncertain = 1, updatedAt = ? WHERE taskId = ?",
      )
      .run(reason, new Date().toISOString(), taskId);
    return this.get(taskId) ?? this.invalidRow();
  }

  private parseRow(row: unknown): TaskWorkspaceBinding {
    const stored = storedWorkspaceSchema.parse(row);
    return taskWorkspaceSchema.parse({
      ...stored,
      repositories: JSON.parse(stored.repositories),
      gitUncertain: stored.gitUncertain === 1,
    });
  }

  private invalidRow(): never {
    throw new Error("Task workspace binding could not be read after update");
  }
}

/** Creates task worktrees and keeps their stable bindings independent of turns. */
export class WorkspaceManager implements TaskWorkspaceLifecycle {
  private readonly workspaceRoot: string;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly gitExecutable: string;
  private readonly gitTimeouts: Partial<Record<GitOperation, number>>;
  private readonly gitTerminationGraceMs: number;
  private readonly gitTerminationObservationMs: number;
  private readonly gitCancellation = new AbortController();
  /** Recent successful worktree identity checks, keyed by workspace path. */
  private readonly worktreeChecks = new Map<
    string,
    { stamp: string; checkedAt: number }
  >();
  private cancelled = false;

  constructor(
    private readonly store: WorkspaceBindingStore,
    workspaceRoot: string,
    private readonly options: WorkspaceManagerOptions = {},
  ) {
    if (!isAbsolute(workspaceRoot))
      throw new Error("Workspace directory must be absolute");
    const resolvedRoot = resolve(workspaceRoot);
    this.workspaceRoot = join(
      realpathSync(dirname(resolvedRoot)),
      basename(resolvedRoot),
    );
    if (
      options.gitExecutable !== undefined &&
      !isAbsolute(options.gitExecutable)
    )
      throw new Error("Test Git executable must be an absolute path");
    this.gitExecutable = options.gitExecutable ?? "git";
    this.gitTimeouts = validateGitTimeouts(options.gitTimeoutMs ?? {});
    this.gitTerminationGraceMs = validateTimer(
      options.gitTerminationGraceMs ?? 2_000,
      "Git termination grace",
    );
    this.gitTerminationObservationMs = validateTimer(
      options.gitTerminationObservationMs ?? 2_000,
      "Git termination observation",
    );
  }

  /** Stops new workspace Git work and interrupts every currently owned child. */
  cancelGitWork(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.gitCancellation.abort();
  }

  /** Waits for workspace callers to persist their bounded cancellation outcome. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0)
      await Promise.allSettled([...this.inFlight.values()]);
  }

  provision(
    taskId: string,
    repositories: TaskWorkspaceRepositoryInput[] = [],
  ): Promise<TaskWorkspaceBinding> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    const requested = this.normalizeRepositories(repositories);
    return this.withTaskLock(id, async () => {
      let binding = this.store.get(id);
      if (!binding) {
        const workspaceId = randomUUID();
        const path = join(this.workspaceRoot, workspaceId);
        const allocated = requested.map((repository, index) => ({
          repositoryId: repository.repositoryId,
          sourcePath: repository.path,
          workspacePath: join(path, `repo-${index + 1}`),
          ref: repository.ref,
          gitCommonDir: null,
          commit: null,
        }));
        binding = this.store.createOrGet(id, workspaceId, path, allocated);
      }
      this.assertSameRepositories(binding, requested);

      if (binding.state === "ready") return this.validateReady(binding);
      if (binding.state !== "provisioning") return binding;
      return this.provisionBinding(binding);
    });
  }

  async get(
    taskId: string,
    options: { reuseRecentIdentity?: boolean } = {},
  ): Promise<TaskWorkspaceBinding | undefined> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    return this.withTaskLock(id, async () => {
      const binding = this.store.get(id);
      if (binding?.state !== "ready") return binding;
      return this.validateReady(binding, options.reuseRecentIdentity === true);
    });
  }

  async forExecution(taskId: string): Promise<TaskWorkspaceBinding> {
    const binding = await this.get(taskId);
    if (!binding) throw new Error(`Task ${taskId} has no workspace binding`);
    if (binding.state !== "ready")
      throw new Error(
        binding.reason ?? `Task workspace is ${binding.state} and cannot run`,
      );
    return binding;
  }

  async recover(): Promise<void> {
    for (const binding of this.store.list()) {
      await this.withTaskLock(binding.taskId, async () => {
        if (binding.path !== join(this.workspaceRoot, binding.workspaceId)) {
          this.store.update(
            binding.taskId,
            "held",
            "Stored workspace path does not match its identity",
          );
          return;
        }
        if (binding.state === "provisioning") {
          await this.provisionBinding(binding);
        } else if (binding.state === "ready") {
          await this.validateReady(binding);
        } else if (binding.state === "archiving") {
          this.store.update(
            binding.taskId,
            "held",
            "Workspace cleanup was interrupted; inspect retained paths before recovery",
          );
        }
      });
    }
  }

  archiveAndCleanup(
    taskId: string,
    evidence: WorkspaceCleanupEvidence,
    finalWriterCheck?: () => boolean,
  ): Promise<WorkspaceCleanupResult> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    const approval = z
      .object({
        deliveryConfirmed: z.boolean(),
        writerOwnershipResolved: z.boolean(),
        handoffsPreserved: z.boolean(),
        reconciliationEvidencePreserved: z.boolean(),
        workspaceContentsPreserved: z.boolean(),
      })
      .parse(evidence);
    return this.withTaskLock(id, async () => {
      const binding = this.store.get(id);
      if (!binding) throw new Error(`Task ${id} has no workspace binding`);
      if (binding.state !== "ready")
        return this.retained(
          binding,
          binding.reason ?? `Workspace is ${binding.state}`,
        );

      const missingEvidence = Object.entries(approval).find(
        ([, value]) => !value,
      )?.[0];
      if (missingEvidence)
        return this.retained(
          binding,
          `Workspace retained until ${missingEvidence} is confirmed`,
        );

      const checked = await this.validateReady(binding);
      if (checked.state !== "ready")
        return this.retained(
          checked,
          checked.reason ?? "Workspace is not available for cleanup",
        );

      for (const repository of checked.repositories) {
        const status = await this.git(
          repository.workspacePath,
          "archive-status",
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
        ).catch((error: unknown) => {
          if (isUncertainGitError(error)) {
            const held = this.store.markGitUncertain(id, error.message);
            return this.retained(held, error.message);
          }
          throw error;
        });
        if (typeof status !== "string") return status;
        if (status.length > 0)
          return this.retained(
            checked,
            `Uncommitted or ignored work remains in ${repository.repositoryId}`,
          );
      }

      if (finalWriterCheck && !finalWriterCheck())
        return this.retained(
          checked,
          "Workspace retained because writer ownership changed during cleanup validation",
        );

      const archiving = this.store.update(
        id,
        "archiving",
        "Workspace cleanup in progress",
      );
      try {
        for (const repository of archiving.repositories) {
          await this.git(
            repository.sourcePath,
            "worktree-remove",
            "worktree",
            "remove",
            repository.workspacePath,
          );
        }
        await this.assertManagedRoot(archiving);
        await rm(archiving.path, { recursive: true });
        return {
          outcome: "cleaned",
          binding: this.store.update(id, "archived", null),
        };
      } catch (error) {
        const reason = `Workspace cleanup interrupted: ${messageOf(error)}`;
        const held =
          isUncertainGitError(error) && error.uncertain
            ? this.store.markGitUncertain(id, error.message)
            : this.store.update(id, "held", reason);
        return this.retained(
          held,
          held.reason ?? "Workspace cleanup interrupted",
        );
      }
    });
  }

  private async provisionBinding(
    original: TaskWorkspaceBinding,
  ): Promise<TaskWorkspaceBinding> {
    let binding = original;
    try {
      await this.ensureManagedRoot(binding);
      for (const originalRepository of binding.repositories) {
        binding = this.store.get(binding.taskId) ?? binding;
        let repository = binding.repositories.find(
          (candidate) =>
            candidate.repositoryId === originalRepository.repositoryId,
        );
        if (!repository) throw new Error("Repository binding disappeared");

        if (!repository.gitCommonDir || !repository.commit) {
          const source = await this.gitInfo(
            repository.sourcePath,
            repository.ref,
          );
          binding = this.store.bindRepository(
            binding.taskId,
            repository.repositoryId,
            source.gitCommonDir,
            source.commit,
          );
          repository = binding.repositories.find(
            (candidate) =>
              candidate.repositoryId === originalRepository.repositoryId,
          );
          if (!repository) throw new Error("Repository binding disappeared");
        }
        if (!repository.gitCommonDir || !repository.commit)
          throw new Error(
            `Repository identity is incomplete for ${repository.repositoryId}`,
          );

        if (await this.isExistingWorktree(repository)) {
          await this.assertProvisionedWorktree(repository);
          continue;
        }
        await this.ensureSourceStillMatches(repository);
        await this.git(
          repository.sourcePath,
          "worktree-add",
          "worktree",
          "add",
          "--detach",
          repository.workspacePath,
          repository.commit,
        ).catch(async (error: unknown) => {
          if (isUncertainGitError(error)) throw error;
          if (!(await this.isExistingWorktree(repository))) throw error;
        });
        if (!(await this.isExistingWorktree(repository)))
          throw new Error(
            `Git did not create the workspace for ${repository.repositoryId}`,
          );
        await this.assertProvisionedWorktree(repository);
      }
      return this.store.update(binding.taskId, "ready", null);
    } catch (error) {
      if (isUncertainGitError(error) && error.uncertain)
        return this.store.markGitUncertain(binding.taskId, error.message);
      return this.store.update(
        binding.taskId,
        "provisioning",
        `Workspace creation incomplete: ${messageOf(error)}`,
      );
    }
  }

  private async validateReady(
    binding: TaskWorkspaceBinding,
    reuseRecentIdentity = false,
  ): Promise<TaskWorkspaceBinding> {
    try {
      await this.assertManagedRoot(binding);
      for (const repository of binding.repositories) {
        if (!(await this.isExistingWorktree(repository, reuseRecentIdentity)))
          throw new Error(
            `Missing workspace for repository ${repository.repositoryId}`,
          );
      }
      return binding;
    } catch (error) {
      if (isUncertainGitError(error) && error.uncertain)
        return this.store.markGitUncertain(binding.taskId, error.message);
      return this.store.update(
        binding.taskId,
        "held",
        `Task workspace unavailable: ${messageOf(error)}`,
      );
    }
  }

  private async ensureManagedRoot(
    binding: TaskWorkspaceBinding,
  ): Promise<void> {
    if (binding.path !== join(this.workspaceRoot, binding.workspaceId))
      throw new Error("Stored workspace path does not match its identity");
    this.assertRepositoryPaths(binding);
    await mkdir(this.workspaceRoot, { recursive: true });
    const rootInfo = await lstat(this.workspaceRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error("Workspace directory must be a real directory");
    if (
      resolve(await realpath(dirname(this.workspaceRoot))) !==
      dirname(this.workspaceRoot)
    )
      throw new Error("Workspace directory parent changed");
    const workspaceInfo = await lstatIfExists(binding.path);
    if (!workspaceInfo) {
      if (binding.state !== "provisioning")
        throw new Error("Task workspace is missing");
      await mkdir(binding.path);
    } else if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
      throw new Error("Task workspace path is not a real directory");
    }
  }

  private async assertManagedRoot(
    binding: TaskWorkspaceBinding,
  ): Promise<void> {
    if (binding.path !== join(this.workspaceRoot, binding.workspaceId))
      throw new Error("Stored workspace path does not match its identity");
    this.assertRepositoryPaths(binding);
    this.options.beforePathAccess?.(binding.path);
    const workspaceInfo = await lstatIfExists(binding.path);
    if (!workspaceInfo) throw new Error("Task workspace is missing");
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
      throw new Error("Task workspace path is not a real directory");
    this.options.beforePathAccess?.(this.workspaceRoot);
    const canonicalRoot = await realpath(this.workspaceRoot);
    this.options.beforePathAccess?.(binding.path);
    const canonicalWorkspace = await realpath(binding.path);
    if (resolve(canonicalRoot) !== this.workspaceRoot)
      throw new Error("Workspace directory escaped its managed location");
    if (
      resolve(canonicalWorkspace) !==
      resolve(canonicalRoot, binding.workspaceId)
    )
      throw new Error("Task workspace escaped its managed directory");
  }

  private async ensureSourceStillMatches(
    repository: TaskWorkspaceRepository,
  ): Promise<void> {
    const source = await this.gitRepositoryInfo(repository.sourcePath);
    if (source.gitCommonDir !== repository.gitCommonDir)
      throw new Error(
        `Repository identity changed for ${repository.repositoryId}`,
      );
  }

  private async gitInfo(
    path: string,
    ref: string,
  ): Promise<{ root: string; gitCommonDir: string; commit: string }> {
    const repository = await this.gitRepositoryInfo(path);
    const commit = await this.git(
      path,
      "ref-resolution",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    );
    return { ...repository, commit };
  }

  private async gitRepositoryInfo(
    path: string,
  ): Promise<{ root: string; gitCommonDir: string }> {
    const combinedIdentity = await this.git(
      path,
      "repository-identity",
      "rev-parse",
      "--show-toplevel",
      "--git-common-dir",
    );
    const identityLines = combinedIdentity.split("\n");
    const reportedCombinedRoot = identityLines[0];
    const reportedCombinedCommonDir = identityLines[1];
    if (
      identityLines.length === 2 &&
      reportedCombinedRoot &&
      isAbsolute(reportedCombinedRoot) &&
      reportedCombinedCommonDir
    ) {
      const root = await realpath(reportedCombinedRoot);
      const reportedCommonPath = isAbsolute(reportedCombinedCommonDir)
        ? reportedCombinedCommonDir
        : resolve(await realpath(path), reportedCombinedCommonDir);
      const gitCommonDir = await realpath(reportedCommonPath);
      return { root: resolve(root), gitCommonDir };
    }

    // Paths can contain newlines, so a combined rev-parse result is ambiguous
    // unless it has exactly two nonempty identity lines. Preserve those paths
    // by falling back to the original separately bounded reads.
    const reportedRoot = await this.git(
      path,
      "repository-identity",
      "rev-parse",
      "--show-toplevel",
    );
    const root = await realpath(reportedRoot);
    const reportedCommonDir = await this.git(
      root,
      "repository-identity",
      "rev-parse",
      "--git-common-dir",
    );
    const gitCommonDir = await realpath(
      isAbsolute(reportedCommonDir)
        ? reportedCommonDir
        : resolve(root, reportedCommonDir),
    );
    return { root: resolve(root), gitCommonDir };
  }

  private git(
    cwd: string,
    operation: GitOperation,
    ...args: string[]
  ): Promise<string> {
    this.assertNotCancelled();
    const defaultTimeoutMs =
      operation === "checkout-validation" && args[0] === "status"
        ? 120_000
        : gitOperationTimeouts[operation];
    return runGit({
      executable: this.gitExecutable,
      cwd,
      args: ["-C", cwd, ...args],
      operation,
      timeoutMs: this.gitTimeouts[operation] ?? defaultTimeoutMs,
      terminationGraceMs: this.gitTerminationGraceMs,
      observationMs: this.gitTerminationObservationMs,
      signal: this.gitCancellation.signal,
      failureObserver: this.options.gitFailureObserver,
    });
  }

  /** @internal Allows service startup to honor the same sticky cancellation latch. */
  assertNotCancelled(): void {
    if (this.cancelled) throw new WorkspaceManagerCancelledError();
  }

  private async isExistingWorktree(
    repository: TaskWorkspaceRepository,
    reuseRecentIdentity = false,
  ): Promise<boolean> {
    const info = await lstatIfExists(repository.workspacePath);
    const previous = this.worktreeChecks.get(repository.workspacePath);
    this.worktreeChecks.delete(repository.workspacePath);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        `Workspace path for ${repository.repositoryId} is not a real directory`,
      );
    // Inspection rechecks run many times per read; they may reuse a just-verified
    // Git identity only while the worktree root and its .git entry are unchanged.
    const gitEntry = await lstatIfExists(
      join(repository.workspacePath, ".git"),
    );
    const stamp = JSON.stringify([
      repository.gitCommonDir,
      ...[info, gitEntry].map((entry) =>
        entry
          ? [entry.dev, entry.ino, entry.mode, entry.mtimeMs, entry.ctimeMs]
          : null,
      ),
    ]);
    const now = Date.now();
    if (
      reuseRecentIdentity &&
      previous?.stamp === stamp &&
      now - previous.checkedAt >= 0 &&
      now - previous.checkedAt < worktreeCheckReuseMs
    ) {
      this.worktreeChecks.set(repository.workspacePath, previous);
      return true;
    }
    try {
      const worktree = await this.gitRepositoryInfo(repository.workspacePath);
      if (
        worktree.root !== resolve(repository.workspacePath) ||
        worktree.gitCommonDir !== repository.gitCommonDir
      )
        throw new Error(
          `Workspace path for ${repository.repositoryId} belongs to another repository`,
        );
      this.worktreeChecks.set(repository.workspacePath, {
        stamp,
        checkedAt: now,
      });
      return true;
    } catch (error) {
      if (
        isUncertainGitError(error) &&
        (error.kind !== "failed" || !error.childExitObserved)
      )
        throw error;
      if (messageOf(error).includes("belongs to another repository"))
        throw error;
      const entries = await readdir(repository.workspacePath);
      if (entries.length > 0)
        throw new Error(
          `Incomplete workspace files for ${repository.repositoryId} are preserved at ${repository.workspacePath}`,
        );
      return false;
    }
  }

  private async assertProvisionedWorktree(
    repository: TaskWorkspaceRepository,
  ): Promise<void> {
    if (!repository.commit)
      throw new Error(
        `Repository commit is missing for ${repository.repositoryId}`,
      );
    const head = await this.git(
      repository.workspacePath,
      "checkout-validation",
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    );
    const trackedChanges = await this.git(
      repository.workspacePath,
      "checkout-validation",
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    );
    if (head !== repository.commit || trackedChanges.length > 0)
      throw new Error(
        `Workspace checkout is incomplete for ${repository.repositoryId}`,
      );
  }

  private normalizeRepositories(
    repositories: TaskWorkspaceRepositoryInput[],
  ): Array<{ repositoryId: string; path: string; ref: string }> {
    const parsed = z.array(repositoryInputSchema).parse(repositories);
    const normalized = parsed
      .map((repository) => {
        if (!isAbsolute(repository.path))
          throw new Error("Repository paths must be absolute");
        return {
          repositoryId: repository.repositoryId,
          path: resolve(repository.path),
          ref: repository.ref ?? "HEAD",
        };
      })
      .sort((a, b) =>
        a.repositoryId < b.repositoryId
          ? -1
          : a.repositoryId > b.repositoryId
            ? 1
            : 0,
      );
    if (
      new Set(normalized.map(({ repositoryId }) => repositoryId)).size !==
      normalized.length
    )
      throw new Error("Repository IDs must be unique within a task");
    if (new Set(normalized.map(({ path }) => path)).size !== normalized.length)
      throw new Error("A task cannot bind the same repository path twice");
    return normalized;
  }

  private assertSameRepositories(
    binding: TaskWorkspaceBinding,
    requested: Array<{ repositoryId: string; path: string; ref: string }>,
  ): void {
    const current = binding.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      path: repository.sourcePath,
      ref: repository.ref,
    }));
    if (JSON.stringify(current) !== JSON.stringify(requested))
      throw new Error(
        `Task ${binding.taskId} is already bound to a different repository set`,
      );
  }

  private retained(
    binding: TaskWorkspaceBinding,
    reason: string,
  ): WorkspaceCleanupResult {
    return { outcome: "retained", binding, reason };
  }

  private assertRepositoryPaths(binding: TaskWorkspaceBinding): void {
    for (const [index, repository] of binding.repositories.entries()) {
      if (repository.workspacePath !== join(binding.path, `repo-${index + 1}`))
        throw new Error(
          `Stored workspace path for ${repository.repositoryId} is invalid`,
        );
    }
  }

  private withTaskLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.inFlight.get(taskId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => {
        this.assertNotCancelled();
        return operation();
      });
    this.inFlight.set(taskId, current);
    return current.finally(() => {
      if (this.inFlight.get(taskId) === current) this.inFlight.delete(taskId);
    });
  }
}

interface GitRunOptions {
  executable: string;
  cwd: string;
  args: string[];
  operation: GitOperation;
  timeoutMs: number;
  terminationGraceMs: number;
  observationMs: number;
  signal: AbortSignal;
  failureObserver?: WorkspaceManagerOptions["gitFailureObserver"];
}

function runGit(options: GitRunOptions): Promise<string> {
  if (options.signal.aborted)
    return Promise.reject(
      new WorkspaceGitError(options.operation, "cancelled", false, null, false),
    );

  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(reportGitFailure(options, "failed", false, null, false));
      return;
    }

    let settled = false;
    let spawned = false;
    let closeObserved = false;
    let childExitObserved = false;
    let childExitSignal: NodeJS.Signals | null = null;
    let outputBytes = 0;
    let failureKind: GitFailureKind | undefined;
    const stdout: Buffer[] = [];
    let deadlineTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let observationTimer: NodeJS.Timeout | undefined;
    let termSent = false;

    const clearTimer = (timer: NodeJS.Timeout | undefined) => {
      if (timer) clearTimeout(timer);
    };

    const cleanup = (detach: boolean) => {
      clearTimer(deadlineTimer);
      clearTimer(graceTimer);
      clearTimer(observationTimer);
      options.signal.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      if (detach) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
    };

    const finishFailure = () => {
      if (settled || failureKind === undefined) return;
      settled = true;
      cleanup(!closeObserved);
      rejectPromise(
        reportGitFailure(
          options,
          failureKind,
          childExitObserved,
          childExitSignal,
          spawned,
        ),
      );
    };

    const finishNormally = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      cleanup(false);
      if (code !== 0 || signal !== null) {
        rejectPromise(
          reportGitFailure(
            options,
            "failed",
            childExitObserved,
            childExitSignal ?? signal,
            spawned,
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    };

    const beginObservation = () => {
      if (observationTimer || settled) return;
      observationTimer = setTimeout(finishFailure, options.observationMs);
    };

    const sendTerm = () => {
      if (termSent || childExitObserved || settled) return;
      try {
        termSent = child.kill("SIGTERM");
      } catch {
        termSent = false;
      }
    };

    const beginFailure = (kind: GitFailureKind) => {
      if (settled || failureKind !== undefined) return;
      failureKind = kind;
      sendTerm();
      graceTimer = setTimeout(() => {
        if (!childExitObserved) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The exact owned child is still observed for only the bounded window.
          }
        }
        beginObservation();
      }, options.terminationGraceMs);
      if (childExitObserved) {
        clearTimer(graceTimer);
        graceTimer = undefined;
        beginObservation();
      }
    };

    const onSpawn = () => {
      spawned = true;
      if (failureKind !== undefined && !termSent) sendTerm();
    };
    const onError = () => {
      if (!spawned) {
        failureKind = "failed";
        finishFailure();
        return;
      }
      beginFailure("failed");
    };
    const onExit = (_code: number | null, signal: NodeJS.Signals | null) => {
      childExitObserved = true;
      childExitSignal = signal;
      if (failureKind !== undefined) {
        clearTimer(graceTimer);
        graceTimer = undefined;
        beginObservation();
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      closeObserved = true;
      if (failureKind !== undefined) finishFailure();
      else finishNormally(code, signal);
    };
    const appendOutput = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (outputBytes + buffer.length > maxGitOutputBytes) {
        beginFailure("output-limit");
        return;
      }
      outputBytes += buffer.length;
      return buffer;
    };
    const onStdout = (chunk: Buffer | string) => {
      const buffer = appendOutput(chunk);
      if (buffer) stdout.push(buffer);
    };
    const onStderr = (chunk: Buffer | string) => {
      appendOutput(chunk);
    };
    const onAbort = () => beginFailure("cancelled");

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    options.signal.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(
      () => beginFailure("timed-out"),
      options.timeoutMs,
    );
    if (options.signal.aborted) onAbort();
  });
}

function isUncertainGitError(error: unknown): error is WorkspaceGitError {
  return error instanceof WorkspaceGitError && error.uncertain;
}

function reportGitFailure(
  options: GitRunOptions,
  kind: GitFailureKind,
  childExitObserved: boolean,
  childExitSignal: NodeJS.Signals | null,
  childStarted: boolean,
): WorkspaceGitError {
  const error = new WorkspaceGitError(
    options.operation,
    kind,
    childExitObserved,
    childExitSignal,
    childStarted,
  );
  try {
    options.failureObserver?.({
      operation: error.operation,
      kind: error.kind,
      childExitObserved: error.childExitObserved,
      childExitSignal: error.childExitSignal,
    });
  } catch {
    // Test observation cannot alter the Git result.
  }
  return error;
}

function validateGitTimeouts(
  values: Partial<Record<GitOperation, number>>,
): Partial<Record<GitOperation, number>> {
  for (const [operation, milliseconds] of Object.entries(values)) {
    if (
      !gitOperations.includes(operation as GitOperation) ||
      !Number.isSafeInteger(milliseconds) ||
      (milliseconds as number) <= 0 ||
      (milliseconds as number) > maxTimerMs
    )
      throw new Error(
        "Git operation deadlines must be finite positive milliseconds",
      );
  }
  return { ...values };
}

function validateTimer(milliseconds: number, label: string): number {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > maxTimerMs
  )
    throw new Error(`${label} must be finite positive milliseconds`);
  return milliseconds;
}

/** Bounds how long an unchanged worktree may skip its Git identity read. */
const worktreeCheckReuseMs = 1_000;

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
