import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OperatorApi,
  OperatorApiError,
} from "../src/standalone/operator-api.js";
import {
  OperatorWebBoundary,
  OperatorWebBundle,
} from "../src/standalone/operator-web.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

function sourceRepository(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.name",
    "Workspace HTTP Test",
  ]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "workspace-http@example.invalid",
  ]);
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  writeFileSync(join(path, "README.md"), `${name}\n`);
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
    name: "Workspace HTTP lead",
    instructions: "workspace HTTP fixture",
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
    outcome: "- [ ] Inspect the requested task workspace",
    ready: false,
  });
  return taskId;
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
  return {
    cookie: sessionCookie(loginResponse),
    csrfToken: session.csrfToken,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function awaitWithin<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sameFilesystemPath(first: string, second: string) {
  try {
    const [firstStat, secondStat] = await Promise.all([
      stat(first),
      stat(second),
    ]);
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
  } catch {
    return false;
  }
}

test("authenticated HTTP workspace listing and preview stay JSON, scoped, private and session-bound", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f);
  const binding = await f.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  mkdirSync(join(binding.path, "directory"));
  mkdirSync(join(binding.path, "directory", "nested"));
  writeFileSync(join(binding.path, "index.html"), "<script>inert()</script>");
  writeFileSync(
    join(binding.path, "directory", "nested", "answer.md"),
    "nested preview",
  );
  writeFileSync(join(binding.path, ".env"), "PRIVATE WORKSPACE SECRET");
  const controlFile = join(binding.path, "operatorauth.txt");
  const controlAlias = join(binding.path, "OperatorAuth.txt");
  writeFileSync(controlFile, "DUMMY_PRIVATE_VALUE HTTP control alias");
  const controlAliasMatches = await sameFilesystemPath(
    controlFile,
    controlAlias,
  );
  t.diagnostic(`HTTP control-path case alias ${controlAliasMatches}`);
  const web = await f.startWeb([f.directory, controlAlias]);
  const files = `${web.origin}/api/operator/tasks/${task.taskId}/files`;
  const preview = `${web.origin}/api/operator/tasks/${task.taskId}/preview`;

  const anonymous = await fetch(`${files}?scope=workspace`);
  assert.equal(anonymous.status, 401);

  const credentials = await login(web);
  const listing = await fetch(`${files}?scope=workspace&showIgnored=true`, {
    headers: { cookie: credentials.cookie },
  });
  assert.equal(listing.status, 200);
  assert.equal(
    listing.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(listing.headers.get("x-content-type-options"), "nosniff");
  assert.equal(listing.headers.get("cache-control"), "no-store");
  const listingText = await listing.text();
  const listingBody = JSON.parse(listingText) as {
    data: {
      taskId: string;
      workspaceId: string;
      state: string;
      entries: { name?: string }[];
    };
  };
  assert.equal(listingBody.data.taskId, task.taskId);
  assert.equal(listingBody.data.workspaceId, binding.workspaceId);
  assert.equal(listingBody.data.state, "ready");
  assert.ok(
    listingBody.data.entries.some((entry) => entry.name === "index.html"),
  );
  assert.ok(!listingText.includes(".env"));
  assert.ok(!listingText.includes("PRIVATE WORKSPACE SECRET"));
  assert.ok(!listingText.includes(binding.path));
  assert.equal(
    listingBody.data.entries.some((entry) => entry.name === "operatorauth.txt"),
    !controlAliasMatches,
  );

  const page = await fetch(
    `${preview}?scope=workspace&path=index.html&showIgnored=true`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(page.status, 200);
  assert.equal(
    page.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const pageText = await page.text();
  const pageBody = JSON.parse(pageText) as {
    data: { state: string; preview?: { kind: string; text?: string } };
  };
  assert.equal(pageBody.data.state, "ready");
  assert.equal(pageBody.data.preview?.kind, "text");
  assert.equal(pageBody.data.preview?.text, "<script>inert()</script>");
  assert.ok(pageText.startsWith("{"));

  const controlPreview = await fetch(
    `${preview}?scope=workspace&path=operatorauth.txt&showIgnored=true`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(controlPreview.status, 200);
  const controlPreviewText = await controlPreview.text();
  const controlPreviewBody = JSON.parse(controlPreviewText) as {
    data: { state: string; preview?: { text?: string } };
  };
  assert.equal(
    controlPreviewBody.data.state,
    controlAliasMatches ? "excluded" : "ready",
  );
  assert.equal(
    controlPreviewBody.data.preview?.text ===
      "DUMMY_PRIVATE_VALUE HTTP control alias",
    !controlAliasMatches,
  );

  const nestedListing = await fetch(
    `${files}?scope=workspace&path=directory/nested`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(nestedListing.status, 200);
  const nestedListingBody = (await nestedListing.json()) as {
    data: { state: string; entries: { name?: string }[] };
  };
  assert.equal(nestedListingBody.data.state, "ready");
  assert.ok(
    nestedListingBody.data.entries.some((entry) => entry.name === "answer.md"),
  );
  const nestedPreview = await fetch(
    `${preview}?scope=workspace&path=directory/nested/answer.md`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(nestedPreview.status, 200);
  const nestedPreviewBody = (await nestedPreview.json()) as {
    data: { state: string; preview?: { text?: string } };
  };
  assert.equal(nestedPreviewBody.data.state, "ready");
  assert.equal(nestedPreviewBody.data.preview?.text, "nested preview");

  const privateRead = await fetch(
    `${preview}?scope=workspace&path=.env&showIgnored=true`,
    { headers: { cookie: credentials.cookie } },
  );
  const privateText = await privateRead.text();
  const privateBody = JSON.parse(privateText) as {
    data: { state: string; path: string[] };
  };
  assert.equal(privateBody.data.state, "excluded");
  assert.deepEqual(privateBody.data.path, []);
  assert.ok(!privateText.includes("PRIVATE WORKSPACE SECRET"));

  const directoryPreview = await fetch(
    `${preview}?scope=workspace&path=directory`,
    { headers: { cookie: credentials.cookie } },
  );
  const directoryBody = (await directoryPreview.json()) as {
    data: { state: string; metadata?: { kind: string }; preview?: unknown };
  };
  assert.equal(directoryBody.data.state, "unavailable");
  assert.equal(directoryBody.data.metadata?.kind, "directory");
  assert.equal(directoryBody.data.preview, undefined);

  for (const query of [
    "scope=workspace&scope=workspace",
    "scope=workspace&unknown=value",
    "scope=workspace&repositoryId=repo-1",
    "scope=workspace&path=%2Fetc%2Fpasswd",
    "scope=workspace&path=..%2Fsecret",
    "scope=workspace&path=C%3A%5Csecret",
    "scope=workspace&path=notes%00private",
    "scope=workspace&path=notes%5Cprivate",
    `scope=repository&repositoryId=${"x".repeat(513)}`,
  ]) {
    const invalid = await fetch(`${files}?${query}`, {
      headers: { cookie: credentials.cookie },
    });
    assert.equal(invalid.status, 400, query);
    assert.ok(!(await invalid.text()).includes(binding.path));
  }

  const foreign = await fetch(
    `${files.replace(task.taskId, randomUUID())}?scope=workspace`,
    {
      headers: { cookie: credentials.cookie },
    },
  );
  assert.equal(foreign.status, 404);

  const logoutCredentials = await login(web);
  const logout = await fetch(`${web.origin}/api/operator/logout`, {
    method: "POST",
    headers: {
      cookie: logoutCredentials.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": logoutCredentials.csrfToken,
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${files}?scope=workspace`, {
    headers: { cookie: logoutCredentials.cookie },
  });
  assert.equal(afterLogout.status, 401);

  const expiringCredentials = await login(web);
  f.advanceClock(60_000);
  const expired = await fetch(`${files}?scope=workspace`, {
    headers: { cookie: expiringCredentials.cookie },
  });
  assert.equal(expired.status, 401);
});

test("internal parsed workspace queries allow nested paths", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Internal nested path");
  const binding = await f.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  mkdirSync(join(binding.path, "nested"));
  writeFileSync(join(binding.path, "nested", "answer.md"), "internal nested");
  const bundle = await OperatorWebBundle.open(
    fileURLToPath(new URL("../operator", import.meta.url)),
  );
  const boundary = new OperatorWebBoundary(
    bundle,
    new OperatorApi(f.service, [f.directory]),
  );
  const result = (await boundary.read(
    `/api/operator/tasks/${task.taskId}/preview`,
    new URLSearchParams("scope=workspace&path=nested%2Fanswer.md"),
  )) as { data: { state: string; preview?: { text?: string } } };
  assert.equal(result.data.state, "ready");
  assert.equal(result.data.preview?.text, "internal nested");
});

test("workspace read errors recheck sessions after logout and expiry", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Session loss during workspace read");
  const web = await f.startWeb();
  const files = `${web.origin}/api/operator/tasks/${task.taskId}/files?scope=workspace`;
  const original = f.service.taskWorkspace.bind(f.service);
  let pendingGate:
    | {
        started: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
        failure: unknown;
      }
    | undefined;
  f.service.taskWorkspace = async (taskId) => {
    const gate = pendingGate;
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
      throw gate.failure;
    }
    return original(taskId);
  };
  t.after(() => {
    pendingGate?.release.resolve();
    f.service.taskWorkspace = original;
  });

  const logoutCredentials = await login(web);
  const logoutGate = {
    started: deferred(),
    release: deferred(),
    failure: new OperatorApiError(404, "not-found"),
  };
  pendingGate = logoutGate;
  const pendingLogoutRead = fetch(files, {
    headers: { cookie: logoutCredentials.cookie },
  });
  await awaitWithin(
    logoutGate.started.promise,
    "workspace lookup before logout",
  );
  const logout = await fetch(`${web.origin}/api/operator/logout`, {
    method: "POST",
    headers: {
      cookie: logoutCredentials.cookie,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": logoutCredentials.csrfToken,
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  logoutGate.release.resolve();
  pendingGate = undefined;
  const afterLogout = await awaitWithin(pendingLogoutRead, "logout result");
  const afterLogoutText = await afterLogout.text();
  assert.equal(afterLogout.status, 401);
  assert.ok(!afterLogoutText.includes("not-found"));

  const expiringCredentials = await login(web);
  const expiryGate = {
    started: deferred(),
    release: deferred(),
    failure: new Error("private workspace lookup detail"),
  };
  pendingGate = expiryGate;
  const pendingExpiredRead = fetch(files, {
    headers: { cookie: expiringCredentials.cookie },
  });
  await awaitWithin(
    expiryGate.started.promise,
    "workspace lookup before expiry",
  );
  f.advanceClock(60_000);
  expiryGate.release.resolve();
  pendingGate = undefined;
  const afterExpiry = await awaitWithin(pendingExpiredRead, "expiry result");
  const afterExpiryText = await afterExpiry.text();
  assert.equal(afterExpiry.status, 401);
  assert.ok(!afterExpiryText.includes("private workspace lookup detail"));
});

test("authenticated multi-repository HTTP reads require an exact repository scope and reveal only requested ignore clutter", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const taskId = seedUnprovisionedTask(f, "Multi-repository workspace");
  const sourceRoot = join(f.directory, "source-repositories");
  const sources = [
    sourceRepository(sourceRoot, "one"),
    sourceRepository(sourceRoot, "two"),
  ];
  const binding = await f.service.provisionTask(
    taskId,
    sources.map((path, index) => ({
      repositoryId: `source-${index + 1}`,
      path,
    })),
  );
  const firstRepository = binding.repositories.at(0);
  assert.ok(firstRepository);
  writeFileSync(
    join(firstRepository.workspacePath, "ignored.log"),
    "ignored fixture text",
  );
  const web = await f.startWeb();
  const credentials = await login(web);
  const files = `${web.origin}/api/operator/tasks/${taskId}/files`;

  const root = await fetch(`${files}?scope=workspace`, {
    headers: { cookie: credentials.cookie },
  });
  const rootBody = (await root.json()) as {
    data: {
      state: string;
      entries: { kind: string; repositoryId?: string; name?: string }[];
    };
  };
  assert.equal(root.status, 200);
  assert.deepEqual(
    rootBody.data.entries
      .filter((entry) => entry.kind === "repository")
      .map((entry) => entry.repositoryId)
      .sort(),
    ["source-1", "source-2"],
  );
  assert.ok(!JSON.stringify(rootBody).includes(binding.path));

  const invalidWorkspaceTraversal = await fetch(
    `${files}?scope=workspace&path=repo-1`,
    {
      headers: { cookie: credentials.cookie },
    },
  );
  const invalidBody = (await invalidWorkspaceTraversal.json()) as {
    data: { state: string; entries: unknown[] };
  };
  assert.equal(invalidBody.data.state, "conflict");
  assert.deepEqual(invalidBody.data.entries, []);

  const repositoryFiles = await fetch(
    `${files}?scope=repository&repositoryId=source-1`,
    { headers: { cookie: credentials.cookie } },
  );
  const repositoryBody = (await repositoryFiles.json()) as {
    data: {
      state: string;
      entries: { name?: string; ignored?: boolean }[];
      ignoreStatus: string;
    };
  };
  assert.equal(repositoryBody.data.state, "ready");
  assert.equal(repositoryBody.data.ignoreStatus, "known");
  assert.ok(
    !repositoryBody.data.entries.some((entry) => entry.name === "ignored.log"),
  );
  assert.ok(
    !repositoryBody.data.entries.some((entry) => entry.name === ".git"),
  );

  const hidden = await fetch(
    `${web.origin}/api/operator/tasks/${taskId}/preview?scope=repository&repositoryId=source-1&path=ignored.log`,
    { headers: { cookie: credentials.cookie } },
  );
  const hiddenBody = (await hidden.json()) as {
    data: { state: string; preview?: unknown };
  };
  assert.equal(hiddenBody.data.state, "ignored");
  assert.equal(hiddenBody.data.preview, undefined);

  const revealed = await fetch(
    `${web.origin}/api/operator/tasks/${taskId}/preview?scope=repository&repositoryId=source-1&path=ignored.log&showIgnored=true`,
    { headers: { cookie: credentials.cookie } },
  );
  const revealedBody = (await revealed.json()) as {
    data: { state: string; preview?: { kind: string; text?: string } };
  };
  assert.equal(revealedBody.data.state, "ready");
  assert.equal(revealedBody.data.preview?.text, "ignored fixture text");

  const excludedGit = await fetch(
    `${web.origin}/api/operator/tasks/${taskId}/preview?scope=repository&repositoryId=source-1&path=.git/HEAD&showIgnored=true`,
    { headers: { cookie: credentials.cookie } },
  );
  assert.equal(
    ((await excludedGit.json()) as { data: { state: string } }).data.state,
    "excluded",
  );
});

test("authenticated HTTP reads discard entries when the task binding changes during an awaited lookup", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Changing binding");
  const binding = await f.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  writeFileSync(
    join(binding.path, "private-to-stale-read.txt"),
    "do not return",
  );
  const web = await f.startWeb();
  const credentials = await login(web);
  const original = f.service.taskWorkspace.bind(f.service);
  t.after(() => {
    f.service.taskWorkspace = original;
  });
  let calls = 0;
  f.service.taskWorkspace = async (taskId) => {
    const current = await original(taskId);
    calls++;
    return calls === 2 && current
      ? { ...current, workspaceId: randomUUID() }
      : current;
  };
  const response = await fetch(
    `${web.origin}/api/operator/tasks/${task.taskId}/files?scope=workspace`,
    { headers: { cookie: credentials.cookie } },
  );
  const text = await response.text();
  const body = JSON.parse(text) as {
    data: { state: string; entries: unknown[] };
  };
  assert.equal(response.status, 200);
  assert.equal(body.data.state, "conflict");
  assert.deepEqual(body.data.entries, []);
  assert.ok(!text.includes("do not return"));
  f.service.taskWorkspace = original;
});
