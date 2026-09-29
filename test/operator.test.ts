import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
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
    assert.match(html, /credential configured/);
    assert.doesNotMatch(html, /TYPESAFE_KEY/);
    assert.match(html, /task.create/);
    assert.match(ui.task(task.id), /Held: project-paused, task-unready/);
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
    assert.match(ui.task(task.id), /Eligible/);
    const assignment = (await ui.submit({
      type: "assignment.create",
      projectId: project.id,
      taskId: task.id,
      profileId: profile.id,
      brief: "Build",
      resultDestination: "lead:task",
    })) as { id: string };
    assert.match(ui.task(task.id), new RegExp(assignment.id));
  } finally {
    db.close();
  }
});

test("loopback HTTP serves and accepts local operator forms", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const http = new LocalOperatorHttp(new LocalOperatorUi(domain));
  try {
    const port = await http.start();
    const base = `http://127.0.0.1:${port}`;
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<form method="post" action="\/command"/);
    const created = await fetch(`${base}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body: new URLSearchParams({
        type: "project.create",
        name: "Web project",
      }),
      redirect: "manual",
    });
    assert.equal(created.status, 303);
    assert.match(await (await fetch(base)).text(), /Web project/);
    const refused = await fetch(`${base}/command`, {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
      body: new URLSearchParams({ type: "project.create", name: "Unwanted" }),
    });
    assert.equal(refused.status, 403);
  } finally {
    await http.stop();
    db.close();
  }
});

test("rendered form retries replay one receipt and retain create IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-form-retry-"));
  const service = new StandaloneService(directory, fakeRuntime);
  let http: LocalOperatorHttp | undefined;
  try {
    await service.start();
    const domain = service.domain();
    http = new LocalOperatorHttp(new LocalOperatorUi(domain));
    const base = `http://127.0.0.1:${await http.start()}`;
    const page = async (path: string) => (await fetch(`${base}${path}`)).text();
    const post = async (fields: Record<string, string>) =>
      fetch(`${base}/command`, {
        method: "POST",
        headers: { origin: base },
        body: new URLSearchParams(fields),
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
    assert.equal((await post({ ...project, name: "Changed" })).status, 400);
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

    const assignmentForm = renderedForm(
      await page(`/task/${taskId}`),
      "assignment.create",
    );
    const assignmentId = formValue(assignmentForm, "assignmentId");
    const assignment = {
      type: "assignment.create",
      key: formValue(assignmentForm, "key"),
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Build",
      resultDestination: "lead:task",
    };
    assert.equal((await post(assignment)).status, 303);
    assert.equal((await post(assignment)).status, 303);
    assert.equal(domain.assignments(taskId).length, 1);

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
    assert.equal((await post({ ...configure, name: "Changed" })).status, 400);
  } finally {
    await http?.stop();
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
