import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { GitHubSourceStore } from "../src/core/github-source.js";
import { Store } from "../src/core/store.js";
import { LocalOperatorUi } from "../src/standalone/operator.js";
import type { IssueSnapshot } from "../src/standalone/github-source.js";

const issue: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Imported issue",
  body: "Ship this",
  state: "open",
  labels: ["ready"],
  projectFields: [
    { projectNodeId: "P_1", fieldNodeId: "F_1", optionNodeId: "O_1" },
  ],
};

test("overlapping complete selections converge on one imported task; partial reads retain memberships", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-reconcile-"));
  const file = join(root, "db.sqlite");
  const projectId = randomUUID();
  let db = new DatabaseSync(file);
  try {
    new Store(db).ensureHost("test");
    let domain = new DomainStore(db);
    domain.migrate();
    let sources = new GitHubSourceStore(db);
    sources.migrate();
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
      credentialRef: "env:TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "org",
          name: "repo",
        },
        { id: "search", kind: "search", query: "repo:org/repo" },
        {
          id: "project",
          kind: "project",
          projectNodeId: "P_1",
          filter: "status:ready",
        },
      ],
      readiness: {
        mode: "all",
        conditions: [
          { kind: "label", name: "ready" },
          {
            kind: "project-field",
            projectNodeId: "P_1",
            fieldNodeId: "F_1",
            optionNodeId: "O_1",
          },
        ],
      },
      repositories: [],
    });
    for (const selectionId of ["repo", "search", "project"])
      domain.execute({
        type: "github.activate",
        actor: "operator",
        key: randomUUID(),
        projectId,
        selectionId,
        expectedVersion: 2,
      });
    for (const selectionId of ["repo", "search", "project"])
      sources.reconcileSelection(projectId, selectionId, {
        complete: true,
        issues: [issue],
        reason: null,
      });
    const imported = sources.issue("I_1");
    assert.equal(imported?.providerInstance, "github.com");
    assert.deepEqual(
      sources.memberships("I_1").map((membership) => membership.selectionId),
      ["project", "repo", "search"],
    );
    assert.equal(domain.tasks(projectId).length, 1);
    assert.equal(domain.tasks(projectId)[0]?.ready, 1);
    const importedVersion = Number(
      domain.task(String(imported?.taskId)).version,
    );
    assert.throws(
      () =>
        domain.execute({
          type: "task.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          taskId: String(imported?.taskId),
          expectedVersion: importedVersion,
          ready: false,
        }),
      /imported.*provider/i,
    );
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, state: "closed" }],
      reason: null,
    });
    assert.equal(domain.task(String(imported?.taskId)).ready, 0);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, labels: [] }],
      reason: null,
    });
    assert.equal(domain.task(String(imported?.taskId)).ready, 0);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    assert.equal(domain.task(String(imported?.taskId)).ready, 1);
    sources.reconcileSelection(projectId, "repo", {
      complete: false,
      issues: [],
      reason: "http-403",
    });
    assert.equal(sources.memberships("I_1").length, 3);
    assert.equal(sources.syncState(projectId, "repo")?.complete, 0);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [],
      reason: null,
    });
    assert.equal(sources.memberships("I_1").length, 2);
    const localId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local",
      outcome: "Keep local",
      ready: true,
    });
    sources.reconcileSelection(projectId, "search", {
      complete: true,
      issues: [],
      reason: null,
    });
    sources.reconcileSelection(projectId, "project", {
      complete: true,
      issues: [],
      reason: null,
    });
    assert.equal(sources.memberships("I_1").length, 0);
    assert.equal(domain.task(String(imported?.taskId)).ready, 0);
    assert.equal(domain.task(localId).ready, 1);
    db.close();
    db = new DatabaseSync(file);
    new Store(db).ensureHost("test");
    domain = new DomainStore(db);
    domain.migrate();
    sources = new GitHubSourceStore(db);
    sources.migrate();
    assert.equal(sources.issue("I_1")?.taskId, imported?.taskId);
    assert.equal(domain.tasks(projectId).length, 2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unowned cross-project overlap waits for operator placement; assigned task keeps its chosen project", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-placement-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const first = randomUUID();
  const second = randomUUID();
  const profileId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    domain.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: "Lead",
      instructions: "Lead",
      capabilities: "work",
    });
    for (const projectId of [first, second]) {
      domain.execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId,
        name: projectId,
        leadProfileId: profileId,
      });
      domain.execute({
        type: "github.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: 1,
        credentialRef: "env:TEST_GITHUB",
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
          conditions: [
            {
              kind: "label",
              name: projectId === first ? "ready" : "approved-for-second",
            },
          ],
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
        issues: [issue],
        reason: null,
      });
    }
    const taskId = String(sources.issue("I_1")?.taskId);
    assert.equal(domain.tasks(first).length, 1);
    assert.equal(domain.tasks(second).length, 0);
    assert.equal(sources.conflicts().length, 1);
    assert.ok(
      domain.admission(taskId).reasons.includes("source-placement-conflict"),
    );
    const version = Number(domain.task(taskId).version);
    assert.throws(
      () =>
        domain.execute({
          type: "github.place",
          actor: "agent",
          key: randomUUID(),
          projectId: first,
          taskId,
          chosenProjectId: second,
          expectedVersion: version,
        }),
      /operator/i,
    );
    const ui = new LocalOperatorUi(domain, undefined, sources);
    const html = ui.project(first, "test-csrf");
    assert.match(html, /data-command="github.place"/);
    assert.match(html, new RegExp(`name="taskId"[^>]*value="${taskId}"`));
    assert.match(html, /name="chosenProjectId"/);
    await ui.submit({
      type: "github.place",
      key: randomUUID(),
      projectId: first,
      taskId,
      chosenProjectId: second,
      expectedVersion: String(version),
    });
    await assert.rejects(
      () =>
        ui.submit({
          type: "github.place",
          key: randomUUID(),
          projectId: first,
          taskId,
          chosenProjectId: second,
          expectedVersion: String(version),
        }),
      /project|version/i,
    );
    assert.equal(sources.conflicts().length, 0);
    assert.equal(domain.tasks(second).length, 1);
    assert.equal(domain.task(taskId).ready, 0);
    assert.equal(domain.admission(taskId).eligible, false);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: second,
      expectedVersion: 2,
      credentialRef: "env:TEST_GITHUB",
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
      projectId: second,
      expectedVersion: 3,
      selectionId: "repo",
    });
    sources.reconcileSelection(second, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    domain.execute({
      type: "assignment.create",
      actor: "agent",
      key: randomUUID(),
      projectId: second,
      taskId,
      assignmentId: randomUUID(),
      profileId,
      brief: "Work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.throws(
      () =>
        domain.execute({
          type: "github.place",
          actor: "operator",
          key: randomUUID(),
          projectId: second,
          taskId,
          chosenProjectId: first,
          expectedVersion: Number(domain.task(taskId).version),
        }),
      /assigned imported task/i,
    );
    sources.reconcileSelection(first, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    assert.equal(sources.conflicts().length, 0);
    assert.equal(String(domain.task(taskId).projectId), second);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
