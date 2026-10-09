import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  StandaloneService,
  CodexRuntime,
} from "../../dist/src/standalone/index.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
export const qualificationResource =
  "existing-login:codex-app-server:qualification";
const limits = { requestMs: 90000, totalMs: 240000, cleanupMs: 10000 };
const reportTool = {
  type: "function",
  name: "ui01_report_answers",
  description:
    "Proof-only: report the exact received native answers then end. Grants no permission.",
  inputSchema: {
    type: "object",
    properties: {
      answers: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { answers: { type: "array", items: { type: "string" } } },
          required: ["answers"],
          additionalProperties: false,
        },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
};
const prompt = [
  "This is a disposable native input capability probe. Use no shell, filesystem, browser, network, delegation or additional external tools.",
  "Directly and synchronously call functions.request_user_input exactly once and await its answer. Ask one question: id delivery, header Delivery, question Select delivery, options Local (Local output) and Remote (Remote output). Custom text is permitted only when the native request explicitly exposes isOther support.",
  "Before receiving the native answer, do not use functions.exec, ALL_TOOLS, tool search/discovery, async input or nonawaited calls. Do not request standalone free text, multiple selection or explicit recommendation. Do not substitute plaintext chat if native input is unavailable.",
  "After receiving the native answer, use functions.exec exactly once to run only this awaited known call: await tools.ui01_report_answers({answers: <exact received answers map>}). Preserve the exact received map {questionId: {answers: [strings]}}. No discovery or other calls; await the report result, then end. Do not guess the answer, ask again or request approval.",
].join("\n");
export async function runService(options = {}) {
  const fixture = options.fixture;
  const budgets = { ...limits, ...options.budgets };
  for (const key of Object.keys(limits)) {
    assert.ok(
      Number.isSafeInteger(budgets[key]) &&
        budgets[key] > 0 &&
        budgets[key] <= limits[key],
    );
    if (!fixture) assert.equal(budgets[key], limits[key]);
  }
  assert.ok(
    fixture ||
      Object.keys(options).every((k) => k === "source" || k === "grant"),
  );
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "ensemble-ui01-service-"),
  );
  chmodSync(root, 0o700);
  const data = join(root, "data"),
    evidencePath = `${root}.json`;
  const evidence = {
    phase: "service",
    mode: fixture ? "deterministic-fixture" : "live",
    source: options.source,
    resource: qualificationResource,
    grantId: options.grant?.grantId ?? null,
    evidencePath,
    status: "failed",
    fixture: { path: root, removed: false },
    counts: { threads: 0, turns: 0, requests: 0, replies: 0, reports: 0 },
    observations: [],
    cleanup: { verified: false },
  };
  let service,
    runtime,
    call,
    accepted,
    reportEnded = false,
    aborted = false;
  let sequence = 0;
  const observe = (kind) =>
    evidence.observations.push({ sequence: ++sequence, kind });
  const started = Date.now(),
    totalDeadline = started + budgets.totalMs,
    deadline = totalDeadline - budgets.cleanupMs;
  async function bounded(operation, end, name) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name}-deadline`)),
            Math.max(0, end - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function active() {
    assert.ok(!aborted && Date.now() < deadline, "service-proof-deadline");
  }
  async function until(predicate, ms = deadline - Date.now()) {
    const end = Math.min(deadline, Date.now() + ms);
    while (!predicate()) {
      if (Date.now() >= end) throw new Error("service-proof-deadline");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  const taskId = randomUUID(),
    projectId = randomUUID(),
    profileId = randomUUID();
  let stage = "start";
  try {
    service = new StandaloneService(
      data,
      (context) => {
        runtime = new CodexRuntime(
          fixture?.executable ?? options.source.executable,
          {
            ...context,
            ...(fixture
              ? {
                  qualifiedExecutableHash: fixture.executableHash,
                  captureProcessIdentity: async (pid) =>
                    pid
                      ? {
                          processId: String(pid),
                          processStartedAt: "fixture-attached-child",
                          bootId: "fixture-boot",
                        }
                      : null,
                  spawnEnvironment: () => ({
                    ...context.spawnEnvironment(),
                    ENSEMBLE_UI01_NATIVE_PROOF_FIXTURE: fixture.mode ?? "proof",
                  }),
                }
              : {}),
          },
        );
        const onUnexpected = runtime.onUnexpectedRequest.bind(runtime);
        runtime.onUnexpectedRequest = (listener) =>
          onUnexpected((request) => {
            evidence.unexpected = request;
            listener(request);
          });
        const startThread = runtime.startThread.bind(runtime),
          startTurn = runtime.startTurn.bind(runtime),
          onRequest = runtime.onUserInputRequest.bind(runtime),
          onOutcome = runtime.onUserInputOutcome.bind(runtime),
          onTool = runtime.onToolCall.bind(runtime),
          reply = runtime.replyUserInput.bind(runtime);
        runtime.startThread = async (workspace, tools) => {
          active();
          assert.equal(evidence.counts.threads, 0, "second-thread-forbidden");
          evidence.counts.threads++;
          return startThread(workspace, [...(tools ?? []), reportTool]);
        };
        runtime.startTurn = async (thread, workspace) => {
          active();
          assert.equal(evidence.counts.turns, 0, "second-turn-forbidden");
          evidence.counts.turns++;
          observe("service-turn-started");
          return startTurn(thread, workspace, prompt);
        };
        runtime.onUserInputRequest = (listener) =>
          onRequest((request) => {
            assert.equal(
              evidence.counts.requests,
              0,
              "second-question-forbidden",
            );
            call = request;
            evidence.counts.requests++;
            listener(request);
            observe("question-persisted-before-exposure");
          });
        runtime.onUserInputOutcome = (listener) =>
          onOutcome((outcome) => {
            observe(`runtime-${outcome.outcome}`);
            listener(outcome);
            evidence.receipt = { ...outcome };
          });
        runtime.replyUserInput = (identity, response, gate) =>
          reply(identity, response, () => {
            active();
            const intent = gate();
            evidence.counts.replies++;
            assert.equal(evidence.counts.replies, 1, "second-reply-forbidden");
            evidence.intent = intent;
            observe("intent-committed-before-write");
            return intent;
          });
        runtime.onToolCall = (listener) =>
          onTool(async (tool) => {
            if (tool.tool !== "ui01_report_answers") return listener(tool);
            assert.ok(call && accepted, "report-before-native-answer");
            assert.equal(tool.threadId, call.identity.threadId);
            assert.equal(tool.turnId, call.identity.turnId);
            assert.ok(
              isDeepStrictEqual(tool.arguments, { answers: accepted }),
              "report-answer-mismatch",
            );
            assert.equal(evidence.counts.reports, 0, "second-report-forbidden");
            evidence.counts.reports++;
            const work = service
              .coordinationView()
              .readTask(taskId)
              .history.find(
                (entry) =>
                  entry.threadId === tool.threadId &&
                  entry.turnId === tool.turnId,
              );
            assert.ok(work);
            const reporting = listener({
              ...tool,
              tool: "ensemble_report_result",
              arguments: {
                summary: "UI01 exact native answer consumption observed",
              },
            });
            service.registerExecutionCallback(work.workId, reporting);
            const result = await reporting;
            assert.equal(
              result.success,
              true,
              "bound-consumption-result-rejected",
            );
            observe("exact-answer-report");
            reportEnded = true;
            observe("report-callback-ended");
            return result;
          });
        return runtime;
      },
      undefined,
      {
        power: { enabled: false },
        supervisor: { observationMs: fixture ? 5 : 1000 },
      },
    );
    await bounded(() => service.start(), deadline, "startup");
    evidence.process = runtime.processIdentity();
    const command = (body) =>
      service
        .domain()
        .execute({ actor: "operator", key: randomUUID(), ...body });
    command({
      type: "profile.create",
      profileId,
      name: "UI01 disposable lead",
      instructions: "Run only the fixed native input proof.",
      capabilities: "native input proof",
    });
    command({
      type: "project.create",
      projectId,
      name: "UI01 disposable qualification",
      leadProfileId: profileId,
    });
    command({
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    command({
      type: "task.create",
      projectId,
      taskId,
      title: "UI01 service proof",
      outcome: prompt,
      ready: true,
    });
    await bounded(() => service.provisionTask(taskId), deadline, "provision");
    command({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    stage = "native-request";
    await until(
      () =>
        service.coordinationView().readTask(taskId).runtimeQuestions?.length ===
        1,
      budgets.requestMs,
    );
    const question = service.coordinationView().readTask(taskId)
      .runtimeQuestions[0];
    assert.ok(call);
    assert.equal(
      question.interactionId,
      service.coordinationView().readTask(taskId).questions[0].interactionId,
    );
    assert.equal(call.request.questions.length, 1);
    assert.equal(call.request.questions[0].id, "delivery");
    assert.deepEqual(
      call.request.questions[0].options.map((o) => o.label),
      ["Local", "Remote"],
    );
    assert.equal(call.request.isBlocking, false);
    assert.equal(call.request.autoResolutionMs, null);
    evidence.qualification = call.qualification;
    evidence.identity = {
      taskId,
      projectId,
      ...call.identity,
      assignmentId: question.requestingAssignmentId,
      workId: service
        .coordinationView()
        .readTask(taskId)
        .history.find(
          (h) =>
            h.threadId === call.identity.threadId &&
            h.turnId === call.identity.turnId,
        )?.workId,
    };
    stage = "paused-answer";
    evidence.pause = command({
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused: true,
    });
    observe("project-pause-committed");
    accepted = {
      delivery: {
        answers: [
          call.request.questions[0].isOther
            ? `UI01 custom ${randomUUID()}`
            : "Local",
        ],
      },
    };
    const answerKey = randomUUID();
    evidence.answerReceipt = await bounded(
      () =>
        service.coordinationView().answerRuntimeQuestion({
          taskId,
          key: answerKey,
          interactionId: question.interactionId,
          expectedRevision: question.revision,
          answers: accepted,
        }),
      deadline,
      "answer-command",
    );
    assert.equal(evidence.counts.replies, 0);
    observe("answer-command-returned-zero-replies");
    const reader = new DatabaseSync(join(data, "standalone.sqlite"), {
      readOnly: true,
    });
    try {
      const persisted = reader
        .prepare(
          "SELECT answerJson,answerDigest,replyIntentId,deliveryState,requestState FROM coordination_runtime_questions WHERE interactionId=?",
        )
        .get(question.interactionId);
      const receipt = reader
        .prepare(
          "SELECT result FROM coordination_operator_receipts WHERE scope='answer-runtime-question' AND commandKey=?",
        )
        .get(answerKey);
      assert.ok(persisted && receipt);
      assert.deepEqual(JSON.parse(persisted.answerJson), accepted);
      assert.deepEqual(JSON.parse(receipt.result), evidence.answerReceipt);
      assert.equal(persisted.replyIntentId, null);
      assert.equal(persisted.deliveryState, "held");
      assert.equal(persisted.requestState, "available");
      assert.equal(evidence.counts.replies, 0);
      evidence.persistence = {
        committedBeforeEffect: true,
        independentReadOnlyConnection: true,
        answerDigest: persisted.answerDigest,
        deliveryState: persisted.deliveryState,
        replyIntentId: null,
        zeroReplies: true,
      };
      observe("independent-committed-answer-readback-zero-replies");
    } finally {
      reader.close();
    }
    stage = "unpause-and-continuation";
    evidence.unpause = command({
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused: false,
    });
    observe("ordinary-project-unpause");
    await until(() => {
      const q = service.coordinationView().readTask(taskId).runtimeQuestions[0];
      return (
        q.deliveryState === "confirmed" &&
        reportEnded &&
        service
          .list()
          .some(
            (i) =>
              i.threadId === call.identity.threadId &&
              i.turnId === call.identity.turnId &&
              i.state === "completed",
          )
      );
    });
    assert.deepEqual(evidence.counts, {
      threads: 1,
      turns: 1,
      requests: 1,
      replies: 1,
      reports: 1,
    });
    assert.equal(evidence.receipt.outcome, "confirmed");
    const order = evidence.receipt.orderedReceipt;
    assert.ok(
      order?.stdinSucceeded && order.matchingResolution,
      "ordered-receipt-evidence-missing",
    );
    assert.ok(
      order.writeInitiated < order.stdinSucceeded &&
        order.writeInitiated < order.matchingResolution,
      "ordered-receipt-evidence-invalid",
    );
    assert.equal(service.taskHold(taskId), undefined);
    evidence.settlement = {
      confirmedCommitted: true,
      reportCallbackEnded: true,
      boundSuccessfulTerminal: true,
      noOtherHold: true,
    };
    evidence.consumption = {
      kind: call.request.questions[0].isOther
        ? "answer-only-nonce-report"
        : "selected-answer-report",
      sameTurn: true,
    };
    evidence.status = "passed";
  } catch (error) {
    let executions = [];
    try {
      executions =
        service
          ?.list()
          .map(({ id, workId, state, reason, threadId, turnId }) => ({
            id,
            workId,
            state,
            reason,
            threadId,
            turnId,
          })) ?? [];
    } catch {}
    evidence.failure = {
      stage,
      reason: String(error.message).slice(0, 1024),
      unexpected: evidence.unexpected,
      executions,
    };
  } finally {
    aborted = true;
    const cleanupDeadline = Math.min(
      totalDeadline,
      Date.now() + budgets.cleanupMs,
    );
    const process = evidence.process ?? runtime?.processIdentity();
    evidence.process ??= process;
    evidence.cleanup.operations = {};
    async function cleanupOperation(name, operation) {
      try {
        await bounded(operation, cleanupDeadline, name);
        evidence.cleanup.operations[name] = "settled";
      } catch (error) {
        evidence.cleanup.operations[name] = "unresolved";
        evidence.failure ??= {
          stage: "cleanup",
          reason: String(error.message).slice(0, 1024),
        };
        evidence.status = "failed";
      }
    }
    if (service) {
      if (evidence.status !== "passed") {
        // End the exact attached child first, including when startup timed out.
        // A timed-out wait is never proof that this cancellation completed.
        await cleanupOperation("runtime-stop", () => runtime?.stop());
        await cleanupOperation("task-stop", () => service.stopTask(taskId));
      }
      await cleanupOperation("service-stop", async () => {
        await service.stop();
        await fixture?.afterServiceStop?.();
      });
    }
    try {
      evidence.cleanup.verification = process
        ? await bounded(
            () =>
              fixture
                ? (
                    fixture.verifyTermination ??
                    (async (identity) => {
                      try {
                        globalThis.process.kill(Number(identity.processId), 0);
                        return {
                          kind: "unknown",
                          reason: "fixture-child-still-live",
                        };
                      } catch (error) {
                        return error.code === "ESRCH"
                          ? {
                              kind: "verified",
                              method: "fixture-exact-pid-absent",
                            }
                          : {
                              kind: "unknown",
                              reason: "fixture-child-unverifiable",
                            };
                      }
                    })
                  )(process)
                : new MacProcessTerminationVerifier().verify(process),
            cleanupDeadline,
            "process-verification",
          )
        : { kind: "unknown", reason: "missing-process-identity" };
      evidence.cleanup.verified =
        evidence.cleanup.verification.kind === "verified" &&
        Object.values(evidence.cleanup.operations).every(
          (state) => state === "settled",
        );
    } catch (error) {
      evidence.cleanup.verification = {
        kind: "unknown",
        reason: String(error.message).slice(0, 1024),
      };
    }
    if (!evidence.cleanup.verified) {
      evidence.status = "failed";
      evidence.failure ??= {
        stage: "cleanup",
        reason: "exact-process-exit-unproved",
      };
      evidence.cleanup.unresolvedIdentity = process ?? null;
    }
    if (evidence.status === "passed") {
      rmSync(root, { recursive: true, force: true });
      evidence.fixture.removed = true;
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return evidence;
}
