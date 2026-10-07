import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  controlledGit,
  type ControlledGitEvent,
} from "./fixtures/controlled-git.js";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/core/store.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
  type TaskWorkspaceBinding,
  type TaskWorkspaceRepositoryInput,
  type WorkspaceCleanupEvidence,
  type WorkspaceBindingStore,
  type WorkspaceManagerOptions,
} from "../src/standalone/workspaces.js";

function fixture(options: WorkspaceManagerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-workspaces-"));
  const databasePath = join(root, "standalone.sqlite");
  const workspaceRoot = join(root, "task-workspaces");
  let db = new DatabaseSync(databasePath);
  new Store(db).ensureHost("workspace-test");
  let manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    workspaceRoot,
    options,
  );
  return {
    root,
    workspaceRoot,
    get manager() {
      return manager;
    },
    reopen(managerOptions: WorkspaceManagerOptions = options) {
      db.close();
      db = new DatabaseSync(databasePath);
      new Store(db).ensureHost("workspace-test");
      manager = new WorkspaceManager(
        new SqliteWorkspaceBindingStore(db),
        workspaceRoot,
        managerOptions,
      );
      return manager;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

function repository(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  git(path, "config", "user.name", "Workspace Test");
  git(path, "config", "user.email", "workspace-test@example.invalid");
  writeFileSync(join(path, "README.md"), `${name}\n`);
  git(path, "add", "README.md");
  git(path, "commit", "--quiet", "-m", "initial");
  return path;
}

async function waitForGitEvent(
  controlled: ReturnType<typeof controlledGit>,
  predicate: (event: ControlledGitEvent) => boolean,
  timeoutMs = 1500,
): Promise<ControlledGitEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = controlled.events().find(predicate);
    if (event) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Controlled Git fixture did not report the expected event: ${JSON.stringify(controlled.events())}`,
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const approvedCleanup: WorkspaceCleanupEvidence = {
  deliveryConfirmed: true,
  writerOwnershipResolved: true,
  handoffsPreserved: true,
  reconciliationEvidencePreserved: true,
  workspaceContentsPreserved: true,
};

test("concurrent requests persist one task binding and reuse its Git worktree after reopen", async () => {
  const f = fixture();
  try {
    const source = repository(f.root, "source");
    const request: TaskWorkspaceRepositoryInput[] = [
      { repositoryId: "main-repo", path: source },
    ];
    const [first, concurrent] = await Promise.all([
      f.manager.provision("task-1", request),
      f.manager.provision("task-1", request),
    ]);

    assert.equal(first.state, "ready");
    assert.equal(concurrent.workspaceId, first.workspaceId);
    assert.equal(concurrent.path, first.path);
    const firstRepository = first.repositories[0];
    assert.ok(firstRepository);
    assert.equal(
      git(firstRepository.workspacePath, "rev-parse", "--show-toplevel"),
      firstRepository.workspacePath,
    );

    const reopened = f.reopen();
    const recovered = await reopened.forExecution("task-1");
    assert.equal(recovered.workspaceId, first.workspaceId);
    assert.equal(recovered.path, first.path);
    const recoveredRepository = recovered.repositories[0];
    assert.ok(recoveredRepository);
    assert.equal(
      recoveredRepository.workspacePath,
      firstRepository.workspacePath,
    );
    await assert.rejects(
      reopened.provision("task-1", []),
      /different repository set/,
    );
  } finally {
    f.close();
  }
});

test("repository-free and multiple-repository tasks get durable independent roots", async () => {
  const f = fixture();
  try {
    const repositoryA = repository(f.root, "repo-a");
    const repositoryB = repository(f.root, "repo-b");
    const noRepository = await f.manager.provision("local-task");
    assert.equal(noRepository.state, "ready");
    assert.deepEqual(noRepository.repositories, []);
    assert.equal(
      await f.manager.forExecution("local-task").then((item) => item.path),
      noRepository.path,
    );

    const multiRepository = await f.manager.provision("multi-task", [
      { repositoryId: "alpha", path: repositoryA },
      { repositoryId: "beta", path: repositoryB },
    ]);
    assert.equal(multiRepository.state, "ready");
    assert.equal(multiRepository.repositories.length, 2);
    for (const item of multiRepository.repositories) {
      assert.equal(
        git(item.workspacePath, "rev-parse", "--show-toplevel"),
        item.workspacePath,
      );
    }
    assert.notEqual(noRepository.path, multiRepository.path);

    const reopened = f.reopen();
    assert.equal(
      (await reopened.forExecution("local-task")).path,
      noRepository.path,
    );
    assert.equal(
      (await reopened.forExecution("multi-task")).repositories.length,
      2,
    );
  } finally {
    f.close();
  }
});

test("interrupted multi-repository creation retries with the same identity and keeps existing files", async () => {
  const f = fixture();
  try {
    const firstSource = repository(f.root, "first-source");
    const laterSource = join(f.root, "later-source");
    const inputs = [
      { repositoryId: "a-first", path: firstSource },
      { repositoryId: "b-later", path: laterSource },
    ];
    const interrupted = await f.manager.provision("task-recovery", inputs);
    assert.equal(interrupted.state, "provisioning");
    assert.match(interrupted.reason ?? "", /creation incomplete/);
    const firstRepository = interrupted.repositories[0];
    assert.ok(firstRepository);
    const preservedFile = join(firstRepository.workspacePath, "notes.txt");
    writeFileSync(preservedFile, "keep this file\n");

    repository(f.root, "later-source");
    const reopened = f.reopen();
    await reopened.recover();
    const recovered = await reopened.forExecution("task-recovery");
    assert.equal(recovered.workspaceId, interrupted.workspaceId);
    assert.equal(recovered.path, interrupted.path);
    assert.equal(readFileSync(preservedFile, "utf8"), "keep this file\n");
    assert.equal(recovered.repositories.length, 2);
    const laterRepository = recovered.repositories[1];
    assert.ok(laterRepository);
    assert.equal(
      git(laterRepository.workspacePath, "rev-parse", "--show-toplevel"),
      laterRepository.workspacePath,
    );
  } finally {
    f.close();
  }
});

test("interrupted checkout remains provisioning when tracked files are incomplete", async () => {
  const f = fixture();
  try {
    const firstSource = repository(f.root, "partial-first-source");
    const laterSource = join(f.root, "partial-later-source");
    const inputs = [
      { repositoryId: "a-first", path: firstSource },
      { repositoryId: "b-later", path: laterSource },
    ];
    const interrupted = await f.manager.provision("partial-checkout", inputs);
    assert.equal(interrupted.state, "provisioning");
    const firstRepository = interrupted.repositories[0];
    assert.ok(firstRepository);
    rmSync(join(firstRepository.workspacePath, "README.md"));

    repository(f.root, "partial-later-source");
    const reopened = f.reopen();
    await reopened.recover();
    const recovered = await reopened.get("partial-checkout");
    assert.equal(recovered?.state, "provisioning");
    assert.match(recovered?.reason ?? "", /checkout is incomplete/);
    await assert.rejects(
      reopened.forExecution("partial-checkout"),
      /checkout is incomplete/,
    );
  } finally {
    f.close();
  }
});

test("cleanup retains delivered workspaces with uncommitted files and removes clean archived worktrees", async () => {
  const f = fixture();
  try {
    const source = repository(f.root, "cleanup-source");
    const binding = await f.manager.provision("task-cleanup", [
      { repositoryId: "repo", path: source },
    ]);
    const repositoryBinding = binding.repositories[0];
    assert.ok(repositoryBinding);
    const repoWorkspace = repositoryBinding.workspacePath;

    const awaitingDelivery = await f.manager.archiveAndCleanup("task-cleanup", {
      ...approvedCleanup,
      deliveryConfirmed: false,
    });
    assert.equal(awaitingDelivery.outcome, "retained");
    assert.equal((await f.manager.forExecution("task-cleanup")).state, "ready");

    writeFileSync(join(repoWorkspace, "README.md"), "uncommitted\n");
    const uncommitted = await f.manager.archiveAndCleanup(
      "task-cleanup",
      approvedCleanup,
    );
    assert.equal(uncommitted.outcome, "retained");
    assert.match(uncommitted.reason, /Uncommitted or ignored work remains/);
    assert.equal(
      readFileSync(join(repoWorkspace, "README.md"), "utf8"),
      "uncommitted\n",
    );

    git(repoWorkspace, "checkout", "--", "README.md");
    const clean = await f.manager.archiveAndCleanup(
      "task-cleanup",
      approvedCleanup,
    );
    assert.equal(clean.outcome, "cleaned");
    assert.equal(clean.binding.state, "archived");
    assert.equal(exists(binding.path), false);
    assert.equal(
      git(source, "worktree", "list", "--porcelain").includes(repoWorkspace),
      false,
    );
  } finally {
    f.close();
  }
});

test("a completed worktree add followed by a bounded stall is retained without retry after reopen", async (t) => {
  const controlled = controlledGit();
  const failureObservations: Parameters<
    NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
  >[0][] = [];
  const f = fixture({
    gitExecutable: controlled.executable,
    gitTimeoutMs: { "worktree-add": 1000 },
    gitTerminationGraceMs: 20,
    gitTerminationObservationMs: 40,
    gitFailureObserver: (failure) => failureObservations.push(failure),
  });
  try {
    const source = repository(f.root, "uncertain-add-source");
    controlled.setRule({
      commandPrefix: "worktree add",
      behavior: "complete-then-stall",
      holdPipe: true,
    });
    const interrupted = await f.manager.provision("private-task-id", [
      { repositoryId: "private-repository-id", path: source },
    ]);
    const worktreeAddReady = await waitForGitEvent(
      controlled,
      ({ event, operation }) =>
        event === "ready" && operation === "worktree-add",
    );
    assert.ok(worktreeAddReady.atMs !== undefined);
    const elapsedMs = Date.now() - worktreeAddReady.atMs;

    assert.equal(interrupted.state, "held");
    assert.equal(interrupted.gitUncertain, true);
    assert.match(interrupted.reason ?? "", /timed-out during worktree-add/);
    assert.doesNotMatch(
      interrupted.reason ?? "",
      /private-task-id|private-repository-id|uncertain-add-source|stderr-secret-shaped-output/,
    );
    assert.ok(elapsedMs < 1000 + 20 + 40 + 500, `settled in ${elapsedMs}ms`);
    t.diagnostic(
      `bounded-git-stall-evidence ${JSON.stringify({
        operation: "worktree-add",
        readyToSettleMs: elapsedMs,
        configuredTimeoutMs: 1000,
        termGraceMs: 20,
        observationMs: 40,
        childExitSignal: failureObservations.at(-1)?.childExitSignal,
        inheritedPipeDescendantAliveAtSettlement: true,
      })}`,
    );
    const repositoryBinding = interrupted.repositories[0];
    assert.ok(repositoryBinding);
    assert.equal(exists(repositoryBinding.workspacePath), true);
    assert.ok(
      controlled
        .events()
        .some(
          ({ event, effectComplete }) => event === "finish" && effectComplete,
        ),
    );
    const descendant = controlled
      .events()
      .find(({ event }) => event === "descendant");
    assert.ok(descendant);
    assert.equal(processIsAlive(descendant.pid), true);

    assert.deepEqual(failureObservations.at(-1), {
      operation: "worktree-add",
      kind: "timed-out",
      childExitObserved: true,
      childExitSignal: "SIGKILL",
    });
    assert.ok(controlled.events().some(({ event }) => event === "term"));

    const launchesBeforeReopen = controlled
      .events()
      .filter(({ event }) => event === "start").length;
    const reopened = f.reopen();
    await reopened.recover();
    assert.equal(
      controlled.events().filter(({ event }) => event === "start").length,
      launchesBeforeReopen,
    );
    const retained = await reopened.get("private-task-id");
    assert.equal(retained?.workspaceId, interrupted.workspaceId);
    assert.equal(retained?.state, "held");
    assert.equal(retained?.gitUncertain, true);
    assert.equal(exists(repositoryBinding.workspacePath), true);
  } finally {
    try {
      await controlled.cleanup();
    } finally {
      f.close();
    }
  }
});

test("validation, archive status, and removal uncertainty preserve the binding", async (t) => {
  const scenarios = [
    {
      name: "ready validation",
      commandPrefix: "rev-parse --show-toplevel",
      operation: "repository-identity",
      run: async (manager: WorkspaceManager) => manager.recover(),
    },
    {
      name: "archive status",
      commandPrefix: "status --porcelain=v1 --untracked-files=all",
      operation: "archive-status",
      run: async (manager: WorkspaceManager) =>
        manager.archiveAndCleanup("uncertain-cleanup", approvedCleanup),
    },
    {
      name: "worktree removal",
      commandPrefix: "worktree remove",
      operation: "worktree-remove",
      run: async (manager: WorkspaceManager) =>
        manager.archiveAndCleanup("uncertain-cleanup", approvedCleanup),
    },
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const controlled = controlledGit();
      const failureObservations: Parameters<
        NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
      >[0][] = [];
      const f = fixture();
      try {
        const source = repository(f.root, `source-${scenario.operation}`);
        const ready = await f.manager.provision("uncertain-cleanup", [
          { repositoryId: "repo", path: source },
        ]);
        assert.equal(ready.state, "ready");
        const repo = ready.repositories[0];
        assert.ok(repo);
        controlled.setRule({
          commandPrefix: scenario.commandPrefix,
          behavior: "stall",
        });
        const manager = f.reopen({
          gitExecutable: controlled.executable,
          gitTerminationGraceMs: 20,
          gitTerminationObservationMs: 40,
          gitFailureObserver: (failure) => failureObservations.push(failure),
        });

        const pending = scenario.run(manager);
        const operationReady = await waitForGitEvent(
          controlled,
          ({ event, operation }) =>
            event === "ready" && operation === scenario.operation,
        );
        manager.cancelGitWork();
        const result = await pending;
        assert.ok(operationReady.atMs !== undefined);
        const elapsedMs = Date.now() - operationReady.atMs;
        assert.ok(elapsedMs < 20 + 40 + 500, `settled in ${elapsedMs}ms`);
        if (scenario.operation === "repository-identity") {
          assert.equal(result, undefined);
        } else {
          assert.equal(result?.outcome, "retained");
          if (result?.outcome === "retained") {
            assert.equal(result.binding.state, "held");
            assert.equal(result.binding.gitUncertain, true);
            assert.match(
              result.reason,
              new RegExp(`cancelled during ${scenario.operation}`),
            );
          }
        }

        const held = await f.reopen().get("uncertain-cleanup");
        assert.equal(held?.state, "held");
        assert.equal(held?.gitUncertain, true);
        assert.equal(held?.workspaceId, ready.workspaceId);
        assert.equal(exists(repo.workspacePath), true);
        assert.deepEqual(failureObservations.at(-1), {
          operation: scenario.operation,
          kind: "cancelled",
          childExitObserved: true,
          childExitSignal: "SIGKILL",
        });
        assert.ok(controlled.events().some(({ event }) => event === "term"));
        if (scenario.operation === "archive-status")
          assert.equal(
            controlled
              .events()
              .some(
                ({ event, operation }) =>
                  event === "start" && operation === "worktree-remove",
              ),
            false,
          );
      } finally {
        try {
          await controlled.cleanup();
        } finally {
          f.close();
        }
      }
    });
  }
});

test("output overflow and sticky cancellation settle safely and retain uncertainty", async (t) => {
  await t.test("output overflow", async () => {
    const controlled = controlledGit();
    const failureObservations: Parameters<
      NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
    >[0][] = [];
    const f = fixture({
      gitExecutable: controlled.executable,
      gitTerminationGraceMs: 20,
      gitTerminationObservationMs: 40,
      gitFailureObserver: (failure) => failureObservations.push(failure),
    });
    try {
      const source = repository(f.root, "secret-output-source");
      controlled.setRule({
        commandPrefix: "rev-parse --show-toplevel",
        behavior: "overflow",
      });
      const binding = await f.manager.provision("secret-task-id", [
        { repositoryId: "secret-repository-id", path: source },
      ]);
      assert.equal(binding.state, "held");
      assert.equal(binding.gitUncertain, true);
      assert.match(
        binding.reason ?? "",
        /output-limit during repository-identity/,
      );
      assert.doesNotMatch(
        binding.reason ?? "",
        /secret-task-id|secret-repository-id|secret-output-source|stderr-secret-shaped-output/,
      );
      assert.deepEqual(failureObservations.at(-1), {
        operation: "repository-identity",
        kind: "output-limit",
        childExitObserved: true,
        childExitSignal: "SIGTERM",
      });
    } finally {
      try {
        await controlled.cleanup();
      } finally {
        f.close();
      }
    }
  });

  await t.test("service-owned cancellation is sticky and bounded", async () => {
    const controlled = controlledGit();
    const failureObservations: Parameters<
      NonNullable<WorkspaceManagerOptions["gitFailureObserver"]>
    >[0][] = [];
    const f = fixture({
      gitExecutable: controlled.executable,
      gitTimeoutMs: { "repository-identity": 30_000 },
      gitTerminationGraceMs: 20,
      gitTerminationObservationMs: 40,
      gitFailureObserver: (failure) => failureObservations.push(failure),
    });
    try {
      const source = repository(f.root, "cancel-source");
      controlled.setRule({
        commandPrefix: "rev-parse --show-toplevel",
        behavior: "stall",
        holdPipe: true,
      });
      const provisioning = f.manager.provision("cancelled-task", [
        { repositoryId: "repo", path: source },
      ]);
      const ready = await waitForGitEvent(
        controlled,
        ({ event, operation }) =>
          event === "ready" && operation === "repository-identity",
      );
      f.manager.cancelGitWork();
      const binding = await provisioning;
      assert.ok(ready.atMs !== undefined);
      const elapsedMs = Date.now() - ready.atMs;
      assert.ok(elapsedMs < 20 + 40 + 500, `settled in ${elapsedMs}ms`);
      assert.equal(binding.state, "held");
      assert.equal(binding.gitUncertain, true);
      assert.match(
        binding.reason ?? "",
        /cancelled during repository-identity/,
      );
      assert.deepEqual(failureObservations.at(-1), {
        operation: "repository-identity",
        kind: "cancelled",
        childExitObserved: true,
        childExitSignal: "SIGKILL",
      });
      await f.manager.settle();
      const launches = controlled
        .events()
        .filter(({ event }) => event === "start").length;
      await assert.rejects(f.manager.provision("later-task"), /stopping/);
      assert.equal(
        controlled.events().filter(({ event }) => event === "start").length,
        launches,
      );
    } finally {
      try {
        await controlled.cleanup();
      } finally {
        f.close();
      }
    }
  });
});

test("a legacy binding table migrates git uncertainty to false", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-workspace-migration-"));
  const db = new DatabaseSync(join(root, "legacy.sqlite"));
  try {
    db.exec(`CREATE TABLE task_workspace_bindings (
      taskId TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      repositories TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO task_workspace_bindings
      (taskId, workspaceId, path, repositories, state, reason, createdAt, updatedAt)
      VALUES (?, ?, ?, '[]', 'held', 'legacy hold', ?, ?)`).run(
      "legacy-task",
      randomUUID(),
      join(root, "workspace"),
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    const store = new SqliteWorkspaceBindingStore(db);
    assert.equal(store.get("legacy-task")?.gitUncertain, false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-free files are retained until preservation evidence is complete", async () => {
  const f = fixture();
  try {
    const binding = await f.manager.provision("artifact-task");
    const artifact = join(binding.path, "summary.md");
    const archive = join(f.root, "preserved-summary.md");
    writeFileSync(artifact, "task result\n");

    const held = await f.manager.archiveAndCleanup("artifact-task", {
      ...approvedCleanup,
      workspaceContentsPreserved: false,
    });
    assert.equal(held.outcome, "retained");
    assert.equal(readFileSync(artifact, "utf8"), "task result\n");

    writeFileSync(archive, readFileSync(artifact));
    const cleaned = await f.manager.archiveAndCleanup(
      "artifact-task",
      approvedCleanup,
    );
    assert.equal(cleaned.outcome, "cleaned");
    assert.equal(readFileSync(archive, "utf8"), "task result\n");
    assert.equal(exists(binding.path), false);
  } finally {
    f.close();
  }
});

test("a missing workspace becomes a visible execution hold and is not silently recreated", async () => {
  const f = fixture();
  try {
    const binding = await f.manager.provision("missing-task");
    rmSync(binding.path, { recursive: true });

    const held = await f.manager.get("missing-task");
    assert.equal(held?.state, "held");
    assert.match(
      held?.reason ?? "",
      /Task workspace unavailable: Task workspace is missing/,
    );
    await assert.rejects(
      f.manager.forExecution("missing-task"),
      /Task workspace unavailable/,
    );
    assert.equal(exists(binding.path), false);
  } finally {
    f.close();
  }
});

test("restored managed bindings reject source-root identity before path access", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-workspace-restore-"));
  const sourceInstall = join(root, "source-install");
  const destinationInstall = join(root, "destination-install");
  const sourceWorkspaceRoot = join(sourceInstall, "workspaces");
  const destinationWorkspaceRoot = join(destinationInstall, "workspaces");
  const workspaceId = randomUUID();
  const bindingPath = join(sourceWorkspaceRoot, workspaceId);
  const repositoryPath = join(bindingPath, "repo-1");
  const sentinelPath = join(repositoryPath, "preserve.txt");
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(destinationInstall);
  writeFileSync(sentinelPath, "source workspace remains untouched\n");
  const original = readFileSync(sentinelPath);
  let binding: TaskWorkspaceBinding = {
    taskId: "restored-task",
    workspaceId,
    path: bindingPath,
    repositories: [
      {
        repositoryId: "source-repo",
        sourcePath: join(root, "source-repository"),
        workspacePath: repositoryPath,
        ref: "HEAD",
        gitCommonDir: join(root, "source-repository", ".git"),
        commit: "a".repeat(40),
      },
    ],
    state: "held",
    reason: "An unrelated persisted hold must not bypass identity validation",
    gitUncertain: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const store: WorkspaceBindingStore = {
    createOrGet: () => binding,
    get: () => binding,
    list: () => [binding],
    bindRepository: () => binding,
    update: (_taskId, state, reason) => {
      binding = { ...binding, state, reason };
      return binding;
    },
    markGitUncertain: (_taskId, reason) => {
      binding = { ...binding, state: "held", reason, gitUncertain: true };
      return binding;
    },
  };
  const observedPaths: string[] = [];
  const manager = new WorkspaceManager(store, destinationWorkspaceRoot, {
    beforePathAccess: (path) => observedPaths.push(path),
  });
  try {
    await manager.recover();
    assert.equal(binding.state, "held");
    assert.match(
      binding.reason ?? "",
      /Stored workspace path does not match its identity/,
    );
    assert.equal(
      observedPaths.some(
        (path) => path === bindingPath || path.startsWith(`${sourceInstall}/`),
      ),
      false,
    );
    assert.equal(readFileSync(sentinelPath).equals(original), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function exists(path: string): boolean {
  return existsSync(path);
}
