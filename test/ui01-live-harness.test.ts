import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

const script = resolve("test/ui01/runtime-contract.mjs");

test("protocol CLI refuses unapproved execution before creating runtime state", () => {
  for (const args of [
    [],
    ["--phase", "protocol"],
    ["--live", "--phase", "service"],
    ["--live", "--phase", "protocol", "--total-ms", "0"],
    ["--live", "--phase", "protocol", "--mode", "plan"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exactly --live --phase protocol/);
    assert.equal(result.stdout, "");
  }
});

const moduleUrl = new URL(`file://${script}`).href;
const probe = () => import(moduleUrl);

test("one native callback continues only its exact disposable turn", async () => {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    fixture: {
      executable: process.execPath,
      args: [resolve("test/ui01/fake-app-server.mjs"), "numeric-id"],
    },
    budgets: { requestMs: 1000, totalMs: 3000, holdMs: 20, cleanupMs: 500 },
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.identity.requestId, 71);
  assert.equal(evidence.identity.requestIdType, "number");
  assert.deepEqual(evidence.counts, {
    threads: 1,
    turns: 1,
    requests: 1,
    replies: 1,
    reports: 1,
  });
  assert.equal(evidence.receipt.kind, "confirmed");
  assert.equal(evidence.consumption.kind, "selected-answer-report");
  assert.equal(evidence.cleanup.verified, true);
  assert.equal(evidence.fixture.removed, true);
});

test("persisted answer and intent are independently readable before the reply effect", async () => {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    fixture: {
      executable: process.execPath,
      args: [resolve("test/ui01/fake-app-server.mjs"), "custom"],
    },
    budgets: { requestMs: 1000, totalMs: 3000, holdMs: 20, cleanupMs: 500 },
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.persistence.committedBeforeEffect, true);
  assert.equal(evidence.consumption.kind, "answer-only-nonce-report");
});

test("unreadable cleanup verification retains failure evidence instead of losing the result", async () => {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    fixture: {
      executable: process.execPath,
      args: [resolve("test/ui01/fake-app-server.mjs"), "numeric-id"],
      verifyTermination: async () => {
        throw new Error("PRIVATE_OS_DIAGNOSTIC");
      },
    },
    budgets: { requestMs: 1000, totalMs: 3000, holdMs: 20, cleanupMs: 500 },
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.cleanup.verified, false);
  assert.equal(evidence.fixture.removed, false);
  assert.equal(
    JSON.stringify(evidence).includes("PRIVATE_OS_DIAGNOSTIC"),
    false,
  );
});

async function fixture(t: TestContext, mode: string, overrides = {}) {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    fixture: {
      executable: process.execPath,
      args: [resolve("test/ui01/fake-app-server.mjs"), mode],
      ...overrides,
    },
    budgets: { requestMs: 150, totalMs: 600, holdMs: 20, cleanupMs: 150 },
  });
  t.after(() => {
    rmSync(evidence.fixture.path, { recursive: true, force: true });
    rmSync(evidence.evidencePath, { force: true });
  });
  return evidence;
}

test("public fixture seam rejects unbounded budgets before spawning", async () => {
  const { runProtocol } = await probe();
  for (const budgets of [
    { totalMs: Infinity },
    { requestMs: 0 },
    { totalMs: 240001 },
    { holdMs: 90000 },
    { requestMs: -1 },
    { cleanupMs: Number.NaN },
  ]) {
    await assert.rejects(
      runProtocol({
        fixture: { executable: "/must-not-spawn", args: [] },
        budgets,
      }),
      /bounded-budgets-required/,
    );
  }
  await assert.rejects(
    runProtocol({ executable: "/must-not-spawn" }),
    /unsupported-live-config/,
  );
});

test("resolution during the native write waits for its successful callback", async (t) => {
  const evidence = await fixture(t, "custom", {
    writeNativeReply: async (
      _child: unknown,
      response: unknown,
      send: (message: unknown) => Promise<void>,
    ) => {
      await send(response);
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
  });
  assert.equal(evidence.status, "passed");
  const kinds = evidence.observations.map(
    (event: { kind: string }) => event.kind,
  );
  assert.ok(
    kinds.indexOf("server-request-resolved") <
      kinds.indexOf("stdin-callback-succeeded"),
  );
  assert.ok(
    kinds.indexOf("stdin-callback-succeeded") <
      kinds.indexOf("receipt-confirmed"),
  );
  assert.ok(
    kinds.indexOf("answer-and-intent-committed") <
      kinds.indexOf("reply-write-initiated"),
  );
  assert.ok(
    kinds.indexOf("report-callback-ended") <
      kinds.indexOf("successful-terminal"),
  );
  assert.equal(evidence.identity.requestId, "71");
  assert.equal(evidence.identity.requestIdType, "string");
});

for (const [mode, reason] of [
  ["wrong-thread", "native-identity-mismatch"],
  ["wrong-turn", "turn-identity-mismatch"],
  ["early-resolution", "resolution-without-reply-write"],
  ["cancelled", "cancelled-or-failed-turn"],
  ["duplicate", "duplicate-native-request"],
  ["nonblocking", "unsupported-continuation"],
  ["timed", "unsupported-continuation"],
  ["secret", "unsupported-or-secret-question"],
  ["wrong-id-type", "resolved-identity-mismatch"],
  ["wrong-report", "answer-consumption-mismatch"],
  ["timeout", "native-request-deadline"],
  ["no-resolution", "total-budget-exceeded"],
]) {
  test(`protocol probe stops on ${mode} and preserves its failure evidence`, async (t) => {
    const evidence = await fixture(t, mode as string);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, reason);
    assert.equal(evidence.cleanup.verified, true);
    assert.equal(evidence.fixture.removed, false);
    assert.ok(evidence.counts.turns <= 1 && evidence.counts.replies <= 1);
    if (mode !== "wrong-report")
      assert.equal(evidence.receipt.kind === "confirmed", false);
    assert.equal(
      evidence.counts.replies,
      ["wrong-id-type", "wrong-report", "no-resolution"].includes(
        mode as string,
      )
        ? 1
        : 0,
    );
    assert.ok(existsSync(evidence.evidencePath));
    assert.equal(
      JSON.parse(readFileSync(evidence.evidencePath, "utf8")).status,
      "failed",
    );
  });
}

test("successful stdin cannot qualify a failed native reply", async (t) => {
  const evidence = await fixture(t, "numeric-id", {
    writeNativeReply: async (
      _child: unknown,
      response: unknown,
      send: (message: unknown) => Promise<void>,
    ) => {
      await send(response);
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw new Error("stdin-write-failed");
    },
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.receipt.kind, "uncertain");
  assert.equal(evidence.failure.reason, "stdin-write-failed");
});

test("an unresponsive cleanup verifier cannot exceed the total proof budget", {
  timeout: 2000,
}, async (t) => {
  const start = Date.now();
  const evidence = await fixture(t, "numeric-id", {
    verifyTermination: async () => new Promise(() => {}),
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.cleanup.verified, false);
  assert.ok(Date.now() - start < 1500);
});
