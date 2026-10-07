import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { OperatorRouteRegistry } from "../../dist/src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../../dist/src/standalone/operator-runtime.js";
import { coordinationOperatorRoutes } from "../../dist/src/standalone/operator-coordination.js";
import { chromium } from "playwright";
import {
  StandaloneService,
  CodexRuntime,
} from "../../dist/src/standalone/index.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import { OperatorAuth } from "../../dist/src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../dist/src/standalone/operator.js";
import { OperatorApi } from "../../dist/src/standalone/operator-api.js";
import {
  OperatorWebBundle,
  OperatorWebBoundary,
} from "../../dist/src/standalone/operator-web.js";
export const instructions = [
  "Disposable repository-free native input qualification. Use no shell, filesystem, browser, network, delegation or additional external tools.",
  "Directly and synchronously call functions.request_user_input exactly once and await its answer. Ask one question: id delivery, header Delivery, question Select delivery, options Local (Local output) and Remote (Remote output). Custom text is permitted only when the native request explicitly exposes isOther support.",
  "Before receiving the native answer, do not use functions.exec, ALL_TOOLS, tool search/discovery, async input or nonawaited calls. Do not substitute plaintext chat if native input is unavailable.",
  "After receiving the native answer, use functions.exec exactly once to run only this awaited known call: await tools.ui07_report_answers({answers: <exact received answers map>}). Preserve the exact map {questionId: {answers: [strings]}}. No discovery or other calls; await the report result, then end. Do not guess the answer, ask again or request approval.",
].join("\n");
const reportTool = {
  type: "function",
  name: "ui07_report_answers",
  description:
    "Qualification-only exact native answer consumption report. Grants no permission.",
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
import {
  consumeGrantMarker,
  observeFixtureChild,
} from "../ui04/runtime-contract.mjs";
export { consumeGrantMarker };
export const resource = "existing-login:codex-app-server:qualification";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const command = (args) =>
  execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
async function bounded(action, deadline, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`${label}-deadline`)),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runQualification(options = {}) {
  const fixture = options.fixture;
  const totalMs = fixture?.totalMs ?? (fixture ? 15000 : 240000),
    cleanupMs = fixture ? 2000 : 10000,
    start = Date.now(),
    deadline = start + totalMs - cleanupMs;
  assert.ok(
    Number.isSafeInteger(totalMs) && totalMs > cleanupMs && totalMs <= 240000,
    "finite-total-budget-required",
  );
  const grant = options.grant;
  let ledger;
  const checkRegistry = () => {
    const registry = JSON.parse(readFileSync(grant.registryPath, "utf8"));
    const lock = registry.resourceLocks?.[resource];
    assert.ok(
      lock &&
        lock.issue === 745 &&
        lock.holder === grant.holder &&
        lock.grantId === grant.grantId &&
        lock.state === "held" &&
        lock.sourceHead === grant.sourceHead &&
        lock.sourceTree === grant.sourceTree &&
        lock.harnessSha256 === grant.harnessSha256 &&
        lock.ledgerPath === grant.ledgerPath,
      "canonical-resource-grant-mismatch",
    );
  };
  if (!fixture) {
    assert.ok(
      grant &&
        grant.issue === 745 &&
        grant.holder === "ui07_worker" &&
        grant.resource === resource &&
        grant.sourceHead === command(["rev-parse", "HEAD"]) &&
        grant.sourceTree === command(["rev-parse", "HEAD^{tree}"]) &&
        command(["status", "--porcelain"]) === "" &&
        grant.executable &&
        grant.runtimeVersion === "0.159.0" &&
        grant.executableSha256 ===
          "e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a" &&
        hash(readFileSync(grant.executable)) === grant.executableSha256 &&
        execFileSync(grant.executable, ["--version"], {
          encoding: "utf8",
          timeout: 10000,
        }).trim() === "codex-cli 0.159.0" &&
        /^[a-f0-9-]{36}$/.test(grant.grantId) &&
        grant.totalMs === totalMs &&
        grant.cleanupMs === cleanupMs &&
        grant.maxThreads === 1 &&
        grant.maxTurns === 1 &&
        grant.maxReports === 1 &&
        grant.maxRequests === 1 &&
        grant.maxReplies === 1 &&
        grant.requestMs === 90000 &&
        grant.retries === 0 &&
        grant.harnessSha256 ===
          hash(readFileSync(fileURLToPath(import.meta.url))) &&
        grant.registryPath === "/tmp/ensemble-approved-run-checkpoint.json" &&
        grant.consumedMarker === `/tmp/ui07-${grant.grantId}.consumed` &&
        grant.ledgerPath === "/tmp/ui07-delivery.json",
      "exact-clean-grant-required",
    );
    checkRegistry();
    ledger = JSON.parse(readFileSync(grant.ledgerPath, "utf8"));
    assert.ok(
      !ledger.live?.consumed && ledger.liveAttemptsStarted === 0,
      "one-use-attempt-already-consumed",
    );
    // Exclusive creation is the irreversible consumption point, before any launch setup.
    consumeGrantMarker(grant, start);
    ledger.liveAttemptsStarted = (ledger.liveAttemptsStarted ?? 0) + 1;
    ledger.live = {
      ...grant,
      consumed: true,
      attemptsUsed: 1,
      state: "starting",
      startedAt: new Date(start).toISOString(),
    };
    writeFileSync(grant.ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  }
  let root;
  try {
    root = mkdtempSync(
      join(realpathSync(tmpdir()), "ensemble-ui07-qualification-"),
    );
    chmodSync(root, 0o700);
  } catch (error) {
    const failure = {
      status: "failed",
      stage: "setup",
      resource,
      grantId: grant?.grantId,
      consumedMarker: grant?.consumedMarker,
      reason: String(error.message),
      counts: { threads: 0, turns: 0, requests: 0, replies: 0, reports: 0 },
      cleanup: { verified: true, reason: "no-process-or-resource-launched" },
    };
    if (!fixture) {
      const evidencePath = `${grant.consumedMarker}.failure.json`;
      writeFileSync(evidencePath, JSON.stringify(failure, null, 2) + "\n", {
        mode: 0o600,
      });
      ledger.live = {
        ...ledger.live,
        state: "failed",
        evidencePath,
        cleanupVerified: true,
      };
      writeFileSync(grant.ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
    }
    return failure;
  }
  const evidence = {
    mode: fixture ? "deterministic-fake-host" : "live",
    root,
    status: "failed",
    sourceHead: grant?.sourceHead ?? command(["rev-parse", "HEAD"]),
    sourceTree: grant?.sourceTree ?? command(["rev-parse", "HEAD^{tree}"]),
    sourceDirty: command(["status", "--porcelain"]) !== "",
    sourceInputs: Object.fromEntries(
      [
        "src/standalone/service.ts",
        "src/standalone/state.ts",
        "src/standalone/scheduler.ts",
        "src/standalone/codex.ts",
        "src/standalone/operator-api.ts",
        "web/src/app.tsx",
        "web/src/question-response.tsx",
        "test/ui07/runtime-contract.mjs",
        "test/ui07/fake-app-server.mjs",
        "test/ui04/runtime-contract.mjs",
        "dist/operator/index.html",
        ...readdirSync(join(rootDir, "dist/operator/assets"))
          .filter((name) => /\.(js|css)$/.test(name))
          .sort()
          .map((name) => `dist/operator/assets/${name}`),
      ].map((path) => [path, hash(readFileSync(join(rootDir, path)))]),
    ),
    timing: [],
    resource,
    grantId: grant?.grantId ?? null,
    limits: { totalMs, cleanupMs },
    counts: { threads: 0, turns: 0, requests: 0, replies: 0, reports: 0 },
    callbackEnded: false,
    cleanup: {
      operations: {},
      failures: [],
      lateResources: [],
      verified: false,
    },
    screenshots: [],
  };
  let service,
    runtime,
    fixtureChild,
    browser,
    http,
    auth,
    accepted,
    nativeCall,
    page,
    callbackPending = false,
    callbackFailure;
  let finishing = false,
    probe;
  const pendingSteps = new Set();
  const step = (action, label, lateCleanup) => {
    const interval = {
      action: label,
      startedAt: new Date().toISOString(),
      startedMs: Date.now() - start,
      state: "pending",
    };
    evidence.timing.push(interval);
    const promise = Promise.resolve()
      .then(() => {
        assert.ok(!finishing && Date.now() < deadline, `${label}-deadline`);
        return action();
      })
      .then(async (value) => {
        if (finishing && lateCleanup) {
          const record = {
            identity: `${label}:${evidence.cleanup.lateResources.length + 1}`,
            kind: value?.constructor?.name ?? label,
            state: "pending",
          };
          evidence.cleanup.lateResources.push(record);
          try {
            await lateCleanup(value);
            record.state = "settled";
          } catch (error) {
            record.state = "failed";
            record.reason = String(error.message).slice(0, 512);
            throw error;
          }
          throw Error(`${label}-late-creation-cleaned`);
        }
        return value;
      });
    pendingSteps.add(promise);
    promise.then(
      () => pendingSteps.delete(promise),
      () => pendingSteps.delete(promise),
    );
    return bounded(
      () => promise,
      Math.min(deadline, Date.now() + 10000),
      label,
    ).then(
      (value) => {
        interval.state = "completed";
        interval.endedMs = Date.now() - start;
        return value;
      },
      (error) => {
        interval.state = "failed";
        interval.endedMs = Date.now() - start;
        throw error;
      },
    );
  };
  let taskId;
  const projectId = randomUUID(),
    profileId = randomUUID(),
    data = join(root, "data");

  evidence.projectId = projectId;
  const save = () =>
    writeFileSync(`${root}.json`, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  const until = async (predicate, label, end = deadline) => {
    while (true) {
      if (callbackFailure) throw callbackFailure;
      if (predicate()) return;
      assert.ok(Date.now() < Math.min(end, deadline), `${label}-deadline`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    let executable = grant?.executable;
    if (fixture) {
      executable = join(root, "fake-codex");
      writeFileSync(
        executable,
        `#!/bin/sh\nexec '${process.execPath}' '${join(rootDir, "test/ui07/fake-app-server.mjs")}' "$@"\n`,
        { mode: 0o700 },
      );
    }
    service = new StandaloneService(
      data,
      (context) => {
        runtime = new CodexRuntime(executable, {
          ...context,
          ...(fixture
            ? {
                qualifiedExecutableHash: hash(readFileSync(executable)),
                captureProcessIdentity: async (pid) => {
                  assert.ok(
                    Number.isSafeInteger(pid) && pid > 0,
                    "fixture-child-pid",
                  );
                  assert.equal(
                    runtime.child?.pid,
                    pid,
                    "exact-fixture-child-binding",
                  );
                  fixtureChild = observeFixtureChild(runtime.child);
                  return {
                    processId: String(pid),
                    processStartedAt: "fixture-owned-child",
                    bootId: "fixture-boot",
                  };
                },
                spawnEnvironment: () => ({
                  ...context.spawnEnvironment(),
                  UI07_FIXTURE_MODE: fixture.mode ?? "proof",
                }),
              }
            : {}),
        });
        const startThread = runtime.startThread.bind(runtime),
          startTurn = runtime.startTurn.bind(runtime),
          onTool = runtime.onToolCall.bind(runtime),
          onRequest = runtime.onUserInputRequest.bind(runtime),
          onOutcome = runtime.onUserInputOutcome.bind(runtime),
          reply = runtime.replyUserInput.bind(runtime),
          waitForTurn = runtime.waitForTurn.bind(runtime);
        const count = (name) => {
          const prior = evidence.counts[name];
          evidence.counts[name]++;
          save();
          if (prior !== 0) {
            callbackFailure ??= Error(`second-${name}-forbidden`);
            throw callbackFailure;
          }
        };
        runtime.startThread = async (workspace, tools) => {
          count("threads");
          return startThread(workspace, [...(tools ?? []), reportTool]);
        };
        runtime.startTurn = async (thread, workspace, prompt) => {
          count("turns");
          assert.ok(
            prompt.includes(instructions),
            "normal-prepared-prompt-missing-instructions",
          );
          assert.match(prompt, /Assignment role: project (lead|assignee)\./);
          for (const label of [
            "Captured review references (JSON):",
            "Captured project instructions (revision 1):",
            "Captured profile instructions (revision 1):",
          ])
            assert.ok(
              prompt.includes(label),
              `normal-prepared-prompt-missing-${label}`,
            );
          const context = service
            .taskReview()
            .read(taskId)
            .contexts.find(
              (c) =>
                c.workId ===
                service.list().find((i) => i.threadId === thread)?.workId,
            );
          assert.ok(context, "normal-prepared-work-context-missing");
          evidence.prompt = {
            sha256: hash(prompt),
            includesFixedInstructions: true,
            includesRoleSourceProjectProfileContext: true,
            contextCaptured: Boolean(context),
            overridden: false,
          };
          return startTurn(thread, workspace, prompt);
        };
        runtime.waitForTurn = async (threadId, turnId) => {
          const outcome = await waitForTurn(threadId, turnId);
          if (!evidence.callbackEnded) {
            callbackFailure ??= Error("terminal-before-native-consumption");
            evidence.earlyTerminal = { threadId, turnId, outcome };
            await service.stopTask(taskId);
          }
          return outcome;
        };
        runtime.onUserInputRequest = (listener) =>
          onRequest((request) => {
            count("requests");
            nativeCall = request;
            listener(request);
          });
        runtime.onUserInputOutcome = (listener) =>
          onOutcome((outcome) => {
            listener(outcome);
            evidence.receipt = outcome;
          });
        runtime.replyUserInput = (identity, response, gate) => {
          if (fixture?.mode === "missing-reply") return new Promise(() => {});
          return reply(identity, response, () => {
            const intent = gate();
            count("replies");
            evidence.intent = intent;
            return intent;
          });
        };
        runtime.onToolCall = (listener) =>
          onTool(async (call) => {
            try {
              assert.equal(call.tool, "ui07_report_answers", "unexpected-tool");
              count("reports");
              assert.ok(nativeCall && accepted, "report-before-native-answer");
              assert.equal(
                call.threadId,
                nativeCall.identity.threadId,
                "foreign-report-thread",
              );
              assert.equal(
                call.turnId,
                nativeCall.identity.turnId,
                "foreign-report-turn",
              );
              assert.ok(
                isDeepStrictEqual(call.arguments, { answers: accepted }),
                "exact-native-answer-map",
              );
              const work = service
                .list()
                .find(
                  (i) =>
                    i.threadId === call.threadId && i.turnId === call.turnId,
                );
              assert.ok(work, "missing-bound-work");
              callbackPending = true;
              const reporting = listener({
                ...call,
                tool: "ensemble_report_result",
                arguments: {
                  summary: "UI07 exact native answer consumption observed",
                },
              });
              service.registerExecutionCallback(work.workId, reporting);
              let result;
              try {
                result = await reporting;
              } finally {
                callbackPending = false;
                evidence.callbackEnded = true;
              }
              assert.equal(result.success, true, "bound-report-rejected");
              return result;
            } catch (error) {
              callbackFailure ??= error;
              await service.stopTask(taskId);
              evidence.callbackFailure = {
                reason: String(error.message).slice(0, 1024),
              };
              return {
                success: false,
                contentItems: [
                  { type: "inputText", text: "Qualification report rejected" },
                ],
              };
            }
          });
        return runtime;
      },
      undefined,
      {
        power: { enabled: false },
        supervisor: { observationMs: fixture ? 5 : 1000 },
      },
    );
    if (!fixture) checkRegistry();
    await step(
      () => service.start(),
      "service-start",
      () => service.stop(),
    );
    evidence.process = runtime?.processIdentity();
    const run = (body) =>
      service
        .domain()
        .execute({ actor: "operator", key: randomUUID(), ...body });
    run({
      type: "profile.create",
      profileId,
      name: "UI07 qualification lead",
      instructions,
      capabilities: "native input qualification",
    });
    run({
      type: "project.create",
      projectId,
      name: "UI07 disposable qualification",
      leadProfileId: profileId,
    });
    run({
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [],
    });
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    probe = createServer();
    await step(
      () =>
        new Promise((r, reject) => {
          probe.once("error", reject);
          probe.listen(0, "127.0.0.1", r);
        }),
      "port",
      () => new Promise((r) => probe.close(r)),
    );
    const port = probe.address().port;
    await step(() => new Promise((r) => probe.close(r)), "port-close");
    const origin = `http://127.0.0.1:${port}`,
      password = "disposable UI07 operator password",
      authFile = join(root, "operator.auth");
    await step(
      () => OperatorAuth.initialize(authFile, password),
      "auth-initialize",
    );
    auth = await step(
      () => OperatorAuth.open({ authFile, origin }),
      "auth-open",
      (late) => late.close(),
    );
    const bundle = await step(
      () => OperatorWebBundle.open(join(rootDir, "dist/operator")),
      "bundle-open",
    );
    const routes = new OperatorRouteRegistry();
    routes.registerSlot("runtime", runtimeOperatorRoutes(service));
    routes.registerSlot(
      "coordination",
      coordinationOperatorRoutes(
        service.coordinationView(),
        service.domain(),
        (id) => service.routingAvailability(id),
      ),
    );
    http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
      routes,
      web: new OperatorWebBoundary(bundle, new OperatorApi(service, [root])),
    });
    await step(
      () => http.start(port),
      "operator-start",
      () => http.stop(),
    );
    browser = await step(
      async () => {
        const value = await chromium.launch();
        if (fixture?.delayBrowserCreation)
          await new Promise((r) =>
            setTimeout(r, Math.max(1, deadline - Date.now()) + 80),
          );
        return value;
      },
      "browser-start",
      async (late) => {
        await late.close();
        if (fixture?.lateCleanupFailure)
          throw Error("injected-late-cleanup-failure");
      },
    );
    page = await step(
      () => browser.newPage({ viewport: { width: 1366, height: 900 } }),
      "browser-page",
      (late) => late.close(),
    );
    page.setDefaultTimeout(5000);
    const commands = [];
    page.on("request", (request) => {
      if (
        request.url().endsWith("/api/operator/commands") &&
        request.method() === "POST"
      ) {
        const body = request.postDataJSON();
        commands.push(body);
        if (body.type === "task.create") {
          taskId = body.taskId;
          evidence.taskId = taskId;
        }
      }
    });
    await step(async () => {
      if (fixture?.delayHttp)
        await new Promise((r) =>
          setTimeout(r, Math.max(1, deadline - Date.now()) + 50),
        );
      assert.ok(
        !finishing && Date.now() < deadline,
        "browser-create-task-deadline",
      );
      await page.goto(`${origin}/app/tasks/new`);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByLabel("Project", { exact: true }).selectOption(projectId);
      await page
        .getByLabel("Task title", { exact: true })
        .fill("UI07 native answer qualification");
      await page
        .getByLabel("Desired outcome", { exact: true })
        .fill(instructions);
      await page.getByLabel("Assignee", { exact: true }).selectOption("");
      await page
        .getByRole("button", { name: "Create and start", exact: true })
        .click();
      await page.getByRole("link", { name: "Open task", exact: true }).click();
    }, "browser-create-task");
    assert.ok(taskId);
    assert.equal(commands.filter((c) => c.type === "task.create").length, 1);
    await until(
      () => nativeCall,
      "native-request",
      Math.min(deadline, Date.now() + (fixture ? 3000 : 90000)),
    );
    assert.equal(nativeCall.request.questions.length, 1);
    assert.equal(nativeCall.request.questions[0].id, "delivery");
    assert.equal(nativeCall.request.isBlocking, false);
    assert.equal(nativeCall.request.autoResolutionMs, null);
    if (fixture?.mode === "assertion-active")
      assert.fail("injected-assertion-while-runtime-active");
    const q = service.coordinationView().readTask(taskId).runtimeQuestions[0];
    assert.ok(q);
    await step(
      () =>
        page.goto(`${origin}/app/tasks/${taskId}?request=${q.interactionId}`),
      "browser-observe-question",
    );
    await step(
      () =>
        page
          .getByRole("button", { name: "Submit answer", exact: true })
          .waitFor(),
      "browser-mounted-native-form",
    );
    run({
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused: true,
    });
    const text = nativeCall.request.questions[0].isOther
      ? `UI07 custom ${randomUUID()}`
      : "Local";
    accepted = { delivery: { answers: [text] } };
    await step(async () => {
      if (nativeCall.request.questions[0].isOther)
        await page
          .getByRole("textbox", {
            name: "Custom answer: Delivery",
            exact: true,
          })
          .fill(text);
      else await page.getByRole("radio", { name: /^Local/ }).check();
      await page
        .getByRole("button", { name: "Submit answer", exact: true })
        .click();
      await page.getByText(/Answer recorded\./).waitFor();
    }, "browser-submit-native-answer");
    const sent = commands.filter((c) => c.type === "question.native.answer");
    assert.equal(sent.length, 1);
    assert.equal(evidence.counts.replies, 0);
    const reader = new DatabaseSync(join(data, "standalone.sqlite"), {
      readOnly: true,
    });
    try {
      const persisted = reader
        .prepare(
          "SELECT answerJson,answerDigest,replyIntentId,deliveryState FROM coordination_runtime_questions WHERE interactionId=?",
        )
        .get(q.interactionId);
      const receipt = reader
        .prepare(
          "SELECT result FROM coordination_operator_receipts WHERE scope='answer-runtime-question' AND commandKey=?",
        )
        .get(sent[0].key);
      assert.ok(persisted && receipt);
      assert.deepEqual(JSON.parse(persisted.answerJson), accepted);
      assert.equal(persisted.replyIntentId, null);
      assert.equal(persisted.deliveryState, "held");
      evidence.persistence = {
        committedBeforeEffect: true,
        independentReadOnlyConnection: true,
        zeroReplies: true,
        answerDigest: persisted.answerDigest,
        receiptCount: 1,
      };
    } finally {
      reader.close();
    }
    run({
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused: false,
    });
    await until(
      () =>
        evidence.callbackEnded &&
        service
          .list()
          .some(
            (i) =>
              i.threadId === nativeCall.identity.threadId &&
              i.turnId === nativeCall.identity.turnId &&
              i.state === "completed",
          ),
      "native-consumption-terminal",
    );
    assert.equal(callbackPending, false);
    assert.equal(service.taskHold(taskId), undefined);
    assert.equal(
      service.coordinationView().readTask(taskId).runtimeQuestions[0]
        .deliveryState,
      "confirmed",
    );
    assert.equal(service.coordinationView().readTask(taskId).results.length, 1);
    assert.deepEqual(evidence.counts, {
      threads: 1,
      turns: 1,
      requests: 1,
      replies: 1,
      reports: 1,
    });
    evidence.settlement = {
      exactBoundSuccessfulTerminal: true,
      callbackEnded: true,
      noOtherHold: true,
    };
    await step(async () => {
      await page.reload();
      await page
        .getByText("UI07 exact native answer consumption observed", {
          exact: true,
        })
        .waitFor();
    }, "browser-inspect-persisted-result");
    await step(async () => {
      const commandCount = commands.length;
      const expected = nativeCall.request.questions[0].isOther ? text : "Local";
      for (const route of [
        `/app/tasks/${taskId}?request=${q.interactionId}`,
        `/app/inbox?task=${taskId}&request=${q.interactionId}`,
      ]) {
        await page.goto(`${origin}${route}`);
        await page.reload();
        const form = page.getByRole("region", {
          name: "Exact question response",
        });
        await form
          .getByText(
            "Answer recorded. Request closed; the retained answer is read-only.",
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await form
            .getByRole("button", { name: "Submit answer", exact: true })
            .isDisabled(),
          true,
        );
        if (nativeCall.request.questions[0].isOther)
          assert.equal(await form.getByRole("textbox").inputValue(), expected);
        else
          assert.equal(
            await form.getByRole("radio", { name: /^Local/ }).isChecked(),
            true,
          );
      }
      assert.equal(commands.length, commandCount);
      evidence.closedQuestionProjection = {
        taskReload: true,
        inboxReload: true,
        retainedExactAnswer: true,
        readOnly: true,
        zeroCommands: true,
      };
    }, "browser-inspect-closed-recorded-question");
    const screenshot = `${root}-runtime-review.png`;
    await step(
      () =>
        page.screenshot({
          path: screenshot,
          fullPage: true,
          timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
        }),
      "browser-screenshot",
    );
    evidence.screenshots.push({
      path: screenshot,
      sha256: hash(readFileSync(screenshot)),
    });
    if (callbackFailure) throw callbackFailure;
    assert.deepEqual(evidence.counts, {
      threads: 1,
      turns: 1,
      requests: 1,
      replies: 1,
      reports: 1,
    });
    assert.equal(service.taskHold(taskId), undefined);
    assert.ok(
      service
        .list()
        .some(
          (i) =>
            i.threadId === nativeCall.identity.threadId &&
            i.turnId === nativeCall.identity.turnId &&
            i.state === "completed",
        ),
    );
    evidence.status = "passed";
  } catch (error) {
    evidence.failure = {
      reason: String(error.message).slice(0, 1024),
      callbackPending,
      callbackEnded: evidence.callbackEnded,
    };
    try {
      evidence.executions = service
        ?.list()
        .map((i) => ({ workId: i.workId, state: i.state, reason: i.reason }));
    } catch {}
  } finally {
    finishing = true;
    evidence.process ??= runtime?.processIdentity();
    const cleanupDeadline = Math.min(start + totalMs, Date.now() + cleanupMs);
    async function clean(name, action) {
      try {
        await bounded(action, cleanupDeadline, name);
        evidence.cleanup.operations[name] = "settled";
      } catch (error) {
        evidence.cleanup.failures.push({
          operation: name,
          reason: String(error.message).slice(0, 512),
        });
        evidence.cleanup.operations[name] = "unresolved";
        evidence.status = "failed";
      }
    }
    if (pendingSteps.size)
      await clean("pending-setup-settlement", () =>
        Promise.allSettled([...pendingSteps]),
      );
    if (probe?.listening)
      await clean("port-close", () => new Promise((r) => probe.close(r)));
    if (evidence.status !== "passed" && service) {
      await clean("exact-runtime-stop", () => runtime?.stop());
      if (taskId) await clean("task-stop-hold", () => service.stopTask(taskId));
    }
    if (browser) await clean("browser-close", () => browser.close());
    if (http) await clean("operator-close", () => http.stop());
    if (auth) await clean("auth-close", () => auth.close());
    if (service)
      await clean("service-close", async () => {
        await service.stop();
        if (fixture?.shutdownFailure) throw Error("injected-shutdown-failure");
      });
    try {
      evidence.cleanup.verification = fixture
        ? (fixtureChild?.verify() ?? {
            kind: "unknown",
            reason: "no-owned-fixture-child",
            method: "fixture-owned-child-exit",
          })
        : evidence.process
          ? await bounded(
              () =>
                new MacProcessTerminationVerifier().verify(evidence.process),
              cleanupDeadline,
              "exact-process-verification",
            )
          : { kind: "unknown", reason: "no-process-identity" };
    } catch {
      evidence.cleanup.verification = {
        kind: "unknown",
        reason: "verification-deadline",
      };
    }
    evidence.cleanup.verified =
      evidence.cleanup.verification.kind === "verified" &&
      Object.values(evidence.cleanup.operations).every(
        (v) => v === "settled",
      ) &&
      evidence.cleanup.lateResources.every((r) => r.state === "settled");
    if (!evidence.cleanup.verified || callbackFailure)
      evidence.status = "failed";
    if (
      evidence.status === "passed" &&
      Object.values(evidence.counts).some((count) => count !== 1)
    ) {
      evidence.status = "failed";
      evidence.failure = { reason: "final-counts-not-one" };
    }
    evidence.fixture = { retained: true, removed: false };
    if (evidence.status === "passed" && evidence.cleanup.verified) {
      rmSync(root, { recursive: true });
      evidence.fixture = { retained: false, removed: true };
    }
    save();
    if (!fixture) {
      ledger.live = {
        ...ledger.live,
        state: evidence.status,
        evidencePath: `${root}.json`,
        cleanupVerified: evidence.cleanup.verified,
        endedAt: new Date().toISOString(),
      };
      writeFileSync(grant.ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
    }
  }
  return { ...evidence, evidencePath: `${root}.json`, data, taskId };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(process.argv[2], "--live");
  assert.equal(process.argv[3], "--grant");
  assert.equal(process.argv.length, 5);
  const result = await runQualification({
    grant: JSON.parse(readFileSync(process.argv[4], "utf8")),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "passed" ? 0 : 1;
}
