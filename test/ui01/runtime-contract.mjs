import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  captureProcessIdentity,
  MacProcessTerminationVerifier,
} from "../../dist/src/standalone/termination.js";

const bounds = {
  requestMs: 90_000,
  totalMs: 240_000,
  holdMs: 250,
  cleanupMs: 10_000,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitBounded(promise, ms, fallback) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) =>
  (typeof value === "string" && value.length > 0 && value.length <= 256) ||
  (Number.isSafeInteger(value) && value >= 0);
const text = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 2048;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateArguments(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--live" ||
    args[1] !== "--phase" ||
    args[2] !== "protocol"
  ) {
    throw new Error("Protocol probe requires exactly --live --phase protocol");
  }
}

function validateBudgets(budgets, fixture) {
  for (const key of Object.keys(bounds)) {
    assert.ok(
      Number.isSafeInteger(budgets[key]) &&
        budgets[key] > 0 &&
        budgets[key] <= bounds[key],
      "bounded-budgets-required",
    );
    if (!fixture)
      assert.equal(budgets[key], bounds[key], "fixed-live-budget-required");
  }
  assert.ok(
    budgets.cleanupMs < budgets.totalMs &&
      budgets.requestMs < budgets.totalMs - budgets.cleanupMs &&
      budgets.holdMs < budgets.requestMs,
    "bounded-budgets-required",
  );
}

const reportTool = {
  type: "function",
  name: "ui01_report_answers",
  description:
    "Proof-only: report the native input answers received in this same turn, then end. Grants no permission.",
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

function qualifiedSource(source) {
  return (
    source.codex === "codex-cli 0.159.0" &&
    source.executableHash ===
      "e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a"
  );
}

function threadProjection(result, includeMode) {
  const projected = {
    thread: { id: result.thread?.id },
    model: result.model,
    modelProvider: result.modelProvider,
    reasoningEffort: result.reasoningEffort,
    serviceTier: result.serviceTier,
    approvalPolicy: result.approvalPolicy,
    sandbox: { type: result.sandbox?.type },
  };
  if (includeMode) {
    const mode = result.collaborationMode;
    const instructions = mode?.settings?.developer_instructions;
    projected.collaborationMode = {
      mode: mode?.mode,
      settings: {
        model: mode?.settings?.model,
        reasoningEffort: mode?.settings?.reasoning_effort,
        developerInstructionsDigest:
          instructions === null || typeof instructions === "string"
            ? hash(JSON.stringify(instructions))
            : undefined,
      },
    };
  }
  return projected;
}

function qualifiedDefaultContinuation(source, qualification, params) {
  return (
    qualifiedSource(source) &&
    qualification?.mode === "default" &&
    qualification.threadId === params.threadId &&
    text(qualification.runtimeGeneration) &&
    params.isBlocking === false &&
    params.autoResolutionMs === null
  );
}

function selectAnswers(source, qualification, params, nonce) {
  assert.ok(
    qualifiedDefaultContinuation(source, qualification, params),
    "unsupported-continuation",
  );
  assert.ok(
    Array.isArray(params.questions) && params.questions.length === 1,
    "unsupported-question-set",
  );
  const answers = {};
  const shapes = [];
  const seen = new Set();
  for (const question of params.questions) {
    assert.ok(
      object(question) && question.id === "delivery" && !seen.has(question.id),
      "unsupported-question-identity",
    );
    seen.add(question.id);
    assert.ok(
      text(question.header) &&
        text(question.question) &&
        typeof question.isOther === "boolean" &&
        question.isSecret === false,
      "unsupported-or-secret-question",
    );
    assert.ok(
      Array.isArray(question.options) &&
        question.options.length > 0 &&
        question.options.length <= 8,
      "unsupported-options",
    );
    if (question.options !== null) {
      for (const option of question.options)
        assert.ok(
          object(option) && text(option.label) && text(option.description),
          "unsupported-options",
        );
      assert.equal(
        new Set(question.options.map((option) => option.label)).size,
        question.options.length,
        "unsupported-options",
      );
    }
    if (question.id === "delivery") {
      assert.deepEqual(
        question.options?.map((option) => option.label),
        ["Local", "Remote"],
        "fixed-delivery-options-required",
      );
      answers.delivery = {
        answers: [question.isOther ? `UI01 custom ${nonce}` : "Local"],
      };
      shapes.push("single-choice");
      if (question.isOther) shapes.push("custom-text");
    }
  }
  assert.ok(seen.has("delivery"), "fixed-delivery-required");
  return { answers, shapes };
}

/** Public disposable protocol seam. Fixture injection covers only OS/stdio boundaries. */
export async function runProtocol(options = {}) {
  const { fixture } = options;
  const budgets = { ...bounds, ...options.budgets };
  validateBudgets(budgets, fixture);
  assert.ok(
    !fixture || (text(fixture.executable) && Array.isArray(fixture.args)),
    "unsupported-fixture-config",
  );
  assert.ok(
    fixture || Object.keys(options).every((key) => key === "source"),
    "unsupported-live-config",
  );
  const root = mkdtempSync(join(tmpdir(), "ensemble-ui01-protocol-"));
  chmodSync(root, 0o700);
  const evidencePath = `${root}.json`;
  const evidence = {
    phase: "protocol",
    mode: fixture ? "deterministic-fixture" : "live",
    source: options.source ?? { node: process.version },
    budgets,
    status: "failed",
    fixture: {
      path: root,
      taskId: randomUUID(),
      created: true,
      removed: false,
    },
    identity: null,
    counts: { threads: 0, turns: 0, requests: 0, replies: 0, reports: 0 },
    observations: [],
    startupMessages: [],
    capabilities: {
      nativeAvailability: "unproved",
      supported: [],
      unsupported: [
        "async-or-nonawaited",
        "standalone-free-text",
        "timed-auto-resolution",
        "multiple-choice-no-cardinality-field",
        "recommendation-no-explicit-field",
      ],
      untested: ["service-integration", "restart-recovery", "production-UI"],
    },
    receipt: { kind: "unproved" },
    consumption: { kind: "unproved" },
    cleanup: { verified: false, interruptRequested: false },
    limitations: {
      providerThreads:
        "Provider thread records may remain; this probe does not delete them.",
      boundary:
        "Existing operator login and Codex runtime controls; no independent Ensemble sandbox guarantee.",
      callbackWait:
        "The same App Server process/turn retains the callback; no suspension or slot-release protocol is qualified.",
    },
    failure: null,
    evidencePath,
  };
  let stage = "spawn";
  let child;
  let db;
  let threadId;
  let turnId;
  let turnStarting = false;
  let endpoint;
  let native;
  let resumeRequested = false;
  let resumeResponded = false;
  evidence.nativeReplay = { accepted: 0 };
  let terminal;
  let report;
  let reportWriteStarted = false;
  let reportResolved = false;
  let resolved = false;
  let writeStarted = false;
  let writeSucceeded = false;
  let stopped = false;
  let exited = false;
  let failure;
  let sequence = 0;
  let clientId = 0;
  const pending = new Map();
  const timers = [];
  const observe = (kind) =>
    evidence.observations.push({ sequence: ++sequence, kind });
  let rejectFailure;
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  // Events may fail before the next awaited operation attaches its race.
  failed.catch(() => {});
  function fail(reason) {
    if (failure || stopped) return;
    failure = reason;
    observe("failure");
    rejectFailure(new Error(reason));
  }
  const bounded = (promise) => Promise.race([promise, failed]);
  function timer(ms, reason) {
    timers.push(setTimeout(() => fail(reason), ms));
  }
  function send(message) {
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(new Error("stdin-write-failed")) : resolve(),
      );
    });
  }
  async function request(method, params) {
    if (method === "thread/resume") {
      assert.equal(resumeRequested, false, "duplicate-resume-request");
      resumeRequested = true;
    }
    const rpcId = ++clientId;
    const response = new Promise((resolve, reject) =>
      pending.set(rpcId, { method, resolve, reject }),
    );
    await bounded(send({ id: rpcId, method, params }));
    return bounded(response);
  }
  function confirm() {
    if (
      !failure &&
      writeStarted &&
      writeSucceeded &&
      resolved &&
      evidence.receipt.kind !== "confirmed"
    ) {
      evidence.receipt = {
        kind: "confirmed",
        replyIntentId: endpoint.replyIntentId,
        answerDigest: endpoint.answerDigest,
        identity: evidence.identity,
      };
      observe("receipt-confirmed");
    }
  }
  function bindTurn(value) {
    assert.ok(
      text(value) && (turnId === undefined || turnId === value),
      "turn-identity-mismatch",
    );
    turnId = value;
  }
  function receive(line) {
    if (stopped || failure) return;
    try {
      const bytes = Buffer.byteLength(line);
      assert.ok(bytes <= 2_097_152, "oversized-message");
      const message = JSON.parse(line);
      assert.ok(object(message), "invalid-message");
      // Installed config/read includes unrelated operator configuration. Only its
      // exact typed pending response gets the larger envelope; callbacks do not.
      if (bytes > 1_048_576) {
        assert.ok(
          message.method === undefined &&
            id(message.id) &&
            pending.get(message.id)?.method === "config/read" &&
            message.error === undefined &&
            object(message.result),
          "oversized-message",
        );
      }
      if (message.method === undefined) {
        assert.ok(
          id(message.id) && pending.has(message.id),
          "unknown-response-identity",
        );
        assert.ok(
          message.error === undefined && object(message.result),
          "rpc-failed",
        );
        const response = pending.get(message.id);
        if (response.method === "config/read") {
          // Never retain the full configuration in a caller, receipt or evidence.
          const config = message.result.config;
          evidence.startupMessages.push({ method: "config/read", bytes });
          response.resolve({
            config: {
              approval_policy: config?.approval_policy,
              sandbox_mode: config?.sandbox_mode,
            },
          });
        } else if (
          ["thread/start", "thread/resume"].includes(response.method)
        ) {
          // Only the exact pending thread response may establish mode/settings;
          // project before any caller can retain private instructions or history.
          if (response.method === "thread/resume") {
            resumeResponded = true;
            observe("explicit-resume-response");
          }
          response.resolve(
            threadProjection(
              message.result,
              response.method === "thread/resume",
            ),
          );
        } else response.resolve(message.result);
        pending.delete(message.id);
        return;
      }
      const params = message.params;
      const item = params?.item;
      if (
        ["item/started", "item/completed"].includes(message.method) &&
        ((item?.type === "agentMessage" &&
          (item.delivery === "async" || item.questions != null)) ||
          (item?.type === "functionCallOutput" &&
            [
              "request_user_input_async",
              "functions.request_user_input_async",
            ].includes(item.name)))
      ) {
        assert.ok(
          turnStarting &&
            params.threadId === threadId &&
            text(params.turnId) &&
            (turnId === undefined || turnId === params.turnId),
          "async-identity-mismatch",
        );
        bindTurn(params.turnId);
        observe("unsupported-async-input");
        throw new Error("unsupported-async-input");
      }
      if (message.method === "item/tool/requestUserInput") {
        // Every delivery is checked, even when a repeated endpoint might be a replay.
        const validIdentity =
          turnStarting &&
          params?.threadId === threadId &&
          text(params.turnId) &&
          (turnId === undefined || params.turnId === turnId) &&
          text(params.itemId) &&
          id(message.id);
        if (native) {
          // Capture only safe identity and an opaque complete-body digest on rejection.
          const second = {
            runtimeGeneration: evidence.runtimeGeneration,
            ...evidence.process,
            method: message.method,
            threadId: text(params?.threadId) ? params.threadId : null,
            turnId: text(params?.turnId) ? params.turnId : null,
            itemId: text(params?.itemId) ? params.itemId : null,
            requestId: id(message.id) ? message.id : null,
            requestIdType: typeof message.id,
            paramsDigest: hash(JSON.stringify(params) ?? "undefined"),
          };
          const sameProcess =
            native.identity.runtimeGeneration === evidence.runtimeGeneration &&
            isDeepStrictEqual(native.process, evidence.process);
          if (
            validIdentity &&
            sameProcess &&
            resumeRequested &&
            resumeResponded &&
            !writeStarted &&
            !resolved &&
            !report &&
            !terminal &&
            evidence.nativeReplay.accepted === 0 &&
            message.id === native.requestId &&
            typeof message.id === typeof native.requestId &&
            message.method === native.method &&
            isDeepStrictEqual(params, native.params)
          ) {
            evidence.nativeReplay.accepted++;
            observe("native-resume-replay");
            return;
          }
          evidence.nativeReplay.rejected = second;
          assert.fail("duplicate-native-request");
        }
        assert.ok(validIdentity, "native-identity-mismatch");
        bindTurn(params.turnId);
        native = {
          requestId: message.id,
          method: message.method,
          params,
          identity: { runtimeGeneration: evidence.runtimeGeneration },
          process: { ...evidence.process },
        };
        evidence.counts.requests++;
        evidence.identity = {
          ...evidence.process,
          runtimeGeneration: evidence.runtimeGeneration,
          threadId,
          turnId,
          itemId: params.itemId,
          requestId: message.id,
          requestIdType: typeof message.id,
        };
        observe("native-request");
      } else if (message.method === "serverRequest/resolved") {
        if (
          report &&
          params?.threadId === threadId &&
          params.requestId === report.requestId &&
          typeof params.requestId === typeof report.requestId
        ) {
          assert.ok(
            reportWriteStarted && !reportResolved,
            "report-resolution-order-mismatch",
          );
          reportResolved = true;
          observe("report-request-resolved");
          return;
        }
        assert.ok(
          native &&
            params?.threadId === threadId &&
            params.requestId === native.requestId &&
            typeof params.requestId === typeof native.requestId,
          "resolved-identity-mismatch",
        );
        assert.ok(writeStarted && !resolved, "resolution-without-reply-write");
        resolved = true;
        observe("server-request-resolved");
        confirm();
      } else if (message.method === "item/tool/call") {
        assert.ok(
          id(message.id) &&
            params?.tool === reportTool.name &&
            params.threadId === threadId &&
            params.turnId === turnId &&
            text(params.callId) &&
            object(params.arguments),
          "report-identity-mismatch",
        );
        assert.ok(
          writeStarted &&
            evidence.counts.reports === 0 &&
            message.id !== native.requestId,
          "report-order-or-count-mismatch",
        );
        assert.deepEqual(
          params.arguments.answers,
          endpoint.answers,
          "answer-consumption-mismatch",
        );
        report = { requestId: message.id, callId: params.callId };
        evidence.counts.reports++;
        evidence.consumption = {
          kind: endpoint.shapes.includes("custom-text")
            ? "answer-only-nonce-report"
            : "selected-answer-report",
          callId: params.callId,
          answerDigest: endpoint.answerDigest,
        };
        observe("answer-report");
      } else if (message.method === "turn/started") {
        assert.ok(params?.threadId === threadId, "turn-identity-mismatch");
        bindTurn(params.turn?.id);
      } else if (message.method === "turn/completed") {
        assert.ok(
          params?.threadId === threadId && params.turn?.id === turnId,
          "terminal-identity-mismatch",
        );
        assert.ok(
          params.turn.status === "completed" && !params.turn.error,
          "cancelled-or-failed-turn",
        );
        assert.ok(
          report && resolved && writeStarted,
          "terminal-before-receipt-or-report",
        );
        assert.equal(terminal, undefined, "duplicate-terminal");
        terminal = { status: "completed", threadId, turnId };
        observe("successful-terminal");
      } else if (
        message.method === "error" ||
        message.method === "turn/failed" ||
        message.method === "thread/closed"
      ) {
        throw new Error("runtime-failure-or-loss");
      } else if (message.id !== undefined) {
        // No model-requested approval or other callback is authorized by this experiment.
        throw new Error("unexpected-server-request");
      }
      // Non-authoritative diagnostics/history are neither captured nor receipts.
    } catch (error) {
      fail(
        error instanceof assert.AssertionError
          ? error.message.split("\n")[0]
          : error instanceof SyntaxError
            ? "invalid-json"
            : error.message,
      );
    }
  }
  async function until(predicate) {
    while (!predicate()) await bounded(delay(5));
  }
  try {
    // Reserve scoped cleanup inside the total budget, rather than extending it after a timeout.
    timer(budgets.totalMs - budgets.cleanupMs, "total-budget-exceeded");
    child = spawn(
      fixture?.executable ?? evidence.source.executable,
      fixture?.args ?? [
        "app-server",
        "-c",
        "approval_policy=never",
        "-c",
        "sandbox_mode=workspace-write",
      ],
      { stdio: "pipe" },
    );
    evidence.runtimeGeneration = randomUUID();
    child.once("exit", () => {
      exited = true;
      fail("runtime-process-exited");
    });
    child.once("error", () => fail("runtime-process-error"));
    child.stdin.on("error", () => fail("stdin-write-failed"));
    child.stdin.on("close", () => fail("stdin-closed"));
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", receive);
    evidence.process = fixture
      ? {
          processId: String(child.pid),
          processStartedAt: "fixture-child-spawn",
          bootId: "fixture-only",
        }
      : await bounded(captureProcessIdentity(child.pid));
    assert.ok(evidence.process, "process-identity-unproved");
    stage = "initialize-and-policy";
    await request("initialize", {
      clientInfo: { name: "ensemble", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    await bounded(send({ method: "initialized" }));
    const account = await request("account/read", { refreshToken: false });
    assert.equal(
      account.account?.type,
      "chatgpt",
      "existing-chatgpt-login-required",
    );
    const config = await request("config/read", {});
    assert.ok(
      config.config?.approval_policy === "never" &&
        config.config.sandbox_mode === "workspace-write",
      "execution-policy-mismatch",
    );
    stage = "source-qualification";
    assert.ok(qualifiedSource(evidence.source), "unsupported-runtime-source");
    stage = "disposable-thread";
    const thread = await request("thread/start", {
      cwd: root,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      dynamicTools: [reportTool],
    });
    assert.ok(
      text(thread.thread?.id) &&
        thread.approvalPolicy === "never" &&
        thread.sandbox?.type === "workspaceWrite",
      "thread-policy-or-identity-mismatch",
    );
    threadId = thread.thread.id;
    evidence.counts.threads++;
    evidence.threadId = threadId;
    stage = "native-request";
    turnStarting = true;
    evidence.counts.turns++;
    timer(budgets.requestMs, "native-request-deadline");
    const started = await request("turn/start", {
      threadId,
      cwd: root,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [root],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
    });
    bindTurn(started.turn?.id);
    await until(() => native !== undefined);
    // Request deadline has been met. Keep only the total-budget timer.
    clearTimeout(timers.pop());
    stage = "effective-mode";
    observe("effective-mode-readback-started");
    const resumed = await request("thread/resume", { threadId });
    const mode = resumed.collaborationMode;
    assert.ok(
      resumed.thread.id === threadId &&
        resumed.approvalPolicy === "never" &&
        resumed.sandbox.type === "workspaceWrite",
      "resume-policy-or-identity-mismatch",
    );
    assert.ok(mode?.mode === "default", "unsupported-effective-mode");
    assert.ok(
      text(thread.model) &&
        text(thread.modelProvider) &&
        (thread.reasoningEffort === null || text(thread.reasoningEffort)) &&
        (thread.serviceTier === null || text(thread.serviceTier)) &&
        ["model", "modelProvider", "reasoningEffort", "serviceTier"].every(
          (key) => resumed[key] === thread[key],
        ) &&
        mode.settings.model === resumed.model &&
        mode.settings.reasoningEffort === resumed.reasoningEffort &&
        /^[a-f0-9]{64}$/.test(mode.settings.developerInstructionsDigest ?? ""),
      "effective-settings-mismatch",
    );
    evidence.qualification = {
      codexVersion: evidence.source.codex,
      executableHash: evidence.source.executableHash,
      runtimeGeneration: evidence.runtimeGeneration,
      threadId,
      mode: mode.mode,
      model: resumed.model,
      modelProvider: resumed.modelProvider,
      reasoningEffort: resumed.reasoningEffort,
      serviceTier: resumed.serviceTier,
      developerInstructionsDigest: mode.settings.developerInstructionsDigest,
      continuation: "version-bound-synchronous-route",
      observedAt: "held-native-callback-before-answer",
    };
    observe("effective-default-observed");
    endpoint = selectAnswers(
      evidence.source,
      evidence.qualification,
      native.params,
      randomUUID(),
    );
    evidence.capabilities.nativeAvailability = "observed";
    evidence.capabilities.supported = endpoint.shapes;
    for (const shape of ["custom-text"]) {
      if (!endpoint.shapes.includes(shape))
        evidence.capabilities.unsupported.push(`${shape}-not-observed`);
    }
    evidence.request = {
      isBlocking: native.params.isBlocking,
      autoResolutionMs: native.params.autoResolutionMs,
      questions: native.params.questions,
    };
    stage = "blocked-checkpoint";
    await bounded(delay(budgets.holdMs));
    assert.ok(
      !resolved && !report && !terminal && evidence.counts.replies === 0,
      "blocked-checkpoint-failed",
    );
    observe("blocked-zero-replies-checkpoint");
    stage = "answer-persistence";
    const answerJson = JSON.stringify({ answers: endpoint.answers });
    endpoint.answerDigest = hash(answerJson);
    endpoint.replyIntentId = randomUUID();
    const commandReceiptId = randomUUID();
    db = new DatabaseSync(join(root, "proof.sqlite"));
    db.exec(
      "CREATE TABLE proof (task_id TEXT PRIMARY KEY, identity TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, command_receipt TEXT NOT NULL, reply_intent TEXT NOT NULL, digest TEXT NOT NULL); BEGIN IMMEDIATE",
    );
    db.prepare("INSERT INTO proof VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      evidence.fixture.taskId,
      JSON.stringify(evidence.identity),
      JSON.stringify(evidence.request),
      answerJson,
      commandReceiptId,
      endpoint.replyIntentId,
      endpoint.answerDigest,
    );
    db.exec("COMMIT");
    const readback = new DatabaseSync(join(root, "proof.sqlite"), {
      readOnly: true,
    });
    try {
      const committed = readback
        .prepare(
          "SELECT answer, command_receipt, reply_intent, digest FROM proof WHERE task_id = ?",
        )
        .get(evidence.fixture.taskId);
      assert.ok(
        committed?.answer === answerJson &&
          committed.command_receipt === commandReceiptId &&
          committed.reply_intent === endpoint.replyIntentId &&
          committed.digest === endpoint.answerDigest &&
          evidence.counts.replies === 0,
        "committed-answer-readback-failed",
      );
    } finally {
      readback.close();
    }
    evidence.persistence = {
      commandReceiptId,
      replyIntentId: endpoint.replyIntentId,
      answerDigest: endpoint.answerDigest,
      committed: true,
      committedBeforeEffect: true,
    };
    observe("answer-and-intent-committed");
    stage = "native-reply";
    assert.ok(
      !failure &&
        !resolved &&
        !terminal &&
        child.exitCode === null &&
        child.signalCode === null,
      "endpoint-unavailable-before-effect",
    );
    writeStarted = true;
    evidence.counts.replies++;
    observe("reply-write-initiated");
    const response = {
      id: native.requestId,
      result: { answers: endpoint.answers },
    };
    if (fixture?.writeNativeReply)
      await bounded(fixture.writeNativeReply(child, response, send));
    else await bounded(send(response));
    writeSucceeded = true;
    observe("stdin-callback-succeeded");
    confirm();
    stage = "receipt-and-consumption";
    await until(
      () => evidence.receipt.kind === "confirmed" && report !== undefined,
    );
    reportWriteStarted = true;
    await bounded(
      send({
        id: report.requestId,
        result: {
          success: true,
          contentItems: [
            { type: "inputText", text: "UI01 proof report recorded" },
          ],
        },
      }),
    );
    observe("report-callback-ended");
    stage = "successful-terminal";
    await until(() => terminal !== undefined);
    evidence.terminal = terminal;
    evidence.status = "passed";
  } catch (error) {
    evidence.failure = {
      stage,
      reason:
        failure ??
        (error instanceof assert.AssertionError
          ? error.message.split("\n")[0]
          : ["stdin-write-failed"].includes(error.message)
            ? error.message
            : "protocol-contract-failed"),
    };
    evidence.receipt =
      evidence.receipt.kind === "confirmed"
        ? evidence.receipt
        : { kind: writeStarted ? "uncertain" : "unavailable" };
  } finally {
    stopped = true;
    for (const handle of timers) clearTimeout(handle);
    db?.close();
    if (child?.pid) {
      const cleanupDeadline = Date.now() + budgets.cleanupMs;
      const remaining = () => Math.max(1, cleanupDeadline - Date.now());
      if (threadId && turnId && !terminal && !exited) {
        evidence.cleanup.interruptRequested = true;
        // Stop uncertainty does not qualify a receipt. Cleanup targets only this created identity.
        try {
          await waitBounded(
            send({
              id: ++clientId,
              method: "turn/interrupt",
              params: { threadId, turnId },
            }),
            Math.min(500, remaining()),
            undefined,
          );
        } catch {
          /* termination below remains required */
        }
      }
      const waitExit = async () => {
        const deadline =
          Date.now() + Math.min(3000, Math.floor(remaining() / 2));
        while (!exited && Date.now() < deadline) await delay(10);
      };
      if (!exited) {
        child.kill("SIGTERM");
        await waitExit();
      }
      if (!exited) {
        child.kill("SIGKILL");
        await waitExit();
      }
      let verification;
      try {
        verification = await waitBounded(
          fixture
            ? fixture.verifyTermination
              ? fixture.verifyTermination(evidence.process)
              : {
                  kind: exited ? "verified" : "unknown",
                  method: "fixture-child-exit-observed",
                }
            : evidence.process
              ? new MacProcessTerminationVerifier().verify(evidence.process)
              : { kind: "unknown", reason: "missing-process-identity" },
          remaining(),
          { kind: "unknown", reason: "process-verification-deadline" },
        );
      } catch {
        verification = {
          kind: "unknown",
          reason: "process-verification-unreadable",
        };
      }
      evidence.cleanup.verification = verification;
      evidence.cleanup.verified = exited && verification.kind === "verified";
    }
    if (!evidence.cleanup.verified) {
      evidence.status = "failed";
      evidence.failure ??= {
        stage: "cleanup",
        reason: "exact-process-exit-unproved",
      };
    }
    if (evidence.status === "passed" && evidence.cleanup.verified) {
      rmSync(root, { recursive: true, force: true });
      evidence.fixture.removed = true;
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return evidence;
}

function sourceEvidence() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-ui01-schema-"));
  chmodSync(directory, 0o700);
  try {
    const command = (executable, args) =>
      execFileSync(executable, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim();
    const executable = command("which", ["codex"]);
    const version = command(executable, ["--version"]);
    command(executable, [
      "app-server",
      "generate-ts",
      "--experimental",
      "--out",
      directory,
    ]);
    const files = [
      "v2/ToolRequestUserInputParams.ts",
      "v2/ToolRequestUserInputQuestion.ts",
      "v2/ToolRequestUserInputOption.ts",
      "v2/ToolRequestUserInputResponse.ts",
      "v2/ToolRequestUserInputAnswer.ts",
      "v2/ServerRequestResolvedNotification.ts",
      "InitializeParams.ts",
      "v2/ThreadStartParams.ts",
      "v2/TurnStartParams.ts",
      "v2/ThreadResumeResponse.ts",
      "v2/ThreadResumeParams.ts",
      "CollaborationMode.ts",
      "Settings.ts",
      "v2/ThreadItem.ts",
      "v2/ItemStartedNotification.ts",
      "v2/AgentMessageDelivery.ts",
    ];
    const schema = Object.fromEntries(
      files.map((file) => [file, hash(readFileSync(join(directory, file)))]),
    );
    return {
      revision: command("git", ["rev-parse", "HEAD"]),
      node: process.version,
      npm: command(process.execPath, [
        "/tmp/ensemble-npm122.pkgNDI/package/bin/npm-cli.js",
        "--version",
      ]),
      executable,
      executableHash: hash(readFileSync(executable)),
      codex: version,
      schema,
      nativeOrigin: {
        tag: "rust-v0.159.0",
        synchronousPath:
          "codex-rs/core/src/tools/handlers/request_user_input.rs",
        asynchronousPath:
          "codex-rs/core/src/tools/handlers/request_user_input_async.rs",
        asynchronousSourceHash:
          "16be7e521e3f91aaede5bd233a52671e0cd5454ef4d8a4a67eeb71908ab06096",
        attribution:
          "inspected-tagged-source; native-RPC-synchronous; async-AgentMessage",
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    validateArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (!process.exitCode) {
    try {
      const evidence = await runProtocol({ source: sourceEvidence() });
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      process.exitCode = evidence.status === "passed" ? 0 : 1;
    } catch {
      process.stderr.write(
        "Protocol metadata or setup unavailable; no capability is qualified.\n",
      );
      process.exitCode = 1;
    }
  }
}
