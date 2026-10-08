import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../src/standalone/codex.js";
import type { SqliteWorkspaceComparisonStore } from "../src/standalone/comparison-store.js";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  WorkspaceComparisonSideContent,
  WorkspaceTurnObservation,
} from "../src/standalone/workspace-comparison.js";
import { tmpdir } from "./temp.js";

type TurnOutcome = "completed" | "failed";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(
  check: () => boolean,
  failureMessage = "Turn capture service did not reach the expected state",
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(failureMessage);
}

async function waitForWorkState(
  service: StandaloneService,
  workId: string,
  expected: string,
  timeoutMs = 3000,
): Promise<void> {
  await until(
    () =>
      service.list().find((work) => work.workId === workId)?.state === expected,
    `Work ${workId} did not reach ${expected}: ${JSON.stringify(
      service.list().filter((work) => work.workId === workId),
    )}`,
    timeoutMs,
  );
}

class CaptureRuntime implements Runtime {
  starts = 0;
  resumes = 0;
  turns = 0;
  firstTurnEnteredAt: number | undefined;
  failStartTurnAt: number | undefined;
  beforeWaitResult: (() => void) | undefined;
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  private nextThread = 0;
  private nextTurn = 0;
  private readonly waits: Array<{
    entered: ReturnType<typeof deferred<void>>;
    outcome: ReturnType<typeof deferred<TurnOutcome>>;
  }> = [];

  async start() {}
  async stop() {}

  async startThread(_workspace: string): Promise<string> {
    this.starts++;
    return `capture-thread-${++this.nextThread}`;
  }

  async resumeThread(_threadId: string): Promise<void> {
    this.resumes++;
  }

  async startTurn(
    _threadId: string,
    workspace: string,
    _prompt: string,
  ): Promise<string> {
    this.turns++;
    this.firstTurnEnteredAt ??= Date.now();
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, "state.txt"),
      this.turns === 1 ? "first\n" : `turn ${this.turns}\n`,
    );
    for (const repositoryIndex of [1, 2]) {
      const repositoryPath = join(workspace, `repo-${repositoryIndex}`);
      if (existsSync(repositoryPath))
        writeFileSync(
          join(repositoryPath, "turn-state.txt"),
          `turn ${this.turns} repository ${repositoryIndex}\n`,
        );
    }
    if (this.failStartTurnAt === this.turns)
      throw new Error("runtime started turn but its response was lost");
    return `capture-turn-${++this.nextTurn}`;
  }

  async interruptTurn(_threadId: string, _turnId: string): Promise<void> {}

  async waitForTurn(_threadId: string, turnId: string): Promise<TurnOutcome> {
    const gate = this.waits.shift();
    let outcome: TurnOutcome;
    if (gate) {
      gate.entered.resolve(undefined);
      outcome = await gate.outcome.promise;
    } else {
      outcome = "completed";
    }
    if (outcome === "completed")
      await this.toolCall?.({
        threadId: _threadId,
        turnId,
        callId: `capture-question-${turnId}`,
        tool: "ensemble_ask_question",
        arguments: {
          question: "The deterministic fixture is waiting for its next step",
        },
      });
    this.beforeWaitResult?.();
    this.beforeWaitResult = undefined;
    return outcome;
  }

  onUnexpectedRequest() {}

  onToolCall(
    listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ): void {
    this.toolCall = listener;
  }

  holdNextWait() {
    const entered = deferred<void>();
    const outcome = deferred<TurnOutcome>();
    this.waits.push({ entered, outcome });
    return { entered: entered.promise, resolve: outcome.resolve };
  }
}

function createGitRepository(root: string, name: string): string {
  const path = join(root, `source-${name}`);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  execFileSync("git", ["-C", path, "config", "user.name", "Capture Test"]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "capture-test@example.invalid",
  ]);
  execFileSync("git", [
    "-C",
    path,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    `fixture ${name}`,
  ]);
  return path;
}

async function fixture(repositoryCount = 0) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-turn-capture-"));
  const runtime = new CaptureRuntime();
  let service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false } },
  );
  await service.start();

  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  execute({
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Builder",
    instructions: "build",
    capabilities: "code",
  });
  execute({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Capture project",
    leadProfileId: profileId,
  });
  execute({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Capture task",
    outcome: "Capture one actual turn",
    ready: true,
  });
  const assignmentId = String(
    service.domain().ensureLeadAssignment(taskId)?.id ?? "",
  );
  assert.ok(assignmentId);
  const repositories = Array.from({ length: repositoryCount }, (_, index) => {
    const repositoryId = `source-${index + 1}`;
    return {
      repositoryId,
      path: createGitRepository(root, repositoryId),
    };
  });
  const observationDurations: number[] = [];
  if (repositoryCount > 0) {
    const observableService = service as unknown as {
      observeTurnWorkspace(taskId: string): Promise<WorkspaceTurnObservation>;
    };
    const observe = observableService.observeTurnWorkspace.bind(service);
    observableService.observeTurnWorkspace = async (observedTaskId) => {
      const startedAt = Date.now();
      try {
        return await observe(observedTaskId);
      } finally {
        observationDurations.push(Date.now() - startedAt);
      }
    };
  }
  const provisionStartedAt = Date.now();
  const workspace = await service.provisionTask(taskId, repositories);
  assert.equal(workspace.state, "ready");
  const firstWorkId = `assignment:${assignmentId}:initial`;
  await waitForWorkState(
    service,
    firstWorkId,
    "completed",
    repositoryCount > 0 ? 20_000 : 3000,
  );
  await until(() => service.list().every((work) => work.state === "completed"));

  return {
    root,
    runtime,
    service,
    taskId,
    profileId,
    assignmentId,
    firstWorkId,
    binding: workspace,
    observationDurations,
    provisionStartedAt,
    close: async () => {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
    reopen: async (nextRuntime = new CaptureRuntime()) => {
      await service.stop();
      const recovered = new StandaloneService(
        join(root, "data"),
        () => nextRuntime,
        undefined,
        { power: { enabled: false } },
      );
      await recovered.start();
      service = recovered;
      return recovered;
    },
  };
}

function storeFor(service: StandaloneService): SqliteWorkspaceComparisonStore {
  const store = (
    service as unknown as {
      workspaceComparisons?: SqliteWorkspaceComparisonStore;
    }
  ).workspaceComparisons;
  assert.ok(store);
  return store;
}

function hash(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

test("successive repository-free turns retain exact identity, export bytes, and survive reopen", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const store = storeFor(f.service);
  const first = store.latestTurnCaptures(f.taskId).latestFinished;
  assert.ok(first);
  assert.equal(first.captureState, "finished");
  assert.equal(first.identity.workId, f.firstWorkId);
  assert.equal(first.identity.profileId, f.profileId);
  assert.equal(first.comparison?.target, "turn");
  assert.equal(first.comparison?.state, "available");
  assert.equal(
    first.comparison?.entries[0]?.hunks[0]?.rightAnchor?.repositoryId,
    null,
  );

  const suppliedClaim = JSON.stringify({
    changes: { diff: "agent-supplied-claim-only" },
  });
  assert.equal(
    f.service.recordTaskResult(first.identity.workId, suppliedClaim),
    true,
  );
  const copied = store.exportComparison(f.taskId, first.comparisonId);
  assert.ok(copied);
  assert.equal(
    JSON.stringify(copied.comparison).includes("agent-supplied-claim-only"),
    false,
  );
  const copiedSides = structuredClone(copied.sides);

  const secondTurnObservations: WorkspaceTurnObservation[] = [];
  const serviceInternals = f.service as unknown as {
    observeTurnWorkspace(taskId: string): Promise<WorkspaceTurnObservation>;
  };
  const observeTurnWorkspace = serviceInternals.observeTurnWorkspace.bind(
    f.service,
  );
  serviceInternals.observeTurnWorkspace = async (taskId) => {
    const observation = await observeTurnWorkspace(taskId);
    secondTurnObservations.push(observation);
    return observation;
  };
  const gate = f.runtime.holdNextWait();
  const secondAction = f.service.submitTask(
    "second-turn",
    f.assignmentId,
    "change it again",
  );
  await gate.entered;
  const during = store.latestTurnCaptures(f.taskId);
  assert.equal(during.latestFinished?.comparisonId, first.comparisonId);
  assert.equal(during.pending?.captureState, "pending");
  assert.equal(during.pending?.outcome, "running");
  const beforeObservedAt = during.pending?.before?.observedAt;
  assert.notEqual(beforeObservedAt, undefined);
  assert.equal(during.pending?.comparison, undefined);
  assert.ok(
    during.pending?.before?.files.some((file) => file.path === "state.txt"),
  );
  assert.equal(
    store.exportComparison(f.taskId, during.pending!.comparisonId),
    undefined,
    "an in-progress turn has no after-side comparison to export at callback time",
  );

  gate.resolve("completed");
  await secondAction;
  await waitForWorkState(f.service, "second-turn", "completed");
  const latest = store.latestTurnCaptures(f.taskId);
  assert.equal(latest.pending, undefined);
  const second = latest.latestFinished;
  assert.ok(second);
  assert.equal(secondTurnObservations.length, 2);
  assert.notEqual(second.comparisonId, first.comparisonId);
  assert.equal(second.identity.taskId, f.taskId);
  assert.equal(second.identity.assignmentId, f.assignmentId);
  assert.equal(second.identity.profileId, f.profileId);
  const secondWork = f.service
    .list()
    .find((work) => work.workId === second.identity.workId);
  assert.equal(second.threadId, secondWork?.threadId);
  assert.equal(second.turnId, secondWork?.turnId);
  const secondRequest = f.service
    .turnRequests()
    .find((request) => request.workId === second.identity.workId);
  assert.equal(secondRequest?.sequence, second.identity.requestSequence);
  assert.equal(
    secondRequest?.assignmentVersion,
    second.identity.assignmentVersion,
  );
  assert.equal(second.identity.workRevision, 2);
  assert.equal(second.comparison?.workId, second.identity.workId);
  assert.equal(second.comparison?.profileId, f.profileId);
  assert.equal(second.comparison?.threadId, second.threadId);
  assert.equal(second.comparison?.turnId, second.turnId);
  assert.equal(second.comparison?.beforeObservedAt, beforeObservedAt);
  assert.equal(
    second.comparison?.beforeObservedAt,
    secondTurnObservations[0]?.observedAt,
  );
  assert.equal(
    second.comparison?.observedAt,
    secondTurnObservations[1]?.observedAt,
  );

  const changed = second.comparison?.entries.find(
    (entry) => entry.path === "state.txt",
  );
  assert.ok(changed);
  assert.equal(changed.left?.sha256, hash("first\n"));
  assert.equal(changed.right?.sha256, hash("turn 2\n"));
  assert.ok(changed.hunks[0]?.leftAnchor);
  assert.ok(changed.hunks[0]?.rightAnchor);
  assert.equal(changed.hunks[0]?.leftAnchor?.workId, second.identity.workId);
  assert.equal(changed.hunks[0]?.leftAnchor?.threadId, second.threadId);
  assert.equal(changed.hunks[0]?.leftAnchor?.turnId, second.turnId);
  assert.equal(changed.hunks[0]?.leftAnchor?.contentSha256, hash("first\n"));
  assert.equal(changed.hunks[0]?.rightAnchor?.contentSha256, hash("turn 2\n"));
  const exported = store.exportComparison(f.taskId, second.comparisonId);
  assert.ok(exported);
  assert.equal(
    exported.sides.find((side) => side.leftText !== undefined)?.leftText,
    "first\n",
  );
  assert.equal(
    exported.sides.find((side) => side.rightText !== undefined)?.rightText,
    "turn 2\n",
  );
  assert.equal(store.exportComparison(f.taskId, first.comparisonId), undefined);
  assert.deepEqual(
    copied.sides,
    copiedSides,
    "a consumer's prior immutable export stays copyable",
  );

  const recovered = await f.reopen();
  const afterRestart = storeFor(recovered).latestTurnCaptures(f.taskId);
  assert.equal(afterRestart.latestFinished?.comparisonId, second.comparisonId);
  assert.equal(
    afterRestart.latestFinished?.comparison?.beforeObservedAt,
    beforeObservedAt,
  );
  assert.equal(
    afterRestart.latestFinished?.comparison?.observedAt,
    secondTurnObservations[1]?.observedAt,
  );
  assert.deepEqual(
    storeFor(recovered).exportComparison(f.taskId, second.comparisonId)?.sides,
    exported.sides,
  );

  const reopenedDb = (
    storeFor(recovered) as unknown as {
      db: {
        prepare(sql: string): {
          get(...params: string[]): { payloadJson: string } | undefined;
          run(...params: string[]): unknown;
        };
      };
    }
  ).db;
  const stored = reopenedDb
    .prepare(
      "SELECT payloadJson FROM workspace_turn_captures WHERE comparisonId = ?",
    )
    .get(second.comparisonId);
  assert.ok(stored);
  const historicalPayload = JSON.parse(stored.payloadJson) as {
    comparison: Record<string, unknown>;
  };
  delete historicalPayload.comparison.beforeObservedAt;
  reopenedDb
    .prepare(
      "UPDATE workspace_turn_captures SET payloadJson = ? WHERE comparisonId = ?",
    )
    .run(JSON.stringify(historicalPayload), second.comparisonId);
  const storedLegacy = reopenedDb
    .prepare(
      "SELECT payloadJson FROM workspace_turn_captures WHERE comparisonId = ?",
    )
    .get(second.comparisonId);
  assert.ok(storedLegacy);
  assert.equal(
    (
      JSON.parse(storedLegacy.payloadJson) as {
        comparison: Record<string, unknown>;
      }
    ).comparison.beforeObservedAt,
    undefined,
    "the stored historical payload no longer contains the optional before timestamp",
  );

  const legacyRecovered = await f.reopen();
  const legacy = storeFor(legacyRecovered).latestTurnCaptures(
    f.taskId,
  ).latestFinished;
  assert.ok(legacy);
  assert.equal(legacy.comparison?.comparisonId, second.comparisonId);
  assert.equal(legacy.comparison?.beforeObservedAt, undefined);
  assert.equal(
    legacy.comparison?.observedAt,
    secondTurnObservations[1]?.observedAt,
    "older immutable captures keep their after timestamp without synthesizing a before timestamp",
  );
});

test("multi-repository turn anchors keep per-entry identity and exact export through SQLite reopen", async (t) => {
  const f = await fixture(2);
  t.after(() => f.close());
  const store = storeFor(f.service);
  const capture = store.latestTurnCaptures(f.taskId).latestFinished;
  assert.ok(capture);
  assert.equal(capture.captureState, "finished");
  assert.equal(capture.outcome, "completed");
  assert.equal(
    f.service.list().find((work) => work.workId === f.firstWorkId)?.state,
    "completed",
  );
  assert.equal(capture.identity.profileId, f.profileId);
  assert.equal(capture.identity.assignmentId, f.assignmentId);
  assert.equal(f.observationDurations.length, 2);
  t.diagnostic(
    JSON.stringify({
      beforeObservationMs: f.observationDurations[0],
      afterObservationMs: f.observationDurations[1],
      firstTurnDispatchDelayMs:
        f.runtime.firstTurnEnteredAt === undefined
          ? null
          : f.runtime.firstTurnEnteredAt - f.provisionStartedAt,
    }),
  );
  const comparison = capture.comparison;
  assert.ok(comparison);
  assert.equal(
    comparison.state,
    "available",
    JSON.stringify({
      reason: comparison.reason,
      observationDurations: f.observationDurations,
      firstTurnEnteredAt: f.runtime.firstTurnEnteredAt,
      firstTurnDispatchDelayMs:
        f.runtime.firstTurnEnteredAt === undefined
          ? undefined
          : f.runtime.firstTurnEnteredAt - f.provisionStartedAt,
      entries: comparison.entries.map((entry) => ({
        repositoryId: entry.repositoryId,
        path: entry.path,
        state: entry.state,
        reason: entry.reason,
      })),
    }),
  );

  const repositoryEntries = comparison.entries.filter(
    (entry) => entry.path === "turn-state.txt",
  );
  assert.deepEqual(
    repositoryEntries.map((entry) => entry.repositoryId).sort(),
    ["source-1", "source-2"],
  );
  for (const entry of repositoryEntries) {
    const anchor = entry.hunks[0]?.rightAnchor;
    assert.ok(anchor);
    assert.equal(anchor.repositoryId, entry.repositoryId);
    assert.equal(anchor.path, entry.path);
    assert.equal(anchor.side, "right");
    assert.equal(anchor.context, "turn");
    assert.equal(anchor.workId, capture.identity.workId);
    assert.equal(anchor.threadId, capture.threadId);
    assert.equal(anchor.turnId, capture.turnId);
    assert.equal(anchor.contentSha256, entry.right?.sha256);
    assert.equal(
      entry.right?.size,
      Buffer.byteLength(
        `turn 1 repository ${entry.repositoryId === "source-1" ? 1 : 2}\n`,
        "utf8",
      ),
    );
    assert.equal(entry.right?.lineCount, 1);
  }

  const invalidRepositoryAnchor = structuredClone(capture);
  const invalidRepositoryEntry =
    invalidRepositoryAnchor.comparison?.entries.find(
      (entry) => entry.repositoryId === "source-1",
    );
  const invalidRepositoryRight = invalidRepositoryEntry?.hunks[0]?.rightAnchor;
  assert.ok(invalidRepositoryRight);
  invalidRepositoryRight.repositoryId = null;
  assert.throws(
    () => store.finishTurnCapture(invalidRepositoryAnchor),
    /comparison-anchor-content-mismatch/,
  );

  const exported = store.exportComparison(f.taskId, capture.comparisonId);
  assert.ok(exported);
  for (const entry of repositoryEntries) {
    const index: number = comparison.entries.indexOf(entry);
    const sideContent: WorkspaceComparisonSideContent | undefined =
      exported.sides.find((candidate) => candidate.entryIndex === index);
    const expected = `turn 1 repository ${entry.repositoryId === "source-1" ? 1 : 2}\n`;
    assert.equal(sideContent?.rightText, expected);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(sideContent?.rightText ?? "", "utf8"))
        .digest("hex"),
      entry.right?.sha256,
    );
  }

  const recovered = await f.reopen();
  const reopenedStore = storeFor(recovered);
  const reopened = reopenedStore.latestTurnCaptures(f.taskId).latestFinished;
  assert.equal(reopened?.comparisonId, capture.comparisonId);
  assert.equal(reopened?.captureState, "finished");
  assert.equal(reopened?.identity.profileId, f.profileId);
  assert.deepEqual(
    reopenedStore.exportComparison(f.taskId, capture.comparisonId)?.sides,
    exported.sides,
  );
});

test("completed turns retain an explicit unsettled capture when finalization returns false or throws", async (t) => {
  for (const failure of ["false", "throw"] as const) {
    const f = await fixture();
    t.after(() => f.close());
    const store = storeFor(f.service);
    const first = store.latestTurnCaptures(f.taskId).latestFinished;
    assert.ok(first);

    const gate = f.runtime.holdNextWait();
    const secondAction = f.service.submitTask(
      `finalize-${failure}`,
      f.assignmentId,
      "retain exact capture failure evidence",
    );
    await gate.entered;

    const realFinishTurnCapture = store.finishTurnCapture.bind(store);
    store.finishTurnCapture = () => {
      if (failure === "throw") throw new Error("injected finalization failure");
      return false;
    };
    try {
      gate.resolve("completed");
      await secondAction;
    } finally {
      store.finishTurnCapture = realFinishTurnCapture;
    }

    assert.equal(
      f.service.list().find((work) => work.workId === `finalize-${failure}`)
        ?.state,
      "completed",
    );
    const slots = store.latestTurnCaptures(f.taskId);
    assert.equal(slots.latestFinished?.comparisonId, first.comparisonId);
    const pending = slots.pending;
    assert.ok(pending);
    assert.equal(pending.outcome, "completed");
    assert.equal(pending.captureState, "unsettled");
    assert.equal(pending.reason, "capture-store-failed");
    assert.equal(pending.comparison, undefined);
    assert.equal(
      store.exportComparison(f.taskId, pending.comparisonId),
      undefined,
    );
  }
});

test("failed terminal captures stay unsettled with the failed-work hold", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const store = storeFor(f.service);
  const failedGate = f.runtime.holdNextWait();
  const failedAction = f.service.submitTask(
    "failed-turn",
    f.assignmentId,
    "write then fail",
  );
  await failedGate.entered;
  failedGate.resolve("failed");
  await failedAction;
  await waitForWorkState(f.service, "failed-turn", "held");
  const failedWork = f.service
    .list()
    .find((work) => work.workId === "failed-turn");
  assert.equal(failedWork?.state, "held");
  assert.match(
    failedWork?.reason ?? "",
    /Bound turn failed or was interrupted/,
  );
  const failed = store.latestTurnCaptures(f.taskId).pending;
  assert.ok(failed);
  assert.equal(failed.captureState, "unsettled");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.comparison?.outcome, "failed");
  assert.equal(failed.comparison?.state, "available");
});

test("an after-observation failure cannot change a successful runtime terminal", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const internals = f.service as unknown as {
    observeTurnWorkspace: (taskId: string) => Promise<WorkspaceTurnObservation>;
  };
  const observe = internals.observeTurnWorkspace.bind(f.service);
  let calls = 0;
  internals.observeTurnWorkspace = async (taskId) => {
    if (++calls === 2)
      throw new Error("observation seam failed after terminal");
    return observe(taskId);
  };

  await f.service.submitTask(
    "after-observation-failure",
    f.assignmentId,
    "complete normally",
  );
  await waitForWorkState(f.service, "after-observation-failure", "completed");
  const work = f.service
    .list()
    .find((item) => item.workId === "after-observation-failure");
  assert.equal(work?.state, "completed");
  assert.equal(work?.reason, null);
  assert.equal(f.service.taskHold(f.taskId), undefined);
  const captures = storeFor(f.service).latestTurnCaptures(f.taskId);
  assert.equal(captures.latestFinished?.identity.workId, f.firstWorkId);
  assert.equal(captures.pending?.captureState, "unsettled");
  assert.equal(captures.pending?.outcome, "completed");
  assert.equal(captures.pending?.reason, "workspace-unavailable");
  assert.equal(captures.pending?.comparison, undefined);
});

test("an unfinished report callback keeps a successful runtime terminal held", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const store = storeFor(f.service);
  const callback = deferred<void>();
  f.runtime.beforeWaitResult = () =>
    f.service.registerExecutionCallback("callback-turn", callback.promise);
  await f.service.submitTask(
    "callback-turn",
    f.assignmentId,
    "finish before report callback",
  );
  await waitForWorkState(f.service, "callback-turn", "held");
  const callbackWork = f.service
    .list()
    .find((work) => work.workId === "callback-turn");
  assert.equal(callbackWork?.state, "held");
  assert.match(callbackWork?.reason ?? "", /callback is unfinished/);
  const held = store.latestTurnCaptures(f.taskId).pending;
  assert.ok(held);
  assert.equal(held.captureState, "unsettled");
  assert.equal(held.outcome, "completed");
  assert.equal(held.reason, "callback-unfinished");
  assert.equal(held.comparison?.outcome, "completed");
  callback.resolve(undefined);
  await Promise.resolve();
  assert.match(
    f.service.list().find((work) => work.workId === "callback-turn")?.reason ??
      "",
    /callback is unfinished/,
  );
});

test("a lost start-turn response preserves partial observation as an unbound uncertain capture", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.runtime.failStartTurnAt = 2;
  await f.service.submitTask(
    "lost-binding",
    f.assignmentId,
    "write before response loss",
  );
  await waitForWorkState(f.service, "lost-binding", "held");
  const capture = storeFor(f.service).latestTurnCaptures(f.taskId).pending;
  assert.ok(capture);
  assert.equal(capture.captureState, "unsettled");
  assert.equal(capture.outcome, "unknown");
  assert.equal(capture.reason, "turn-unbound");
  assert.equal(capture.threadId, undefined);
  assert.equal(capture.turnId, undefined);
  assert.equal(capture.comparison?.outcome, "unknown");
  assert.equal(
    capture.comparison?.entries.find((entry) => entry.path === "state.txt")
      ?.right?.sha256,
    hash("turn 2\n"),
  );
  assert.match(
    f.service.list().find((work) => work.workId === "lost-binding")?.reason ??
      "",
    /Runtime submission or observation uncertain/,
  );
});

test("Stop during an awaited before observation prevents runtime dispatch", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const internals = f.service as unknown as {
    observeTurnWorkspace: (taskId: string) => Promise<WorkspaceTurnObservation>;
  };
  const observe = internals.observeTurnWorkspace.bind(f.service);
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  internals.observeTurnWorkspace = async (taskId) => {
    const result = await observe(taskId);
    if (++calls === 1) {
      entered.resolve(undefined);
      await release.promise;
    }
    return result;
  };

  const action = f.service.submitTask(
    "stopped-before",
    f.assignmentId,
    "must not dispatch",
  );
  await entered.promise;
  const stopping = f.service.stopTask(f.taskId);
  assert.equal(f.service.taskHold(f.taskId), "Task stopped");
  release.resolve(undefined);
  await action;
  await stopping;
  await waitForWorkState(f.service, "stopped-before", "held");
  assert.equal(f.runtime.turns, 1);
  assert.equal(f.runtime.starts, 1);
  assert.equal(f.runtime.resumes, 0);
  const captures = storeFor(f.service).latestTurnCaptures(f.taskId);
  assert.equal(captures.latestFinished?.identity.workId, f.firstWorkId);
  assert.equal(captures.pending?.captureState, "unsettled");
  assert.equal(captures.pending?.reason, "turn-unbound");
  assert.equal(captures.pending?.threadId, undefined);
  assert.equal(f.service.taskHold(f.taskId), "Task stopped");
});

test("generation shutdown during before observation does not dispatch and leaves durable unsettled evidence", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const internals = f.service as unknown as {
    generation?: { accepting: boolean };
    observeTurnWorkspace: (taskId: string) => Promise<WorkspaceTurnObservation>;
  };
  const observe = internals.observeTurnWorkspace.bind(f.service);
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  internals.observeTurnWorkspace = async (taskId) => {
    const result = await observe(taskId);
    if (++calls === 1) {
      entered.resolve(undefined);
      await release.promise;
    }
    return result;
  };

  const action = f.service.submitTask(
    "shutdown-before",
    f.assignmentId,
    "must not dispatch",
  );
  await entered.promise;
  const stopping = f.service.stop();
  assert.equal(internals.generation?.accepting, false);
  release.resolve(undefined);
  await action;
  await stopping;
  assert.equal(f.runtime.turns, 1);
  assert.equal(f.runtime.starts, 1);
  assert.equal(f.runtime.resumes, 0);

  const recovered = new StandaloneService(
    join(f.root, "data"),
    () => new CaptureRuntime(),
    undefined,
    { power: { enabled: false } },
  );
  f.service = recovered;
  await recovered.start();
  assert.equal(
    recovered.list().find((work) => work.workId === "shutdown-before")?.state,
    "held",
  );
  const captures = storeFor(recovered).latestTurnCaptures(f.taskId);
  assert.equal(captures.latestFinished?.identity.workId, f.firstWorkId);
  assert.equal(captures.pending?.captureState, "unsettled");
  assert.equal(captures.pending?.outcome, "unknown");
  assert.ok(captures.pending?.comparison);
});

test("Stop during after observation preserves the stop hold and does not finish the turn capture", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const internals = f.service as unknown as {
    observeTurnWorkspace: (taskId: string) => Promise<WorkspaceTurnObservation>;
  };
  const observe = internals.observeTurnWorkspace.bind(f.service);
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  internals.observeTurnWorkspace = async (taskId) => {
    const result = await observe(taskId);
    if (++calls === 2) {
      entered.resolve(undefined);
      await release.promise;
    }
    return result;
  };

  const action = f.service.submitTask(
    "stopped-after",
    f.assignmentId,
    "complete then observe",
  );
  await entered.promise;
  const stopping = f.service.stopTask(f.taskId);
  assert.equal(f.service.taskHold(f.taskId), "Task stopped");
  release.resolve(undefined);
  await action;
  await stopping;
  await waitForWorkState(f.service, "stopped-after", "held");
  assert.equal(f.service.taskHold(f.taskId), "Task stopped");
  const captures = storeFor(f.service).latestTurnCaptures(f.taskId);
  assert.equal(captures.latestFinished?.identity.workId, f.firstWorkId);
  assert.equal(captures.pending?.captureState, "unsettled");
  assert.equal(captures.pending?.outcome, "completed");
  assert.equal(captures.pending?.reason, "runtime-uncertain");
  assert.ok(captures.pending?.comparison);
});
