import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { StandaloneService } from "../src/standalone/service.js";
import { OperatorFixtureRuntime } from "./fixtures/operator-web.js";
const harness = await import(
  pathToFileURL(resolve("test/ui07/runtime-contract.mjs")).href
);
test("UI07 production browser creates task, persists native answer before reply, consumes exact map and inspects result without prompt override", async () => {
  const r = await harness.runQualification({
    fixture: { mode: "delayed-native" },
  });
  assert.equal(r.status, "passed", JSON.stringify(r.failure));
  assert.deepEqual(r.counts, {
    threads: 1,
    turns: 1,
    requests: 1,
    replies: 1,
    reports: 1,
  });
  assert.equal(r.prompt.overridden, false);
  assert.equal(r.persistence.committedBeforeEffect, true);
  assert.equal(r.persistence.independentReadOnlyConnection, true);
  assert.equal(r.persistence.zeroReplies, true);
  assert.equal(r.settlement.exactBoundSuccessfulTerminal, true);
  assert.equal(r.callbackEnded, true);
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
  assert.equal(r.screenshots.length, 1);
  assert.deepEqual(r.closedQuestionProjection, {
    taskReload: true,
    inboxReload: true,
    retainedExactAnswer: true,
    readOnly: true,
    zeroCommands: true,
  });
});
for (const mode of [
  "assertion-active",
  "malformed-report",
  "foreign-report",
  "missing-report",
  "missing-reply",
  "missing-request",
  "terminal-before-consumption",
]) {
  test(`UI07 ${mode} fails finitely, retains persisted fixture and hold, closes exact child and never dispatches on restart`, async () => {
    const r = await harness.runQualification({
      fixture: { mode, totalMs: 6500 },
    });
    assert.equal(r.status, "failed");
    const expected = {
      "assertion-active": /injected-assertion-while-runtime-active/,
      "malformed-report": /exact-native-answer-map/,
      "foreign-report": /terminal-before-native-consumption/,
      "missing-report": /native-consumption-terminal-deadline/,
      "missing-reply": /native-consumption-terminal-deadline/,
      "missing-request": /native-request-deadline/,
      "terminal-before-consumption": /terminal-before-native-consumption/,
    };
    assert.match(r.failure.reason, expected[mode as keyof typeof expected]);
    assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
    assert.equal(r.counts.threads, 1);
    assert.equal(r.counts.turns, 1);
    if (mode === "terminal-before-consumption") {
      assert.equal(r.counts.requests, 0);
      assert.equal(r.counts.replies, 0);
      assert.equal(r.counts.reports, 0);
      assert.ok(r.earlyTerminal);
    }
    if (mode === "foreign-report") {
      assert.equal(r.counts.requests, 1);
      assert.equal(r.counts.replies, 1);
      assert.equal(r.counts.reports, 0);
      assert.ok(r.earlyTerminal);
    }
    if (mode === "malformed-report")
      assert.equal(r.callbackFailure.reason, "exact-native-answer-map");

    assert.ok(
      r.counts.requests <= 1 && r.counts.replies <= 1 && r.counts.reports <= 1,
    );
    const runtime = new OperatorFixtureRuntime();
    const service = new StandaloneService(r.data, () => runtime, undefined, {
      power: { enabled: false },
    });
    try {
      await service.start();
      assert.ok(service.taskHold(r.taskId));
      assert.equal(runtime.turns, 0);
      assert.equal(service.domain().task(r.taskId).id, r.taskId);
    } finally {
      await service.stop();
    }
  });
}
test("UI07 setup deadline closes late browser and records failed cleanup without losing primary assertion", async () => {
  const r = await harness.runQualification({
    fixture: {
      delayBrowserCreation: true,
      lateCleanupFailure: true,
      totalMs: 4500,
    },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /browser-start-deadline/);
  assert.equal(r.cleanup.verified, false);
  assert.equal(r.cleanup.lateResources[0].state, "failed");
  assert.equal(r.counts.turns, 0);
});

test("UI07 timed-out service startup keeps its late service-stop owner without racing runtime shutdown", async () => {
  const r = await harness.runQualification({
    fixture: { delayRuntimeStart: 3000, totalMs: 4500 },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /service-start-deadline/);
  assert.equal(r.counts.threads, 0);
  assert.equal(r.counts.turns, 0);
  assert.equal(r.cleanup.operations["pending-setup-settlement"], "settled");
  assert.equal(r.cleanup.operations["exact-runtime-stop"], undefined);
  assert.equal(r.cleanup.operations["service-close"], undefined);
  assert.deepEqual(
    r.cleanup.lateResources.map(
      ({
        identity,
        state,
        settledWithinCleanupDeadline,
      }: {
        identity: string;
        state: string;
        settledWithinCleanupDeadline: boolean;
      }) => ({
        identity,
        state,
        settledWithinCleanupDeadline,
      }),
    ),
    [
      {
        identity: "service-start:1",
        state: "settled",
        settledWithinCleanupDeadline: true,
      },
    ],
  );
  assert.equal(r.cleanup.verified, true, JSON.stringify(r.cleanup));
});
test("UI07 delayed HTTP setup and shutdown failure retain incomplete cleanup evidence", async () => {
  const r = await harness.runQualification({
    fixture: { delayHttp: true, shutdownFailure: true, totalMs: 4500 },
  });
  assert.equal(r.status, "failed");
  assert.match(r.failure.reason, /browser-create-task-deadline/);
  assert.equal(r.cleanup.operations["service-close"], "unresolved");
  assert.equal(r.cleanup.verified, false);
  assert.equal(r.counts.turns, 0);
});
test("UI07 missing and malformed grants reject before creating any resources", async () => {
  await assert.rejects(
    harness.runQualification(),
    /exact-clean-grant-required/,
  );
  await assert.rejects(
    harness.runQualification({ grant: { issue: 745 } }),
    /exact-clean-grant-required/,
  );
});
test("UI07 grant marker has immutable exclusive 0600 durable consumption and rejects replay", () => {
  const consumedMarker = join(
    mkdtempSync(join(tmpdir(), "ui07-grant-")),
    "consumed",
  );
  const grant = {
    issue: 745,
    resource: harness.resource,
    grantId: "fixture-only",
    consumedMarker,
  };
  harness.consumeGrantMarker(grant, 1000);
  const original = readFileSync(consumedMarker, "utf8");
  assert.equal(statSync(consumedMarker).mode & 0o777, 0o600);
  assert.equal(JSON.parse(original).consumedAt, new Date(1000).toISOString());
  assert.throws(() => harness.consumeGrantMarker(grant, 2000), {
    code: "EEXIST",
  });
  assert.equal(readFileSync(consumedMarker, "utf8"), original);
});
