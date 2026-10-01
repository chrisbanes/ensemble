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
  "This is a disposable native input capability probe. Use no shell, filesystem, browser, network, delegation or external tools.",
  "Use the runtime's native user-input tool exactly once. Ask delivery, header Delivery, question Select delivery, with Local (Local output) and Remote (Remote output).",
  "The installed callback schema has no explicit multiple-choice cardinality or recommendation field. In that same native request include free-text goal, multiple-choice formats with Text/JSON, custom text on delivery, and an explicit recommendation only where the native tool actually exposes explicit support for those semantics. Omit unsupported variants. Do not imply multiple selection from an array or recommendation from a label suffix. Do not substitute ordinary chat if native input is unavailable.",
  "After the native answer, call ui01_report_answers exactly once with the exact answers received in native response shape {answers: {questionId: {answers: [strings]}}}, then end. Do not guess the answer, ask again or request approval.",
].join("\n");

function selectAnswers(params, nonce) {
  assert.ok(
    params.isBlocking === true && params.autoResolutionMs === null,
    "unsupported-continuation",
  );
  assert.ok(
    Array.isArray(params.questions) &&
      params.questions.length > 0 &&
      params.questions.length <= 3,
    "unsupported-question-set",
  );
  const answers = {};
  const shapes = [];
  const seen = new Set();
  for (const question of params.questions) {
    assert.ok(
      object(question) &&
        ["delivery", "goal", "formats"].includes(question.id) &&
        !seen.has(question.id),
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
      question.options === null ||
        (Array.isArray(question.options) &&
          question.options.length > 0 &&
          question.options.length <= 8),
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
    } else if (question.id === "goal") {
      assert.equal(question.options, null, "unsupported-goal-shape");
      answers.goal = { answers: [`UI01 goal ${nonce}`] };
      shapes.push("free-text");
    } else {
      // A string-array response is not evidence of multiple-selection semantics.
      throw new Error("unproved-multiple-choice-semantics");
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
        "nonblocking",
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
        } else response.resolve(message.result);
        pending.delete(message.id);
        return;
      }
      const params = message.params;
      if (message.method === "item/tool/requestUserInput") {
        assert.equal(evidence.counts.requests, 0, "duplicate-native-request");
        assert.ok(
          turnStarting &&
            params?.threadId === threadId &&
            text(params.turnId) &&
            text(params.itemId) &&
            id(message.id),
          "native-identity-mismatch",
        );
        bindTurn(params.turnId);
        native = { requestId: message.id, params };
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
          kind:
            endpoint.shapes.includes("custom-text") ||
            endpoint.shapes.includes("free-text")
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
      fixture?.executable ?? "codex",
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
    endpoint = selectAnswers(native.params, randomUUID());
    evidence.capabilities.nativeAvailability = "observed";
    evidence.capabilities.supported = endpoint.shapes;
    if (native.params.questions.length > 1)
      evidence.capabilities.supported.push("grouped-question-set");
    for (const shape of ["free-text", "custom-text"]) {
      if (!endpoint.shapes.includes(shape))
        evidence.capabilities.unsupported.push(`${shape}-not-observed`);
    }
    evidence.request = {
      isBlocking: true,
      autoResolutionMs: null,
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
          : [
                "unproved-multiple-choice-semantics",
                "stdin-write-failed",
              ].includes(error.message)
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
    const version = command("codex", ["--version"]);
    const executable = command("which", ["codex"]);
    command("codex", [
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
