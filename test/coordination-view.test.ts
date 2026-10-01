import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { RoutingFailure } from "../src/standalone/routing.js";
import {
  StandaloneService,
  type StandaloneServiceOptions,
} from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("coordination view fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

class ViewRuntime implements Runtime {
  starts = 0;
  turns = 0;
  readonly prompts: string[] = [];
  readonly resumed: string[] = [];
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
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
    _tools?: readonly RuntimeToolDefinition[],
  ) {
    return `thread-${++this.starts}`;
  }

  async resumeThread(
    threadId: string,
    _tools?: readonly RuntimeToolDefinition[],
  ) {
    this.resumed.push(threadId);
  }

  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    const turnId = `turn-${++this.turns}`;
    this.prompts.push(prompt);
    this.outcomes.set(turnId, deferred());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  complete(turn: number) {
    this.outcomes.get(`turn-${turn}`)?.resolve("completed");
  }

  callTool(call: RuntimeToolCall) {
    assert.ok(this.toolCall, "service registered the runtime tool listener");
    return this.toolCall(call);
  }
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...body } as never);
}

async function fixture(
  routingClient: StandaloneServiceOptions["routingClient"] = null,
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-coordination-view-"));
  const runtime = new ViewRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      routingClient,
    } satisfies StandaloneServiceOptions,
  );
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const otherTaskId = randomUUID();
  await service.start();
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId: leadProfileId,
    name: "Task lead",
    instructions: "Coordinate safe work.",
    capabilities: "coordination",
  });
  command(service, {
    type: "profile.create",
    actor: "operator",
    profileId: workerProfileId,
    name: "Worker",
    instructions: "Review output.",
    capabilities: "review",
  });
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Scoped project",
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
    guidance: "Pick a suitable profile.",
    credentialRef: "env:S04B_VIEW_ROUTING_SECRET",
    candidateProfileIds: [workerProfileId],
  });
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Scoped task",
    outcome: "APP_SERVER_RAW_SENTINEL",
    ready: false,
  });
  command(service, {
    type: "project.create",
    actor: "operator",
    projectId: otherProjectId,
    name: "Unrelated project",
    leadProfileId,
  });
  command(service, {
    type: "task.create",
    actor: "operator",
    projectId: otherProjectId,
    taskId: otherTaskId,
    title: "Other task secret title",
    outcome: "OTHER_PROJECT_RAW_SENTINEL",
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
  await waitUntil(() => runtime.turns > 0);
  const leadAssignment = service
    .domain()
    .assignments(taskId)
    .find((assignment) => assignment.profileId === leadProfileId);
  assert.ok(leadAssignment);
  command(service, {
    type: "assignment.create",
    actor: "operator",
    projectId,
    taskId,
    assignmentId: randomUUID(),
    profileId: workerProfileId,
    brief: "Review scoped output.",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const workerAssignment = service
    .domain()
    .assignments(taskId)
    .find((assignment) => assignment.profileId === workerProfileId);
  assert.ok(workerAssignment);
  await waitUntil(() =>
    service
      .turnRequests()
      .some((request) => request.assignmentId === workerAssignment.id),
  );
  const leadRequest = service
    .turnRequests()
    .find((request) => request.assignmentId === leadAssignment.id);
  assert.ok(leadRequest);
  const leadWork = service
    .list()
    .find(
      (item) => item.workId === leadRequest.workId && item.state === "running",
    );
  assert.ok(leadWork?.threadId && leadWork.turnId);
  const database = (
    service as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): void } };
    }
  ).db;
  database
    .prepare(
      "UPDATE domain_assignments SET resultRecipientDisposition = 'unresolved' WHERE id = ?",
    )
    .run(workerAssignment.id);
  return {
    root,
    runtime,
    service,
    taskId,
    otherProjectId,
    otherTaskId,
    assignmentId: String(leadAssignment.id),
    workerAssignmentId: String(workerAssignment.id),
    threadId: leadWork.threadId,
    turnId: leadWork.turnId,
  };
}

test("coordination routing view exposes only the bounded provider failure code", async () => {
  const f = await fixture({
    choose: async () => {
      throw new RoutingFailure(
        "PRIVATE_PROVIDER_ERROR_BODY_SENTINEL",
        "permanent",
        "http-401",
      );
    },
  });
  try {
    await waitUntil(() => {
      const attempts = f.service.coordinationView().readTask(f.taskId)
        .routing.attempts;
      return attempts.some((operation) => operation.attempts.length > 0);
    });
    const dto = f.service.coordinationView().readTask(f.taskId);
    const attempts = dto.routing.attempts.flatMap(
      (operation) => operation.attempts,
    );
    assert.equal(attempts[0]?.failureCode, "http-401");
    assert.doesNotMatch(
      JSON.stringify(dto),
      /PRIVATE_PROVIDER_ERROR_BODY_SENTINEL|S04B_VIEW_ROUTING_SECRET|env:S04B_VIEW_ROUTING_SECRET/,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("task coordination view is scoped, durable, and excludes runtime internals", async () => {
  const f = await fixture();
  try {
    const call = (
      threadId: string,
      turnId: string,
      tool: string,
      args: Record<string, unknown>,
      callId: string,
    ) =>
      f.runtime.callTool({
        threadId,
        turnId,
        callId,
        tool,
        arguments: args,
      });
    const questionResult = await call(
      f.threadId,
      f.turnId,
      "ensemble_ask_question",
      { question: "Which compatibility target should remain?" },
      "call-question",
    );
    assert.equal(questionResult.success, true, questionResult.text);
    assert.equal(
      (
        await call(
          f.threadId,
          f.turnId,
          "ensemble_request_approval",
          {
            action: "Publish package",
            target: "ensemble@next",
            material: { version: "next" },
          },
          "call-approval",
        )
      ).success,
      true,
    );
    assert.equal(f.runtime.turns, 1);
    f.runtime.complete(1);
    await waitUntil(() =>
      f.service.list().some((item) => item.state === "completed"),
    );
    await waitUntil(() => f.runtime.turns >= 2);
    const workerRequest = f.service
      .turnRequests()
      .find((request) => request.assignmentId === f.workerAssignmentId);
    assert.ok(workerRequest);
    const workerWork = f.service
      .list()
      .find(
        (item) =>
          item.workId === workerRequest.workId && item.state === "running",
      );
    assert.ok(workerWork?.threadId && workerWork.turnId);
    assert.equal(
      (
        await call(
          workerWork.threadId,
          workerWork.turnId,
          "ensemble_report_result",
          { summary: "Reviewed parser output" },
          "call-result",
        )
      ).success,
      true,
    );
    f.runtime.complete(2);
    await waitUntil(() =>
      f.service
        .list()
        .some(
          (item) =>
            item.workId === workerRequest.workId && item.state === "completed",
        ),
    );

    let view = f.service.coordinationView();
    const dto = view.readTask(f.taskId);
    assert.equal(dto.task.id, f.taskId);
    assert.equal(dto.task.projectId !== f.otherProjectId, true);
    assert.equal(dto.history.length, 2);
    assert.equal(
      dto.history.some((entry) => entry.threadId === f.threadId),
      true,
    );
    assert.equal(dto.results.length, 1);
    assert.equal(dto.unresolvedResults.length, 1);
    assert.equal(
      dto.messages.some((message) => message.eventType === "routing-fallback"),
      true,
    );
    assert.equal(
      dto.messages.find((message) => message.eventType === "routing-fallback")
        ?.deliveryState,
      "delivered",
    );
    assert.equal(dto.questions.length, 1);
    assert.equal(dto.approvals.length, 1);
    assert.equal(dto.approvals[0]?.materialJson, '{"version":"next"}');
    assert.equal(dto.attention.interactions.length, 2);
    assert.equal(dto.attention.routingFallbacks.length, 1);
    assert.equal(dto.routing.dispositions.length, 1);
    assert.equal(dto.routing.attempts.length, 1);
    assert.equal(
      view
        .readTask(f.otherTaskId)
        .approvals.some((approval) => approval.materialJson !== null),
      false,
    );

    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes(f.otherTaskId), false);
    assert.equal(serialized.includes("Other task secret title"), false);
    assert.equal(serialized.includes("OTHER_PROJECT_RAW_SENTINEL"), false);
    assert.equal(serialized.includes("APP_SERVER_RAW_SENTINEL"), false);
    assert.equal(serialized.includes("S04B_VIEW_ROUTING_SECRET"), false);
    assert.equal(serialized.includes("env:S04B_VIEW_ROUTING_SECRET"), false);
    assert.equal(Object.hasOwn(dto.history[0] ?? {}, "prompt"), false);
    assert.equal(serialized.includes('"workspace"'), false);
    assert.equal(serialized.includes('"payload"'), false);

    await f.service.stop();
    const runtime = new ViewRuntime();
    const service = new StandaloneService(
      join(f.root, "data"),
      () => runtime,
      undefined,
      {
        power: { enabled: false },
        routingClient: null,
      } satisfies StandaloneServiceOptions,
    );
    f.service = service;
    f.runtime = runtime;
    await service.start();
    view = service.coordinationView();
    const reopened = view.readTask(f.taskId);
    assert.equal(reopened.results[0]?.resultId, dto.results[0]?.resultId);
    assert.equal(reopened.unresolvedResults.length, 1);
    assert.equal(reopened.questions[0]?.status, "open");
    assert.equal(reopened.approvals[0]?.status, "open");
    assert.equal(reopened.history.length, 2);
    assert.equal(
      reopened.messages.find(
        (message) => message.eventType === "routing-fallback",
      )?.deliveryState,
      "delivered",
    );

    const question = reopened.questions[0];
    const approval = reopened.approvals[0];
    const unresolved = reopened.unresolvedResults[0];
    assert.ok(question && approval && unresolved);
    await assert.rejects(
      view.answerQuestion({
        taskId: f.otherTaskId,
        key: randomUUID(),
        interactionId: question.interactionId,
        expectedRevision: question.revision,
        answer: "Not in this task",
      }),
      /Question is not in this task/,
    );
    const eventsBeforeStale = reopened.messages.length;
    await assert.rejects(
      view.answerQuestion({
        taskId: f.taskId,
        key: randomUUID(),
        interactionId: question.interactionId,
        expectedRevision: question.revision + 1,
        answer: "Stale answer",
      }),
      /revision conflict/,
    );
    await assert.rejects(
      view.decideApproval({
        taskId: f.taskId,
        key: randomUUID(),
        interactionId: approval.interactionId,
        expectedRevision: approval.revision,
        decision: "approved",
        action: approval.action ?? "",
        ...(approval.target === null ? {} : { target: approval.target }),
        material: { version: "changed" },
      }),
      /material does not match/,
    );
    await assert.rejects(
      view.reconcileResultRecipient({
        taskId: f.taskId,
        key: randomUUID(),
        resultId: unresolved.resultId,
        expectedRevision: unresolved.revision + 1,
        recipientAssignmentId: f.assignmentId,
      }),
      /revision conflict/,
    );
    assert.equal(view.readTask(f.taskId).messages.length, eventsBeforeStale);
    assert.equal(view.readTask(f.taskId).unresolvedResults.length, 1);

    const messageCommand = {
      taskId: f.taskId,
      key: randomUUID(),
      recipientAssignmentId: f.assignmentId,
      expectedAssignmentVersion: 1,
      message: "Please inspect the final output.",
    };
    await assert.rejects(
      view.postOperatorMessage({
        ...messageCommand,
        key: randomUUID(),
        expectedAssignmentVersion: 2,
      }),
      /assignment version conflict/,
    );
    const messageReceipt = await view.postOperatorMessage(messageCommand);
    assert.equal(
      (await view.postOperatorMessage(messageCommand)).eventId,
      messageReceipt.eventId,
    );
    await assert.rejects(
      view.postOperatorMessage({
        ...messageCommand,
        message: "Changed content",
      }),
      /key reused with different content/,
    );

    const resultCommand = {
      taskId: f.taskId,
      key: randomUUID(),
      resultId: unresolved.resultId,
      expectedRevision: unresolved.revision,
      recipientAssignmentId: f.assignmentId,
    };
    const resultReceipt = await view.reconcileResultRecipient(resultCommand);
    assert.equal(
      (await view.reconcileResultRecipient(resultCommand)).eventId,
      resultReceipt.eventId,
    );
    await assert.rejects(
      view.reconcileResultRecipient({
        ...resultCommand,
        expectedRevision: unresolved.revision + 1,
      }),
      /key reused with different content/,
    );

    const questionCommand = {
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: "Keep the stable compatibility target.",
    };
    const answerReceipt = await view.answerQuestion(questionCommand);
    assert.equal(
      (await view.answerQuestion(questionCommand)).eventId,
      answerReceipt.eventId,
    );
    await assert.rejects(
      view.answerQuestion({ ...questionCommand, answer: "Changed answer" }),
      /key reused with different content/,
    );

    const approvalCommand = {
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: approval.interactionId,
      expectedRevision: approval.revision,
      decision: "denied" as const,
      action: approval.action ?? "",
      ...(approval.target === null ? {} : { target: approval.target }),
      material: { version: "next" },
    };
    const decisionReceipt = await view.decideApproval(approvalCommand);
    assert.equal(
      (await view.decideApproval(approvalCommand)).eventId,
      decisionReceipt.eventId,
    );
    await assert.rejects(
      view.decideApproval({ ...approvalCommand, decision: "approved" }),
      /key reused with different content/,
    );

    const receipts = [
      messageReceipt,
      resultReceipt,
      answerReceipt,
      decisionReceipt,
    ];
    assert.deepEqual(
      receipts.map((receipt) => receipt.recipientAssignmentId),
      Array(4).fill(f.assignmentId),
    );
    const finalView = view.readTask(f.taskId);
    assert.equal(finalView.unresolvedResults.length, 0);
    assert.equal(finalView.questions[0]?.status, "answered");
    assert.equal(finalView.approvals[0]?.status, "denied");
    for (const receipt of receipts)
      assert.equal(
        finalView.messages.filter(
          (message) => message.eventId === receipt.eventId,
        ).length,
        1,
      );
    await waitUntil(() => runtime.turns > 0);
    await waitUntil(() => runtime.resumed.includes(f.threadId));
    assert.equal(
      service
        .turnRequests()
        .some(
          (request) =>
            request.assignmentId === f.assignmentId &&
            request.kind === "assignment",
        ),
      true,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
