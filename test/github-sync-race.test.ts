import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  GitHubSourceReader,
  IssueSnapshot,
} from "../src/standalone/github-source.js";
import type { Runtime } from "../src/standalone/codex.js";

const issue: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Old",
  body: "Old scope",
  state: "open",
  labels: ["ready"],
  projectFields: [],
};
const selection = {
  id: "repo",
  kind: "repository" as const,
  repositoryId: "R_1",
  owner: "org",
  name: "repo",
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
    throw new Error("Paused fixture cannot start a turn");
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
});
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a selection response from the previous configuration cannot commit after same-ID reactivation", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-selection-race-")),
  );
  const projectId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const reader: GitHubSourceReader = {
    async readSelection() {
      reads++;
      if (reads === 1) await gate;
      return { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
    async previewSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
  };
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
      selections: [selection],
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
      expectedVersion: 2,
      selectionId: "repo",
    });
    const refresh = service.refreshGitHub();
    for (let i = 0; i < 100 && reads === 0; i++) await nextTick();
    assert.equal(reads, 1);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      credentialRef: "env:TEST_GITHUB",
      selections: [selection],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "different" }],
      },
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 3,
      selectionId: "repo",
    });
    release();
    await refresh;
    assert.equal(service.githubSources().issue("I_1"), undefined);
    assert.equal(
      service.githubSources().syncState(projectId, "repo"),
      undefined,
    );
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a native blocker response from the previous configuration cannot clear the reconfigured task", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-blocker-race-")),
  );
  const projectId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blockerReads = 0;
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      blockerReads++;
      if (blockerReads === 2) await gate;
      return blockerReads === 1
        ? { complete: false, blockers: [], reason: "http-403" }
        : { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" };
    },
    async previewSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
  };
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
      selections: [selection],
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
      expectedVersion: 2,
      selectionId: "repo",
    });
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    assert.equal(domain.task(taskId).importedBlockers, "unknown");
    const refresh = service.refreshGitHub();
    for (let i = 0; i < 100 && blockerReads < 2; i++) await nextTick();
    assert.equal(blockerReads, 2);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      credentialRef: "env:TEST_GITHUB",
      selections: [selection],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "different" }],
      },
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 3,
      selectionId: "repo",
    });
    release();
    await refresh;
    assert.equal(domain.task(taskId).importedBlockers, "unknown");
    assert.equal(
      service.githubSources().syncState(projectId, "repo")?.complete,
      0,
    );
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retained status response cannot release a local dependent after credential removal", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-status-race-")),
  );
  const projectId = randomUUID();
  const localId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let statusReads = 0;
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      statusReads++;
      if (statusReads === 2) await gate;
      return statusReads === 1
        ? { status: "unknown" as const, reason: "http-403" }
        : { status: "closed" as const };
    },
    async previewSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
  };
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
      selections: [selection],
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
      expectedVersion: 2,
      selectionId: "repo",
    });
    await service.refreshGitHub();
    const importedId = String(service.githubSources().issue("I_1")?.taskId);
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local dependent",
      outcome: "Wait for issue",
      ready: true,
    });
    domain.execute({
      type: "dependency.add",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      blockerTaskId: importedId,
      expectedVersion: 1,
    });
    await service.refreshGitHub();
    assert.equal(statusReads, 1);
    const refresh = service.refreshGitHub();
    for (let i = 0; i < 100 && statusReads < 2; i++) await nextTick();
    assert.equal(statusReads, 2);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      credentialRef: null,
      selections: [selection],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    release();
    await refresh;
    assert.ok(domain.admission(localId).reasons.includes("local-dependency"));
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
