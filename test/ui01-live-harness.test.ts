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

const qualifiedSource = {
  codex: "codex-cli 0.159.0",
  executableHash:
    "e89718aa1969bfc4a471277bdc4679a3a3529293de0a309909822dfd67ddb77a",
};

test("qualified Default false/null request records actual waiting before one nonce answer", async (t) => {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    source: qualifiedSource,
    fixture: {
      executable: process.execPath,
      args: [resolve("test/ui01/fake-app-server.mjs"), "default"],
    },
    budgets: { requestMs: 1000, totalMs: 3000, holdMs: 20, cleanupMs: 500 },
  });
  t.after(() => {
    rmSync(evidence.fixture.path, { recursive: true, force: true });
    rmSync(evidence.evidencePath, { force: true });
  });
  assert.equal(evidence.status, "passed");
  assert.deepEqual(evidence.request, {
    isBlocking: false,
    autoResolutionMs: null,
    questions: [
      {
        id: "delivery",
        header: "Delivery",
        question: "Select delivery",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Local", description: "Local output" },
          { label: "Remote", description: "Remote output" },
        ],
      },
    ],
  });
  assert.equal(evidence.persistence.committedBeforeEffect, true);
  assert.equal(evidence.consumption.kind, "answer-only-nonce-report");
  assert.equal(evidence.receipt.kind, "confirmed");
  assert.equal(evidence.counts.turns, 1);
  assert.equal(evidence.counts.replies, 1);
  assert.equal(evidence.cleanup.verified, true);
});

test("one exact native callback replay after resume response and optional update stays one request/effect", async (t) => {
  const evidence = await fixture(t, "resume-replay");
  assert.equal(evidence.status, "passed");
  assert.deepEqual(evidence.counts, {
    threads: 1,
    turns: 1,
    requests: 1,
    replies: 1,
    reports: 1,
  });
  assert.equal(evidence.nativeReplay.accepted, 1);
  assert.equal(evidence.receipt.kind, "confirmed");
  assert.equal(evidence.persistence.committedBeforeEffect, true);
  assert.equal(evidence.consumption.kind, "answer-only-nonce-report");
  assert.equal(
    evidence.observations.filter(
      (x: { kind: string }) => x.kind === "answer-and-intent-committed",
    ).length,
    1,
  );
  assert.equal(
    evidence.observations.filter(
      (x: { kind: string }) => x.kind === "native-resume-replay",
    ).length,
    1,
  );
  assert.equal(evidence.cleanup.verified, true);
});

test("replay compares complete parameters structurally while preserving object-key equivalence", async (t) => {
  const evidence = await fixture(t, "replay-reordered-keys");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.nativeReplay.accepted, 1);
  assert.equal(evidence.counts.requests, 1);
  assert.equal(evidence.counts.replies, 1);
});

for (const mode of [
  "replay-changed-body",
  "replay-unknown-field",
  "replay-null-absence",
  "replay-array-order",
  "replay-new-id",
  "replay-id-type",
  "replay-foreign-thread",
  "replay-foreign-turn",
  "replay-foreign-item",
  "replay-before-response",
  "replay-excess",
  "duplicate",
]) {
  test(`native delivery ${mode} fails closed without a second request or answer effect`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, "duplicate-native-request");
    assert.equal(evidence.counts.requests, 1);
    assert.equal(evidence.counts.replies, 0);
    assert.equal(evidence.persistence, undefined);
    assert.equal(
      evidence.nativeReplay.accepted,
      mode === "replay-excess" ? 1 : 0,
    );
    assert.match(evidence.nativeReplay.rejected.paramsDigest, /^[a-f0-9]{64}$/);
    assert.equal(
      evidence.nativeReplay.rejected.method,
      "item/tool/requestUserInput",
    );
    assert.equal(
      evidence.nativeReplay.rejected.runtimeGeneration,
      evidence.runtimeGeneration,
    );
    assert.equal(
      evidence.nativeReplay.rejected.processId,
      evidence.process.processId,
    );
    assert.equal(JSON.stringify(evidence).includes("PRIVATE_REPLAY"), false);
    assert.equal(evidence.cleanup.verified, true);
    if (mode === "replay-id-type")
      assert.equal(evidence.nativeReplay.rejected.requestIdType, "number");
  });
}

for (const [mode, receipt] of [
  ["replay-after-write", "uncertain"],
  ["replay-after-confirmed", "confirmed"],
] as const) {
  test(`${mode} fails proof without repeating an effect or rewriting historical receipt`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, "duplicate-native-request");
    assert.equal(evidence.counts.requests, 1);
    assert.equal(evidence.counts.replies, 1);
    assert.equal(evidence.nativeReplay.accepted, 0);
    assert.equal(evidence.receipt.kind, receipt);
    assert.match(evidence.nativeReplay.rejected.paramsDigest, /^[a-f0-9]{64}$/);
    assert.equal(evidence.cleanup.verified, true);
  });
}

test("same textual RPC ids in a replacement process retain separate replay/effect generations", async (t) => {
  const held = await fixture(t, "duplicate");
  const replacement = await fixture(t, "resume-replay");
  assert.equal(held.status, "failed");
  assert.equal(replacement.status, "passed");
  assert.equal(held.identity.requestId, replacement.identity.requestId);
  assert.notEqual(held.runtimeGeneration, replacement.runtimeGeneration);
  assert.notEqual(held.process.processId, replacement.process.processId);
  assert.equal(
    replacement.receipt.identity.runtimeGeneration,
    replacement.runtimeGeneration,
  );
  assert.equal(replacement.nativeReplay.accepted, 1);
  assert.equal(replacement.counts.replies, 1);
  assert.equal(held.counts.replies, 0);
  assert.equal(held.receipt.kind, "unavailable");
});

test("native qualification binds the exact thread's observed Default settings without private instructions", async (t) => {
  const evidence = await fixture(t, "default");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.qualification.threadId, "thread-1");
  assert.equal(
    evidence.qualification.runtimeGeneration,
    evidence.runtimeGeneration,
  );
  assert.equal(evidence.qualification.mode, "default");
  assert.equal(evidence.qualification.model, "fixture-model");
  assert.equal(evidence.qualification.modelProvider, "fixture-provider");
  assert.equal(evidence.qualification.reasoningEffort, "high");
  assert.equal(evidence.qualification.serviceTier, null);
  assert.match(
    evidence.qualification.developerInstructionsDigest,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    JSON.stringify(evidence).includes("PRIVATE_MODE_INSTRUCTIONS"),
    false,
  );
  const kinds = evidence.observations.map((x: { kind: string }) => x.kind);
  assert.ok(
    kinds.indexOf("native-request") <
      kinds.indexOf("effective-default-observed"),
  );
});

test("delayed mode readback qualifies only the held callback before persistence or reply", async (t) => {
  const evidence = await fixture(t, "mode-delayed");
  assert.equal(evidence.status, "passed");
  assert.equal(
    evidence.qualification.observedAt,
    "held-native-callback-before-answer",
  );
  const kinds = evidence.observations.map((x: { kind: string }) => x.kind);
  const order = [
    "native-request",
    "effective-mode-readback-started",
    "effective-default-observed",
    "blocked-zero-replies-checkpoint",
    "answer-and-intent-committed",
    "reply-write-initiated",
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      kinds.indexOf(order[i - 1] as string) < kinds.indexOf(order[i] as string),
    );
  }
  assert.equal(evidence.counts.turns, 1);
  assert.equal(evidence.counts.replies, 1);
});

for (const [mode, reason] of [
  ["mode-pending-resolution", "resolution-without-reply-write"],
  ["mode-pending-report", "report-order-or-count-mismatch"],
  ["mode-pending-terminal", "terminal-before-receipt-or-report"],
  ["mode-pending-async", "unsupported-async-input"],
  ["mode-pending-foreign-async", "async-identity-mismatch"],
  ["mode-pending-foreign-terminal", "terminal-identity-mismatch"],
  ["mode-resume-failed", "rpc-failed"],
  ["mode-resume-timeout", "total-budget-exceeded"],
] as const) {
  test(`mode readback refuses ${mode} without answer, receipt or hold release`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.stage, "effective-mode");
    assert.equal(evidence.failure.reason, reason);
    assert.equal(evidence.counts.turns, 1);
    assert.equal(evidence.counts.requests, 1);
    assert.equal(evidence.counts.replies, 0);
    assert.equal(evidence.persistence, undefined);
    assert.equal(evidence.qualification, undefined);
    assert.equal(evidence.receipt.kind, "unavailable");
    assert.equal(evidence.fixture.removed, false);
    assert.equal(
      existsSync(resolve(evidence.fixture.path, "proof.sqlite")),
      false,
    );
    assert.equal(evidence.cleanup.verified, true);
    assert.equal(JSON.stringify(evidence).includes("PRIVATE_ASYNC"), false);
  });
}

test("prompt keeps input direct-only and permits only awaited known reporting through exec after the answer", async (t) => {
  const evidence = await fixture(t, "prompt");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.counts.requests, 1);
  assert.equal(evidence.counts.turns, 1);
  assert.equal(evidence.counts.reports, 1);
  assert.equal(evidence.receipt.kind, "confirmed");
  assert.equal(evidence.consumption.kind, "selected-answer-report");
});

test("input discovery callback cannot masquerade as the known proof report", async (t) => {
  const evidence = await fixture(t, "input-discovery");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.reason, "report-identity-mismatch");
  assert.equal(evidence.counts.requests, 0);
  assert.equal(evidence.counts.replies, 0);
  assert.equal(evidence.counts.reports, 0);
  assert.equal(evidence.persistence, undefined);
  assert.equal(evidence.cleanup.verified, true);
});

test("missing report still fails consumption without rewriting a confirmed receipt", async (t) => {
  const evidence = await fixture(t, "no-report");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.reason, "terminal-before-receipt-or-report");
  assert.equal(evidence.counts.replies, 1);
  assert.equal(evidence.counts.reports, 0);
  assert.equal(evidence.persistence.committedBeforeEffect, true);
  assert.equal(evidence.receipt.kind, "confirmed");
  assert.equal(evidence.consumption.kind, "unproved");
  assert.equal(evidence.fixture.removed, false);
  assert.equal(evidence.cleanup.verified, true);
});

test("explicit async origin during a held false/null callback prevents any answer effect", async (t) => {
  const evidence = await fixture(t, "async-held");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.reason, "unsupported-async-input");
  assert.equal(evidence.counts.replies, 0);
  assert.equal(evidence.receipt.kind, "unavailable");
  assert.equal(evidence.fixture.removed, false);
  assert.equal(JSON.stringify(evidence).includes("PRIVATE_ASYNC"), false);
});

test("unsupported standalone free text cannot be smuggled into the fixed native proof", async (t) => {
  const evidence = await fixture(t, "free-text-group");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.reason, "unsupported-question-set");
  assert.equal(evidence.counts.replies, 0);
  assert.equal(evidence.fixture.removed, false);
});

for (const [mode, reason] of [
  ["missing-mode", "unsupported-effective-mode"],
  ["plan-mode", "unsupported-effective-mode"],
  ["unknown-mode", "unsupported-effective-mode"],
  ["foreign-resume-thread", "resume-policy-or-identity-mismatch"],
  ["changed-model", "effective-settings-mismatch"],
  ["changed-provider", "effective-settings-mismatch"],
  ["changed-effort", "effective-settings-mismatch"],
  ["changed-tier", "effective-settings-mismatch"],
  ["conflicting-mode-settings", "effective-settings-mismatch"],
  ["missing-instruction-settings", "effective-settings-mismatch"],
] as const) {
  test(`effective mode qualification refuses ${mode} after one held turn and before answer effects`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, reason);
    assert.equal(evidence.counts.turns, 1);
    assert.equal(evidence.counts.replies, 0);
    assert.equal(evidence.persistence, undefined);
    assert.equal(evidence.cleanup.verified, true);
    assert.equal(
      JSON.stringify(evidence).includes("PRIVATE_MODE_INSTRUCTIONS"),
      false,
    );
  });
}

for (const source of [
  { ...qualifiedSource, codex: "codex-cli 0.159.1" },
  { executableHash: qualifiedSource.executableHash },
  { ...qualifiedSource, executableHash: "0".repeat(64) },
  { codex: qualifiedSource.codex },
]) {
  test(`unqualified runtime source ${JSON.stringify(source)} starts no thread or turn`, async (t) => {
    const evidence = await fixture(t, "default", {}, source);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, "unsupported-runtime-source");
    assert.equal(evidence.counts.threads, 0);
    assert.equal(evidence.counts.turns, 0);
    assert.equal(evidence.counts.replies, 0);
    assert.equal(evidence.cleanup.verified, true);
  });
}

for (const [mode, reason] of [
  ["async-before-native", "unsupported-async-input"],
  ["async-function-output", "unsupported-async-input"],
  ["foreign-async-marker", "async-identity-mismatch"],
  ["async-rpc", "unexpected-server-request"],
  ["free-text-only", "unsupported-options"],
  ["wrong-question", "unsupported-question-identity"],
  ["terminal-held", "terminal-before-receipt-or-report"],
  ["report-held", "report-order-or-count-mismatch"],
] as const) {
  test(`qualified false/null never permits ${mode}`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, reason);
    assert.equal(evidence.counts.replies, 0);
    assert.equal(evidence.cleanup.verified, true);
    assert.equal(JSON.stringify(evidence).includes("PRIVATE_ASYNC"), false);
  });
}

for (const [mode, receipt] of [
  ["async-after-write", "uncertain"],
  ["async-after-confirmed", "confirmed"],
] as const) {
  test(`async evidence in ${mode} prevents proof pass without rewriting historical receipts`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, "unsupported-async-input");
    assert.equal(evidence.counts.replies, 1);
    assert.equal(evidence.receipt.kind, receipt);
    assert.equal(evidence.fixture.removed, false);
    assert.equal(evidence.cleanup.verified, true);
  });
}

test("a new fixture process never replays a retained failed generation's request", async (t) => {
  const held = await fixture(t, "async-held");
  assert.equal(held.status, "failed");
  assert.equal(held.counts.replies, 0);
  assert.equal(held.fixture.removed, false);
  const replacement = await fixture(t, "default");
  assert.equal(replacement.status, "passed");
  // The provider may reuse all textual endpoint ids; only the new generation is eligible.
  assert.equal(replacement.identity.requestId, held.identity.requestId);
  assert.notEqual(replacement.runtimeGeneration, held.runtimeGeneration);
  assert.notEqual(replacement.fixture.taskId, held.fixture.taskId);
  assert.notEqual(replacement.fixture.path, held.fixture.path);
  assert.equal(replacement.counts.replies, 1);
  assert.equal(held.receipt.kind, "unavailable");
  assert.equal(held.counts.replies, 0);
});

test("one native callback continues only its exact disposable turn", async () => {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    source: qualifiedSource,
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
    source: qualifiedSource,
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
    source: qualifiedSource,
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

async function fixture(
  t: TestContext,
  mode: string,
  overrides = {},
  source: Record<string, unknown> = qualifiedSource,
) {
  const { runProtocol } = await probe();
  const evidence = await runProtocol({
    source,
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
  ["plan-flag", "unsupported-continuation"],
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

test("observed large config response reaches the same-turn proof without retaining config payload", async (t) => {
  const evidence = await fixture(t, "oversized-config");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.receipt.kind, "confirmed");
  assert.deepEqual(evidence.counts, {
    threads: 1,
    turns: 1,
    requests: 1,
    replies: 1,
    reports: 1,
  });
  assert.deepEqual(evidence.startupMessages, [
    { method: "config/read", bytes: 1_601_330 },
  ]);
  assert.equal(
    JSON.stringify(evidence).includes("PRIVATE_CONFIG_PAYLOAD_DO_NOT_RETAIN"),
    false,
  );
  assert.equal(
    readFileSync(evidence.evidencePath, "utf8").includes(
      "PRIVATE_CONFIG_PAYLOAD_DO_NOT_RETAIN",
    ),
    false,
  );
});

for (const mode of [
  "oversized-native",
  "oversized-unknown",
  "oversized-config-overbound",
  "oversized-config-wrong-id-type",
  "oversized-config-error",
  "oversized-account",
]) {
  test(`config envelope exception refuses ${mode}`, async (t) => {
    const evidence = await fixture(t, mode);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failure.reason, "oversized-message");
    assert.equal(evidence.counts.replies, 0);
    assert.equal(evidence.cleanup.verified, true);
    if (mode.startsWith("oversized-config") || mode === "oversized-account")
      assert.equal(evidence.counts.turns, 0);
    assert.equal(JSON.stringify(evidence).includes("PRIVATE_CONFIG"), false);
  });
}
