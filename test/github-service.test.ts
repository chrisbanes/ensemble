import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { DeliveryStore } from "../src/core/delivery.js";
import { DomainStore } from "../src/core/domain.js";
import { GitHubSourceStore } from "../src/core/github-source.js";
import { Store } from "../src/core/store.js";
import { GitHubSynchronizer } from "../src/standalone/github-sync.js";
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
      const ordinaryEventId = randomUUID();
      const boundAssignmentId = String(
        (
          noticeDb
            .prepare(
              "SELECT assignmentId FROM task_execution_bindings WHERE workId = (SELECT workId FROM execution_intents WHERE threadId = 'thread' AND turnId = 'turn-1')",
            )
            .get() as { assignmentId: string }
        ).assignmentId,
      );
      noticeDb
        .prepare(
          "INSERT INTO coordination_inbox_events (eventId, taskId, recipientAssignmentId, eventType, payload) VALUES (?, ?, ?, 'operator-message', '{}')",
        )
        .run(ordinaryEventId, taskId, boundAssignmentId);
      assert.equal(
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_inbox_events WHERE eventId = ? AND recipientAssignmentId = ? AND eventType = 'operator-message'",
              )
              .get(ordinaryEventId, boundAssignmentId) as { count: number }
          ).count,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_delivery_events WHERE eventId = ?",
              )
              .get(ordinaryEventId) as { count: number }
          ).count,
        ),
        0,
      );
      const ordinaryBlocked = await toolCall({
        threadId: "thread",
        turnId: "turn-1",
        callId: "report-with-ordinary-inbox",
        tool: "ensemble_report_result",
        arguments: { summary: "Finished admitted work" },
      });
      assert.equal(ordinaryBlocked.success, false);
      assert.match(ordinaryBlocked.text, /inbox events remain undelivered/);
      noticeDb
        .prepare("DELETE FROM coordination_inbox_events WHERE eventId = ?")
        .run(ordinaryEventId);
      const report = await toolCall({
        threadId: "thread",
        turnId: "turn-1",
        callId: "report-after-source-hold",
        tool: "ensemble_report_result",
        arguments: { summary: "Finished admitted work" },
      });
      assert.equal(report.success, true, report.text);
      assert.equal(
        Number(
          (
            noticeDb
              .prepare(
                "SELECT count(*) AS count FROM coordination_results WHERE taskId = ? AND assignmentId = ?",
              )
              .get(taskId, boundAssignmentId) as { count: number }
          ).count,
        ),
        1,
      );
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

test("a held canonical lead receives one source-hold notice without changing assignment state", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-held-lead-")),
  );
  const projectId = randomUUID();
  const profileId = randomUUID();
  let title = "Original";
  const reader: GitHubSourceReader = {
    async readSelection() {
      return { complete: true, issues: [{ ...issue, title }], reason: null };
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
      throw new Error("Paused fixture must not start");
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
      expectedVersion: 2,
      selectionId: "repo",
    });
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    const leadId = String(domain.ensureLeadAssignment(taskId)?.id);
    const db = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    try {
      db.prepare(
        "UPDATE domain_assignments SET state = 'held' WHERE id = ?",
      ).run(leadId);
      title = "Revised";
      await service.refreshGitHub();
      assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
      const count = () =>
        Number(
          (
            db
              .prepare(
                "SELECT count(*) AS count FROM coordination_inbox_events WHERE recipientAssignmentId = ? AND eventType = 'source-hold'",
              )
              .get(leadId) as { count: number }
          ).count,
        );
      assert.equal(count(), 1);
      await service.refreshGitHub();
      assert.equal(count(), 1);
      assert.equal(domain.assignment(leadId).state, "held");
    } finally {
      db.close();
    }
  } finally {
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

const idleRuntime = (): Runtime => ({
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

function addGitHubProject(domain: DomainStore): string {
  const projectId = randomUUID();
  const profileId = randomUUID();
  const execute = (command: object) =>
    domain.execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  execute({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  execute({
    type: "project.create",
    projectId,
    name: "Alpha",
    leadProfileId: profileId,
  });
  execute({
    type: "github.configure",
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
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  execute({
    type: "github.activate",
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  return projectId;
}

test("blocker reads skip closed issues unless their still-open imported task owns the delivery closure", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  try {
    const projectId = addGitHubProject(domain);
    const owned = { ...issue, nodeId: "I_owned", number: 11 };
    const stale = {
      ...issue,
      nodeId: "I_stale",
      number: 12,
      state: "closed" as const,
    };
    const live = { ...issue, nodeId: "I_live", number: 13 };
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [owned],
      reason: null,
    });
    sources.reconcileBlockers("I_owned", {
      complete: true,
      blockers: [],
      reason: null,
    });
    const taskId = String(sources.issue("I_owned")?.taskId);
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "issue.close", repositoryId: "R_1", mode: "allow" }],
      requiredChecks: [],
    });
    const delivery = new DeliveryStore(db);
    const operationId = randomUUID();
    delivery.prepareAction(
      {
        operationId,
        action: {
          kind: "issue.close",
          target: { repositoryId: "R_1", nodeId: "I_owned", number: 11 },
          reviewedResultIds: [],
        },
      },
      {
        projectId,
        taskId,
        taskVersion: Number(domain.task(taskId).version),
        assignmentId: randomUUID(),
        assignmentVersion: 1,
        workId: "w",
        workRevision: 1,
        conversationRevision: 1,
      },
      false,
    );
    delivery.beginAttempt(operationId, { state: "open" });
    delivery.recordObservation(operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_owned", issueClosed: true },
    });
    const closedOwned = { ...owned, state: "closed" as const };
    sources.recordDeliveryClosure(
      projectId,
      domain.githubConfiguration(projectId).version,
      closedOwned,
      operationId,
      null,
    );
    assert.equal(domain.hasOwnDeliveryClosure(taskId), true);

    const blockerReads: string[] = [];
    const reader: GitHubSourceReader = {
      async readSelection() {
        return {
          complete: true,
          issues: [closedOwned, stale, live],
          reason: null,
        };
      },
      async readBlockers(reference) {
        blockerReads.push(reference.nodeId);
        return { complete: true, blockers: [], reason: null };
      },
      async readIssueStatus() {
        return { status: "open" };
      },
    };
    const synchronizer = new GitHubSynchronizer(domain, sources, () => reader);
    await synchronizer.refresh();
    assert.deepEqual(blockerReads.sort(), ["I_live", "I_owned"]);

    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      state: "done",
    });
    blockerReads.length = 0;
    await synchronizer.refresh();
    assert.deepEqual(blockerReads, ["I_live"]);
  } finally {
    db.close();
  }
});

test("a rate-limited read pauses manual refreshes until the reset without implying dependency clearance", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-rate-limit-")),
  );
  const calls: string[] = [];
  let limited = false;
  const reader: GitHubSourceReader = {
    async readSelection() {
      calls.push("selection");
      return limited
        ? {
            complete: false,
            issues: [],
            reason: "rate-limited",
            resumeAt: Date.now() + 60_000,
          }
        : { complete: true, issues: [issue], reason: null };
    },
    async readBlockers() {
      calls.push("blockers");
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      calls.push("status");
      return { status: "open" };
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    idleRuntime,
    undefined,
    {
      github: { readerFactory: () => reader, intervalMs: 3_600_000 },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const domain = service.domain();
    const projectId = addGitHubProject(domain);
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await service.refreshGitHub();
    const taskId = String(service.githubSources().issue("I_1")?.taskId);
    assert.equal(domain.task(taskId).importedBlockers, "clear");
    assert.deepEqual(calls, ["selection", "blockers"]);

    limited = true;
    await service.refreshGitHub();
    const readsAtLimit = calls.length;
    for (let i = 0; i < 2; i++) {
      await service.refreshGitHub();
      const sync = service.githubSources().syncState(projectId, "repo");
      assert.equal(sync?.complete, 0);
      assert.equal(sync?.reason, "rate-limited");
      assert.equal(domain.task(taskId).importedBlockers, "unknown");
    }
    assert.equal(calls.length, readsAtLimit);

    limited = false;
    mock.timers.tick(60_000);
    await service.refreshGitHub();
    assert.deepEqual(calls.slice(readsAtLimit), ["selection", "blockers"]);
    assert.equal(
      service.githubSources().syncState(projectId, "repo")?.complete,
      1,
    );
    assert.equal(domain.task(taskId).importedBlockers, "clear");
  } finally {
    mock.timers.reset();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("timer refreshes also wait out a rate limit", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-rate-limit-timer-")),
  );
  let reads = 0;
  const reader: GitHubSourceReader = {
    async readSelection() {
      reads++;
      return {
        complete: false,
        issues: [],
        reason: "rate-limited",
        resumeAt: Date.now() + 3_600_000,
      };
    },
    async readBlockers() {
      reads++;
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      reads++;
      return { status: "open" };
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    idleRuntime,
    undefined,
    {
      github: { readerFactory: () => reader, intervalMs: 1000 },
      power: { enabled: false },
    },
  );
  try {
    await service.start();
    const projectId = addGitHubProject(service.domain());
    const reconcile = mock.method(
      service.githubSources(),
      "reconcileSelection",
    );
    await service.refreshGitHub();
    assert.equal(reads, 1);
    assert.equal(reconcile.mock.callCount(), 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 1150));
    assert.ok(reconcile.mock.callCount() >= 2, "the timer pass ran");
    assert.equal(reads, 1);
    const sync = service.githubSources().syncState(projectId, "repo");
    assert.equal(sync?.complete, 0);
    assert.equal(sync?.reason, "rate-limited");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub refresh defaults to five minutes", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-github-default-interval-")),
  );
  const delays: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const spy = mock.method(globalThis, "setInterval", ((
    ...args: Parameters<typeof setInterval>
  ) => {
    delays.push(args[1]);
    return realSetInterval(...args);
  }) as typeof setInterval);
  const service = new StandaloneService(
    join(root, "data"),
    idleRuntime,
    undefined,
    { power: { enabled: false } },
  );
  try {
    await service.start();
    assert.ok(delays.includes(300_000), `intervals: ${delays.join(",")}`);
    assert.ok(!delays.includes(60_000));
  } finally {
    spy.mock.restore();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
