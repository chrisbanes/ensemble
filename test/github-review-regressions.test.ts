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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore, type DomainCommand } from "../src/core/domain.js";
import {
  GitHubSourceStore,
  type GitHubSelection,
  type IssueSnapshot,
} from "../src/core/github-source.js";
import { Store } from "../src/core/store.js";
import { StandaloneService } from "../src/standalone/service.js";
import type { Runtime } from "../src/standalone/codex.js";
import type { GitHubSourceReader } from "../src/standalone/github-source.js";

const issue: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Imported",
  body: "Ship",
  state: "open",
  labels: ["ready"],
  projectFields: [],
};
const repo: GitHubSelection = {
  id: "repo",
  kind: "repository",
  repositoryId: "R_1",
  owner: "org",
  name: "repo",
};
const search: GitHubSelection = {
  id: "search",
  kind: "search",
  query: "repo:org/repo",
};
type Configuration = Extract<DomainCommand, { type: "github.configure" }>;

function configuration(
  domain: DomainStore,
  projectId: string,
  selections = [repo, search],
): Configuration {
  return {
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: domain.githubConfiguration(projectId).version,
    credentialRef: "env:TEST_GITHUB",
    selections,
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  };
}

function project(domain: DomainStore) {
  const projectId = randomUUID(),
    profileId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Alpha",
    leadProfileId: profileId,
  });
  return { projectId, profileId };
}

function activate(domain: DomainStore, projectId: string, selectionId: string) {
  domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId,
    expectedVersion: domain.githubConfiguration(projectId).version,
  });
}

function observe(
  sources: GitHubSourceStore,
  projectId: string,
  selectionId: string,
) {
  sources.reconcileSelection(projectId, selectionId, {
    complete: true,
    issues: [issue],
    reason: null,
  });
  sources.reconcileBlockers(issue.nodeId, {
    complete: true,
    blockers: [],
    reason: null,
  });
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  return { db, domain, sources, ...project(domain) };
}

test("persisted GitHub repository bindings and Project field arrays are validated before use", () => {
  const { db, domain, sources, projectId } = fixture();
  try {
    db.prepare(
      "UPDATE project_github_sources SET repositories = ? WHERE projectId = ?",
    ).run(
      '[{"repositoryId":7,"path":false,"ref":null,"gitCommonDirectory":[]}]',
      projectId,
    );
    assert.throws(() => domain.githubConfiguration(projectId), /Invalid input/);
    db.prepare(
      "UPDATE project_github_sources SET repositories = '[]' WHERE projectId = ?",
    ).run(projectId);
    domain.execute({
      ...configuration(domain, projectId, [repo]),
      readiness: {
        mode: "all",
        conditions: [
          {
            kind: "project-field",
            projectNodeId: "P",
            fieldNodeId: "F",
            optionNodeId: "O",
          },
        ],
      },
    });
    activate(domain, projectId, repo.id);
    observe(sources, projectId, repo.id);
    const taskId = String(sources.issue(issue.nodeId)?.taskId);
    assert.equal(domain.task(taskId).ready, 0);
    for (const fields of [
      { projectNodeId: "P", fieldNodeId: "F", optionNodeId: "O" },
      [{ projectNodeId: "P", fieldNodeId: "F", optionNodeId: 7 }],
    ]) {
      db.prepare(
        "UPDATE github_memberships SET projectFields = ? WHERE nodeId = ?",
      ).run(JSON.stringify(fields), issue.nodeId);
      assert.throws(() => sources.updateReadiness(taskId), /Invalid input/);
      assert.equal(domain.task(taskId).ready, 0);
    }
    db.prepare(
      "UPDATE github_memberships SET projectFields = ? WHERE nodeId = ?",
    ).run(
      JSON.stringify([
        { projectNodeId: "P", fieldNodeId: "F", optionNodeId: "O" },
      ]),
      issue.nodeId,
    );
    sources.updateReadiness(taskId);
    assert.equal(domain.task(taskId).ready, 1);
  } finally {
    db.close();
  }
});

test("removing one overlapping selection retires its membership and preserves remaining eligibility", () => {
  const { db, domain, sources, projectId } = fixture();
  try {
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    domain.execute(configuration(domain, projectId));
    for (const selection of [repo, search]) {
      activate(domain, projectId, selection.id);
      observe(sources, projectId, selection.id);
    }
    const taskId = String(sources.issue(issue.nodeId)?.taskId);
    assert.equal(domain.admission(taskId).eligible, true);
    domain.execute(configuration(domain, projectId, [repo]));
    assert.equal(domain.admission(taskId).eligible, false);
    assert.deepEqual(
      sources.memberships(issue.nodeId).map((member) => member.selectionId),
      [repo.id],
    );
    assert.equal(sources.syncState(projectId, search.id), undefined);
    activate(domain, projectId, repo.id);
    observe(sources, projectId, repo.id);
    assert.deepEqual(domain.admission(taskId), { eligible: true, reasons: [] });
    assert.equal(domain.tasks(projectId).length, 1);
    assert.equal(sources.issue(issue.nodeId)?.taskId, taskId);
    // Reconcile obsolete rows left by a previously removed configuration too.
    db.prepare(
      "INSERT INTO github_memberships (projectId, selectionId, nodeId, projectFields) VALUES (?, 'retired', ?, '[]')",
    ).run(projectId, issue.nodeId);
    assert.ok(domain.admission(taskId).reasons.includes("source-unknown"));
    domain.execute(configuration(domain, projectId, [repo]));
    activate(domain, projectId, repo.id);
    observe(sources, projectId, repo.id);
    assert.deepEqual(
      sources.memberships(issue.nodeId).map((member) => member.selectionId),
      [repo.id],
    );
    assert.equal(domain.admission(taskId).eligible, true);
    domain.execute(configuration(domain, projectId, []));
    assert.deepEqual(sources.memberships(issue.nodeId), []);
    assert.equal(domain.task(taskId).ready, 0);
    assert.equal(sources.hold(issue.nodeId)?.reason, "withdrawn");
    assert.equal(domain.tasks(projectId).length, 1);
  } finally {
    db.close();
  }
});

for (const revoke of [false, true])
  test(
    revoke
      ? "a removed repository grant blocks new turns in a retained imported workspace"
      : "a current repository grant permits a new turn in an imported workspace",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "ensemble-github-revocation-")),
      );
      const path = join(root, "repo");
      mkdirSync(path);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      writeFileSync(join(path, "README.md"), "fixture");
      git("add", "README.md");
      git("commit", "-m", "fixture");
      let turns = 0;
      let release!: () => void;
      const terminal = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reader: GitHubSourceReader = {
        async readSelection() {
          return { complete: true, issues: [issue], reason: null };
        },
        async readBlockers() {
          return { complete: true, blockers: [], reason: null };
        },
        async readIssueStatus() {
          return { status: "open" };
        },
      };
      const runtime = (): Runtime => ({
        async start() {},
        async stop() {},
        onUnexpectedRequest() {},
        async startThread() {
          return "thread";
        },
        async resumeThread() {},
        async startTurn() {
          turns++;
          return "turn";
        },
        async interruptTurn() {},
        async waitForTurn() {
          await terminal;
          return "completed";
        },
      });
      const service = new StandaloneService(
        join(root, "data"),
        runtime,
        undefined,
        {
          github: { readerFactory: () => reader, intervalMs: 60_000 },
          power: { enabled: false },
        },
      );
      try {
        await service.start();
        const domain = service.domain();
        const { projectId, profileId } = project(domain);
        await domain.configureGitHub({
          ...configuration(domain, projectId, [repo]),
          repositories: [{ repositoryId: "R_1", path, ref: "main" }],
        });
        activate(domain, projectId, repo.id);
        await service.refreshGitHub();
        const taskId = String(
          service.githubSources().issue(issue.nodeId)?.taskId,
        );
        const workspace = await service.provisionTask(taskId, [
          { repositoryId: "R_1", path, ref: "main" },
        ]);
        if (revoke) {
          domain.execute(configuration(domain, projectId, [repo]));
          activate(domain, projectId, repo.id);
          await service.refreshGitHub();
        }
        domain.execute({
          type: "project.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          expectedVersion: 1,
          paused: false,
        });
        const assignmentId = randomUUID();
        domain.execute({
          type: "assignment.create",
          actor: "operator",
          key: randomUUID(),
          projectId,
          taskId,
          assignmentId,
          profileId,
          brief: "New work",
          resultDestination: "lead",
          requesterAssignmentId: null,
        });
        await service.refreshGitHub();
        const expectedReadiness = () =>
          revoke
            ? service
                .list()
                .some((intent) =>
                  intent.reason?.includes("repository-access-revoked"),
                )
            : turns > 0;
        const readinessDeadline = Date.now() + (revoke ? 5_000 : 15_000);
        while (!expectedReadiness() && Date.now() < readinessDeadline)
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        assert.equal(turns, revoke ? 0 : 1);
        if (revoke)
          assert.ok(
            service
              .list()
              .some((intent) =>
                intent.reason?.includes("repository-access-revoked"),
              ),
          );
        assert.equal(
          domain.githubConfiguration(projectId).repositories.length,
          revoke ? 0 : 1,
        );
        assert.equal(
          (await service.taskWorkspace(taskId))?.workspaceId,
          workspace.workspaceId,
        );
        assert.equal(
          (await service.taskWorkspace(taskId))?.repositories.length,
          1,
        );
      } finally {
        release();
        await service.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
