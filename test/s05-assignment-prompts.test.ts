import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import type {
  RoutingChoiceClient,
  RoutingChoiceRequest,
  RoutingChoiceResponse,
} from "../src/standalone/routing.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { StandaloneService } from "../src/standalone/service.js";

type ToolListener = (call: RuntimeToolCall) => Promise<RuntimeToolResult>;

class JourneyRuntime implements Runtime {
  turns = 0;
  starts = 0;
  maxActiveTurns = 0;
  activeTurns = 0;
  prompts: string[] = [];
  profilesAtTurnStart: string[][] = [];
  resultCalls: RuntimeToolResult[] = [];
  completionCalls: RuntimeToolResult[] = [];
  handleTurn: ((threadId: string, turnId: string) => Promise<void>) | undefined;
  mutateAfterInitialPrompts: (() => void) | undefined;
  private mutated = false;
  private listener: ToolListener | undefined;
  private service: StandaloneService | undefined;
  private taskId: string | undefined;

  observe(service: StandaloneService, taskId: string): void {
    this.service = service;
    this.taskId = taskId;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async startThread(): Promise<string> {
    this.starts++;
    return `thread-${this.starts}`;
  }

  async resumeThread(): Promise<void> {}

  async startTurn(
    _threadId: string,
    _workspace: string,
    prompt: string,
  ): Promise<string> {
    this.turns++;
    this.prompts.push(prompt);
    const service = this.service;
    const taskId = this.taskId;
    this.profilesAtTurnStart.push(
      service && taskId
        ? service
            .domain()
            .assignments(taskId)
            .map((assignment) => String(assignment.profileId))
        : [],
    );
    if (this.turns === 2 && !this.mutated) {
      this.mutated = true;
      this.mutateAfterInitialPrompts?.();
    }
    return `turn-${this.turns}`;
  }

  async interruptTurn(): Promise<void> {}

  async waitForTurn(threadId: string, turnId: string) {
    this.activeTurns++;
    this.maxActiveTurns = Math.max(this.maxActiveTurns, this.activeTurns);
    try {
      const turn = Number(turnId.slice("turn-".length));
      assert.ok(turn > 0);
      await this.handleTurn?.(threadId, turnId);
      return "completed" as const;
    } finally {
      this.activeTurns--;
    }
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void): void {}

  onToolCall(listener: ToolListener): void {
    this.listener = listener;
  }

  async callTool(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    assert.ok(this.listener, "service registers the runtime tool callback");
    return this.listener(call);
  }
}

class FixedRoutingClient implements RoutingChoiceClient {
  requests: RoutingChoiceRequest[] = [];

  constructor(private readonly profileId: string) {}

  async choose(
    request: RoutingChoiceRequest,
    _signal: AbortSignal,
  ): Promise<RoutingChoiceResponse> {
    this.requests.push(request);
    const probability = 0.9;
    return {
      choice: this.profileId,
      model: request.requestedModel,
      confidence: probability,
      probabilities: Object.fromEntries(
        request.choices.map((choice) => [
          choice,
          choice === this.profileId
            ? probability
            : (1 - probability) / (request.choices.length - 1),
        ]),
      ),
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body } as never);
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  diagnostics: () => unknown = () => undefined,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(
        `${description} timed out; ${JSON.stringify(diagnostics())}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("task turns include their captured instructions and lead accountability context", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-prompt-context-"));
  const projectId = randomUUID();
  const leadProfileId = randomUUID();
  const workerTaskId = randomUUID();
  const leadTaskId = randomUUID();
  const workerAssignmentId = randomUUID();
  let service: StandaloneService | undefined;
  const runtime = new JourneyRuntime();
  const currentService = () => {
    if (!service) throw new Error("Service is not started");
    return service;
  };

  try {
    service = new StandaloneService(
      join(root, "data"),
      () => runtime,
      undefined,
      {
        power: { enabled: false },
        routingClient: null,
      },
    );
    runtime.observe(service, workerTaskId);
    await service.start();

    command(service, {
      type: "profile.create",
      profileId: leadProfileId,
      name: "S05 lead profile",
      instructions: "S05_LEAD_PROFILE_REVISION_ONE",
      capabilities: "task coordination",
    });
    command(service, {
      type: "project.create",
      projectId,
      name: "S05 prompt context project",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
      instructions: "S05_PROJECT_INSTRUCTIONS_REVISION_ONE",
    });
    command(service, {
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    const tasks: Array<[string, string, string]> = [
      [workerTaskId, "S05 worker prompt task", "S05_WORKER_BRIEF_SENTINEL"],
      [leadTaskId, "S05 lead prompt task", "S05_LEAD_BRIEF_SENTINEL"],
    ];
    for (const [taskId, title, outcome] of tasks) {
      command(service, {
        type: "task.create",
        projectId,
        taskId,
        title,
        outcome,
        ready: false,
      });
      await service.provisionTask(taskId);
    }
    command(service, {
      type: "assignment.create",
      projectId,
      taskId: workerTaskId,
      assignmentId: workerAssignmentId,
      profileId: leadProfileId,
      brief: "S05_WORKER_ASSIGNMENT_BRIEF",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });

    runtime.mutateAfterInitialPrompts = () => {
      command(currentService(), {
        type: "profile.configure",
        profileId: leadProfileId,
        expectedVersion: 1,
        instructions: "S05_LEAD_PROFILE_REVISION_TWO",
      });
      command(currentService(), {
        type: "project.configure",
        projectId,
        expectedVersion: 2,
        instructions: "S05_PROJECT_INSTRUCTIONS_REVISION_TWO",
      });
    };
    runtime.handleTurn = async (threadId, turnId) => {
      await runtime.callTool({
        threadId,
        turnId,
        callId: `s05-prompt-question-${turnId}`,
        tool: "ensemble_ask_question",
        arguments: { question: `S05_PROMPT_QUESTION_${turnId}` },
      });
    };

    await service.configureCapacity({
      key: randomUUID(),
      globalLimit: 2,
    });
    command(service, {
      type: "task.configure",
      projectId,
      taskId: workerTaskId,
      expectedVersion: 1,
      ready: true,
    });
    command(service, {
      type: "task.configure",
      projectId,
      taskId: leadTaskId,
      expectedVersion: 1,
      ready: true,
    });
    await service.provisionTask(workerTaskId);
    await service.provisionTask(leadTaskId);
    assert.notEqual(
      service
        .domain()
        .leadBindings()
        .find((binding) => binding.taskId === workerTaskId)?.assignmentId,
      workerAssignmentId,
    );
    await waitUntil(
      () => runtime.prompts.length >= 2,
      "lead and worker turns",
      () => ({
        starts: runtime.starts,
        turns: runtime.turns,
        requestStates: currentService()
          .turnRequests()
          .map((request) => request.state),
        workerState: currentService().domain().task(workerTaskId).state,
        leadState: currentService().domain().task(leadTaskId).state,
        workerAdmission: currentService().domain().admission(workerTaskId)
          .eligible,
        leadAdmission: currentService().domain().admission(leadTaskId).eligible,
      }),
    );
    await waitUntil(
      () =>
        currentService()
          .coordinationView()
          .readTask(workerTaskId)
          .questions.some(
            (question) =>
              question.requestingAssignmentId === workerAssignmentId,
          ),
      "worker question",
    );

    const workerPrompt = runtime.prompts.find((prompt) =>
      prompt.includes("S05_WORKER_ASSIGNMENT_BRIEF"),
    );
    const leadPrompt = runtime.prompts.find((prompt) =>
      prompt.includes("S05_LEAD_BRIEF_SENTINEL"),
    );
    assert.ok(
      workerPrompt,
      JSON.stringify(
        runtime.prompts.map((prompt) => ({
          workerBrief: prompt.includes("S05_WORKER_ASSIGNMENT_BRIEF"),
          workerOutcome: prompt.includes("S05_WORKER_BRIEF_SENTINEL"),
          leadOutcome: prompt.includes("S05_LEAD_BRIEF_SENTINEL"),
        })),
      ),
    );
    assert.ok(leadPrompt);
    assert.match(workerPrompt, /S05_PROJECT_INSTRUCTIONS_REVISION_ONE/);
    assert.match(workerPrompt, /S05_LEAD_PROFILE_REVISION_ONE/);
    assert.doesNotMatch(workerPrompt, /REVISION_TWO/);
    assert.match(workerPrompt, /Assignment role: project assignee/i);
    assert.doesNotMatch(workerPrompt, /Assignment role: project lead/i);
    assert.match(workerPrompt, /project lead remains accountable/i);
    assert.match(workerPrompt, /assignee/i);
    assert.match(leadPrompt, /S05_PROJECT_INSTRUCTIONS_REVISION_ONE/);
    assert.match(leadPrompt, /S05_LEAD_PROFILE_REVISION_ONE/);
    assert.doesNotMatch(leadPrompt, /REVISION_TWO/);
    assert.match(leadPrompt, /Assignment role: project lead/i);
    assert.match(leadPrompt, /project lead/i);
    assert.match(leadPrompt, /accountable/i);
    assert.ok(
      service
        .turnRequests()
        .every(
          (request) =>
            !request.prompt.includes("S05_PROJECT_INSTRUCTIONS_REVISION_ONE") &&
            !request.prompt.includes("S05_LEAD_PROFILE_REVISION_ONE"),
        ),
      "captured instructions are composed at runtime, not copied into durable queued prompts",
    );

    command(service, {
      type: "assignment.apply",
      projectId,
      assignmentId: workerAssignmentId,
      expectedVersion: 1,
    });
    const question = service
      .coordinationView()
      .readTask(workerTaskId)
      .questions.find(
        (item) => item.requestingAssignmentId === workerAssignmentId,
      );
    assert.ok(question);
    await service.coordinationView().answerQuestion({
      key: randomUUID(),
      taskId: workerTaskId,
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: "S05_OPERATOR_ANSWER_REVISION_TWO",
    });
    await waitUntil(
      () =>
        runtime.prompts.some(
          (prompt) =>
            prompt.includes("S05_WORKER_ASSIGNMENT_BRIEF") &&
            prompt.includes("S05_OPERATOR_ANSWER_REVISION_TWO"),
        ),
      "worker's next turn after explicit apply",
    );
    const workerFollowUpPrompt = runtime.prompts.find(
      (prompt) =>
        prompt.includes("S05_WORKER_ASSIGNMENT_BRIEF") &&
        prompt.includes("S05_OPERATOR_ANSWER_REVISION_TWO"),
    );
    assert.ok(workerFollowUpPrompt);
    assert.match(workerFollowUpPrompt, /S05_PROJECT_INSTRUCTIONS_REVISION_TWO/);
    assert.match(workerFollowUpPrompt, /S05_LEAD_PROFILE_REVISION_TWO/);
    assert.doesNotMatch(workerFollowUpPrompt, /REVISION_ONE/);
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("routed candidate result materializes and wakes the task lead at capacity one", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-routed-lead-"));
  const projectId = randomUUID();
  const leadProfileId = randomUUID();
  const candidateProfileId = randomUUID();
  const taskId = randomUUID();
  let service: StandaloneService | undefined;
  const runtime = new JourneyRuntime();
  const routingClient = new FixedRoutingClient(candidateProfileId);
  const currentService = () => {
    if (!service) throw new Error("Service is not started");
    return service;
  };

  try {
    service = new StandaloneService(
      join(root, "data"),
      () => runtime,
      undefined,
      {
        power: { enabled: false },
        routingClient,
      },
    );
    runtime.observe(service, taskId);
    runtime.handleTurn = async (threadId, turnId) => {
      if (turnId === "turn-1") {
        runtime.resultCalls.push(
          await runtime.callTool({
            threadId,
            turnId,
            callId: "s05-candidate-result",
            tool: "ensemble_report_result",
            arguments: { summary: "S05_ROUTED_CANDIDATE_RESULT" },
          }),
        );
      } else if (turnId === "turn-2") {
        const reviewedResultIds = currentService()
          .coordinationView()
          .readTask(taskId)
          .results.map((result) => result.resultId);
        runtime.completionCalls.push(
          await runtime.callTool({
            threadId,
            turnId,
            callId: "s05-lead-completion",
            tool: "ensemble_request_completion",
            arguments: { reviewedResultIds },
          }),
        );
      }
    };
    await service.start();
    command(service, {
      type: "profile.create",
      profileId: leadProfileId,
      name: "S05 accountable lead",
      instructions: "S05_ACCOUNTABLE_LEAD_INSTRUCTIONS",
      capabilities: "task coordination",
    });
    command(service, {
      type: "profile.create",
      profileId: candidateProfileId,
      name: "S05 routed candidate",
      instructions: "S05_ROUTED_CANDIDATE_INSTRUCTIONS",
      capabilities: "candidate work",
    });
    command(service, {
      type: "project.create",
      projectId,
      name: "S05 routed lead project",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
      instructions: "S05_ROUTED_PROJECT_INSTRUCTIONS",
    });
    command(service, {
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Select the eligible implementation profile.",
      candidateProfileIds: [candidateProfileId],
      credentialRef: "env:S05_ROUTING_FIXTURE",
    });
    command(service, {
      type: "task.create",
      projectId,
      taskId,
      title: "S05 routed task lead result",
      outcome: "S05_ROUTED_TASK_BRIEF",
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
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    await service.provisionTask(taskId);

    await waitUntil(
      () => currentService().domain().task(taskId).state === "done",
      "routed result and lead completion",
      () => ({
        starts: runtime.starts,
        turns: runtime.turns,
        requestStates: currentService()
          .turnRequests()
          .map((request) => request.state),
        taskState: currentService().domain().task(taskId).state,
        admission: currentService().domain().admission(taskId).eligible,
        assignments: currentService().domain().assignments(taskId).length,
        routingRequests: routingClient.requests.length,
        results: currentService().coordinationView().readTask(taskId).results
          .length,
      }),
    );

    assert.equal(routingClient.requests.length, 1);
    assert.equal(runtime.turns, 2);
    assert.equal(runtime.maxActiveTurns, 1);
    assert.deepEqual(runtime.profilesAtTurnStart[0], [candidateProfileId]);
    assert.deepEqual(
      runtime.profilesAtTurnStart[1]?.sort(),
      [candidateProfileId, leadProfileId].sort(),
    );
    assert.match(runtime.prompts[0] ?? "", /S05_ROUTED_CANDIDATE_INSTRUCTIONS/);
    assert.match(runtime.prompts[0] ?? "", /S05_ROUTED_PROJECT_INSTRUCTIONS/);
    assert.match(runtime.prompts[0] ?? "", /project lead remains accountable/i);
    assert.match(runtime.prompts[1] ?? "", /S05_ACCOUNTABLE_LEAD_INSTRUCTIONS/);
    assert.match(runtime.prompts[1] ?? "", /S05_ROUTED_PROJECT_INSTRUCTIONS/);
    assert.match(runtime.prompts[1] ?? "", /project lead/i);
    assert.equal(runtime.resultCalls.length, 1);
    assert.equal(runtime.resultCalls[0]?.success, true);
    assert.equal(runtime.completionCalls.length, 1);
    assert.equal(runtime.completionCalls[0]?.success, true);

    const view = service.coordinationView().readTask(taskId);
    const leadAssignment = service
      .domain()
      .assignments(taskId)
      .find((assignment) => assignment.profileId === leadProfileId);
    const candidateAssignment = service
      .domain()
      .assignments(taskId)
      .find((assignment) => assignment.profileId === candidateProfileId);
    assert.ok(leadAssignment);
    assert.ok(candidateAssignment);
    assert.equal(view.task.state, "done");
    assert.equal(view.results.length, 1);
    assert.ok(
      view.messages.some(
        (message) =>
          message.eventType === "assignment-result" &&
          message.recipientAssignmentId === leadAssignment.id &&
          message.deliveryState === "delivered",
      ),
    );
    const leadRequest = service
      .turnRequests()
      .find((request) => request.assignmentId === leadAssignment.id);
    const candidateRequest = service
      .turnRequests()
      .find((request) => request.assignmentId === candidateAssignment.id);
    assert.ok(leadRequest);
    assert.ok(candidateRequest);
    assert.equal(candidateRequest.state, "completed");
    assert.equal(leadRequest.state, "completed");
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("instruction apply rebinds only a never-admitted stale inbox batch", async (t) => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-s05-rebind-refused-inbox-"),
  );
  const projectId = randomUUID();
  const leadProfileId = randomUUID();
  const refusedBeforeApplyTaskId = randomUUID();
  const applyBeforeRefusalTaskId = randomUUID();
  const runtime = new JourneyRuntime();
  const turnsByTask = new Map<string, number>();
  let service: StandaloneService | undefined;
  let turnsDuringHandler = 0;
  const currentService = () => {
    if (!service) throw new Error("Service is not started");
    return service;
  };
  const database = () =>
    (
      currentService() as unknown as {
        db: {
          prepare(sql: string): {
            get(...args: unknown[]): unknown;
            all(...args: unknown[]): unknown[];
          };
        };
      }
    ).db;
  const row = <T>(sql: string, ...args: unknown[]) =>
    database()
      .prepare(sql)
      .get(...args) as T | undefined;
  const rows = <T>(sql: string, ...args: unknown[]) =>
    database()
      .prepare(sql)
      .all(...args) as T[];
  const makeService = () =>
    new StandaloneService(join(root, "data"), () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      supervisor: { observationMs: 5 },
    });
  const createReadyTask = async (taskId: string, title: string) => {
    command(currentService(), {
      type: "task.create",
      projectId,
      taskId,
      title,
      outcome: `S05_${title.replaceAll(" ", "_")}_TASK_BRIEF`,
      ready: false,
    });
    await currentService().provisionTask(taskId);
    command(currentService(), {
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
  };
  const waitForQuestion = async (taskId: string) => {
    await waitUntil(
      () =>
        currentService()
          .coordinationView()
          .readTask(taskId)
          .questions.some((question) => question.status === "open") &&
        currentService()
          .list()
          .every((intent) => intent.state !== "running"),
      "initial-question-turn-terminal",
    );
    return currentService()
      .coordinationView()
      .readTask(taskId)
      .questions.find((question) => question.status === "open");
  };
  const queueAnswerAndMessage = async (
    taskId: string,
    assignmentId: string,
    question: NonNullable<
      ReturnType<typeof waitForQuestion> extends Promise<infer T> ? T : never
    >,
    marker: string,
  ) => {
    assert.ok(question);
    const answerKey = randomUUID();
    const answerInput = {
      key: answerKey,
      taskId,
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: `${marker}_ANSWER`,
    };
    const answerReceipt = await currentService()
      .coordinationView()
      .answerQuestion(answerInput);
    const answerReplay = await currentService()
      .coordinationView()
      .answerQuestion(answerInput);
    assert.equal(answerReplay.eventId, answerReceipt.eventId);

    const assignment = currentService().domain().assignment(assignmentId);
    const messageInput = {
      key: randomUUID(),
      taskId,
      recipientAssignmentId: assignmentId,
      expectedAssignmentVersion: Number(assignment.version),
      message: `${marker}_OPERATOR_MESSAGE`,
    };
    const messageReceipt = await currentService()
      .coordinationView()
      .postOperatorMessage(messageInput);
    const messageReplay = await currentService()
      .coordinationView()
      .postOperatorMessage(messageInput);
    assert.equal(messageReplay.eventId, messageReceipt.eventId);
    return {
      eventIds: [answerReceipt.eventId, messageReceipt.eventId],
      answer: answerInput.answer,
      message: messageInput.message,
    };
  };

  runtime.handleTurn = async (threadId, turnId) => {
    const intent = currentService()
      .list()
      .find((item) => item.turnId === turnId);
    assert.ok(intent);
    const request = currentService()
      .turnRequests()
      .find((candidate) => candidate.workId === intent.workId);
    assert.ok(request?.taskId);
    const turnNumber = (turnsByTask.get(request.taskId) ?? 0) + 1;
    turnsByTask.set(request.taskId, turnNumber);
    if (turnNumber === 1) {
      const result = await runtime.callTool({
        threadId,
        turnId,
        callId: `s05-refusal-question-${request.taskId}`,
        tool: "ensemble_ask_question",
        arguments: { question: `S05_${request.taskId}_INITIAL_QUESTION` },
      });
      assert.equal(result.success, true);
    } else {
      const result = await runtime.callTool({
        threadId,
        turnId,
        callId: `s05-refusal-completion-${request.taskId}`,
        tool: "ensemble_request_completion",
        arguments: { reviewedResultIds: [] },
      });
      assert.equal(result.success, true);
      turnsDuringHandler++;
    }
  };

  try {
    service = makeService();
    runtime.observe(service, refusedBeforeApplyTaskId);
    await service.start();
    command(service, {
      type: "profile.create",
      profileId: leadProfileId,
      name: "S05 stale inbox lead",
      instructions: "S05_STALE_INBOX_LEAD_INSTRUCTIONS",
      capabilities: "task coordination",
    });
    command(service, {
      type: "project.create",
      projectId,
      name: "S05 stale inbox project",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
      instructions: "S05_STALE_INBOX_PROJECT_REVISION_ONE",
    });
    command(service, {
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    await createReadyTask(refusedBeforeApplyTaskId, "refused before apply");
    const firstQuestion = await waitForQuestion(refusedBeforeApplyTaskId);
    assert.ok(firstQuestion);
    const firstLead = service
      .domain()
      .assignments(refusedBeforeApplyTaskId)
      .find((assignment) => assignment.profileId === leadProfileId);
    assert.ok(firstLead);

    let project = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(project.version),
      instructions: "S05_STALE_INBOX_PROJECT_REVISION_TWO",
      paused: true,
    });
    const firstEvents = await queueAnswerAndMessage(
      refusedBeforeApplyTaskId,
      String(firstLead.id),
      firstQuestion,
      "S05_REFUSED_BEFORE_APPLY",
    );
    await waitUntil(() => {
      const request = currentService()
        .turnRequests()
        .find(
          (item) => item.assignmentId === firstLead.id && item.state === "held",
        );
      const refusal = request
        ? row<{ reason: string }>(
            "SELECT reason FROM execution_request_refusals WHERE workId = ?",
            request.workId,
          )
        : undefined;
      return Boolean(request && refusal);
    }, "revision-refusal-recorded-before-apply");
    const firstOldRequest = service
      .turnRequests()
      .find(
        (item) => item.assignmentId === firstLead.id && item.state === "held",
      );
    assert.ok(firstOldRequest);
    const firstOldBatch = row<{
      batchId: string;
      deliveryWorkId: string;
      assignmentVersion: number;
    }>(
      `SELECT batchId, deliveryWorkId, assignmentVersion
       FROM coordination_delivery_batches
       WHERE recipientAssignmentId = ? AND state = 'queued'`,
      String(firstLead.id),
    );
    assert.ok(firstOldBatch);
    assert.equal(firstOldBatch.assignmentVersion, 1);
    assert.equal(
      row<{ count: number }>(
        `SELECT COUNT(*) AS count FROM coordination_delivery_events
         WHERE batchId = ?`,
        firstOldBatch.batchId,
      )?.count,
      1,
      "the first reply is bound before the later operator message",
    );

    await service.stop();
    service = makeService();
    runtime.observe(service, refusedBeforeApplyTaskId);
    await service.start();
    assert.equal(
      service
        .turnRequests()
        .find((item) => item.workId === firstOldRequest.workId)?.state,
      "held",
      "restart retains the exact old refused request",
    );
    assert.equal(
      row(
        "SELECT state FROM execution_pending_effects WHERE workId = ? AND state = 'pending'",
        firstOldRequest.workId,
      ),
      undefined,
      "restart migration must not invent an assignment effect for a never-admitted refusal",
    );

    const applyKey = randomUUID();
    const applyCommand = {
      type: "assignment.apply",
      projectId,
      assignmentId: String(firstLead.id),
      expectedVersion: 1,
    };
    service.domain().execute({
      key: applyKey,
      actor: "operator",
      ...applyCommand,
    } as never);
    service.domain().execute({
      key: applyKey,
      actor: "operator",
      ...applyCommand,
    } as never);
    assert.equal(
      Number(service.domain().assignment(String(firstLead.id)).version),
      2,
    );
    assert.equal(
      runtime.turns,
      1,
      "the paused project still holds the rebound events",
    );
    await waitUntil(
      () =>
        service
          ?.turnRequests()
          .some(
            (request) =>
              request.assignmentId === firstLead.id &&
              request.workId !== firstOldRequest.workId &&
              request.assignmentVersion === 2,
          ) ?? false,
      "current-version-request-created-while-paused",
    );
    const firstNewRequest = service
      .turnRequests()
      .find(
        (request) =>
          request.assignmentId === firstLead.id &&
          request.workId !== firstOldRequest.workId &&
          request.assignmentVersion === 2,
      );
    assert.ok(firstNewRequest);
    assert.equal(
      row(
        "SELECT batchId FROM coordination_delivery_batches WHERE batchId = ?",
        firstOldBatch.batchId,
      ),
      undefined,
      "only the old never-admitted batch is removed",
    );
    assert.deepEqual(
      rows<{ eventId: string }>(
        `SELECT eventId FROM coordination_delivery_events
         WHERE batchId = (SELECT batchId FROM coordination_delivery_batches
           WHERE deliveryWorkId = ?) ORDER BY ordinal`,
        firstNewRequest.workId,
      ).map((event) => event.eventId),
      firstEvents.eventIds,
      "the original answer and message event IDs are rebound in sequence",
    );
    assert.equal(
      service
        .turnRequests()
        .find((item) => item.workId === firstOldRequest.workId)?.state,
      "held",
      "the refused old request is retained rather than completed",
    );
    assert.ok(
      row(
        "SELECT workId FROM execution_request_refusals WHERE workId = ?",
        firstOldRequest.workId,
      ),
      "the old refusal record remains durable",
    );

    project = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(project.version),
      paused: false,
    });
    await waitUntil(
      () => service?.domain().task(refusedBeforeApplyTaskId).state === "done",
      "completion-ignores-only-the-proven-old-refusal",
    );
    const firstDelivered = service
      .coordinationView()
      .readTask(refusedBeforeApplyTaskId)
      .messages.filter((message) =>
        firstEvents.eventIds.includes(message.eventId),
      );
    assert.deepEqual(
      Object.fromEntries(
        firstDelivered.map((message) => [
          message.eventId,
          message.deliveryState,
        ]),
      ),
      Object.fromEntries(
        firstEvents.eventIds.map((eventId) => [eventId, "delivered"]),
      ),
    );
    assert.equal(
      row<{ count: number }>(
        `SELECT COUNT(*) AS count FROM coordination_delivery_events
         WHERE eventId IN (?, ?)`,
        ...firstEvents.eventIds,
      )?.count,
      2,
      "each original inbox event is mapped exactly once",
    );

    await createReadyTask(applyBeforeRefusalTaskId, "apply before refusal");
    const secondQuestion = await waitForQuestion(applyBeforeRefusalTaskId);
    assert.ok(secondQuestion);
    const secondLead = service
      .domain()
      .assignments(applyBeforeRefusalTaskId)
      .find((assignment) => assignment.profileId === leadProfileId);
    assert.ok(secondLead);
    project = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(project.version),
      paused: true,
    });
    const secondEvents = await queueAnswerAndMessage(
      applyBeforeRefusalTaskId,
      String(secondLead.id),
      secondQuestion,
      "S05_APPLY_BEFORE_REFUSAL",
    );
    const secondInboxWorkId = `assignment:${secondLead.id}:v1:inbox:${secondEvents.eventIds[0]}`;
    await waitUntil(() => {
      const request = service
        ?.turnRequests()
        .find((item) => item.workId === secondInboxWorkId);
      return Boolean(
        request?.state === "queued" &&
          !row(
            "SELECT workId FROM execution_request_refusals WHERE workId = ?",
            request.workId,
          ),
      );
    }, "paused-request-remains-queued-before-revision-change");
    project = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(project.version),
      instructions: "S05_STALE_INBOX_PROJECT_REVISION_THREE",
      paused: true,
    });
    command(service, {
      type: "assignment.apply",
      projectId,
      assignmentId: String(secondLead.id),
      expectedVersion: 1,
    });
    project = service.domain().project(projectId);
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: Number(project.version),
      paused: false,
    });
    await waitUntil(
      () => service?.domain().task(applyBeforeRefusalTaskId).state === "done",
      "bounded-post-refusal-rebind-after-apply-wins-race",
    );
    const secondRequest = service
      .turnRequests()
      .find(
        (request) =>
          request.assignmentId === secondLead.id &&
          request.assignmentVersion === 2 &&
          request.state === "completed",
      );
    assert.ok(secondRequest);
    assert.deepEqual(
      rows<{ eventId: string }>(
        `SELECT eventId FROM coordination_delivery_events
         WHERE batchId = (SELECT batchId FROM coordination_delivery_batches
           WHERE deliveryWorkId = ?) ORDER BY ordinal`,
        secondRequest.workId,
      ).map((event) => event.eventId),
      secondEvents.eventIds,
    );
    assert.equal(turnsDuringHandler, 2);
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale inbox withdrawal preserves independent stop and admission holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-rebind-holds-"));
  const projectId = randomUUID();
  const leadProfileId = randomUUID();
  const runtime = new JourneyRuntime();
  let service: StandaloneService | undefined;
  const currentService = () => {
    if (!service) throw new Error("Service is not started");
    return service;
  };
  const database = () =>
    (
      currentService() as unknown as {
        db: {
          prepare(sql: string): {
            get(...args: unknown[]): unknown;
            all(...args: unknown[]): unknown[];
            run(...args: unknown[]): unknown;
          };
        };
      }
    ).db;
  const row = <T>(sql: string, ...args: unknown[]) =>
    database()
      .prepare(sql)
      .get(...args) as T | undefined;
  const makeService = () =>
    new StandaloneService(join(root, "data"), () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      supervisor: { observationMs: 5 },
    });
  const createReadyTask = async (taskId: string, title: string) => {
    command(currentService(), {
      type: "task.create",
      projectId,
      taskId,
      title,
      outcome: `S05_${title.replaceAll(" ", "_")}_TASK_BRIEF`,
      ready: false,
    });
    await currentService().provisionTask(taskId);
    command(currentService(), {
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
  };

  runtime.handleTurn = async (threadId, turnId) => {
    const intent = currentService()
      .list()
      .find((item) => item.turnId === turnId);
    assert.ok(intent);
    const request = currentService()
      .turnRequests()
      .find((item) => item.workId === intent.workId);
    assert.ok(request?.taskId);
    const result = await runtime.callTool({
      threadId,
      turnId,
      callId: `s05-hold-question-${request.taskId}`,
      tool: "ensemble_ask_question",
      arguments: { question: `S05_${request.taskId}_QUESTION` },
    });
    assert.equal(result.success, true);
  };

  try {
    service = makeService();
    await service.start();
    command(service, {
      type: "profile.create",
      profileId: leadProfileId,
      name: "S05 held stale inbox lead",
      instructions: "S05_HELD_STALE_INBOX_LEAD_INSTRUCTIONS",
      capabilities: "task coordination",
    });
    command(service, {
      type: "project.create",
      projectId,
      name: "S05 held stale inbox project",
      leadProfileId,
    });
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
      instructions: "S05_HELD_STALE_INBOX_PROJECT_REVISION_ONE",
    });
    command(service, {
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });

    for (const [index, witness] of [
      "stop",
      "recovery",
      "admission",
    ].entries()) {
      const taskId = randomUUID();
      runtime.observe(service, taskId);
      await createReadyTask(taskId, `hold case ${index}`);
      await waitUntil(
        () =>
          currentService()
            .coordinationView()
            .readTask(taskId)
            .questions.some((question) => question.status === "open"),
        `question-created-for-${witness}-case`,
      );
      const assignment = currentService()
        .domain()
        .assignments(taskId)
        .find((item) => item.profileId === leadProfileId);
      assert.ok(assignment);
      const assignmentId = String(assignment.id);
      const question = currentService()
        .coordinationView()
        .readTask(taskId)
        .questions.find((item) => item.status === "open");
      assert.ok(question);

      const project = service.domain().project(projectId);
      command(service, {
        type: "project.configure",
        projectId,
        expectedVersion: Number(project.version),
        instructions: `S05_HELD_STALE_INBOX_PROJECT_REVISION_${index + 2}`,
      });
      const answer = await service.coordinationView().answerQuestion({
        key: randomUUID(),
        taskId,
        interactionId: question.interactionId,
        expectedRevision: question.revision,
        answer: `S05_${witness.toUpperCase()}_ANSWER`,
      });
      const message = await service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId,
        recipientAssignmentId: assignmentId,
        expectedAssignmentVersion: Number(assignment.version),
        message: `S05_${witness.toUpperCase()}_MESSAGE`,
      });
      const oldRequest = await (async () => {
        let found:
          | {
              workId: string;
              assignmentVersion: number | null;
              sequence: number;
            }
          | undefined;
        await waitUntil(() => {
          found = currentService()
            .turnRequests()
            .find(
              (item) =>
                item.assignmentId === assignmentId && item.state === "held",
            );
          return Boolean(
            found &&
              row(
                "SELECT workId FROM execution_request_refusals WHERE workId = ?",
                found.workId,
              ),
          );
        }, `revision-refusal-created-for-${witness}-case`);
        assert.ok(found);
        return {
          workId: found.workId,
          assignmentVersion: found.assignmentVersion,
          sequence: found.sequence,
        };
      })();
      assert.equal(oldRequest.assignmentVersion, 1);
      const batch = row<{ batchId: string }>(
        `SELECT batchId FROM coordination_delivery_batches
         WHERE deliveryWorkId = ? AND state = 'queued'`,
        oldRequest.workId,
      );
      assert.ok(batch);
      assert.deepEqual(
        (
          database()
            .prepare(
              `SELECT eventId FROM coordination_delivery_events
             WHERE batchId = ? ORDER BY ordinal`,
            )
            .all(batch.batchId) as Array<{ eventId: string }>
        ).map((item) => item.eventId),
        [answer.eventId],
        "the first event is bound while the later message remains pending",
      );

      if (witness === "stop") {
        await service.stopTask(taskId);
      } else if (witness === "recovery") {
        database()
          .prepare(`INSERT INTO execution_recovery_identities
            (workId, workRevision, requestSequence, processId,
              processStartedAt, bootId, threadId, turnId)
            VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, NULL)`)
          .run(oldRequest.workId, oldRequest.sequence);
      } else {
        const workspace = row<{ workspace: string }>(
          "SELECT workspace FROM execution_intents WHERE workId = ?",
          oldRequest.workId,
        );
        assert.ok(workspace);
        database()
          .prepare(
            "INSERT INTO task_writer_admissions (workId, workspace) VALUES (?, ?)",
          )
          .run(oldRequest.workId, workspace.workspace);
        database()
          .prepare(
            "INSERT INTO execution_capacity_reservations (workId, projectId) VALUES (?, ?)",
          )
          .run(oldRequest.workId, projectId);
      }

      const currentAssignment = service.domain().assignment(assignmentId);
      command(service, {
        type: "assignment.apply",
        projectId,
        assignmentId,
        expectedVersion: Number(currentAssignment.version),
      });
      await service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
      assert.ok(
        row(
          "SELECT batchId FROM coordination_delivery_batches WHERE batchId = ? AND state = 'queued'",
          batch.batchId,
        ),
        `${witness} evidence keeps the exact old delivery batch bound`,
      );
      assert.equal(
        service
          .turnRequests()
          .some(
            (request) =>
              request.assignmentId === assignmentId &&
              request.assignmentVersion === 2 &&
              request.workId !== oldRequest.workId,
          ),
        false,
        `${witness} evidence does not create a successor request`,
      );
      if (witness === "stop")
        assert.match(service.taskHold(taskId) ?? "", /stopped/i);
      else
        assert.equal(
          row(
            "SELECT workId FROM execution_request_refusals WHERE workId = ?",
            oldRequest.workId,
          ) !== undefined,
          true,
          "the exact refusal remains durable",
        );
    }
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
