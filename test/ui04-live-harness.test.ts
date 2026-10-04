import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperatorFixtureRuntime } from "./fixtures/operator-web.js";
import { StandaloneService } from "../src/standalone/service.js";
const module = await import(
  pathToFileURL(resolve("test/ui04/runtime-contract.mjs")).href
);
test("UI04 changed callback fake App Server waits for delayed callback, persists exact review/context and renders production UI with verified exact cleanup", async () => {
  const r = await module.runQualification({ fixture: { delayCallback: true } });
  assert.equal(r.status, "passed", JSON.stringify(r.failure));
  assert.deepEqual(r.counts, { threads: 1, turns: 1, reports: 1 });
  assert.equal(r.callbackEnded, true);
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
  assert.equal(r.screenshots.length, 1);
  assert.equal(
    JSON.parse(readFileSync(r.evidencePath, "utf8")).sourceId,
    r.sourceId,
  );
});
test("UI04 assertion failure consumes one fake turn, verifies exact process cleanup and retains recorded result/context plus Stop hold across production service restart", async () => {
  const r = await module.runQualification({
    fixture: { assertionFailure: true },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /injected-assertion-failure/);
  assert.deepEqual(r.counts, { threads: 1, turns: 1, reports: 1 });
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
  const restartRuntime = new OperatorFixtureRuntime();
  const service = new StandaloneService(
    r.data,
    () => restartRuntime,
    undefined,
    { power: { enabled: false } },
  );
  try {
    await service.start();
    assert.ok(service.taskHold(r.taskId));
    assert.equal(
      service.coordinationView().readTask(r.taskId).results.length,
      1,
    );
    assert.equal(
      service.taskReview().read(r.taskId).results[0]?.metadata.sourceId,
      r.sourceId,
    );
    assert.equal(restartRuntime.turns, 0);
  } finally {
    await service.stop();
  }
});

test("UI04 timed-out browser creation settles and closes its late resource within reserved cleanup without another turn", async () => {
  const r = await module.runQualification({
    fixture: { delayBrowserCreation: true },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /browser-start-deadline/);
  assert.deepEqual(r.counts, { threads: 1, turns: 1, reports: 1 });
  assert.equal(r.cleanup.operations["pending-setup-settlement"], "settled");
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
});

test("UI04 grant consumption atomically rejects replay and retains immutable scoped marker", () => {
  const consumedMarker = join(
    mkdtempSync(join(tmpdir(), "ui04-grant-test-")),
    "grant.consumed",
  );
  const grant = {
    issue: 742,
    holder: "ui04_worker",
    grantId: "fixture-grant",
    resource: module.resource,
    sourceHead: "fixture-head",
    sourceTree: "fixture-tree",
    harnessSha256: "fixture-hash",
    totalMs: 240000,
    cleanupMs: 10000,
    maxThreads: 1,
    maxTurns: 1,
    maxReports: 1,
    retries: 0,
    consumedMarker,
  };
  module.consumeGrantMarker(grant, 1000);
  const original = readFileSync(consumedMarker, "utf8");
  assert.deepEqual(JSON.parse(original), {
    ...grant,
    consumedAt: new Date(1000).toISOString(),
  });
  assert.equal(statSync(consumedMarker).mode & 0o777, 0o600);
  assert.throws(() => module.consumeGrantMarker(grant, 2000), {
    code: "EEXIST",
  });
  assert.equal(readFileSync(consumedMarker, "utf8"), original);
});

test("UI04 failed late-resource cleanup remains unresolved even after tracked setup promise settles", async () => {
  const r = await module.runQualification({
    fixture: { delayBrowserCreation: true, lateCleanupFailure: true },
  });
  assert.equal(r.status, "failed");
  assert.equal(r.cleanup.operations["pending-setup-settlement"], "settled");
  assert.equal(r.cleanup.lateResources.length, 1);
  assert.equal(r.cleanup.lateResources[0].state, "failed");
  assert.match(
    r.cleanup.lateResources[0].reason,
    /injected-late-cleanup-failure/,
  );
  assert.equal(r.cleanup.verified, false);
});

test("UI04 malformed callback material promptly ends the one attempt, preserves rejection and verifies exact cleanup without retry", async () => {
  const r = await module.runQualification({
    fixture: { malformedCallback: true },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /exact-callback-material/);
  assert.equal(r.callbackEnded, false);
  assert.deepEqual(r.counts, { threads: 1, turns: 1, reports: 1 });
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
  assert.ok(r.callbackFailure);
});
