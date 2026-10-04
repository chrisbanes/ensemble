import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  realpathSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
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
export function consumeGrantMarker(grant, startedAt) {
  const fd = openSync(grant.consumedMarker, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        ...grant,
        consumedAt: new Date(startedAt).toISOString(),
      }) + "\n",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function runQualification(options = {}) {
  const fixture = options.fixture;
  const totalMs = fixture ? 5000 : 240000,
    cleanupMs = fixture ? 1000 : 10000,
    start = Date.now(),
    deadline = start + totalMs - cleanupMs;
  const grant = options.grant;
  let ledger;
  const checkRegistry = () => {
    const registry = JSON.parse(readFileSync(grant.registryPath, "utf8"));
    const lock = registry.resourceLocks?.[resource];
    assert.ok(
      lock &&
        lock.issue === 742 &&
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
        grant.issue === 742 &&
        grant.holder === "ui04_worker" &&
        grant.resource === resource &&
        grant.sourceHead === command(["rev-parse", "HEAD"]) &&
        grant.sourceTree === command(["rev-parse", "HEAD^{tree}"]) &&
        command(["status", "--porcelain"]) === "" &&
        grant.executable &&
        /^[a-f0-9-]{36}$/.test(grant.grantId) &&
        grant.totalMs === totalMs &&
        grant.cleanupMs === cleanupMs &&
        grant.maxThreads === 1 &&
        grant.maxTurns === 1 &&
        grant.maxReports === 1 &&
        grant.retries === 0 &&
        grant.harnessSha256 ===
          hash(readFileSync(fileURLToPath(import.meta.url))) &&
        grant.registryPath === "/tmp/ensemble-approved-run-checkpoint.json" &&
        grant.consumedMarker === `/tmp/ui04-${grant.grantId}.consumed` &&
        grant.ledgerPath === "/tmp/ui04-delivery.json",
      "exact-clean-grant-required",
    );
    checkRegistry();
    ledger = JSON.parse(readFileSync(grant.ledgerPath, "utf8"));
    assert.ok(!ledger.live?.consumed, "one-use-attempt-already-consumed");
    // Exclusive creation is the irreversible consumption point, before any launch setup.
    consumeGrantMarker(grant, start);
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
      join(realpathSync(tmpdir()), "ensemble-ui04-qualification-"),
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
      counts: { threads: 0, turns: 0, reports: 0 },
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
    resource,
    grantId: grant?.grantId ?? null,
    limits: { totalMs, cleanupMs },
    counts: { threads: 0, turns: 0, reports: 0 },
    callbackEnded: false,
    cleanup: { operations: {}, lateResources: [], verified: false },
    screenshots: [],
  };
  let service,
    runtime,
    browser,
    http,
    auth,
    expected,
    reportCall,
    callbackPending = false;
  let finishing = false,
    probe;
  const pendingSteps = new Set();
  const step = (action, label, lateCleanup) => {
    const promise = Promise.resolve()
      .then(action)
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
    return bounded(() => promise, deadline, label);
  };
  const taskId = randomUUID(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    data = join(root, "data");
  const save = () =>
    writeFileSync(`${root}.json`, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  const until = async (predicate, label) => {
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `${label}-deadline`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    let executable = grant?.executable;
    if (fixture) {
      executable = join(root, "fake-codex");
      writeFileSync(
        executable,
        `#!/bin/sh\nexec '${process.execPath}' '${join(rootDir, "test/ui04/fake-app-server.mjs")}' "$@"\n`,
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
                spawnEnvironment: () => ({
                  ...context.spawnEnvironment(),
                  UI04_FIXTURE_DELAY: "50",
                }),
              }
            : {}),
        });
        const startThread = runtime.startThread.bind(runtime),
          startTurn = runtime.startTurn.bind(runtime),
          onTool = runtime.onToolCall.bind(runtime);
        runtime.startThread = async (...args) => {
          assert.equal(evidence.counts.threads++, 0, "second-thread-forbidden");
          return startThread(...args);
        };
        runtime.startTurn = async (thread, workspace) => {
          assert.equal(evidence.counts.turns++, 0, "second-turn-forbidden");
          assert.ok(expected);
          return startTurn(
            thread,
            workspace,
            [
              "Synthetic repository-free UI04 callback qualification. Do not use shell, file, network, browser, delegation, questions or other tools. Invoke ensemble_report_result exactly once with the JSON below and end this turn. These are unverified synthetic transport records, not product validation claims.",
              `UI04_CALLBACK_JSON=${JSON.stringify(expected)}`,
            ].join("\n"),
          );
        };
        runtime.onToolCall = (listener) =>
          onTool(async (call) => {
            assert.equal(
              call.tool,
              "ensemble_report_result",
              "unexpected-tool",
            );
            assert.equal(
              evidence.counts.reports++,
              0,
              "second-report-forbidden",
            );
            assert.deepEqual(
              call.arguments,
              expected,
              "exact-callback-material",
            );
            reportCall = call;
            callbackPending = true;
            const work = service
              .list()
              .find(
                (i) => i.threadId === call.threadId && i.turnId === call.turnId,
              );
            assert.ok(work);
            const reporting = (async () => {
              if (fixture?.delayCallback) {
                await new Promise((r) => setTimeout(r, 150));
                assert.equal(
                  service.coordinationView().readTask(taskId).results.length,
                  0,
                  "callback-not-ended-before-persistence",
                );
              }
              return listener(call);
            })();
            service.registerExecutionCallback(work.workId, reporting);
            const result = await reporting;
            assert.equal(result.success, true);
            callbackPending = false;
            evidence.callbackEnded = true;
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
      name: "UI04 qualification lead",
      instructions: "Only execute the fixed synthetic callback qualification.",
      capabilities: "synthetic callback qualification",
    });
    run({
      type: "project.create",
      projectId,
      name: "UI04 disposable qualification",
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
      type: "task.create",
      projectId,
      taskId,
      title: "UI04 synthetic callback task",
      outcome: "- [ ] Record the unverified synthetic callback",
      ready: true,
    });
    const source = service.taskReview().sources(taskId)[0];
    assert.ok(source?.criteria[0]);
    expected = {
      summary: "UI04 synthetic callback recorded",
      review: {
        sourceId: source.sourceId,
        criteria: [
          {
            criterionId: source.criteria[0].criterionId,
            outcome: "unverified",
            scope: "Synthetic callback transport only",
            provenance:
              "Real runtime supplied record; no product verification claim",
          },
        ],
        validations: [
          {
            label: "Synthetic transport record",
            outcome: "unverified",
            scope: "One callback in one model turn",
            provenance: "UI04 qualification",
          },
        ],
      },
    };
    evidence.expectedHash = hash(JSON.stringify(expected));
    evidence.sourceId = source.sourceId;
    service.domain().ensureLeadAssignment(taskId);
    await step(() => service.provisionTask(taskId), "workspace");
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    await until(
      () =>
        evidence.callbackEnded &&
        service
          .list()
          .some(
            (i) =>
              i.threadId === reportCall?.threadId &&
              i.turnId === reportCall?.turnId &&
              i.state === "completed",
          ),
      "callback-terminal",
    );
    assert.equal(callbackPending, false);
    assert.equal(service.taskHold(taskId), undefined);
    assert.deepEqual(evidence.counts, { threads: 1, turns: 1, reports: 1 });
    evidence.process = runtime.processIdentity();
    evidence.results = service
      .coordinationView()
      .readTask(taskId)
      .results.map((r) => ({
        resultId: r.resultId,
        workId: r.workId,
        workRevision: r.workRevision,
        assignmentId: r.assignmentId,
      }));
    const api = new OperatorApi(service, [root]),
      read = await step(() => api.readTask(taskId), "task-read");
    assert.equal(
      read.data.review.results[0].metadata.sourceId,
      source.sourceId,
    );
    assert.ok(
      read.data.review.contexts.some(
        (c) => c.workId === evidence.results[0].workId,
      ),
    );
    if (fixture?.assertionFailure)
      assert.fail("injected-assertion-failure-after-recorded-callback");
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
      password = "disposable UI04 operator password",
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
    http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
      web: new OperatorWebBoundary(bundle, api),
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
    const page = await step(
      () => browser.newPage({ viewport: { width: 1366, height: 900 } }),
      "browser-page",
      (late) => late.close(),
    );
    page.setDefaultTimeout(5000);
    await step(async () => {
      await page.goto(`${origin}/app/tasks/${taskId}`);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByText("UI04 synthetic callback recorded", { exact: true })
        .waitFor();
      await page.getByText(/Synthetic callback transport only/).waitFor();
      await page
        .getByRole("heading", { name: "Captured context", exact: true })
        .waitFor();
    }, "browser-review");
    const screenshot = join(root, "runtime-review.png");
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
      } catch {
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
      await clean("task-stop-hold", () => service.stopTask(taskId));
    }
    if (browser) await clean("browser-close", () => browser.close());
    if (http) await clean("operator-close", () => http.stop());
    if (auth) await clean("auth-close", () => auth.close());
    if (service) await clean("service-close", () => service.stop());
    try {
      evidence.cleanup.verification = evidence.process
        ? await bounded(
            () => new MacProcessTerminationVerifier().verify(evidence.process),
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
    if (!evidence.cleanup.verified) evidence.status = "failed";
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
