import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import type { Database } from "../core/store.js";

const execFileAsync = promisify(execFile);

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

/** The task-domain and writer-owner call seam; neither needs to own this storage. */
export interface TaskWorkspaceLifecycle {
  provision(
    taskId: string,
    repositories?: TaskWorkspaceRepositoryInput[],
  ): Promise<TaskWorkspaceBinding>;
  get(taskId: string): Promise<TaskWorkspaceBinding | undefined>;
  forExecution(taskId: string): Promise<TaskWorkspaceBinding>;
  archiveAndCleanup(
    taskId: string,
    evidence: WorkspaceCleanupEvidence,
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
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
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
          (taskId, workspaceId, path, repositories, state, reason, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'provisioning', NULL, ?, ?)`,
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
    return this.transaction(() => {
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

  private parseRow(row: unknown): TaskWorkspaceBinding {
    const stored = storedWorkspaceSchema.parse(row);
    return taskWorkspaceSchema.parse({
      ...stored,
      repositories: JSON.parse(stored.repositories),
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Keep the storage error that caused rollback.
      }
      throw error;
    }
  }

  private invalidRow(): never {
    throw new Error("Task workspace binding could not be read after update");
  }
}

/** Creates task worktrees and keeps their stable bindings independent of turns. */
export class WorkspaceManager implements TaskWorkspaceLifecycle {
  private readonly workspaceRoot: string;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: WorkspaceBindingStore,
    workspaceRoot: string,
  ) {
    if (!isAbsolute(workspaceRoot))
      throw new Error("Workspace directory must be absolute");
    const resolvedRoot = resolve(workspaceRoot);
    this.workspaceRoot = join(
      realpathSync(dirname(resolvedRoot)),
      basename(resolvedRoot),
    );
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

  async get(taskId: string): Promise<TaskWorkspaceBinding | undefined> {
    const id = z.string().trim().min(1).max(512).parse(taskId);
    return this.withTaskLock(id, async () => {
      const binding = this.store.get(id);
      if (binding?.state !== "ready") return binding;
      return this.validateReady(binding);
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
        const status = await git(
          repository.workspacePath,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
        );
        if (status.length > 0)
          return this.retained(
            checked,
            `Uncommitted or ignored work remains in ${repository.repositoryId}`,
          );
      }

      const archiving = this.store.update(
        id,
        "archiving",
        "Workspace cleanup in progress",
      );
      try {
        for (const repository of archiving.repositories) {
          await git(
            repository.sourcePath,
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
        const held = this.store.update(
          id,
          "held",
          `Workspace cleanup interrupted; inspect retained paths: ${messageOf(error)}`,
        );
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
          const source = await gitInfo(repository.sourcePath, repository.ref);
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

        if (await this.isExistingWorktree(repository)) continue;
        await this.ensureSourceStillMatches(repository);
        await git(
          repository.sourcePath,
          "worktree",
          "add",
          "--detach",
          repository.workspacePath,
          repository.commit,
        ).catch(async (error: unknown) => {
          if (!(await this.isExistingWorktree(repository))) throw error;
        });
        if (!(await this.isExistingWorktree(repository)))
          throw new Error(
            `Git did not create the workspace for ${repository.repositoryId}`,
          );
      }
      return this.store.update(binding.taskId, "ready", null);
    } catch (error) {
      return this.store.update(
        binding.taskId,
        "provisioning",
        `Workspace creation incomplete: ${messageOf(error)}`,
      );
    }
  }

  private async validateReady(
    binding: TaskWorkspaceBinding,
  ): Promise<TaskWorkspaceBinding> {
    try {
      await this.assertManagedRoot(binding);
      for (const repository of binding.repositories) {
        if (!(await this.isExistingWorktree(repository)))
          throw new Error(
            `Missing workspace for repository ${repository.repositoryId}`,
          );
      }
      return binding;
    } catch (error) {
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
    if (binding.path !== join(this.workspaceRoot, binding.workspaceId))
      throw new Error("Stored workspace path does not match its identity");
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
    this.assertRepositoryPaths(binding);
    const workspaceInfo = await lstatIfExists(binding.path);
    if (!workspaceInfo) throw new Error("Task workspace is missing");
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
      throw new Error("Task workspace path is not a real directory");
    const canonicalRoot = await realpath(this.workspaceRoot);
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
    const source = await gitRepositoryInfo(repository.sourcePath);
    if (source.gitCommonDir !== repository.gitCommonDir)
      throw new Error(
        `Repository identity changed for ${repository.repositoryId}`,
      );
  }

  private async isExistingWorktree(
    repository: TaskWorkspaceRepository,
  ): Promise<boolean> {
    const info = await lstatIfExists(repository.workspacePath);
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        `Workspace path for ${repository.repositoryId} is not a real directory`,
      );
    try {
      const worktree = await gitRepositoryInfo(repository.workspacePath);
      if (
        worktree.root !== resolve(repository.workspacePath) ||
        worktree.gitCommonDir !== repository.gitCommonDir
      )
        throw new Error(
          `Workspace path for ${repository.repositoryId} belongs to another repository`,
        );
      return true;
    } catch (error) {
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
    const current = previous.catch(() => {}).then(operation);
    this.inFlight.set(taskId, current);
    return current.finally(() => {
      if (this.inFlight.get(taskId) === current) this.inFlight.delete(taskId);
    });
  }
}

async function gitInfo(
  path: string,
  ref: string,
): Promise<{ root: string; gitCommonDir: string; commit: string }> {
  const repository = await gitRepositoryInfo(path);
  const commit = await git(
    path,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  );
  return { ...repository, commit };
}

async function gitRepositoryInfo(
  path: string,
): Promise<{ root: string; gitCommonDir: string }> {
  const reportedRoot = await git(path, "rev-parse", "--show-toplevel");
  const root = await realpath(reportedRoot);
  const reportedCommonDir = await git(root, "rev-parse", "--git-common-dir");
  const gitCommonDir = await realpath(
    isAbsolute(reportedCommonDir)
      ? reportedCommonDir
      : resolve(root, reportedCommonDir),
  );
  return { root: resolve(root), gitCommonDir };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const details = error as NodeJS.ErrnoException & { stderr?: string };
    const reason = details.stderr?.trim() || details.message;
    throw new Error(`git ${args[0]} failed: ${reason}`);
  }
}

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
