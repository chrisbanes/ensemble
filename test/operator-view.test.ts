import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { LocalOperatorUi } from "../src/standalone/operator.js";

function form(html: string, command: string): string {
  const opening = `<form method="post" action="/command" data-command="${command}">`;
  const start = html.indexOf(opening);
  assert.notEqual(start, -1, `missing ${command} form`);
  const end = html.indexOf("</form>", start);
  assert.notEqual(end, -1);
  return html.slice(start, end);
}

test("operator project, profile, routing, and task views render scoped editable forms", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const ui = new LocalOperatorUi(domain);
    const csrfToken = "session-csrf-token";
    const profile = (await ui.submit({
      key: randomUUID(),
      type: "profile.create",
      name: "Private builder profile",
      instructions: "Build with reviewed constraints",
      capabilities: "TypeScript",
    })) as { id: string };
    const project = (await ui.submit({
      key: randomUUID(),
      type: "project.create",
      name: "Private operator project",
      leadProfileId: profile.id,
    })) as { id: string };
    await ui.submit({
      key: randomUUID(),
      type: "routing.configure",
      projectId: project.id,
      expectedVersion: "1",
      enabled: "1",
      guidance: "Use the operator-selected profile",
      credentialRef: "env:ROUTING_SECRET_REF",
      candidateProfileIds: JSON.stringify([profile.id]),
    });
    const task = (await ui.submit({
      key: randomUUID(),
      type: "task.create",
      projectId: project.id,
      title: "Local task title",
      outcome: "Local task outcome",
    })) as { id: string };
    const assignment = (await ui.submit({
      key: randomUUID(),
      type: "assignment.create",
      projectId: project.id,
      taskId: task.id,
      profileId: profile.id,
      brief: "Only a persisted proposal",
      resultDestination: "lead:task",
    })) as { id: string };

    const home = ui.home(csrfToken);
    const projectPage = ui.project(project.id, csrfToken);
    const profilePage = ui.profile(profile.id, csrfToken);
    const taskPage = ui.task(task.id, csrfToken);
    for (const [page, commands] of [
      [home, ["project.create", "profile.create"]],
      [projectPage, ["project.configure", "task.create", "routing.configure"]],
      [profilePage, ["profile.configure"]],
      [taskPage, ["task.configure"]],
    ] as const) {
      for (const command of commands) {
        assert.ok(
          new RegExp(`name="csrfToken"[^>]*value="${csrfToken}"`).test(
            form(page, command),
          ),
          `${command} form contains its CSRF token`,
        );
      }
    }
    assert.ok(/name="credentialRef"/.test(projectPage));
    assert.ok(/name="candidateProfileIds"/.test(projectPage));
    assert.ok(projectPage.includes(profile.id));
    assert.ok(!projectPage.includes("ROUTING_SECRET_REF"));
    assert.ok(taskPage.includes("Local task title"));
    assert.ok(taskPage.includes("Local task outcome"));
    assert.ok(!taskPage.includes(assignment.id));
    assert.ok(
      !/data-command="(?:assignment|dependency|imported-blockers)/.test(
        taskPage,
      ),
    );
    assert.ok(/not presented|unavailable/i.test(taskPage));
    assert.match(ui.assignment(assignment.id), /execution state.*unavailable/i);
    assert.doesNotMatch(ui.assignment(assignment.id), /data-command=/);
    assert.match(ui.runtime(), /Unavailable/i);
    assert.match(ui.coordination(), /Unavailable/i);
  } finally {
    db.close();
  }
});
