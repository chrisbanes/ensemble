import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CoordinationStore,
  type CoordinationToolResponse,
} from "../src/core/coordination.js";
import { DomainStore } from "../src/core/domain.js";
import { coordinationTools } from "../src/standalone/coordination-tools.js";
import type {
  RoutingChoiceClient,
  RoutingChoiceRequest,
  RoutingChoiceResponse,
} from "../src/standalone/routing.js";
import { RoutingFailure } from "../src/standalone/routing.js";
import {
  StandaloneService,
  type StandaloneServiceOptions,
} from "../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("integration condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

class CoordinationRuntime implements Runtime {
  starts = 0;
  turns = 0;
  readonly prompts: string[] = [];
  readonly threadTools = new Map<string, readonly RuntimeToolDefinition[]>();
  readonly resumed: string[] = [];
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private readonly entered = new Map<
    number,
    ReturnType<typeof deferred<void>>
  >();
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("completed");
  }

  async startThread(
    _workspace: string,
    tools: readonly RuntimeToolDefinition[] = [],
  ) {
    const id = `thread-${++this.starts}`;
    this.threadTools.set(id, tools);
    return id;
  }

  async resumeThread(
    threadId: string,
    tools?: readonly RuntimeToolDefinition[],
  ) {
    this.resumed.push(threadId);
    if (tools) this.threadTools.set(threadId, tools);
  }

  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    const turnId = `turn-${++this.turns}`;
    this.prompts.push(prompt);
    this.outcomes.set(turnId, deferred());
    this.entered.set(this.turns, deferred());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    const turn = Number(turnId.slice("turn-".length));
    this.entered.get(turn)?.resolve();
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  async waitForTurnNumber(turn: number) {
    await waitUntil(() => this.turns >= turn);
    await this.entered.get(turn)?.promise;
  }

  complete(turn: number) {
    this.outcomes.get(`turn-${turn}`)?.resolve("completed");
  }

  callTool(call: RuntimeToolCall) {
    assert.ok(this.toolCall, "service registered the runtime tool listener");
    return this.toolCall(call);
  }
}

class StopAtAdmissionRuntime extends CoordinationRuntime {
  beforeAdmission: (() => void) | undefined;

  processIdentity() {
    this.beforeAdmission?.();
    return null;
  }
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...body } as never);
}

function rowCount(service: StandaloneService, sql: string, ...args: unknown[]) {
  const db = (
    service as unknown as {
      db: {
        prepare(sql: string): { get(...args: unknown[]): { count: number } };
      };
    }
  ).db;
  return db.prepare(sql).get(...args).count;
}

function row(service: StandaloneService, sql: string, ...args: unknown[]) {
  const db = (
    service as unknown as {
      db: {
        prepare(sql: string): {
          get(...args: unknown[]): Record<string, unknown> | undefined;
        };
      };
    }
  ).db;
  return db.prepare(sql).get(...args);
}

class FakeRoutingClient implements RoutingChoiceClient {
  readonly requests: RoutingChoiceRequest[] = [];

  constructor(
    private readonly answer: (
      request: RoutingChoiceRequest,
      index: number,
    ) => Promise<RoutingChoiceResponse> | RoutingChoiceResponse | Error,
  ) {}

  choose(
    request: RoutingChoiceRequest,
    _signal: AbortSignal,
  ): Promise<RoutingChoiceResponse> {
    const index = this.requests.push(request) - 1;
    const response = this.answer(request, index);
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  }
}

function routeResponse(
  request: RoutingChoiceRequest,
  choice: string,
): RoutingChoiceResponse {
  const remainder = 0.1 / (request.choices.length - 1);
  return {
    choice,
    model: request.requestedModel,
    confidence: 0.9,
    probabilities: Object.fromEntries(
      request.choices.map((candidate) => [
        candidate,
        candidate === choice ? 0.9 : remainder,
      ]),
    ),
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

async function routedFixture(
  client: FakeRoutingClient,
  options: {
    credentialRef?: string | null;
    candidateProfileIds?: string[];
    brief?: string;
    routingEnabled?: boolean;
    preassign?: "lead" | "worker";
    fillCapacity?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-routing-race-"));
  const runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: client },
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await service.start();
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId: leadProfileId,
    name: "Lead",
    instructions: "Coordinate",
    capabilities: "delegate",
  });
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId: workerProfileId,
    name: "Worker",
    instructions: "Build",
    capabilities: "parser maintenance",
  });
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Routing race",
    leadProfileId,
  });
  command(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "routing.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: options.routingEnabled ?? true,
    guidance: "Select the best parser maintainer.",
    credentialRef:
      options.credentialRef === undefined
        ? "env:TEST_TYPESAFE_KEY"
        : options.credentialRef,
    candidateProfileIds: options.candidateProfileIds ?? [workerProfileId],
  });
  let capacityHolderTaskId: string | undefined;
  if (options.fillCapacity) {
    await service.configureCapacity({
      key: randomUUID(),
      globalLimit: 4,
      projectOverrides: { [projectId]: 1 },
    });
    capacityHolderTaskId = randomUUID();
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId: capacityHolderTaskId,
      title: "Occupy capacity",
      outcome: "Hold one slot",
      ready: false,
    });
    command(service, {
      type: "assignment.create",
      actor: "operator",
      projectId,
      taskId: capacityHolderTaskId,
      assignmentId: randomUUID(),
      profileId: leadProfileId,
      brief: "Hold one slot",
      resultDestination: "lead:task",
      requesterAssignmentId: null,
    });
    await service.provisionTask(capacityHolderTaskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId: capacityHolderTaskId,
      expectedVersion: 1,
      ready: true,
    });
    await runtime.waitForTurnNumber(1);
  }
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Stabilize parsing",
    outcome: options.brief ?? "Ship a stable parser.",
    ready: false,
  });
  if (options.preassign)
    command(service, {
      type: "assignment.create",
      actor: "operator",
      projectId,
      taskId,
      assignmentId: randomUUID(),
      profileId: options.preassign === "lead" ? leadProfileId : workerProfileId,
      brief: options.brief ?? "Ship a stable parser.",
      resultDestination: "lead:task",
      requesterAssignmentId: null,
    });
  await service.provisionTask(taskId);
  command(service, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return {
    root,
    runtime,
    service,
    client,
    leadProfileId,
    workerProfileId,
    projectId,
    taskId,
    capacityHolderTaskId,
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("enabled routing allocates the initial brief without a lead turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-routing-"));
  const runtime = new CoordinationRuntime();
  const workerProfileId = randomUUID();
  const client = new FakeRoutingClient((request) =>
    routeResponse(request, workerProfileId),
  );
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      routingClient: client,
    } satisfies StandaloneServiceOptions,
  );
  const leadProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "Build",
      capabilities: "parser maintenance",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Routing",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Select the best parser maintainer.",
      credentialRef: "env:TEST_TYPESAFE_KEY",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Stabilize parsing",
      outcome: "Ship a stable parser.",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });

    await runtime.waitForTurnNumber(1);

    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0]?.state.brief, "Ship a stable parser.");
    assert.deepEqual(
      client.requests[0]?.state.candidates.map(
        (candidate) => candidate.profileId,
      ),
      [workerProfileId],
    );
    assert.equal(runtime.turns, 1);
    assert.equal(
      service
        .domain()
        .assignments(taskId)
        .filter((item) => item.state !== "held").length,
      1,
    );
    assert.equal(
      service.domain().assignments(taskId)[0]?.profileId,
      workerProfileId,
    );
  } finally {
    runtime.complete(1);
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit assignments bypass routing and disabled routing allocates the lead", async () => {
  for (const policy of ["explicit", "disabled"] as const) {
    const client = new FakeRoutingClient(() => {
      throw new Error("this policy must not call the routing client");
    });
    const f = await routedFixture(
      client,
      policy === "explicit"
        ? { preassign: "worker" }
        : { routingEnabled: false },
    );
    try {
      await f.runtime.waitForTurnNumber(1);
      assert.equal(client.requests.length, 0, policy);
      const assignments = f.service.domain().assignments(f.taskId);
      assert.equal(assignments.length, 1, policy);
      assert.equal(
        assignments[0]?.profileId,
        policy === "explicit" ? f.workerProfileId : f.leadProfileId,
        policy,
      );
      assert.equal(
        f.service.domain().routingOperations(f.taskId).length,
        0,
        policy,
      );
    } finally {
      await f.close();
    }
  }
});

test("a committed initial routing assignment is not inferred again after restart", async () => {
  const client = new FakeRoutingClient((request) =>
    routeResponse(
      request,
      request.state.candidates[0]?.profileId ?? "lead_review",
    ),
  );
  const f = await routedFixture(client);
  try {
    await waitUntil(
      () => f.service.domain().routingOperations(f.taskId).length === 1,
    );
    assert.equal(client.requests.length, 1);
    assert.equal(f.service.domain().assignments(f.taskId).length, 1);

    await f.service.stop();
    await f.service.start();

    assert.equal(client.requests.length, 1);
    assert.equal(f.service.domain().routingOperations(f.taskId).length, 1);
    assert.equal(f.service.domain().assignments(f.taskId).length, 1);
    assert.equal(
      f.service.domain().assignments(f.taskId)[0]?.profileId,
      f.workerProfileId,
    );
  } finally {
    await f.close();
  }
});

test("capacity waiting preserves the routing-selected candidate", async () => {
  const client = new FakeRoutingClient((request) =>
    routeResponse(
      request,
      request.state.candidates[0]?.profileId ?? "lead_review",
    ),
  );
  const f = await routedFixture(client, { fillCapacity: true });
  try {
    await waitUntil(
      () => f.service.domain().routingOperations(f.taskId).length === 1,
    );
    assert.equal(client.requests.length, 1);
    const routed = f.service.domain().routingOperations(f.taskId)[0];
    assert.ok(routed?.assignmentId);
    assert.equal(
      f.service.domain().assignment(String(routed.assignmentId)).profileId,
      f.workerProfileId,
    );
    assert.equal(
      f.service.domain().assignment(String(routed.assignmentId)).state,
      "pending",
    );
    await waitUntil(() =>
      f.service.list().some((item) => item.state === "capacity-waiting"),
    );
    const request = f.service
      .turnRequests()
      .find((item) => item.taskId === f.taskId);
    assert.ok(request);
    const waiting = f.service
      .list()
      .find((item) => item.workId === request.workId);
    assert.equal(waiting?.state, "capacity-waiting");
    assert.equal(f.runtime.turns, 1);

    await f.service.configureCapacity({
      key: randomUUID(),
      globalLimit: 4,
      projectOverrides: { [f.projectId]: 2 },
    });
    await f.runtime.waitForTurnNumber(2);
    assert.equal(
      f.service.domain().assignment(String(routed.assignmentId)).profileId,
      f.workerProfileId,
    );
    assert.equal(
      f.service.domain().assignment(String(routed.assignmentId)).state,
      "running",
    );
    assert.equal(f.runtime.turns, 2);

    f.runtime.complete(2);
    await f.runtime.waitForTurnNumber(3);
    assert.equal(client.requests.length, 1);
    assert.equal(
      f.service.domain().assignment(String(routed.assignmentId)).profileId,
      f.workerProfileId,
    );
    assert.equal(
      rowCount(
        f.service,
        "SELECT COUNT(*) AS count FROM coordination_reporting_repairs WHERE assignmentId = ? AND attempts = 1",
        routed.assignmentId,
      ),
      1,
    );
  } finally {
    await f.close();
  }
});

test("stale assignment versions stay pending and never reserve writer capacity", async () => {
  const client = new FakeRoutingClient((request) =>
    routeResponse(
      request,
      request.state.candidates[0]?.profileId ?? "lead_review",
    ),
  );
  const f = await routedFixture(client, { fillCapacity: true });
  try {
    await waitUntil(
      () => f.service.domain().routingOperations(f.taskId).length === 1,
    );
    const route = f.service.domain().routingOperations(f.taskId)[0];
    assert.ok(route?.assignmentId);
    const assignmentId = String(route.assignmentId);
    const request = f.service
      .turnRequests()
      .find((item) => item.taskId === f.taskId);
    assert.ok(request);
    await waitUntil(() =>
      f.service
        .list()
        .some(
          (item) =>
            item.workId === request.workId && item.state === "capacity-waiting",
        ),
    );
    assert.equal(f.service.domain().assignment(assignmentId).state, "pending");

    const db = (
      f.service as unknown as {
        db: {
          prepare(sql: string): {
            run(...args: unknown[]): { changes: number };
          };
        };
      }
    ).db;
    assert.equal(
      db
        .prepare(
          "UPDATE domain_assignments SET version = version + 1 WHERE id = ?",
        )
        .run(assignmentId).changes,
      1,
    );
    f.runtime.complete(1);
    await waitUntil(() =>
      f.service
        .list()
        .some(
          (item) => item.workId === request.workId && item.state === "held",
        ),
    );
    assert.equal(f.service.domain().assignment(assignmentId).version, 2);
    assert.equal(f.service.domain().assignment(assignmentId).state, "pending");
    assert.equal(
      rowCount(
        f.service,
        "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
        request.workId,
      ),
      0,
    );
    assert.equal(
      rowCount(
        f.service,
        "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        request.workId,
      ),
      0,
    );
  } finally {
    await f.close();
  }
});

test("a delayed routing response cannot dispatch after the task brief changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-stale-route-"));
  const runtime = new CoordinationRuntime();
  const firstResponse = deferred<RoutingChoiceResponse>();
  const client = new FakeRoutingClient((request, index) =>
    index === 0 ? firstResponse.promise : routeResponse(request, "lead_review"),
  );
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: client },
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "Build",
      capabilities: "parser maintenance",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Routing",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Select the best parser maintainer.",
      credentialRef: "env:TEST_TYPESAFE_KEY",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Stabilize parsing",
      outcome: "Ship the original parser brief.",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });

    await waitUntil(() => client.requests.length === 1);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 2,
      outcome: "Ship the revised parser brief.",
    });
    await waitUntil(() => client.requests.length === 2);
    const firstRequest = client.requests[0];
    assert.ok(firstRequest);
    firstResponse.resolve(routeResponse(firstRequest, workerProfileId));
    await runtime.waitForTurnNumber(1);

    const operation = service.domain().routingOperations(taskId);
    assert.equal(operation.length, 1);
    assert.equal(operation[0]?.taskVersion, 3);
    assert.equal(operation[0]?.brief, "Ship the revised parser brief.");
    const assignments = service.domain().assignments(taskId);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]?.profileId, leadProfileId);
    assert.equal(client.requests.length, 2);
  } finally {
    firstResponse.resolve({
      choice: workerProfileId,
      model: "jev-1.13.0",
      confidence: 0.9,
      probabilities: { [workerProfileId]: 0.9, lead_review: 0.1 },
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Stop committed after routing still blocks scheduler admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-stop-after-route-"));
  const runtime = new StopAtAdmissionRuntime();
  const workerProfileId = randomUUID();
  const client = new FakeRoutingClient((request) =>
    routeResponse(request, workerProfileId),
  );
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: client },
  );
  const leadProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let stopped = false;
  let running = false;
  runtime.beforeAdmission = () => {
    if (!stopped && service.domain().routingOperations(taskId).length === 1) {
      stopped = true;
      void service.stopTask(taskId);
    }
  };
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "Build",
      capabilities: "parser maintenance",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Routing",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Select the best parser maintainer.",
      credentialRef: "env:TEST_TYPESAFE_KEY",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Stabilize parsing",
      outcome: "Ship a stable parser.",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });

    await waitUntil(() => stopped);
    assert.equal(service.domain().routingOperations(taskId).length, 1);
    assert.equal(
      service.domain().assignments(taskId)[0]?.profileId,
      workerProfileId,
    );
    assert.equal(service.taskHold(taskId), "Task stopped");
    assert.equal(runtime.turns, 0);
  } finally {
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("revision, routing, candidate and hold changes stale an in-flight recommendation", async () => {
  const changes = [
    "task-revision",
    "routing-opt-out",
    "project-pause",
    "candidate-removal",
    "candidate-revocation",
    "candidate-revision",
    "dependency-hold",
    "stop-hold",
  ] as const;
  for (const change of changes) {
    const firstResponse = deferred<RoutingChoiceResponse>();
    const client = new FakeRoutingClient((request, index) =>
      index === 0
        ? firstResponse.promise
        : routeResponse(request, "lead_review"),
    );
    const f = await routedFixture(client);
    try {
      await waitUntil(() => client.requests.length === 1);
      switch (change) {
        case "task-revision":
          command(f.service, {
            type: "task.configure",
            actor: "operator",
            projectId: f.projectId,
            taskId: f.taskId,
            expectedVersion: 2,
            outcome: "Ship a revised parser.",
            ready: false,
          });
          break;
        case "routing-opt-out":
          command(f.service, {
            type: "routing.configure",
            actor: "operator",
            projectId: f.projectId,
            expectedVersion: 2,
            enabled: false,
            guidance: "Select the best parser maintainer.",
            candidateProfileIds: [f.workerProfileId],
          });
          break;
        case "project-pause":
          command(f.service, {
            type: "project.configure",
            actor: "operator",
            projectId: f.projectId,
            expectedVersion: 2,
            paused: true,
          });
          break;
        case "candidate-removal":
          command(f.service, {
            type: "routing.configure",
            actor: "operator",
            projectId: f.projectId,
            expectedVersion: 2,
            enabled: true,
            guidance: "Select the best parser maintainer.",
            candidateProfileIds: [],
          });
          break;
        case "candidate-revocation":
          command(f.service, {
            type: "profile.configure",
            actor: "operator",
            profileId: f.workerProfileId,
            expectedVersion: 1,
            revoked: true,
          });
          break;
        case "candidate-revision":
          command(f.service, {
            type: "profile.configure",
            actor: "operator",
            profileId: f.workerProfileId,
            expectedVersion: 1,
            capabilities: "updated parser maintenance",
          });
          break;
        case "dependency-hold": {
          const blockerTaskId = randomUUID();
          command(f.service, {
            type: "task.create",
            actor: "operator",
            projectId: f.projectId,
            taskId: blockerTaskId,
            title: "Parser dependency",
            outcome: "Complete first",
            ready: false,
          });
          command(f.service, {
            type: "dependency.add",
            actor: "operator",
            projectId: f.projectId,
            taskId: f.taskId,
            blockerTaskId,
            expectedVersion: 2,
          });
          break;
        }
        case "stop-hold":
          await f.service.stopTask(f.taskId);
          break;
      }

      const firstRequest = client.requests[0];
      assert.ok(firstRequest);
      firstResponse.resolve(routeResponse(firstRequest, f.workerProfileId));
      await waitUntil(
        () =>
          row(
            f.service,
            "SELECT status FROM routing_attempt_operations WHERE taskId = ?",
            f.taskId,
          )?.status === "stale",
      );
      const stale = row(
        f.service,
        "SELECT status, staleReason FROM routing_attempt_operations WHERE taskId = ?",
        f.taskId,
      );
      assert.equal(stale?.status, "stale", change);
      assert.equal(
        rowCount(
          f.service,
          "SELECT COUNT(*) AS count FROM routing_attempts WHERE status = 'running' AND operationId = (SELECT operationId FROM routing_attempt_operations WHERE taskId = ?)",
          f.taskId,
        ),
        0,
        change,
      );
      assert.equal(
        f.service
          .domain()
          .assignments(f.taskId)
          .some((item) => item.profileId === f.workerProfileId),
        false,
        change,
      );
      assert.equal(
        f.service.domain().routingOperations(f.taskId).length,
        0,
        change,
      );
      assert.equal(client.requests.length, 1, change);
    } finally {
      const firstRequest = client.requests[0];
      if (firstRequest) {
        firstResponse.resolve(routeResponse(firstRequest, f.workerProfileId));
      }
      await f.close();
    }
  }
});

test("routing fallbacks retain one lead event across duplicate wakes and restart", async () => {
  const scenarios: Array<{
    name: string;
    options: {
      credentialRef?: string | null;
      candidateProfileIds?: string[];
      brief?: string;
    };
    expectedReason: string;
    answer: (request: RoutingChoiceRequest) => RoutingChoiceResponse | Error;
    expectedRequests: number;
  }> = [
    {
      name: "no-candidates",
      options: { candidateProfileIds: [] as string[] },
      expectedReason: "no-candidates",
      answer: () => {
        throw new Error("no-candidate routing must not call the client");
      },
      expectedRequests: 0,
    },
    {
      name: "missing-credentials",
      options: { credentialRef: null },
      expectedReason: "missing-credentials",
      answer: () => {
        throw new Error("missing credentials must not call the client");
      },
      expectedRequests: 0,
    },
    {
      name: "missing-context",
      options: { brief: "" },
      expectedReason: "missing-context",
      answer: () => {
        throw new Error("missing context must not call the client");
      },
      expectedRequests: 0,
    },
    {
      name: "lead-review",
      options: {},
      expectedReason: "lead-review",
      answer: (request: RoutingChoiceRequest) =>
        routeResponse(request, "lead_review"),
      expectedRequests: 1,
    },
    {
      name: "malformed-response",
      options: {},
      expectedReason: "malformed-response",
      answer: (request: RoutingChoiceRequest) =>
        routeResponse(request, "unlisted-profile"),
      expectedRequests: 1,
    },
    {
      name: "transient-exhaustion",
      options: {},
      expectedReason: "transient-exhausted",
      answer: () =>
        new RoutingFailure("temporary provider failure", "transient"),
      expectedRequests: 2,
    },
  ];

  for (const scenario of scenarios) {
    const client = new FakeRoutingClient((request) => scenario.answer(request));
    const f = await routedFixture(client, scenario.options);
    try {
      await f.runtime.waitForTurnNumber(1);
      assert.equal(
        client.requests.length,
        scenario.expectedRequests,
        scenario.name,
      );
      const operation = f.service.domain().routingOperations(f.taskId)[0];
      assert.ok(operation, scenario.name);
      assert.equal(
        operation.disposition,
        `lead-review:${scenario.expectedReason}`,
      );
      assert.equal(
        operation.brief,
        scenario.options.brief ?? "Ship a stable parser.",
      );
      const assignments = f.service.domain().assignments(f.taskId);
      assert.equal(assignments.length, 1, scenario.name);
      assert.equal(assignments[0]?.profileId, f.leadProfileId, scenario.name);
      const leadAssignmentId = String(assignments[0]?.id);
      assert.equal(
        rowCount(
          f.service,
          "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE routingOperationId = ? AND recipientAssignmentId = ? AND eventType = 'routing-fallback'",
          operation.id,
          leadAssignmentId,
        ),
        1,
        scenario.name,
      );
      const event = row(
        f.service,
        "SELECT payload FROM coordination_inbox_events WHERE routingOperationId = ?",
        operation.id,
      );
      const payload = JSON.parse(String(event?.payload)) as {
        brief: string;
        reason: string;
      };
      assert.equal(
        payload.brief,
        scenario.options.brief ?? "Ship a stable parser.",
        scenario.name,
      );
      assert.equal(payload.reason, scenario.expectedReason, scenario.name);

      await f.service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
      assert.equal(
        rowCount(
          f.service,
          "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE routingOperationId = ?",
          operation.id,
        ),
        1,
        scenario.name,
      );

      await f.service.stop();
      await f.service.start();
      assert.equal(
        rowCount(
          f.service,
          "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE routingOperationId = ?",
          operation.id,
        ),
        1,
        scenario.name,
      );
      assert.equal(
        client.requests.length,
        scenario.expectedRequests,
        scenario.name,
      );
      assert.equal(
        f.service.domain().assignments(f.taskId).length,
        1,
        scenario.name,
      );
    } finally {
      await f.close();
    }
  }
});

test("task threads receive scoped tools and delivery resumes the exact lead conversation", async () => {
  assert.deepEqual(
    coordinationTools.map((tool) => tool.name),
    [
      "ensemble_delegate",
      "ensemble_report_result",
      "ensemble_ask_question",
      "ensemble_request_approval",
      "ensemble_request_follow_up",
      "ensemble_request_completion",
    ],
  );
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-integration-"));
  const runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
    } satisfies StandaloneServiceOptions,
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let leadAssignmentId = "";
  let childAssignmentId = "";
  try {
    await service.start();
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "Build",
      capabilities: "code",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Coordination",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Coordinate work",
      outcome: "Complete the task",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await runtime.waitForTurnNumber(1);
    leadAssignmentId = String(
      service
        .domain()
        .assignments(taskId)
        .find((item) => item.profileId === leadProfileId)?.id,
    );
    const leadThread = "thread-1";
    assert.deepEqual(
      runtime.threadTools.get(leadThread)?.map((tool) => tool.name),
      coordinationTools.map((tool) => tool.name),
    );

    const delegation = await runtime.callTool({
      threadId: leadThread,
      turnId: "turn-1",
      callId: "delegate-1",
      tool: "ensemble_delegate",
      arguments: { profileId: workerProfileId, brief: "Build the feature" },
    });
    assert.equal(delegation.success, true);
    const delegated = service
      .domain()
      .assignments(taskId)
      .find((item) => item.requesterAssignmentId === leadAssignmentId);
    assert.ok(delegated);
    childAssignmentId = String(delegated.id);
    const childWorkId = `assignment:${childAssignmentId}:initial`;
    await waitUntil(() =>
      service.turnRequests().some((item) => item.workId === childWorkId),
    );
    assert.equal(
      service.domain().assignment(childAssignmentId).state,
      "pending",
    );

    runtime.complete(1);
    await runtime.waitForTurnNumber(2);
    const childThread = "thread-2";
    assert.deepEqual(
      runtime.threadTools.get(childThread)?.map((tool) => tool.name),
      coordinationTools.map((tool) => tool.name),
    );
    const questionCall = {
      threadId: childThread,
      turnId: "turn-2",
      callId: "question-1",
      tool: "ensemble_ask_question",
      arguments: { question: "Should the output use format B?" },
    } as const;
    const question = await runtime.callTool(questionCall);
    assert.equal(question.success, true);
    const questionId = question.text.split(" ").at(-1) ?? "";
    const material = { format: "B", destination: "release-notes" };
    const approval = await runtime.callTool({
      threadId: childThread,
      turnId: "turn-2",
      callId: "approval-1",
      tool: "ensemble_request_approval",
      arguments: {
        action: "publish",
        target: "release-notes",
        material,
      },
    });
    assert.equal(approval.success, true);
    const approvalId = approval.text.split(" ").at(-1) ?? "";
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_operator_attention WHERE taskId = ? AND status = 'open'",
        taskId,
      ),
      2,
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_inbox_events",
      ),
      0,
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_delivery_batches",
      ),
      0,
    );

    runtime.complete(2);
    await waitUntil(
      () =>
        service.list().find((intent) => intent.workId === childWorkId)
          ?.state === "completed",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.turns, 2);
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_reporting_repairs WHERE assignmentId = ?",
        childAssignmentId,
      ),
      0,
    );

    await service.stop();
    const db = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    const coordination = new CoordinationStore(db);
    coordination.migrate();
    assert.deepEqual(
      coordination
        .interactions(taskId)
        .map((interaction) => interaction.status),
      ["open", "open"],
    );
    const answerKey = randomUUID();
    const answered = coordination.answerQuestion({
      actor: "operator",
      key: answerKey,
      interactionId: questionId,
      expectedRevision: 1,
      answer: "Use format B.",
    });
    assert.equal(answered.recipientAssignmentId, childAssignmentId);
    assert.equal(answered.eventType, "question-answer");
    assert.equal(
      coordination.answerQuestion({
        actor: "operator",
        key: answerKey,
        interactionId: questionId,
        expectedRevision: 1,
        answer: "Use format B.",
      }).eventId,
      answered.eventId,
    );
    const decided = coordination.decideApproval({
      actor: "operator",
      key: randomUUID(),
      interactionId: approvalId,
      expectedRevision: 1,
      decision: "approved",
      action: "publish",
      target: "release-notes",
      material,
    });
    assert.equal(decided.recipientAssignmentId, childAssignmentId);
    assert.equal(decided.eventType, "approval-decision");
    assert.deepEqual(
      coordination
        .inboxEvents(childAssignmentId)
        .map((event) => event.eventType),
      ["question-answer", "approval-decision"],
    );
    assert.equal(coordination.inboxEvents(leadAssignmentId).length, 0);
    const domain = new DomainStore(db);
    const projectVersion = Number(domain.project(projectId).version);
    domain.execute({
      key: randomUUID(),
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: projectVersion,
      paused: true,
    });
    db.close();

    await service.start();
    await waitUntil(() =>
      service
        .turnRequests()
        .some(
          (request) =>
            request.assignmentId === childAssignmentId &&
            request.workId !== childWorkId,
        ),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.turns, 2);
    await service.stopTask(taskId);
    const pausedProject = service.domain().project(projectId);
    service.domain().execute({
      key: randomUUID(),
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: Number(pausedProject.version),
      paused: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.turns, 2);
    await service.resumeTask(taskId);
    await runtime.waitForTurnNumber(3);
    assert.equal(runtime.resumed.includes(childThread), true);
    assert.match(runtime.prompts[2] ?? "", /Use format B/);
    assert.match(runtime.prompts[2] ?? "", /approved/);
    const childDeliveryWork = service
      .turnRequests()
      .filter(
        (request) =>
          request.assignmentId === childAssignmentId &&
          request.workId !== childWorkId,
      );
    assert.equal(
      childDeliveryWork.length,
      1,
      JSON.stringify(
        service.turnRequests().map((request) => ({
          workId: request.workId,
          assignmentId: request.assignmentId,
          state: request.state,
          previousWorkId: request.previousWorkId,
          reason: request.reason,
        })),
      ),
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE interactionId = ?",
        questionId,
      ),
      1,
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE interactionId = ?",
        approvalId,
      ),
      1,
    );

    const reportCall = {
      threadId: childThread,
      turnId: "turn-3",
      callId: "result-1",
      tool: "ensemble_report_result",
      arguments: { summary: "Implemented the feature" },
    } as const;
    const reported = await runtime.callTool(reportCall);
    assert.equal(reported.success, true);
    assert.equal(
      service.domain().assignment(childAssignmentId).state,
      "completed",
    );
    runtime.complete(3);
    await runtime.waitForTurnNumber(4);
    assert.equal(runtime.resumed.includes(leadThread), true);
    assert.match(runtime.prompts[3] ?? "", /Implemented the feature/);
    const deliveredWorkId = service
      .turnRequests()
      .find(
        (request) =>
          request.assignmentId === leadAssignmentId &&
          request.workId !== `assignment:${leadAssignmentId}:initial`,
      )?.workId;
    assert.ok(deliveredWorkId);

    const replay = await runtime.callTool(reportCall);
    assert.deepEqual(replay, reported satisfies CoordinationToolResponse);
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_results WHERE workId = ?",
        childDeliveryWork[0]?.workId,
      ),
      1,
    );
    assert.equal(
      service
        .list()
        .find((intent) => intent.workId === childDeliveryWork[0]?.workId)
        ?.state,
      "completed",
    );
    assert.equal(
      (
        await runtime.callTool({
          ...reportCall,
          arguments: { summary: "Changed payload" },
        })
      ).success,
      false,
    );
    assert.equal(
      service
        .list()
        .find((intent) => intent.workId === childDeliveryWork[0]?.workId)
        ?.state,
      "completed",
    );

    runtime.complete(4);
    await waitUntil(
      () =>
        service.list().find((item) => item.workId === deliveredWorkId)
          ?.state === "completed",
    );
    const late = await runtime.callTool({
      ...reportCall,
      callId: "late-new-result",
      arguments: { summary: "Must not be accepted" },
    });
    assert.equal(late.success, false);
    assert.equal(
      service
        .list()
        .find((intent) => intent.workId === childDeliveryWork[0]?.workId)
        ?.state,
      "held",
    );
  } finally {
    runtime.complete(1);
    runtime.complete(2);
    runtime.complete(4);
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Stop committed before delegation rejects without a child or receipt", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-s04b-stop-before-delegate-"),
  );
  const runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false } },
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "Build",
      capabilities: "code",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Coordination",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Coordinate work",
      outcome: "Complete the task",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await runtime.waitForTurnNumber(1);
    const leadAssignmentId = String(
      service
        .domain()
        .assignments(taskId)
        .find((assignment) => assignment.profileId === leadProfileId)?.id,
    );
    const db = (
      service as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }
    ).db;
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Task stopped')",
    ).run(taskId);
    const response = await runtime.callTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "delegate-after-stop",
      tool: "ensemble_delegate",
      arguments: {
        profileId: workerProfileId,
        brief: "Must remain unassigned.",
      },
    });
    assert.equal(response.success, false);
    assert.match(response.text, /task hold/i);
    assert.equal(service.taskHold(taskId), "Task stopped");
    assert.deepEqual(
      service
        .domain()
        .assignments(taskId)
        .filter(
          (assignment) => assignment.requesterAssignmentId === leadAssignmentId,
        ),
      [],
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_receipts WHERE callId = ?",
        "delegate-after-stop",
      ),
      0,
    );
    runtime.complete(1);
  } finally {
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Stop after delegation commit leaves the child pending without dispatch", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-s04b-stop-after-delegate-"),
  );
  const runtime = new StopAtAdmissionRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false } },
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let leadAssignmentId = "";
  let childAssignmentId = "";
  let stop: Promise<unknown> | undefined;
  let stopped = false;
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "Build",
      capabilities: "code",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Coordination",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Coordinate work",
      outcome: "Complete the task",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await runtime.waitForTurnNumber(1);
    leadAssignmentId = String(
      service
        .domain()
        .assignments(taskId)
        .find((assignment) => assignment.profileId === leadProfileId)?.id,
    );
    runtime.beforeAdmission = () => {
      const child = service
        .domain()
        .assignments(taskId)
        .find(
          (assignment) => assignment.requesterAssignmentId === leadAssignmentId,
        );
      if (child && !stopped) {
        stopped = true;
        childAssignmentId = String(child.id);
        stop = service.stopTask(taskId);
      }
    };
    const response = await runtime.callTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "delegate-before-stop",
      tool: "ensemble_delegate",
      arguments: { profileId: workerProfileId, brief: "Created before Stop." },
    });
    assert.equal(response.success, true);
    await waitUntil(() => stopped);
    assert.ok(service.taskHold(taskId));
    assert.equal(
      service.domain().assignment(childAssignmentId).state,
      "pending",
    );
    assert.equal(runtime.turns, 1, "the child is not submitted to the runtime");
    runtime.complete(1);
    await stop;
  } finally {
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart leaves legacy inbox events for a completed recipient undelivered", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-completed-inbox-"));
  let runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false } },
  );
  const leadProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Coordination",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Coordinate work",
      outcome: "Complete the task",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await runtime.waitForTurnNumber(1);
    const leadAssignmentId = String(
      service
        .domain()
        .assignments(taskId)
        .find((assignment) => assignment.profileId === leadProfileId)?.id,
    );
    const message = await service.coordinationView().postOperatorMessage({
      taskId,
      key: randomUUID(),
      recipientAssignmentId: leadAssignmentId,
      expectedAssignmentVersion: 1,
      message: "This event predates completion.",
    });
    const result = await runtime.callTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "lead-result-before-completion",
      tool: "ensemble_report_result",
      arguments: { summary: "Completed the task." },
    });
    assert.equal(result.success, true);
    runtime.complete(1);
    await waitUntil(
      () => service.domain().assignment(leadAssignmentId).state === "completed",
    );
    assert.equal(
      service
        .coordinationView()
        .readTask(taskId)
        .messages.find((item) => item.eventId === message.eventId)
        ?.deliveryState,
      "pending",
    );
    await service.stop();
    running = false;

    runtime = new CoordinationRuntime();
    await service.start();
    running = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(runtime.turns, 0);
    assert.equal(
      service
        .coordinationView()
        .readTask(taskId)
        .messages.find((item) => item.eventId === message.eventId)
        ?.deliveryState,
      "pending",
    );
    assert.equal(
      (
        service as unknown as { coordination: CoordinationStore }
      ).coordination.queuedDeliveries().length,
      0,
    );
  } finally {
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion rejection is final for one lead generation; a fresh turn can complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-completion-"));
  const runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Completion lead",
      instructions: "Coordinate the task.",
      capabilities: "coordination",
    });
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Completion worker",
      instructions: "Complete assigned work.",
      capabilities: "verification",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Completion boundary",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [workerProfileId],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Complete through the lead",
      outcome: "Delegate, review one result, and complete.",
      ready: false,
    });
    await service.configureCapacity({
      key: randomUUID(),
      globalLimit: 1,
      projectOverrides: { [projectId]: 1 },
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });

    await runtime.waitForTurnNumber(1);
    const leadAssignmentId = String(
      service
        .domain()
        .assignments(taskId)
        .find((item) => item.profileId === leadProfileId)?.id,
    );
    const leadThread = "thread-1";
    const delegation = await runtime.callTool({
      threadId: leadThread,
      turnId: "turn-1",
      callId: "completion-delegate",
      tool: "ensemble_delegate",
      arguments: {
        profileId: workerProfileId,
        brief: "Use ensemble_report_result with summary 'completion-result'.",
      },
    });
    assert.equal(delegation.success, true);
    const workerAssignmentId = String(
      service
        .domain()
        .assignments(taskId)
        .find((item) => item.requesterAssignmentId === leadAssignmentId)?.id,
    );
    assert.ok(workerAssignmentId);
    runtime.complete(1);
    await runtime.waitForTurnNumber(2);
    const delegatedLeadWorkId = service
      .list()
      .find((item) => item.turnId === "turn-1")?.workId;
    assert.ok(delegatedLeadWorkId);
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        delegatedLeadWorkId,
      )?.state,
      "settled",
      "a durable lead delegation settles only the completed generation's effect",
    );
    assert.equal(
      service.domain().assignment(leadAssignmentId).state,
      "running",
    );
    const workerWorkId = service
      .list()
      .find((item) => item.turnId === "turn-2")?.workId;
    assert.ok(workerWorkId);
    const workerResult = await runtime.callTool({
      threadId: "thread-2",
      turnId: "turn-2",
      callId: "completion-worker-result",
      tool: "ensemble_report_result",
      arguments: { summary: "completion-result" },
    });
    assert.equal(workerResult.success, true);
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        workerWorkId,
      )?.state,
      "settled",
      "a worker result callback settles only that work's result effect",
    );
    const resultId = workerResult.text.split(" ").at(-1) ?? "";
    assert.match(resultId, /^[0-9a-f-]{36}$/i);
    runtime.complete(2);
    await runtime.waitForTurnNumber(3);

    const questionResponse = await runtime.callTool({
      threadId: leadThread,
      turnId: "turn-3",
      callId: "completion-question",
      tool: "ensemble_ask_question",
      arguments: { question: "Should the verification be retained?" },
    });
    assert.equal(questionResponse.success, true);
    const interactionId = questionResponse.text.split(" ").at(-1) ?? "";
    assert.match(interactionId, /^[0-9a-f-]{36}$/i);
    const firstCompletion = await runtime.callTool({
      threadId: leadThread,
      turnId: "turn-3",
      callId: "completion-blocked-request",
      tool: "ensemble_request_completion",
      arguments: { reviewedResultIds: [resultId] },
    });
    assert.equal(firstCompletion.success, true);
    const rejectedRequestId = firstCompletion.text.split(" ").at(-1) ?? "";
    assert.match(rejectedRequestId, /^[0-9a-f-]{36}$/i);
    const currentProject = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: Number(currentProject.version),
      paused: true,
    });
    runtime.complete(3);
    await waitUntil(() =>
      service
        .list()
        .some((item) => item.turnId === "turn-3" && item.state === "completed"),
    );
    let view = service.coordinationView().readTask(taskId);
    const rejected = view.completionRequests.find(
      (item) => item.requestId === rejectedRequestId,
    );
    const leadWorkId = service
      .list()
      .find((item) => item.turnId === "turn-3")?.workId;
    assert.ok(rejected);
    assert.ok(leadWorkId);
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.rejectionReasons.includes("open-interaction"));
    assert.ok(rejected.rejectionReasons.includes("project-paused"));
    assert.equal(view.task.state, "open");
    assert.equal(
      service.domain().assignment(leadAssignmentId).state,
      "running",
    );
    assert.equal(
      row(
        service,
        "SELECT state, reason FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        leadWorkId,
      )?.state,
      "settled",
      "a successfully terminal rejected request settles only its lead work effect",
    );
    assert.match(
      String(
        row(
          service,
          "SELECT reason FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          leadWorkId,
        )?.reason,
      ),
      /^Completion rejected:/,
    );

    const coordination = (
      service as unknown as { coordination: CoordinationStore }
    ).coordination;
    const rejectedReplay = coordination.finalizeTaskCompletion({
      requestId: rejectedRequestId,
      workId: leadWorkId,
      terminal: "completed",
    });
    assert.equal(rejectedReplay.completed, false);
    assert.deepEqual(rejectedReplay.reasons, rejected.rejectionReasons);

    await service.coordinationView().answerQuestion({
      taskId,
      key: randomUUID(),
      interactionId,
      expectedRevision: 1,
      answer: "Retain the verification.",
    });
    const unpaused = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: Number(unpaused.version),
      paused: false,
    });
    await runtime.waitForTurnNumber(4);
    assert.ok(runtime.resumed.includes(leadThread));
    assert.match(runtime.prompts[3] ?? "", /Retain the verification/);
    view = service.coordinationView().readTask(taskId);
    assert.equal(view.task.state, "open");
    assert.equal(
      view.completionRequests.find(
        (item) => item.requestId === rejectedRequestId,
      )?.status,
      "rejected",
    );

    const freshCompletion = await runtime.callTool({
      threadId: leadThread,
      turnId: "turn-4",
      callId: "completion-fresh-request",
      tool: "ensemble_request_completion",
      arguments: { reviewedResultIds: [resultId] },
    });
    assert.equal(freshCompletion.success, true);
    const freshRequestId = freshCompletion.text.split(" ").at(-1) ?? "";
    assert.match(freshRequestId, /^[0-9a-f-]{36}$/i);
    runtime.complete(4);
    await waitUntil(() =>
      service
        .list()
        .some((item) => item.turnId === "turn-4" && item.state === "completed"),
    );
    view = service.coordinationView().readTask(taskId);
    assert.equal(
      view.task.state,
      "done",
      JSON.stringify({
        completions: view.completionRequests,
        assignments: view.assignments.map((item) => ({
          assignmentId: item.assignmentId,
          state: item.state,
        })),
      }),
    );
    assert.equal(
      service.domain().assignment(leadAssignmentId).state,
      "completed",
    );
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        leadWorkId,
      )?.state,
      "settled",
      "finalization settles the exact successful lead work effect",
    );
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        workerWorkId,
      )?.state,
      "settled",
      "lead finalization leaves the separate worker effect settled by its result",
    );
    assert.equal(
      view.completionRequests.find(
        (item) => item.requestId === rejectedRequestId,
      )?.status,
      "rejected",
    );
    assert.equal(
      view.completionRequests.find((item) => item.requestId === freshRequestId)
        ?.status,
      "finalized",
    );
  } finally {
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart acknowledges the exact lead inbox batch before finalizing a completion commit gap", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-completion-gap-"));
  const runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  const leadProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  let coordination: CoordinationStore | undefined;
  let originalFinalizer:
    | CoordinationStore["finalizeTaskCompletion"]
    | undefined;
  let originalCompleteDelivery:
    | CoordinationStore["completeDeliveryBatch"]
    | undefined;
  let originalPrototypeFinalizer:
    | CoordinationStore["finalizeTaskCompletion"]
    | undefined;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Crash-gap lead",
      instructions: "Complete the task.",
      capabilities: "coordination",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Completion commit gap",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Recover exact completion",
      outcome: "Complete without delegating.",
      ready: false,
    });
    const leadAssignment = service.domain().ensureLeadAssignment(taskId);
    assert.ok(leadAssignment);
    const inboxMessage = await service.coordinationView().postOperatorMessage({
      taskId,
      key: randomUUID(),
      recipientAssignmentId: String(leadAssignment.id),
      expectedAssignmentVersion: Number(leadAssignment.version),
      message: "Review the durable result inbox before finalizing.",
    });
    await service.configureCapacity({
      key: randomUUID(),
      globalLimit: 1,
      projectOverrides: { [projectId]: 1 },
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });

    await runtime.waitForTurnNumber(1);
    const completion = await runtime.callTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "completion-gap-request",
      tool: "ensemble_request_completion",
      arguments: { reviewedResultIds: [] },
    });
    assert.equal(completion.success, true);
    const requestId = completion.text.split(" ").at(-1) ?? "";
    assert.match(requestId, /^[0-9a-f-]{36}$/i);
    const workId = service
      .list()
      .find((item) => item.turnId === "turn-1")?.workId;
    assert.ok(workId);

    coordination = (service as unknown as { coordination: CoordinationStore })
      .coordination;
    originalFinalizer = coordination.finalizeTaskCompletion.bind(coordination);
    const completeDelivery =
      coordination.completeDeliveryBatch.bind(coordination);
    originalCompleteDelivery = completeDelivery;
    const queuedBatch = coordination.deliveryForWork(workId);
    assert.ok(queuedBatch);
    coordination.completeDeliveryBatch = (deliveryWorkId) =>
      deliveryWorkId === workId
        ? queuedBatch
        : completeDelivery(deliveryWorkId);
    coordination.finalizeTaskCompletion = (input) => {
      if (input.requestId !== requestId || input.workId !== workId)
        return originalFinalizer?.(input) as ReturnType<
          CoordinationStore["finalizeTaskCompletion"]
        >;
      const request = coordination
        ?.completionRequests(taskId)
        .find((item) => item.requestId === requestId);
      assert.ok(request);
      return {
        completed: false,
        reasons: ["simulated-finalizer-gap"],
        request,
      };
    };
    runtime.complete(1);
    await waitUntil(() =>
      service
        .list()
        .some((item) => item.workId === workId && item.state === "completed"),
    );
    assert.equal(
      service.coordinationView().readTask(taskId).completionRequests[0]?.status,
      "pending",
    );
    assert.equal(
      coordination.deliveryForWork(workId)?.state,
      "queued",
      "the simulated crash leaves the exact lead inbox batch unacknowledged",
    );
    assert.equal(
      service
        .coordinationView()
        .readTask(taskId)
        .messages.find((message) => message.eventId === inboxMessage.eventId)
        ?.deliveryState,
      "queued",
    );
    assert.equal(service.domain().task(taskId).state, "open");
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        workId,
      )?.state,
      "pending",
      "the finalizer crash gap preserves the pending lead result effect",
    );
    assert.equal(
      service
        .domain()
        .assignment(String(service.domain().assignments(taskId)[0]?.id ?? ""))
        .state,
      "running",
    );

    coordination.finalizeTaskCompletion = originalFinalizer;
    await service.stop();
    running = false;
    originalPrototypeFinalizer =
      CoordinationStore.prototype.finalizeTaskCompletion;
    CoordinationStore.prototype.finalizeTaskCompletion = function (input) {
      if (input.requestId !== requestId || input.workId !== workId)
        return originalPrototypeFinalizer?.call(this, input) as ReturnType<
          CoordinationStore["finalizeTaskCompletion"]
        >;
      const request = this.completionRequests(taskId).find(
        (item) => item.requestId === requestId,
      );
      assert.ok(request);
      return {
        completed: false,
        reasons: ["simulated-post-ack-finalizer-gap"],
        request,
      };
    };
    try {
      await service.start();
      running = true;
    } finally {
      CoordinationStore.prototype.finalizeTaskCompletion =
        originalPrototypeFinalizer;
    }
    const afterBatchAcknowledgement = (
      service as unknown as { coordination: CoordinationStore }
    ).coordination;
    assert.equal(
      afterBatchAcknowledgement.deliveryForWork(workId)?.state,
      "completed",
    );
    assert.equal(
      service.coordinationView().readTask(taskId).completionRequests[0]?.status,
      "pending",
      "a crash after batch acknowledgement keeps its exact completion request retryable",
    );
    assert.equal(service.domain().task(taskId).state, "open");
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        workId,
      )?.state,
      "pending",
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_reporting_repairs WHERE taskId = ?",
        taskId,
      ),
      0,
    );
    await service.stop();
    running = false;
    await service.start();
    running = true;
    const recovered = service.coordinationView().readTask(taskId);
    assert.equal(
      recovered.task.state,
      "done",
      JSON.stringify({
        completions: recovered.completionRequests,
        assignments: recovered.assignments.map((item) => ({
          assignmentId: item.assignmentId,
          state: item.state,
        })),
      }),
    );
    assert.equal(recovered.completionRequests[0]?.status, "finalized");
    assert.equal(
      service
        .coordinationView()
        .readTask(taskId)
        .messages.find((message) => message.eventId === inboxMessage.eventId)
        ?.deliveryState,
      "delivered",
      "recovery acknowledges inbox delivery before the completion gate",
    );
    assert.equal(
      rowCount(
        service,
        "SELECT COUNT(*) AS count FROM coordination_reporting_repairs WHERE taskId = ?",
        taskId,
      ),
      0,
    );
    assert.equal(
      service.domain().assignment(recovered.assignments[0]?.assignmentId ?? "")
        .state,
      "completed",
    );
    assert.equal(
      row(
        service,
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
        workId,
      )?.state,
      "settled",
      "restart reconciliation settles only the exact completed lead work effect",
    );
  } finally {
    if (originalPrototypeFinalizer)
      CoordinationStore.prototype.finalizeTaskCompletion =
        originalPrototypeFinalizer;
    if (coordination && originalFinalizer)
      coordination.finalizeTaskCompletion = originalFinalizer;
    if (coordination && originalCompleteDelivery)
      coordination.completeDeliveryBatch = originalCompleteDelivery;
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a result-free turn gets one durable reporting repair then holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s04b-repair-"));
  const runtime = new CoordinationRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
    } satisfies StandaloneServiceOptions,
  );
  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let running = false;
  try {
    await service.start();
    running = true;
    command(service, {
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Lead",
      instructions: "Coordinate",
      capabilities: "delegate",
    });
    command(service, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Reporting repair",
      leadProfileId: profileId,
    });
    command(service, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Report a result",
      outcome: "Persist a result",
      ready: false,
    });
    await service.provisionTask(taskId);
    command(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });

    await runtime.waitForTurnNumber(1);
    runtime.complete(1);
    await runtime.waitForTurnNumber(2);
    assert.match(runtime.prompts[1] ?? "", /Reporting repair/);
    runtime.complete(2);
    await waitUntil(
      () =>
        service
          .domain()
          .assignments(taskId)
          .find((item) => item.profileId === profileId)?.state === "held",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.turns, 2);
    const repairs = (
      service as unknown as { coordination: CoordinationStore }
    ).coordination.reportingRepairs();
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0]?.attempts, 2);
    assert.equal(repairs[0]?.state, "held");
    assert.ok(
      rowCount(
        service,
        `SELECT COUNT(*) AS count FROM execution_pending_effects effect
        JOIN task_execution_bindings binding ON binding.workId = effect.workId
        WHERE binding.taskId = ? AND effect.state = 'pending'`,
        taskId,
      ) > 0,
      "assignment completion still requires an explicit result callback",
    );

    await service.stop();
    running = false;
    await service.start();
    running = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.turns, 2);
    assert.equal(
      service
        .domain()
        .assignments(taskId)
        .find((item) => item.profileId === profileId)?.state,
      "held",
    );
  } finally {
    if (running) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
