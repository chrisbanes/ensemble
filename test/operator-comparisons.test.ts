import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceComparisonReadSchema } from "../src/operator/contracts.js";
import { workspaceInspectionPathExcluded } from "../src/standalone/workspace-inspection.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./fixtures/operator-web.js";

class ReportingComparisonRuntime extends OperatorFixtureRuntime {
  override async waitForTurn(threadId: string, turnId: string) {
    const outcome = await super.waitForTurn(threadId, turnId);
    await this.callTool({
      threadId,
      turnId,
      callId: `comparison-report-${turnId}`,
      tool: "ensemble_ask_question",
      arguments: {
        question: "The comparison fixture has finished its observation",
      },
    });
    return outcome;
  }
}

function sourceRepository(
  root: string,
  name: string,
  options: { minimal?: boolean } = {},
) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.name",
    "Comparison HTTP Test",
  ]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "comparison-http@example.invalid",
  ]);
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  if (!options.minimal) {
    writeFileSync(join(path, "README.md"), `${name} base\n`);
    writeFileSync(join(path, "private.md"), "safe baseline\n");
  }
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "fixture"]);
  return path;
}

function seedUnprovisionedTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  name: string,
) {
  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const domain = f.service.domain();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Comparison HTTP lead",
    instructions: "comparison HTTP fixture",
    capabilities: "review",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name,
    leadProfileId: profileId,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: name,
    outcome: "Read the exact local comparison",
    ready: false,
  });
  return taskId;
}

async function seedRunnableTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  name: string,
) {
  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const domain = f.service.domain();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Runnable comparison lead",
    instructions: "observe a comparison",
    capabilities: "review",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name,
    leadProfileId: profileId,
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: name,
    outcome: "Observe one actual workspace change",
    ready: true,
  });
  const assignmentId = String(domain.ensureLeadAssignment(taskId)?.id ?? "");
  assert.ok(assignmentId);
  const binding = await f.service.provisionTask(taskId, []);
  return {
    taskId,
    profileId,
    assignmentId,
    firstWorkId: `assignment:${assignmentId}:initial`,
    binding,
  };
}

function sessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Operator fixture did not set a session cookie");
  return cookie;
}

async function login(
  web: Awaited<
    ReturnType<Awaited<ReturnType<typeof createOperatorFixture>>["startWeb"]>
  >,
) {
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anonymousSession = (await anonymous.json()) as { csrfToken: string };
  const loginResponse = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(anonymous),
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anonymousSession.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(loginResponse.status, 200);
  const session = (await loginResponse.json()) as { csrfToken: string };
  return { cookie: sessionCookie(loginResponse), csrfToken: session.csrfToken };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function awaitWithin<T>(
  promise: Promise<T>,
  description: string,
  diagnostic: () => string = () => "",
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const detail = diagnostic();
          reject(
            new Error(
              `${description} timed out${detail ? ` (${detail})` : ""}`,
            ),
          );
        }, 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function until(
  check: () => boolean,
  description: string,
  diagnostic: () => string = () => "",
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const detail = diagnostic();
  assert.fail(
    `Timed out waiting for ${description}${detail ? ` (${detail})` : ""}`,
  );
}

function comparisonUrl(
  origin: string,
  taskId: string,
  params: URLSearchParams,
) {
  return `${origin}/api/operator/tasks/${taskId}/comparisons?${params.toString()}`;
}

test("authenticated repository comparisons require explicit bases, stable IDs and exact anchors", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const taskId = seedUnprovisionedTask(f, "Comparison reads");
  const sourceRoot = join(f.directory, "comparison-sources");
  const firstSource = sourceRepository(sourceRoot, "first");
  const secondSource = sourceRepository(sourceRoot, "second", {
    minimal: true,
  });
  writeFileSync(
    join(firstSource, "rename-before.md"),
    "rename source contents\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n",
  );
  execFileSync("git", ["-C", firstSource, "add", "rename-before.md"]);
  execFileSync("git", [
    "-C",
    firstSource,
    "commit",
    "--quiet",
    "-m",
    "rename fixture",
  ]);
  const firstBranch = execFileSync(
    "git",
    ["-C", firstSource, "branch", "--show-current"],
    {
      encoding: "utf8",
    },
  ).trim();
  const binding = await f.service.provisionTask(taskId, [
    { repositoryId: "source-1", path: firstSource },
    { repositoryId: "source-2", path: secondSource },
  ]);
  const first = binding.repositories.find(
    (repository) => repository.repositoryId === "source-1",
  );
  const second = binding.repositories.find(
    (repository) => repository.repositoryId === "source-2",
  );
  assert.ok(first && second);
  renameSync(
    join(first.workspacePath, "rename-before.md"),
    join(first.workspacePath, "rename-after.md"),
  );
  writeFileSync(
    join(first.workspacePath, "rename-after.md"),
    "rename source contents\nline two\nline three\nline four\nline five\nline six\nline seven\nchanged line eight\n",
  );
  execFileSync("git", [
    "-C",
    first.workspacePath,
    "add",
    "-A",
    "--",
    "rename-before.md",
    "rename-after.md",
  ]);
  const repositoryCurrent = async () => {
    const currentBinding = await f.service.taskWorkspace(taskId);
    return {
      taskId,
      taskVersion: Number(f.service.domain().task(taskId).version),
      visibility: "comparison fixture",
      ...(currentBinding ? { binding: currentBinding } : {}),
      controlPaths: [f.directory, join(first.workspacePath, "private.md")],
    };
  };
  assert.equal(
    await workspaceInspectionPathExcluded(
      taskId,
      { kind: "repository", repositoryId: "source-2" },
      [],
      repositoryCurrent,
    ),
    false,
    "a currently bound repository root is safe to revalidate",
  );
  writeFileSync(
    join(first.workspacePath, "README.md"),
    "first unstaged change\n",
  );
  writeFileSync(join(first.workspacePath, "staged.md"), "staged change\n");
  execFileSync("git", ["-C", first.workspacePath, "add", "staged.md"]);
  writeFileSync(
    join(first.workspacePath, "untracked.md"),
    "untracked change\n",
  );
  writeFileSync(
    join(first.workspacePath, "private.md"),
    "PRIVATE COMPARISON SECRET",
  );

  const controlPaths = [f.directory, join(first.workspacePath, "private.md")];
  const web = await f.startWeb(controlPaths);
  const anonymous = await fetch(
    comparisonUrl(
      web.origin,
      taskId,
      new URLSearchParams({ target: "uncommitted", repositoryId: "source-1" }),
    ),
  );
  assert.equal(anonymous.status, 401);
  const credentials = await login(web);
  const endpoint = `${web.origin}/api/operator/tasks/${taskId}/comparisons`;
  const get = (params: URLSearchParams) =>
    fetch(comparisonUrl(web.origin, taskId, params), {
      headers: { cookie: credentials.cookie },
    });

  const baseRequired = await get(
    new URLSearchParams({ target: "branch", repositoryId: "source-1" }),
  );
  assert.equal(baseRequired.status, 200);
  const baseRequiredBody = (await baseRequired.json()) as {
    data: {
      state: string;
      reason?: string;
      comparison?: { baseline?: unknown; availableBaseBranches: string[] };
    };
  };
  assert.equal(baseRequiredBody.data.state, "unavailable");
  assert.equal(baseRequiredBody.data.reason, "base-branch-required");
  assert.equal(baseRequiredBody.data.comparison?.baseline, undefined);
  assert.ok(
    baseRequiredBody.data.comparison?.availableBaseBranches.includes(
      firstBranch,
    ),
  );

  const secondBranch = execFileSync(
    "git",
    ["-C", secondSource, "branch", "--show-current"],
    {
      encoding: "utf8",
    },
  ).trim();
  const taskWorkspaceLookupMs: number[] = [];
  const originalTaskWorkspace = f.service.taskWorkspace.bind(f.service);
  f.service.taskWorkspace = async (...args) => {
    const startedAt = performance.now();
    try {
      return await originalTaskWorkspace(...args);
    } finally {
      taskWorkspaceLookupMs.push(performance.now() - startedAt);
    }
  };
  const branchStartedAt = performance.now();
  let branchResponse: Response;
  try {
    branchResponse = await get(
      new URLSearchParams({
        target: "branch",
        repositoryId: "source-2",
        baseBranch: secondBranch,
      }),
    );
  } finally {
    f.service.taskWorkspace = originalTaskWorkspace;
  }
  assert.equal(branchResponse.status, 200);
  const branchText = await branchResponse.text();
  const branchBody = JSON.parse(branchText) as {
    data: {
      state: string;
      comparisonId: string;
      comparison: {
        taskId: string;
        repositoryId: string;
        baseline?: { branch?: string; commit: string };
        entries: Array<{
          path: string;
          hunks: Array<{
            leftAnchor?: Record<string, unknown>;
            rightAnchor?: Record<string, unknown>;
          }>;
        }>;
      };
    };
  };
  t.diagnostic(
    JSON.stringify({
      branchRequestElapsedMs: Math.round(performance.now() - branchStartedAt),
      taskWorkspaceLookupCount: taskWorkspaceLookupMs.length,
      taskWorkspaceLookupTotalMs: Math.round(
        taskWorkspaceLookupMs.reduce((sum, duration) => sum + duration, 0),
      ),
      taskWorkspaceLookupMaxMs: Math.round(
        Math.max(0, ...taskWorkspaceLookupMs),
      ),
      state: branchBody.data.state,
      reason: "reason" in branchBody.data ? branchBody.data.reason : undefined,
    }),
  );
  assert.equal(
    branchBody.data.state,
    "available",
    JSON.stringify(branchBody.data),
  );
  assert.equal(branchBody.data.comparison.taskId, taskId);
  assert.equal(branchBody.data.comparison.repositoryId, "source-2");
  assert.equal(branchBody.data.comparison.baseline?.branch, secondBranch);
  assert.ok(branchBody.data.comparison.baseline?.commit);
  assert.ok(!branchText.includes(binding.path));
  assert.ok(!branchText.includes(firstSource));
  assert.ok(!branchText.includes("PRIVATE COMPARISON SECRET"));

  const staged = await get(
    new URLSearchParams({
      target: "uncommitted",
      repositoryId: "source-1",
      changeSet: "staged",
    }),
  );
  const stagedBody = (await staged.json()) as {
    data: {
      state: string;
      comparison: { entries: { path: string; changeSet?: string }[] };
    };
  };
  assert.equal(stagedBody.data.state, "available");
  assert.ok(
    stagedBody.data.comparison.entries.some(
      (entry) => entry.path === "staged.md",
    ),
  );
  assert.ok(
    stagedBody.data.comparison.entries.every(
      (entry) => entry.changeSet === "staged",
    ),
  );

  const unstaged = await get(
    new URLSearchParams({
      target: "uncommitted",
      repositoryId: "source-1",
      changeSet: "unstaged",
    }),
  );
  const unstagedBody = (await unstaged.json()) as {
    data: { comparison: { entries: { path: string; changeSet?: string }[] } };
  };
  assert.ok(
    unstagedBody.data.comparison.entries.some(
      (entry) => entry.path === "README.md",
    ),
  );
  assert.ok(
    unstagedBody.data.comparison.entries.some(
      (entry) => entry.path === "untracked.md",
    ),
  );
  assert.ok(
    unstagedBody.data.comparison.entries.every(
      (entry) => entry.changeSet === "unstaged",
    ),
  );

  const allQuery = new URLSearchParams({
    target: "uncommitted",
    repositoryId: "source-1",
    changeSet: "all",
  });
  const allStartedAt = performance.now();
  const allResponse = await get(allQuery);
  const allElapsedMs = Math.round(performance.now() - allStartedAt);
  const allBody = (await allResponse.json()) as {
    data: {
      state: string;
      reason?: string;
      comparisonId: string;
      comparison: {
        state: string;
        reason?: string;
        truncated: boolean;
        entries: {
          state: string;
          reason?: string;
          path: string;
          repositoryId?: string | null;
          previousPath?: string;
          hunks: {
            leftAnchor?: Record<string, unknown>;
            rightAnchor?: Record<string, unknown>;
          }[];
        }[];
      };
    };
  };
  t.diagnostic(
    JSON.stringify({
      httpStatus: allResponse.status,
      elapsedMs: allElapsedMs,
      state: allBody.data.state,
      reason: allBody.data.reason ?? null,
      comparisonState: allBody.data.comparison.state,
      comparisonReason: allBody.data.comparison.reason ?? null,
      entryCount: allBody.data.comparison.entries.length,
      entryStates: allBody.data.comparison.entries.map((entry) => ({
        state: entry.state,
        reason: entry.reason ?? null,
      })),
      truncated: allBody.data.comparison.truncated,
    }),
  );
  const oldId = allBody.data.comparisonId;
  assert.ok(allBody.data.comparison.entries.length >= 3);
  const renamed = allBody.data.comparison.entries.find(
    (entry) => entry.path === "rename-after.md",
  );
  assert.equal(renamed?.previousPath, "rename-before.md");
  assert.equal(renamed?.repositoryId, "source-1");
  const uncommittedAnchor = allBody.data.comparison.entries
    .flatMap((entry) => entry.hunks)
    .flatMap((hunk) => [hunk.leftAnchor, hunk.rightAnchor])
    .find((anchor) => anchor !== undefined);
  assert.ok(uncommittedAnchor);
  assert.equal(uncommittedAnchor.taskId, taskId);
  assert.equal(uncommittedAnchor.repositoryId, "source-1");
  assert.equal(uncommittedAnchor.comparisonId, oldId);
  assert.equal(uncommittedAnchor.context, "uncommitted");
  assert.equal(typeof uncommittedAnchor.startLine, "number");
  assert.equal(typeof uncommittedAnchor.endLine, "number");
  assert.ok(
    Number(uncommittedAnchor.endLine) >= Number(uncommittedAnchor.startLine),
  );
  writeFileSync(
    join(first.workspacePath, "README.md"),
    "newer workspace contents\n",
  );
  const stableResponse = await get(allQuery);
  const stableBody = (await stableResponse.json()) as {
    data: {
      comparisonId: string;
      comparison: { entries: { path: string; right?: { sha256?: string } }[] };
    };
  };
  assert.equal(stableBody.data.comparisonId, oldId);
  assert.notEqual(
    stableBody.data.comparison.entries.find(
      (entry) => entry.path === "README.md",
    )?.right?.sha256,
    createHash("sha256").update("newer workspace contents\n").digest("hex"),
  );

  const refreshValidationMs: number[] = [];
  const refreshTaskWorkspace = f.service.taskWorkspace.bind(f.service);
  f.service.taskWorkspace = async (...args) => {
    const startedAt = performance.now();
    try {
      return await refreshTaskWorkspace(...args);
    } finally {
      refreshValidationMs.push(performance.now() - startedAt);
    }
  };
  const refreshStartedAt = performance.now();
  let refreshed: Response;
  try {
    refreshed = await get(
      new URLSearchParams({ ...Object.fromEntries(allQuery), refresh: "true" }),
    );
  } finally {
    f.service.taskWorkspace = refreshTaskWorkspace;
  }
  const refreshElapsedMs = Math.round(performance.now() - refreshStartedAt);
  const refreshedBody = (await refreshed.json()) as {
    data: {
      state: string;
      reason?: string;
      comparisonId: string;
      comparison: {
        entries: {
          path: string;
          state: string;
          reason?: string;
          previousPath?: string;
          left?: { sha256?: string };
          right?: { sha256?: string };
          hunks: {
            leftAnchor?: Record<string, unknown>;
            rightAnchor?: Record<string, unknown>;
          }[];
        }[];
      };
    };
  };
  const refreshedReadme = refreshedBody.data.comparison.entries.find(
    (entry) => entry.path === "README.md",
  );
  const expectedRefreshedHash = createHash("sha256")
    .update("newer workspace contents\n")
    .digest("hex");
  t.diagnostic(
    `comparison-refresh ${JSON.stringify({
      refreshElapsedMs,
      currentValidationCount: refreshValidationMs.length,
      currentValidationTotalMs: Math.round(
        refreshValidationMs.reduce((total, duration) => total + duration, 0),
      ),
      currentValidationMaxMs: Math.round(Math.max(0, ...refreshValidationMs)),
      comparisonState: refreshedBody.data.state,
      comparisonReason: refreshedBody.data.reason,
      readme: refreshedReadme
        ? {
            state: refreshedReadme.state,
            reason: refreshedReadme.reason,
            leftSha256: refreshedReadme.left?.sha256,
            rightSha256: refreshedReadme.right?.sha256,
          }
        : null,
    })}`,
  );
  assert.notEqual(refreshedBody.data.comparisonId, oldId);
  assert.equal(refreshedReadme?.right?.sha256, expectedRefreshedHash);
  const stale = await get(
    new URLSearchParams({ target: "uncommitted", comparisonId: oldId }),
  );
  const staleBody = (await stale.json()) as {
    data: { state: string; reason?: string; comparisonId?: string };
  };
  assert.equal(staleBody.data.state, "unavailable");
  assert.equal(staleBody.data.reason, "comparison-unavailable");
  assert.equal(staleBody.data.comparisonId, oldId);

  const exact = await get(
    new URLSearchParams({
      target: "uncommitted",
      comparisonId: refreshedBody.data.comparisonId,
    }),
  );
  const exactBody = (await exact.json()) as { data: { comparisonId: string } };
  assert.equal(exactBody.data.comparisonId, refreshedBody.data.comparisonId);

  for (const excludedName of ["rename-before.md", "rename-after.md"]) {
    controlPaths.push(join(first.workspacePath, excludedName));
    for (const query of [
      allQuery,
      new URLSearchParams({
        target: "uncommitted",
        comparisonId: refreshedBody.data.comparisonId,
      }),
    ]) {
      const hidden = await get(query);
      const hiddenText = await hidden.text();
      const hiddenBody = JSON.parse(hiddenText) as {
        data: { state: string; reason?: string; comparisonId?: string };
      };
      assert.equal(hiddenBody.data.state, "unavailable", hiddenText);
      assert.equal(hiddenBody.data.reason, "comparison-unavailable");
      assert.equal(
        hiddenBody.data.comparisonId,
        refreshedBody.data.comparisonId,
      );
      assert.ok(!hiddenText.includes("rename-before.md"));
      assert.ok(!hiddenText.includes("rename-after.md"));
      assert.ok(!hiddenText.includes("rename source contents"));
    }
    controlPaths.pop();
  }

  const invalidAnchors = structuredClone(refreshedBody);
  const anchorHunk = invalidAnchors.data.comparison.entries
    .flatMap((entry) => entry.hunks)
    .find((hunk) => hunk.rightAnchor);
  assert.ok(anchorHunk?.rightAnchor);
  anchorHunk.rightAnchor.taskId = randomUUID();
  assert.equal(
    workspaceComparisonReadSchema.safeParse(invalidAnchors).success,
    false,
  );

  const invalidAnchorPath = structuredClone(refreshedBody);
  const pathHunk = invalidAnchorPath.data.comparison.entries
    .flatMap((entry) => entry.hunks)
    .find((hunk) => hunk.rightAnchor);
  assert.ok(pathHunk?.rightAnchor);
  pathHunk.rightAnchor.path = "different-file.md";
  assert.equal(
    workspaceComparisonReadSchema.safeParse(invalidAnchorPath).success,
    false,
  );

  const invalidAnchorSide = structuredClone(refreshedBody);
  const sideHunk = invalidAnchorSide.data.comparison.entries
    .flatMap((entry) => entry.hunks)
    .find((hunk) => hunk.rightAnchor);
  assert.ok(sideHunk?.rightAnchor);
  sideHunk.rightAnchor.side = "left";
  assert.equal(
    workspaceComparisonReadSchema.safeParse(invalidAnchorSide).success,
    false,
  );

  assert.equal(workspaceComparisonReadSchema.safeParse(allBody).success, true);
  const renameEntry = allBody.data.comparison.entries.find(
    (entry) => entry.path === "rename-after.md",
  );
  const renameLeftAnchor = renameEntry?.hunks.find(
    (hunk) => hunk.leftAnchor,
  )?.leftAnchor;
  assert.ok(renameEntry?.previousPath);
  assert.equal(renameLeftAnchor?.path, renameEntry.previousPath);
  const invalidRenamePath = structuredClone(allBody);
  const renameHunk = invalidRenamePath.data.comparison.entries
    .find((entry) => entry.path === "rename-after.md")
    ?.hunks.find((hunk) => hunk.leftAnchor);
  assert.ok(renameHunk?.leftAnchor);
  renameHunk.leftAnchor.path = "rename-after.md";
  assert.equal(
    workspaceComparisonReadSchema.safeParse(invalidRenamePath).success,
    false,
  );

  for (const query of [
    "target=uncommitted&target=branch&repositoryId=source-1",
    "target=uncommitted&repositoryId=source-1&changeSet=guess",
    "target=branch&repositoryId=source-1&changeSet=staged",
    "target=last-turn&repositoryId=source-1",
    "target=uncommitted&repositoryId=source-1&unknown=value",
  ]) {
    const invalid = await get(new URLSearchParams(query));
    assert.equal(invalid.status, 400, query);
  }
  const missingTask = await fetch(
    `${endpoint.replace(taskId, randomUUID())}?target=last-turn`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(missingTask.status, 404);
});

test("stored comparison reads recheck privacy and session after awaited path validation", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const taskId = seedUnprovisionedTask(f, "Stored comparison recheck");
  const source = sourceRepository(join(f.directory, "stored-source"), "repo");
  const binding = await f.service.provisionTask(taskId, [
    { repositoryId: "source-1", path: source },
  ]);
  const repository = binding.repositories[0];
  assert.ok(repository);
  writeFileSync(
    join(repository.workspacePath, "stored-secret.md"),
    "stored comparison secret contents\n",
  );
  const controlPaths = [f.directory];
  const web = await f.startWeb(controlPaths);
  const credentials = await login(web);
  const get = (params: URLSearchParams) =>
    fetch(comparisonUrl(web.origin, taskId, params), {
      headers: { cookie: credentials.cookie },
    });
  const generated = await get(
    new URLSearchParams({ target: "uncommitted", repositoryId: "source-1" }),
  );
  const generatedBody = (await generated.json()) as {
    data: { comparisonId: string; comparison: { entries: { path: string }[] } };
  };
  assert.ok(
    generatedBody.data.comparison.entries.some(
      (entry) => entry.path === "stored-secret.md",
    ),
  );

  const originalTaskWorkspace = f.service.taskWorkspace.bind(f.service);
  const entered = deferred();
  const release = deferred();
  let lookups = 0;
  f.service.taskWorkspace = async (...args) => {
    const value = await originalTaskWorkspace(...args);
    if (++lookups === 3) {
      entered.resolve();
      await release.promise;
    }
    return value;
  };
  t.after(() => {
    release.resolve();
    f.service.taskWorkspace = originalTaskWorkspace;
  });
  const exactRead = get(
    new URLSearchParams({
      target: "uncommitted",
      comparisonId: generatedBody.data.comparisonId,
    }),
  );
  await entered.promise;
  controlPaths.push(join(repository.workspacePath, "stored-secret.md"));
  const logout = await fetch(`${web.origin}/api/operator/logout`, {
    method: "POST",
    headers: {
      cookie: credentials.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": credentials.csrfToken,
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  release.resolve();
  const hidden = await exactRead;
  const hiddenText = await hidden.text();
  assert.equal(hidden.status, 401);
  assert.ok(!hiddenText.includes("stored-secret.md"));
  assert.ok(!hiddenText.includes("stored comparison secret contents"));
});

test("last-turn HTTP reads distinguish pending and finished captures and never retarget old IDs", async (t) => {
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    () => new ReportingComparisonRuntime(),
  );
  t.after(() => f.close());
  const task = await seedRunnableTask(f, "Turn comparison reads");
  const binding = task.binding;
  await until(() => f.runtime.turns === 1, "initial fake turn start");
  await until(() => f.runtime.hasPending(1), "first fake turn wait");
  const controlPaths = [f.directory];
  const web = await f.startWeb(controlPaths);
  const credentials = await login(web);
  const url = (params: URLSearchParams) =>
    comparisonUrl(web.origin, task.taskId, params);
  const get = (params: URLSearchParams) =>
    fetch(url(params), { headers: { cookie: credentials.cookie } });
  const endpoint = new URLSearchParams({ target: "last-turn" });

  const pending = await get(endpoint);
  const pendingText = await pending.text();
  const pendingBody = JSON.parse(pendingText) as {
    data: {
      state: string;
      pending: {
        comparisonId: string;
        outcome: string;
        threadId?: string;
        turnId?: string;
        beforeObservedAt?: number;
      };
    };
  };
  assert.equal(pendingBody.data.state, "unsettled");
  assert.equal(pendingBody.data.pending.outcome, "running");
  assert.equal(pendingBody.data.pending.threadId, "fixture-thread");
  assert.equal(pendingBody.data.pending.turnId, "fixture-turn-1");
  assert.ok(
    pendingBody.data.pending.beforeObservedAt !== undefined,
    "the pending API returns the actual pre-turn observation timestamp",
  );
  assert.ok(!pendingText.includes(binding.path));
  writeFileSync(
    join(binding.path, "http-turn.md"),
    "first actual turn observation\n",
  );
  f.runtime.complete(1);
  await until(
    () =>
      f.service.list().find((work) => work.workId === task.firstWorkId)
        ?.state === "completed",
    "first fake turn completion",
  );
  assert.equal(f.service.taskHold(task.taskId), undefined);
  const first = await get(endpoint);
  const firstBody = (await first.json()) as {
    data: {
      state: string;
      comparisonId: string;
      comparison: {
        workId: string;
        profileId: string;
        threadId?: string;
        turnId?: string;
        startedAt: number;
        beforeObservedAt?: number;
        observedAt: number;
        entries: Array<{
          path: string;
          right?: { sha256?: string };
          hunks: Array<{
            rightAnchor?: { repositoryId: string | null; context: string };
          }>;
        }>;
      };
    };
  };
  assert.equal(firstBody.data.state, "available");
  assert.equal(firstBody.data.comparison.workId, task.firstWorkId);
  assert.equal(firstBody.data.comparison.profileId, task.profileId);
  assert.equal(firstBody.data.comparison.threadId, "fixture-thread");
  assert.equal(firstBody.data.comparison.turnId, "fixture-turn-1");
  assert.equal(
    firstBody.data.comparison.beforeObservedAt,
    pendingBody.data.pending.beforeObservedAt,
    "the finished response preserves the exact before observation exposed while pending",
  );
  assert.ok(
    firstBody.data.comparison.startedAt <=
      firstBody.data.comparison.beforeObservedAt!,
  );
  assert.ok(
    firstBody.data.comparison.observedAt >=
      firstBody.data.comparison.beforeObservedAt!,
  );
  const marker = firstBody.data.comparison.entries.find(
    (entry) => entry.path === "http-turn.md",
  );
  assert.equal(
    marker?.right?.sha256,
    createHash("sha256")
      .update("first actual turn observation\n")
      .digest("hex"),
  );
  assert.equal(marker?.hunks[0]?.rightAnchor?.repositoryId, null);
  assert.equal(marker?.hunks[0]?.rightAnchor?.context, "turn");

  const excludedTurnPath = join(binding.path, "http-turn.md");
  controlPaths.push(excludedTurnPath);
  const hiddenExact = await get(
    new URLSearchParams({
      target: "last-turn",
      comparisonId: firstBody.data.comparisonId,
    }),
  );
  const hiddenExactText = await hiddenExact.text();
  const hiddenExactBody = JSON.parse(hiddenExactText) as {
    data: { state: string; reason?: string; comparisonId?: string };
  };
  assert.equal(hiddenExactBody.data.state, "unavailable");
  assert.equal(hiddenExactBody.data.reason, "comparison-unavailable");
  assert.equal(hiddenExactBody.data.comparisonId, firstBody.data.comparisonId);
  assert.ok(!hiddenExactText.includes("http-turn.md"));
  assert.ok(!hiddenExactText.includes("first actual turn observation"));

  const secondAction = f.service.submitTask(
    "http-turn-two",
    task.assignmentId,
    "capture another change",
  );
  await until(() => f.runtime.turns === 2, "second fake turn start");
  await until(() => f.runtime.hasPending(2), "second fake turn wait");
  const secondPending = await get(endpoint);
  const secondPendingBody = (await secondPending.json()) as {
    data: {
      state: string;
      latestFinished?: { comparisonId: string };
      pending: { comparisonId: string };
    };
  };
  assert.equal(secondPendingBody.data.state, "unsettled");
  assert.equal(secondPendingBody.data.latestFinished, undefined);
  const secondPendingText = JSON.stringify(secondPendingBody);
  assert.ok(!secondPendingText.includes("http-turn.md"));
  assert.ok(!secondPendingText.includes("first actual turn observation"));
  controlPaths.pop();
  writeFileSync(
    join(binding.path, "http-turn.md"),
    "second actual turn observation\n",
  );
  f.runtime.complete(2);
  const secondTerminal = await secondAction;
  assert.equal(
    secondTerminal.state,
    "completed",
    JSON.stringify({
      terminal: secondTerminal,
      work: f.service.list().find((work) => work.workId === "http-turn-two"),
      taskHold: f.service.taskHold(task.taskId),
      capture: f.service.workspaceTurnCaptureSlots(task.taskId),
    }),
  );
  assert.equal(f.service.taskHold(task.taskId), undefined);
  const latest = await get(endpoint);
  const latestBody = (await latest.json()) as {
    data: {
      state: string;
      comparisonId: string;
      comparison: {
        workId: string;
        beforeObservedAt?: number;
        observedAt: number;
      };
    };
  };
  assert.equal(latestBody.data.state, "available");
  assert.equal(latestBody.data.comparison.workId, "http-turn-two");
  assert.notEqual(latestBody.data.comparisonId, firstBody.data.comparisonId);
  const stale = await get(
    new URLSearchParams({
      target: "last-turn",
      comparisonId: firstBody.data.comparisonId,
    }),
  );
  const staleBody = (await stale.json()) as {
    data: { state: string; reason?: string };
  };
  assert.equal(staleBody.data.state, "unavailable");
  assert.equal(staleBody.data.reason, "comparison-unavailable");
  const wrongTask = await get(
    new URLSearchParams({ target: "last-turn", comparisonId: randomUUID() }),
  );
  assert.equal(
    ((await wrongTask.json()) as { data: { state: string } }).data.state,
    "unavailable",
  );

  const thirdAction = f.service.submitTask(
    "http-turn-three",
    task.assignmentId,
    "keep the previous finished capture visible while this turn is pending",
  );
  await until(() => f.runtime.turns === 3, "third fake turn start");
  await until(() => f.runtime.hasPending(3), "third fake turn wait");
  const thirdPending = await get(endpoint);
  const thirdPendingBody = (await thirdPending.json()) as {
    data: {
      state: string;
      pending: { comparisonId: string };
      latestFinished?: {
        comparisonId: string;
        workId: string;
        beforeObservedAt?: number;
        observedAt: number;
      };
    };
  };
  assert.equal(thirdPendingBody.data.state, "unsettled");
  assert.equal(
    thirdPendingBody.data.pending.comparisonId ===
      thirdPendingBody.data.latestFinished?.comparisonId,
    false,
  );
  assert.equal(
    thirdPendingBody.data.latestFinished?.comparisonId,
    latestBody.data.comparisonId,
  );
  assert.equal(
    thirdPendingBody.data.latestFinished?.workId,
    "http-turn-two",
    "the unsettled projection retains the exact latest finished snapshot",
  );
  assert.equal(
    thirdPendingBody.data.latestFinished?.beforeObservedAt,
    latestBody.data.comparison.beforeObservedAt,
    "the pending projection retains the exact latest finished before-observation timestamp",
  );
  assert.equal(
    thirdPendingBody.data.latestFinished?.observedAt,
    latestBody.data.comparison.observedAt,
    "the pending projection retains the exact latest finished after-observation timestamp",
  );
  f.runtime.complete(3);
  await thirdAction;
  assert.equal(f.service.taskHold(task.taskId), undefined);
});

test("last-turn reads reject a finished slot replaced during stored projection", async (t) => {
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    () => new ReportingComparisonRuntime(),
  );
  t.after(() => f.close());
  const task = await seedRunnableTask(f, "Replaced turn comparison slot");
  await until(() => f.runtime.turns === 1, "fake turn start");
  await until(() => f.runtime.hasPending(1), "fake turn wait");
  writeFileSync(
    join(task.binding.path, "replaced-slot-secret.md"),
    "original completed comparison bytes\n",
  );
  f.runtime.complete(1);
  await until(
    () =>
      f.service.list().find((work) => work.workId === task.firstWorkId)
        ?.state === "completed",
    "fake turn completion",
  );
  const originalSlots = f.service.workspaceTurnCaptureSlots(task.taskId);
  assert.ok(originalSlots.latestFinished?.comparison);

  const web = await f.startWeb([f.directory]);
  const credentials = await login(web);
  const originalReadSlots = f.service.workspaceTurnCaptureSlots.bind(f.service);
  let reads = 0;
  f.service.workspaceTurnCaptureSlots = (taskId) => {
    const current = originalReadSlots(taskId);
    return ++reads === 2 ? {} : current;
  };
  t.after(() => {
    f.service.workspaceTurnCaptureSlots = originalReadSlots;
  });

  const response = await fetch(
    comparisonUrl(
      web.origin,
      task.taskId,
      new URLSearchParams({ target: "last-turn" }),
    ),
    { headers: { cookie: credentials.cookie } },
  );
  const responseText = await response.text();
  const body = JSON.parse(responseText) as {
    data: { state: string; reason?: string; comparisonId?: string };
  };
  assert.equal(reads, 2);
  assert.equal(body.data.state, "unavailable");
  assert.equal(body.data.reason, "capture-unavailable");
  assert.equal(body.data.comparisonId, undefined);
  assert.ok(!responseText.includes("replaced-slot-secret.md"));
  assert.ok(!responseText.includes("original completed comparison bytes"));
});

test("unsettled terminal comparisons hide old entries when the current policy excludes them", async (t) => {
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    () => new ReportingComparisonRuntime(),
  );
  t.after(() => f.close());
  const task = await seedRunnableTask(f, "Unsettled comparison privacy");
  const binding = task.binding;
  const controlPaths = [f.directory];
  const web = await f.startWeb(controlPaths);
  const credentials = await login(web);
  const get = (params: URLSearchParams) =>
    fetch(comparisonUrl(web.origin, task.taskId, params), {
      headers: { cookie: credentials.cookie },
    });

  await until(() => f.runtime.turns === 1, "failed fake turn start");
  await until(() => f.runtime.hasPending(1), "failed fake turn wait");
  writeFileSync(
    join(binding.path, "held-secret.md"),
    "held private comparison contents\n",
  );
  f.runtime.fail(1);
  await until(
    () =>
      f.service.list().find((work) => work.workId === task.firstWorkId)
        ?.state === "held",
    "failed work hold",
  );
  const failedWork = f.service
    .list()
    .find((work) => work.workId === task.firstWorkId);
  assert.equal(failedWork?.state, "held");
  const failureReason = failedWork?.reason;
  assert.match(failureReason ?? "", /Bound turn failed or was interrupted/);
  const pending = f.service.workspaceTurnCaptureSlots(task.taskId).pending;
  assert.ok(pending?.comparison);
  assert.equal(pending.captureState, "unsettled");

  const excludedPath = join(binding.path, "held-secret.md");
  controlPaths.push(excludedPath);
  for (const query of [
    new URLSearchParams({ target: "last-turn" }),
    new URLSearchParams({
      target: "last-turn",
      comparisonId: pending.comparisonId,
    }),
  ]) {
    const hidden = await get(query);
    const hiddenText = await hidden.text();
    const hiddenBody = JSON.parse(hiddenText) as {
      data: {
        state: string;
        pending?: { comparisonId: string; comparison?: { entries: unknown[] } };
      };
    };
    assert.equal(hiddenBody.data.state, "unsettled");
    assert.equal(hiddenBody.data.pending?.comparisonId, pending.comparisonId);
    assert.equal(hiddenBody.data.pending?.comparison, undefined);
    assert.ok(!hiddenText.includes("held-secret.md"));
    assert.ok(!hiddenText.includes("held private comparison contents"));
  }
  const stillHeldWork = f.service
    .list()
    .find((work) => work.workId === task.firstWorkId);
  assert.equal(stillHeldWork?.state, "held");
  assert.equal(stillHeldWork?.reason, failureReason);
});

test("workspace comparison awaits recheck logout, expiry, binding and changing exclusions", async (t) => {
  const f = await createOperatorFixture();
  const taskId = seedUnprovisionedTask(f, "Comparison visibility recheck");
  const source = sourceRepository(
    join(f.directory, "visibility-source"),
    "repo",
  );
  const binding = await f.service.provisionTask(taskId, [
    { repositoryId: "source-1", path: source },
  ]);
  const repository = binding.repositories[0];
  assert.ok(repository);
  writeFileSync(
    join(repository.workspacePath, "private.md"),
    "PRIVATE FILE CONTENT",
  );
  const controlPaths = [f.directory];
  const web = await f.startWeb(controlPaths);
  let credentials = await login(web);
  const originalTaskWorkspace = f.service.taskWorkspace.bind(f.service);
  let entered = deferred();
  let release = deferred();
  t.after(async () => {
    release.resolve();
    f.service.taskWorkspace = originalTaskWorkspace;
    await f.close();
  });
  let pauseNextLookup = true;
  const pauseTaskWorkspaceLookup = () => {
    f.service.taskWorkspace = async (...args) => {
      const value = await originalTaskWorkspace(...args);
      if (pauseNextLookup) {
        pauseNextLookup = false;
        entered.resolve();
        await release.promise;
      }
      return value;
    };
  };
  pauseTaskWorkspaceLookup();
  const endpoint = `${web.origin}/api/operator/tasks/${taskId}/comparisons?target=uncommitted&repositoryId=source-1&refresh=true`;
  let expiredReadState = "pending";
  const expiredRead = fetch(endpoint, {
    headers: { cookie: credentials.cookie },
  }).then(
    (response) => {
      expiredReadState = `HTTP ${response.status}`;
      return response;
    },
    (error: unknown) => {
      expiredReadState = `rejected: ${String(error)}`;
      throw error;
    },
  );
  await awaitWithin(
    entered.promise,
    "expiry taskWorkspace gate",
    () => `request ${expiredReadState}`,
  );
  f.advanceClock(60_001);
  release.resolve();
  const expired = await expiredRead;
  assert.equal(expired.status, 401);
  assert.ok(!(await expired.text()).includes("PRIVATE FILE CONTENT"));

  f.service.taskWorkspace = originalTaskWorkspace;
  credentials = await login(web);
  entered = deferred();
  release = deferred();
  pauseNextLookup = true;
  pauseTaskWorkspaceLookup();
  let logoutReadState = "pending";
  const logoutRead = fetch(endpoint, {
    headers: { cookie: credentials.cookie },
  }).then(
    (response) => {
      logoutReadState = `HTTP ${response.status}`;
      return response;
    },
    (error: unknown) => {
      logoutReadState = `rejected: ${String(error)}`;
      throw error;
    },
  );
  await awaitWithin(
    entered.promise,
    "logout taskWorkspace gate",
    () => `request ${logoutReadState}`,
  );
  const logout = await fetch(`${web.origin}/api/operator/logout`, {
    method: "POST",
    headers: {
      cookie: credentials.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": credentials.csrfToken,
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  release.resolve();
  const afterLogout = await logoutRead;
  assert.equal(afterLogout.status, 401);
  assert.ok(!(await afterLogout.text()).includes("PRIVATE FILE CONTENT"));
  f.service.taskWorkspace = originalTaskWorkspace;
  credentials = await login(web);

  const wrapperRoot = join(f.directory, "git-gate");
  mkdirSync(wrapperRoot);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const marker = join(wrapperRoot, "entered");
  const gate = join(wrapperRoot, "release");
  const used = join(wrapperRoot, "used");
  const wrapper = join(wrapperRoot, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$ENSEMBLE_TEST_GATE_ARMED" = "1" ] && [ ! -e "$ENSEMBLE_TEST_GATE_USED" ]; then : > "$ENSEMBLE_TEST_GATE_USED"; : > "$ENSEMBLE_TEST_GATE_ENTERED"; while [ ! -e "$ENSEMBLE_TEST_GATE_RELEASE" ]; do /bin/sleep 0.01; done; rm -f "$ENSEMBLE_TEST_GATE_ENTERED" "$ENSEMBLE_TEST_GATE_RELEASE"; fi\nexec "$ENSEMBLE_TEST_GIT_REAL" "$@"\n`,
  );
  chmodSync(wrapper, 0o700);
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${wrapperRoot}:${previousPath}`;
  process.env.ENSEMBLE_TEST_GATE_ENTERED = marker;
  process.env.ENSEMBLE_TEST_GATE_RELEASE = gate;
  process.env.ENSEMBLE_TEST_GATE_USED = used;
  process.env.ENSEMBLE_TEST_GATE_ARMED = "0";
  process.env.ENSEMBLE_TEST_GIT_REAL = realGit;
  let gateLookups = 0;
  let changeNextBinding = false;
  f.service.taskWorkspace = async (...args) => {
    const value = await originalTaskWorkspace(...args);
    if (++gateLookups === 4) process.env.ENSEMBLE_TEST_GATE_ARMED = "1";
    if (!changeNextBinding || !value) return value;
    changeNextBinding = false;
    return { ...value, workspaceId: randomUUID() };
  };
  try {
    const excludedPath = join(repository.workspacePath, "private.md");
    let exclusionReadState = "pending";
    const exclusionRead = fetch(endpoint, {
      headers: { cookie: credentials.cookie },
    }).then(
      (response) => {
        exclusionReadState = `HTTP ${response.status}`;
        return response;
      },
      (error: unknown) => {
        exclusionReadState = `rejected: ${String(error)}`;
        throw error;
      },
    );
    await until(
      () => existsSync(marker),
      "Git comparison enumeration",
      () => `request ${exclusionReadState}`,
    );
    controlPaths.push(excludedPath);
    writeFileSync(gate, "release");
    const excluded = await exclusionRead;
    assert.equal(excluded.status, 200);
    assert.equal(exclusionReadState, "HTTP 200");
    const excludedText = await excluded.text();
    const excludedBody = JSON.parse(excludedText) as {
      data: {
        state: string;
        reason?: string;
        comparisonId?: string;
        comparison?: { entries: unknown[] };
      };
    };
    assert.equal(excludedBody.data.state, "unavailable");
    assert.equal(excludedBody.data.reason, "comparison-unavailable");
    assert.ok(excludedBody.data.comparisonId);
    assert.equal(excludedBody.data.comparison, undefined);
    assert.ok(!excludedText.includes("PRIVATE FILE CONTENT"));
    assert.ok(!excludedText.includes(repository.sourcePath));
    assert.ok(!excludedText.includes(repository.workspacePath));

    rmSync(used, { force: true });
    gateLookups = 0;
    process.env.ENSEMBLE_TEST_GATE_ARMED = "0";
    let bindingReadState = "pending";
    const bindingRead = fetch(endpoint, {
      headers: { cookie: credentials.cookie },
    });
    void bindingRead.then(
      (response) => {
        bindingReadState = `HTTP ${response.status}`;
      },
      (error: unknown) => {
        bindingReadState = `rejected: ${String(error)}`;
      },
    );
    await until(
      () => existsSync(marker),
      "second Git comparison enumeration",
      () => `request ${bindingReadState}`,
    );
    changeNextBinding = true;
    writeFileSync(gate, "release");
    const changedBinding = await bindingRead;
    const changedBindingText = await changedBinding.text();
    const changedBindingBody = JSON.parse(changedBindingText) as {
      data: {
        state: string;
        reason?: string;
        comparisonId?: string;
        comparison?: { comparisonId: string; entries: unknown[] };
      };
    };
    assert.equal(changedBinding.status, 200);
    assert.equal(bindingReadState, "HTTP 200");
    assert.equal(changedBindingBody.data.state, "gap");
    assert.equal(changedBindingBody.data.reason, "workspace-changed");
    assert.ok(changedBindingBody.data.comparisonId);
    assert.equal(
      changedBindingBody.data.comparison?.comparisonId,
      changedBindingBody.data.comparisonId,
    );
    assert.deepEqual(changedBindingBody.data.comparison?.entries, []);
    assert.ok(!changedBindingText.includes("private.md"));
    assert.ok(!changedBindingText.includes("PRIVATE FILE CONTENT"));
    assert.ok(!changedBindingText.includes(repository.sourcePath));
    assert.ok(!changedBindingText.includes(repository.workspacePath));
  } finally {
    writeFileSync(gate, "release");
    f.service.taskWorkspace = originalTaskWorkspace;
    process.env.PATH = previousPath;
    delete process.env.ENSEMBLE_TEST_GATE_ENTERED;
    delete process.env.ENSEMBLE_TEST_GATE_RELEASE;
    delete process.env.ENSEMBLE_TEST_GATE_USED;
    delete process.env.ENSEMBLE_TEST_GATE_ARMED;
    delete process.env.ENSEMBLE_TEST_GIT_REAL;
  }
});
