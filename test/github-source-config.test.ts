import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { DomainStore } from "../src/core/domain.js";
import { GitHubSourceStore } from "../src/core/github-source.js";
import { Store } from "../src/core/store.js";
import { StandaloneService } from "../src/standalone/service.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import type { GitHubSourceReader } from "../src/standalone/github-source.js";

test("operator-owned GitHub configuration survives restart and rejects stale or agent changes", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-config-"));
  const file = join(root, "service.sqlite");
  const projectId = randomUUID();
  let db = new DatabaseSync(file);
  let domain = new DomainStore(db);
  try {
    new Store(db).ensureHost("test");
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    const command = {
      type: "github.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:ENSEMBLE_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository" as const,
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
        {
          id: "search",
          kind: "search" as const,
          query: "repo:org/repo label:ready",
        },
        {
          id: "project",
          kind: "project" as const,
          projectNodeId: "P_1",
          filter: "status:ready",
        },
      ],
      readiness: {
        mode: "all" as const,
        conditions: [
          { kind: "label" as const, name: "ready" },
          {
            kind: "project-field" as const,
            projectNodeId: "P_1",
            fieldNodeId: "F_1",
            optionNodeId: "O_1",
          },
        ],
      },
      repositories: [],
    };
    const receipt = domain.execute(command);
    assert.deepEqual(domain.execute(command), receipt);
    assert.throws(
      () => domain.execute({ ...command, key: randomUUID() }),
      /Version conflict/,
    );
    assert.throws(
      () =>
        domain.execute({
          ...command,
          key: randomUUID(),
          actor: "agent",
          expectedVersion: 2,
        }),
      /operator/i,
    );
    db.close();
    db = new DatabaseSync(file);
    domain = new DomainStore(db);
    new Store(db).ensureHost("test");
    domain.migrate();
    const config = domain.githubConfiguration(projectId);
    assert.equal(config.version, 2);
    assert.deepEqual(config.selections, command.selections);
    assert.deepEqual(config.readiness, command.readiness);
    assert.equal(config.credentialRef, "env:ENSEMBLE_TEST_GITHUB");
    assert.doesNotMatch(JSON.stringify(config), /secret-value/);
    const html = new LocalOperatorUi(domain).project(projectId);
    assert.match(html, /data-command="github\.configure"/);
    assert.match(html, /status:ready/);
    assert.doesNotMatch(html, /env:ENSEMBLE_TEST_GITHUB|secret-value/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version-matched successful source preview activates only that selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-preview-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:ENSEMBLE_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    let previewComplete = true;
    const reader = {
      async previewSelection() {
        return previewComplete
          ? ({ complete: true, issues: [], reason: null } as const)
          : ({ complete: false, issues: [], reason: "http-403" } as const);
      },
    } as Pick<GitHubSourceReader, "previewSelection">;
    const ui = new LocalOperatorUi(domain, () => reader);
    const fields = {
      type: "github.preview",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: "2",
    };
    await ui.submit(fields);
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), ["repo"]);
    assert.deepEqual(await ui.submit(fields), await ui.submit(fields));
    await assert.rejects(
      ui.submit({ ...fields, key: randomUUID(), expectedVersion: "1" }),
      /Version conflict/,
    );
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      credentialRef: "env:ENSEMBLE_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
    previewComplete = false;
    await assert.rejects(
      ui.submit({ ...fields, key: randomUUID(), expectedVersion: "3" }),
      /preview incomplete/,
    );
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator pages distinguish GitHub sync, provenance and source holds while escaping provider text", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-ui-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:ENSEMBLE_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_1",
          repositoryId: "R_1",
          repositoryName: "org/repo",
          number: 1,
          title: "<img src=x onerror=alert(1)>",
          body: "<script>alert(2)</script>",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
      reason: null,
    });
    const taskId = String(sources.issue("I_1")?.taskId);
    const localId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Independent local task",
      outcome: "Local",
      ready: false,
    });
    sources.reconcileBlockers("I_1", {
      complete: false,
      blockers: [],
      reason: "http-403",
    });
    const ui = new LocalOperatorUi(domain, undefined, sources);
    const project = ui.project(projectId);
    const task = ui.task(taskId);
    assert.match(project, /repo.*complete/i);
    assert.match(project, /Independent local task/);
    assert.match(task, /github\.com|org\/repo/);
    assert.match(task, /imported-blockers-unknown/);
    assert.match(task, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(project + task, /<script>|<img src=x/);
    assert.doesNotMatch(project + task, /ENSEMBLE_TEST_GITHUB|fixture-token/);
    sources.reconcileSelection(projectId, "repo", {
      complete: false,
      issues: [],
      reason: "http-403",
    });
    assert.match(ui.project(projectId), /repo.*partial: http-403/i);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub source pages and refresh inherit authenticated origin and CSRF guards", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-http-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  let http: LocalOperatorHttp | undefined;
  let auth: OperatorAuth | undefined;
  let browser: Browser | undefined;
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:ENSEMBLE_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I_1",
          repositoryId: "R_1",
          repositoryName: "org/repo",
          number: 1,
          title: "<img src=x>",
          body: "Observed body",
          state: "open",
          labels: ["ready"],
          projectFields: [],
        },
      ],
      reason: null,
    });
    const taskId = String(sources.issue("I_1")?.taskId);
    let refreshes = 0;
    const ui = new LocalOperatorUi(domain, undefined, sources, async () => {
      refreshes++;
    });
    const portServer = createServer();
    await new Promise<void>((resolve) =>
      portServer.listen(0, "127.0.0.1", resolve),
    );
    const port = (portServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const password = "test operator password";
    await OperatorAuth.initialize(join(root, "auth.json"), password);
    auth = await OperatorAuth.open({
      authFile: join(root, "auth.json"),
      origin,
    });
    http = new LocalOperatorHttp(ui, auth);
    await http.start(port);
    const privatePage = await fetch(`${origin}/project/${projectId}`, {
      redirect: "manual",
    });
    assert.doesNotMatch(
      await privatePage.text(),
      /Alpha|GitHub discovery|github\.refresh/,
    );
    const loginPage = await fetch(`${origin}/login`);
    const anonymousCookie =
      (loginPage.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const loginCsrf = (await loginPage.text()).match(
      /name="csrfToken"[^>]*value="([^"]+)"/,
    )?.[1];
    assert.ok(loginCsrf);
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: {
        origin,
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginCsrf }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const cookie =
      (login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    const projectResponse = await fetch(`${origin}/project/${projectId}`, {
      headers: { cookie },
    });
    assert.equal(projectResponse.status, 200);
    const html = await projectResponse.text();
    const csrfToken = html.match(/name="csrfToken"[^>]*value="([^"]+)"/)?.[1];
    assert.ok(csrfToken);
    assert.match(html, /data-command="github\.refresh"/);
    const fields = new URLSearchParams({
      type: "github.refresh",
      key: randomUUID(),
      projectId,
      csrfToken,
    });
    const post = (headers: Record<string, string>, body: URLSearchParams) =>
      fetch(`${origin}/command`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
        redirect: "manual",
      });
    assert.equal(
      (await post({ origin: "https://elsewhere.example" }, fields)).status,
      403,
    );
    assert.equal(
      (
        await post(
          { origin },
          new URLSearchParams({
            ...Object.fromEntries(fields),
            csrfToken: "wrong",
          }),
        )
      ).status,
      403,
    );
    assert.equal(refreshes, 0);
    assert.equal((await post({ origin }, fields)).status, 303);
    assert.equal(refreshes, 1);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const [cookieName, cookieValue] = cookie.split("=", 2);
    assert.ok(cookieName && cookieValue);
    await context.addCookies([
      { name: cookieName, value: cookieValue, url: origin },
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}/project/${projectId}`);
    assert.match(await page.locator("main").innerText(), /repo.*complete/s);
    await page.goto(`${origin}/task/${taskId}`);
    assert.match(
      await page.locator("main").innerText(),
      /GitHub source|org\/repo/,
    );
    assert.equal(await page.locator("img").count(), 0);
  } finally {
    await browser?.close();
    await http?.stop();
    auth?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing standalone projects acquire inactive source configuration on migration", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-migration-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const projectId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Existing",
      leadProfileId: null,
    });
    db.prepare("DELETE FROM project_github_sources WHERE projectId = ?").run(
      projectId,
    );
    domain.migrate();
    assert.equal(domain.githubConfiguration(projectId).version, 1);
    assert.deepEqual(domain.githubActiveSelectionIds(projectId), []);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("imported task provisioning requires the project's exact linked Git repository", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-provision-")),
  );
  const repository = join(root, "source");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "fixture");
  const service = new StandaloneService(join(root, "data"), () => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed" as const;
    },
  }));
  const projectId = randomUUID();
  const importedId = randomUUID();
  const localId = randomUUID();
  try {
    await service.start();
    const domain = service.domain();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
    });
    for (const { taskId, title } of [
      { taskId: importedId, title: "Imported" },
      { taskId: localId, title: "Local" },
    ])
      domain.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        title,
        outcome: title,
        ready: false,
      });
    domain.markImportedTask(importedId, "I_1", "R_1");
    await assert.rejects(
      service.provisionTask(importedId, [
        { repositoryId: "R_1", path: repository, ref: "main" },
      ]),
      /linked repository/i,
    );
    await assert.rejects(
      service.provisionTask(importedId, [
        { repositoryId: "R_1", path: root, ref: "main" },
      ]),
      /linked repository/i,
    );
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:ENSEMBLE_TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "R_1", path: repository, ref: "main" }],
    });
    await assert.rejects(
      service.provisionTask(importedId, [
        { repositoryId: "R_1", path: repository, ref: "HEAD" },
      ]),
      /linked repository/i,
    );
    const binding = await service.provisionTask(importedId, [
      { repositoryId: "R_1", path: repository, ref: "main" },
    ]);
    assert.equal(binding.state, "ready");
    const local = await service.provisionTask(localId);
    assert.equal(local.state, "ready");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
