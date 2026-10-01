import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../src/standalone/codex.js";
import type {
  GitHubSourceReader,
  IssueSnapshot,
} from "../src/standalone/github-source.js";

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

test("startup invalidates prior clear source/dependency evidence before the first scheduler wake", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-startup-")),
  );
  const data = join(root, "data");
  const projectId = randomUUID();
  const profileId = randomUUID();
  const localId = randomUUID();
  let readsFail = false;
  const startedWorkspaces: string[] = [];
  const reader: GitHubSourceReader = {
    async readSelection() {
      return readsFail
        ? { complete: false, issues: [], reason: "http-403" }
        : { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      return readsFail
        ? { complete: false, blockers: [], reason: "http-403" }
        : { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: readsFail ? "unknown" : "open" };
    },
    async previewSelection() {
      return { complete: true, issues: [issue], reason: null };
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
    async startTurn(_thread, workspace) {
      startedWorkspaces.push(workspace);
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed";
    },
  });
  const options = {
    github: { readerFactory: () => reader, intervalMs: 60_000 },
    power: { enabled: false },
  };
  let service = new StandaloneService(data, runtime, undefined, options);
  try {
    await service.start();
    const domain = service.domain();
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
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local",
      outcome: "Independent local work",
      ready: true,
    });
    await service.refreshGitHub();
    const imported = service.githubSources().issue("I_1");
    const taskId = String(imported?.taskId);
    assert.equal(domain.task(taskId).importedBlockers, "clear");
    const importedWorkspace = await service.provisionTask(taskId);
    await service.provisionTask(localId);
    await service.stop();
    const db = new DatabaseSync(join(data, "standalone.sqlite"));
    new Store(db).ensureHost("standalone-codex");
    const offline = new DomainStore(db);
    offline.migrate();
    offline.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    db.close();
    readsFail = true;
    service = new StandaloneService(data, runtime, undefined, options);
    await service.start();
    assert.ok(
      service.domain().admission(taskId).reasons.includes("source-unknown"),
    );
    assert.ok(
      service
        .domain()
        .admission(taskId)
        .reasons.includes("imported-blockers-unknown"),
    );
    assert.equal(service.domain().admission(localId).eligible, true);
    assert.equal(startedWorkspaces.includes(importedWorkspace.path), false);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runnable imported assignment starts on complete evidence, then a failed refresh holds later admission without cancelling its turn", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-active-hold-")),
  );
  const projectId = randomUUID();
  const profileId = randomUUID();
  const workerId = randomUUID();
  const assignmentId = randomUUID();
  let failed = false;
  let changed = false;
  let turns = 0;
  let toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  let release!: () => void;
  const heldTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader: GitHubSourceReader = {
    async readSelection() {
      return failed
        ? { complete: false, issues: [], reason: "http-403" }
        : {
            complete: true,
            issues: [changed ? { ...issue, title: "Imported revised" } : issue],
            reason: null,
          };
    },
    async readBlockers() {
      return failed
        ? { complete: false, blockers: [], reason: "http-403" }
        : { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: failed ? "unknown" : "open" };
    },
    async previewSelection() {
      return { complete: true, issues: [issue], reason: null };
    },
  };
  const runtime = (): Runtime => ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    onToolCall(listener) {
      toolCall = listener;
    },
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn() {
      turns++;
      return `turn-${turns}`;
    },
    async interruptTurn() {
      throw new Error("source hold must not cancel admitted turn");
    },
    async waitForTurn() {
      await heldTurn;
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
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: workerId,
      name: "Worker",
      instructions: "Worker",
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
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
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
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    assert.equal(domain.admission(taskId).eligible, true);
    await service.provisionTask(taskId);
    domain.execute({
      type: "assignment.create",
      actor: "agent",
      key: randomUUID(),
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Complete imported work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    await service.refreshGitHub();
    for (let i = 0; i < 100 && turns === 0; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(turns, 1);
    changed = true;
    await service.refreshGitHub();
    assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
    assert.ok(toolCall);
    const beforeDelegation = domain.assignments(taskId).length;
    const rejected = await toolCall({
      threadId: "thread",
      turnId: "turn-1",
      callId: "delegate-after-source-hold",
      tool: "ensemble_delegate",
      arguments: { profileId: workerId, brief: "Must remain held" },
    });
    assert.equal(rejected.success, false);
    assert.equal(domain.assignments(taskId).length, beforeDelegation);
    const noticeDb = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    try {
      const count = () =>
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_inbox_events WHERE taskId = ? AND eventType = 'source-hold'",
              )
              .get(taskId) as { count: number }
          ).count,
        );
      assert.equal(count(), 2);
      await service.refreshGitHub();
      assert.equal(count(), 2);
    } finally {
      noticeDb.close();
    }
    failed = true;
    await service.refreshGitHub();
    assert.ok(domain.admission(taskId).reasons.includes("source-unknown"));
    assert.ok(
      domain.admission(taskId).reasons.includes("imported-blockers-unknown"),
    );
    assert.equal(turns, 1);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unassigned routing-enabled source hold does not invent a lead assignment", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-routing-hold-")),
  );
  const projectId = randomUUID();
  const leadId = randomUUID();
  const workerId = randomUUID();
  let body = issue.body;
  let routingCalls = 0;
  let releaseFirst!: (value: {
    choice: string;
    model: string;
    confidence: number;
    probabilities: Record<string, number>;
    usage: { inputTokens: number; outputTokens: number };
  }) => void;
  const firstRoute = new Promise<{
    choice: string;
    model: string;
    confidence: number;
    probabilities: Record<string, number>;
    usage: { inputTokens: number; outputTokens: number };
  }>((resolve) => {
    releaseFirst = resolve;
  });
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [{ ...issue, body }], reason: null };
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
  const runtime = (): Runtime => ({
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
      routingClient: {
        async choose(request) {
          routingCalls++;
          const choice = workerId;
          const response = {
            choice,
            model: request.requestedModel,
            confidence: 1,
            probabilities: Object.fromEntries(
              request.choices.map((candidate) => [
                candidate,
                candidate === choice ? 1 : 0,
              ]),
            ),
            usage: { inputTokens: 0, outputTokens: 0 },
          };
          return routingCalls === 1 ? firstRoute : response;
        },
      },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    for (const [profileId, name] of [
      [leadId, "Lead"],
      [workerId, "Worker"],
    ] as const)
      domain.execute({
        type: "profile.create",
        actor: "operator",
        key: randomUUID(),
        profileId,
        name,
        instructions: name,
        capabilities: "work",
      });
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: leadId,
    });
    domain.execute({
      type: "routing.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Choose the worker",
      credentialRef: "env:TEST_ROUTER",
      candidateProfileIds: [workerId],
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
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    body = "Revised work";
    await service.refreshGitHub();
    assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
    assert.equal(domain.assignments(taskId).length, 0);
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    await service.provisionTask(taskId);
    assert.equal(domain.assignments(taskId).length, 0);
    const reviewDb = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    const digest = String(
      (
        reviewDb
          .prepare(
            "SELECT observedDigest FROM github_source_reviews WHERE nodeId = 'I_1'",
          )
          .get() as { observedDigest: string }
      ).observedDigest,
    );
    reviewDb.close();
    domain.execute({
      type: "source.review",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      observedDigest: digest,
      decision: "accept-revised-scope",
    });
    for (let i = 0; i < 100 && routingCalls === 0; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(routingCalls, 1);
    body = "Revised again";
    service.githubSources().reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, body }],
      reason: null,
    });
    releaseFirst({
      choice: workerId,
      model: "jev-1.13.0",
      confidence: 1,
      probabilities: { [workerId]: 1, lead_review: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    for (let i = 0; i < 100; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(domain.assignments(taskId).length, 0);
    assert.ok(
      domain.admission(taskId).reasons.includes("source-review-required"),
    );
    const secondDb = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    const secondDigest = String(
      (
        secondDb
          .prepare(
            "SELECT observedDigest FROM github_source_reviews WHERE nodeId = 'I_1'",
          )
          .get() as { observedDigest: string }
      ).observedDigest,
    );
    secondDb.close();
    domain.execute({
      type: "source.review",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      observedDigest: secondDigest,
      decision: "accept-revised-scope",
    });
    await service.refreshGitHub();
    assert.equal(routingCalls, 2);
    assert.deepEqual(
      domain.assignments(taskId).map((assignment) => assignment.profileId),
      [workerId],
    );
  } finally {
    releaseFirst({
      choice: workerId,
      model: "jev-1.13.0",
      confidence: 1,
      probabilities: { [workerId]: 1, lead_review: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit and timer refresh converge, and stop settles an in-flight read before closing storage", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-poll-")),
  );
  const projectId = randomUUID();
  const leadId = randomUUID();
  let reads = 0;
  let stall = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader: GitHubSourceReader = {
    async readSelection() {
      reads++;
      if (stall) await blocked;
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
  const runtime = (): Runtime => ({
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
      return "completed";
    },
  });
  const service = new StandaloneService(
    join(root, "data"),
    runtime,
    undefined,
    {
      github: { readerFactory: () => reader, intervalMs: 1000 },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    domain.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: leadId,
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
      leadProfileId: leadId,
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
    await service.refreshGitHub();
    assert.equal(reads, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 1150));
    assert.ok(reads >= 2);
    stall = true;
    const first = service.refreshGitHub();
    const second = service.refreshGitHub();
    for (let i = 0; i < 100 && reads < 3; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const beforeStop = reads;
    const stopping = service.stop();
    assert.equal(reads, beforeStop);
    release();
    await Promise.all([first, second, stopping]);
    assert.equal(reads, beforeStop);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
