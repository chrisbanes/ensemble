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

test("standalone startup migrates and exposes the same local operator boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-operator-service-"));
  const runtime = () => ({
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
  });
  const service = new StandaloneService(directory, runtime);
  try {
    await service.start();
    const ui = new LocalOperatorUi(service.domain());
    const project = (await ui.submit({
      type: "project.create",
      name: "Persistent",
    })) as { id: string };
    await service.stop();
    const restarted = new StandaloneService(directory, runtime);
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
