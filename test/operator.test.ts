import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { StandaloneService } from "../src/standalone/service.js";

function renderedForm(html: string, type: string): string {
  const opening = `<form method="post" action="/command" data-command="${type}">`;
  const start = html.indexOf(opening);
  assert.notEqual(start, -1, `Missing ${type} form`);
  const end = html.indexOf("</form>", start);
  assert.notEqual(end, -1);
  return html.slice(start, end);
}

function formValue(html: string, name: string): string {
  const value = html.match(
    new RegExp(`name="${name}"[^>]*value="([^"]*)"`),
  )?.[1];
  assert.ok(value, `Missing ${name} value`);
  return value;
}

function fakeRuntime() {
  return {
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
  };
}

test("local forms submit versioned commands and render secret-safe views", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const ui = new LocalOperatorUi(domain);
    assert.match(ui.home(), /project.create/);
    const profile = (await ui.submit({
      type: "profile.create",
      name: "<Builder>",
      instructions: "Code",
      capabilities: "TypeScript",
    })) as { id: string };
    const project = (await ui.submit({
      type: "project.create",
      name: "Sample",
      leadProfileId: profile.id,
    })) as { id: string; paused: number };
    assert.equal(project.paused, 1);
    const task = (await ui.submit({
      type: "task.create",
      projectId: project.id,
      title: "First",
      outcome: "Ship",
    })) as { id: string; ready: number };
    assert.equal(task.ready, 0);
    assert.match(ui.home(), /&lt;Builder&gt;/);
    assert.doesNotMatch(ui.home(), /<Builder>/);
    await ui.submit({
      type: "routing.configure",
      projectId: project.id,
      expectedVersion: "1",
      enabled: "1",
      guidance: "Find a coder",
      credentialRef: "env:TYPESAFE_KEY",
      candidateProfileIds: JSON.stringify([profile.id]),
    });
    const html = ui.project(project.id);
    assert.match(html, /credential reference configured/);
    assert.doesNotMatch(html, /TYPESAFE_KEY/);
    assert.match(html, /task.create/);
    assert.match(
      ui.task(task.id),
      /Configuration eligibility only: held: project-paused, task-unready\./,
    );
    await ui.submit({
      type: "project.configure",
      projectId: project.id,
      expectedVersion: "1",
      name: "Sample",
      instructions: "Instructions",
      paused: "",
    });
    await ui.submit({
      type: "task.configure",
      projectId: project.id,
      taskId: task.id,
      expectedVersion: "1",
      title: "First",
      outcome: "Ship",
      ready: "1",
    });
    assert.ok(
      /eligible for future admission/i.test(ui.task(task.id)),
      "eligible means configuration eligibility only",
    );
    const assignment = (await ui.submit({
      type: "assignment.create",
      projectId: project.id,
      taskId: task.id,
      profileId: profile.id,
      brief: "Build",
      resultDestination: "lead:task",
    })) as { id: string };
    assert.doesNotMatch(ui.task(task.id), new RegExp(assignment.id));
    assert.match(ui.task(task.id), /eligibility only/i);
    assert.match(
      ui.assignment(assignment.id),
      /does not confirm runtime admission or execution/i,
    );
    assert.ok(
      ui
        .assignment(assignment.id)
        .includes(`/runtime/assignment/${assignment.id}`),
    );
    assert.ok(
      ui
        .assignment(assignment.id)
        .includes(`/coordination/assignment/${assignment.id}`),
    );
  } finally {
    db.close();
  }
});

test("rendered form retries replay one receipt and retain create IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-form-retry-"));
  chmodSync(directory, 0o700);
  const authFile = join(directory, "operator-auth.json");
  const service = new StandaloneService(directory, fakeRuntime);
  let http: LocalOperatorHttp | undefined;
  let auth: OperatorAuth | undefined;
  try {
    await service.start();
    const domain = service.domain();
    const portServer = createServer();
    await new Promise<void>((resolve) =>
      portServer.listen(0, "127.0.0.1", resolve),
    );
    const port = (portServer.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      portServer.close((error) => (error ? reject(error) : resolve())),
    );
    const base = `http://127.0.0.1:${port}`;
    const password = "retry form operator password";
    await OperatorAuth.initialize(authFile, password);
    auth = await OperatorAuth.open({ authFile, origin: base });
    http = new LocalOperatorHttp(new LocalOperatorUi(domain), auth);
    await http.start(port);
    const loginPage = await fetch(`${base}/login`);
    const cookie = loginPage.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const loginHtml = await loginPage.text();
    const loginToken = formValue(loginHtml, "csrfToken");
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: {
        cookie,
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password, csrfToken: loginToken }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const authenticatedCookie = login.headers
      .get("set-cookie")
      ?.split(";", 1)[0];
    assert.ok(authenticatedCookie);
    const page = async (path: string) =>
      fetch(`${base}${path}`, {
        headers: { cookie: authenticatedCookie },
      }).then((response) => response.text());
    const home = await page("/");
    const csrfToken = formValue(
      renderedForm(home, "project.create"),
      "csrfToken",
    );
    const post = async (fields: Record<string, string>) =>
      fetch(`${base}/command`, {
        method: "POST",
        headers: {
          cookie: authenticatedCookie,
          origin: base,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ ...fields, csrfToken }),
        redirect: "manual",
      });

    const profileForm = renderedForm(await page("/"), "profile.create");
    const profileId = formValue(profileForm, "profileId");
    const profile = {
      type: "profile.create",
      key: formValue(profileForm, "key"),
      profileId,
      name: "Lead",
      instructions: "Own",
      capabilities: "coordinate",
    };
    assert.equal((await post(profile)).status, 303);
    assert.equal((await post(profile)).status, 303);
    assert.equal(domain.profiles().length, 1);

    const projectForm = renderedForm(await page("/"), "project.create");
    const projectId = formValue(projectForm, "projectId");
    const project = {
      type: "project.create",
      key: formValue(projectForm, "key"),
      projectId,
      name: "Retry project",
      leadProfileId: profileId,
    };
    assert.equal((await post(project)).status, 303);
    assert.equal((await post(project)).status, 303);
    assert.equal(domain.projects().length, 1);
    assert.equal(domain.project(projectId).id, projectId);
    const conflictingReplay = await post({ ...project, name: "Changed" });
    assert.equal(conflictingReplay.status, 409);
    assert.match(
      await conflictingReplay.text(),
      /reload.*review before retrying/i,
    );
    assert.equal(domain.projects().length, 1);
    assert.notEqual(
      formValue(renderedForm(await page("/"), "project.create"), "key"),
      project.key,
    );

    const taskForm = renderedForm(
      await page(`/project/${projectId}`),
      "task.create",
    );
    const taskId = formValue(taskForm, "taskId");
    const task = {
      type: "task.create",
      key: formValue(taskForm, "key"),
      projectId,
      taskId,
      title: "First",
      outcome: "Ship",
    };
    assert.equal((await post(task)).status, 303);
    assert.equal((await post(task)).status, 303);
    assert.equal(domain.tasks(projectId).length, 1);

    const taskHtml = await page(`/task/${taskId}`);
    assert.ok(
      /Readiness and configuration eligibility do not confirm runtime admission or execution\./.test(
        taskHtml,
      ),
      "task view distinguishes configuration from execution status",
    );
    assert.ok(
      !/data-command="(?:assignment|dependency|imported-blockers)/.test(
        taskHtml,
      ),
      "task page omits deferred action forms",
    );
    assert.equal(
      (
        await post({
          type: "assignment.create",
          key: "unauthorized-assignment",
          projectId,
          taskId,
          profileId,
          brief: "Build",
          resultDestination: "lead:task",
        })
      ).status,
      400,
    );
    assert.equal(domain.assignments(taskId).length, 0);

    const configureForm = renderedForm(
      await page(`/project/${projectId}`),
      "project.configure",
    );
    const configure = {
      type: "project.configure",
      key: formValue(configureForm, "key"),
      projectId,
      expectedVersion: formValue(configureForm, "expectedVersion"),
      name: "Renamed",
    };
    assert.equal((await post(configure)).status, 303);
    assert.equal((await post(configure)).status, 303);
    assert.equal(domain.project(projectId).version, 2);
    assert.equal((await post({ ...configure, name: "Changed" })).status, 409);
  } finally {
    await http?.stop();
    auth?.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("draft project stays held until an active lead is selected in its form", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const ui = new LocalOperatorUi(domain);
    const draft = (await ui.submit({
      type: "project.create",
      name: "Draft",
    })) as { id: string };
    const task = (await ui.submit({
      type: "task.create",
      projectId: draft.id,
      title: "Ready work",
      outcome: "Ship",
      ready: "1",
    })) as { id: string };
    await ui.submit({
      type: "project.configure",
      projectId: draft.id,
      expectedVersion: "1",
      name: "Draft",
      paused: "",
    });
    assert.deepEqual(domain.admission(task.id).reasons, [
      "project-lead-unconfigured",
    ]);
    assert.match(ui.project(draft.id), /name="leadProfileId"/);
    const lead = (await ui.submit({
      type: "profile.create",
      name: "Lead",
      instructions: "Own outcomes",
      capabilities: "coordinate",
    })) as { id: string };
    await ui.submit({
      type: "project.configure",
      projectId: draft.id,
      expectedVersion: "2",
      name: "Draft",
      leadProfileId: lead.id,
      paused: "",
    });
    assert.deepEqual(domain.admission(task.id), {
      eligible: true,
      reasons: [],
    });
    await ui.submit({
      type: "profile.configure",
      profileId: lead.id,
      expectedVersion: "1",
      name: "Lead",
      instructions: "Own outcomes",
      capabilities: "coordinate",
      revoked: "1",
    });
    assert.deepEqual(domain.admission(task.id).reasons, [
      "project-lead-revoked",
    ]);
    const replacement = (await ui.submit({
      type: "profile.create",
      name: "Replacement",
      instructions: "Own outcomes",
      capabilities: "coordinate",
    })) as { id: string };
    await ui.submit({
      type: "project.configure",
      projectId: draft.id,
      expectedVersion: "3",
      name: "Draft",
      leadProfileId: replacement.id,
      paused: "",
    });
    assert.deepEqual(domain.admission(task.id), {
      eligible: true,
      reasons: [],
    });
  } finally {
    db.close();
  }
});

test("standalone startup migrates and exposes the same local operator boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-operator-service-"));
  const service = new StandaloneService(directory, fakeRuntime);
  try {
    await service.start();
    const ui = new LocalOperatorUi(service.domain());
    const project = (await ui.submit({
      type: "project.create",
      name: "Persistent",
    })) as { id: string };
    await service.stop();
    const restarted = new StandaloneService(directory, fakeRuntime);
    try {
      await restarted.start();
      assert.match(
        new LocalOperatorUi(restarted.domain()).project(project.id),
        /Persistent/,
      );
    } finally {
      await restarted.stop();
    }
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
