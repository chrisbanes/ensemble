import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeliveryStore, type DeliveryCaller } from "../src/core/delivery.js";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { DeliveryCoordinator } from "../src/standalone/delivery.js";
import type { GitHubDeliveryProvider } from "../src/standalone/github-delivery.js";

test("persisted intent is visible before write and uncertain create is never replayed after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-delivery-")),
    file = join(directory, "db.sqlite");
  let db = new DatabaseSync(file);
  const projectId = randomUUID(),
    taskId = randomUUID();
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  domain.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "P",
    leadProfileId: null,
  });
  domain.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "T",
    outcome: "O",
  });
  domain.execute({
    type: "delivery.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  let store = new DeliveryStore(db);
  store.migrate();
  let writes = 0,
    confirmed = false,
    valid = true;
  const provider: GitHubDeliveryProvider = {
    async preflight() {
      return { nodeId: "I1" };
    },
    async performAction(record) {
      writes++;
      assert.equal(store.action(record.operationId).state, "attempting");
      return { state: "uncertain", reason: "lost-response", receipt: null };
    },
    async inspectAction() {
      return confirmed
        ? {
            state: "confirmed-success",
            reason: null,
            receipt: { nodeId: "C1" },
          }
        : { state: "uncertain", reason: "no-match", receipt: null };
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  const options = {
    providerFactory: () => provider,
    authorize: () => {
      if (!valid) throw new Error("stale caller");
    },
    approved: () => false,
  };
  const request = {
    operationId: randomUUID(),
    action: {
      kind: "issue.comment" as const,
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      body: "B",
    },
  };
  try {
    let coordinator = new DeliveryCoordinator(store, options);
    const outcomes = await Promise.all([
      coordinator.submit(request, caller),
      coordinator.submit(request, caller),
    ]);
    assert.equal(outcomes[0]?.state, "uncertain");
    assert.equal(writes, 1);
    await coordinator.stop();
    db.close();
    db = new DatabaseSync(file);
    store = new DeliveryStore(db);
    store.migrate();
    coordinator = new DeliveryCoordinator(store, options);
    await coordinator.reconcile();
    assert.equal(writes, 1);
    assert.equal(store.action(request.operationId).state, "uncertain");
    confirmed = true;
    await coordinator.reconcile();
    assert.equal(store.action(request.operationId).state, "confirmed-success");
    assert.equal(writes, 1);
    valid = false;
    assert.equal(
      (
        await coordinator.submit(
          { ...request, operationId: randomUUID() },
          caller,
        )
      ).state,
      "denied",
    );
    assert.equal(writes, 1);
    await coordinator.stop();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { deliveryFixture } from "./delivery-fixture.js";
test("bound service delivery refuses spoofing and a revoked policy during asynchronous preflight", async () => {
  const f = await deliveryFixture();
  try {
    const args = {
      operationId: randomUUID(),
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", number: 1, nodeId: "I1" },
        body: "B",
      },
    };
    assert.equal(
      (
        await f.call("ensemble_external_action", {
          ...args,
          taskId: randomUUID(),
        })
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    let release!: () => void;
    f.holdPreflight(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.call("ensemble_external_action", args);
    let response: unknown;
    void pending.then((value) => {
      response = value;
    });
    const deadline = Date.now() + 3000;
    while (!f.service.delivery().actions(f.taskId).length) {
      if (Date.now() > deadline)
        throw new Error(
          JSON.stringify({
            response,
            admission: f.domain.admission(f.taskId),
            list: f.service.list(),
          }),
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [],
      requiredChecks: [],
    });
    release();
    assert.equal((await pending).success, false);
    assert.equal(f.effects.length, 0);
    assert.equal(
      f.service.delivery().actions(f.taskId)[0]?.state,
      "confirmed-failure",
    );
  } finally {
    await f.close();
  }
});

import { canonicalMaterial } from "../src/core/delivery.js";
test("actual operator approval authorizes only exact material on the next eligible bound lead turn", async () => {
  const f = await deliveryFixture();
  try {
    const action = {
      kind: "issue.edit",
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      fields: { title: "Approved title" },
    };
    assert.equal(
      (
        await f.call("ensemble_external_action", {
          operationId: randomUUID(),
          action,
        })
      ).success,
      false,
    );
    const approval = await f.call("ensemble_request_approval", {
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    assert.equal(approval.success, true);
    const interaction = f.service.coordinationView().readTask(f.taskId)
      .approvals[0];
    assert.ok(interaction);
    f.turns[0]?.release();
    const deadline = Date.now() + 3000;
    while (!f.service.list().some((i) => i.state === "completed")) {
      if (Date.now() > deadline) throw new Error("terminal timeout");
      await new Promise<void>((r) => setImmediate(r));
    }
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    await f.waitTurn(1);
    const approved = {
      interactionId: interaction.interactionId,
      expectedRevision: 2,
    };
    assert.equal(
      (
        await f.call(
          "ensemble_external_action",
          {
            operationId: randomUUID(),
            action: {
              ...action,
              fields: { title: "Changed unapproved title" },
            },
            approval: approved,
          },
          1,
        )
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    assert.equal(
      (
        await f.call(
          "ensemble_external_action",
          { operationId: randomUUID(), action, approval: approved },
          1,
        )
      ).success,
      true,
    );
    assert.equal(f.effects.length, 1);
    assert.equal(
      (
        await f.call(
          "ensemble_external_action",
          { operationId: randomUUID(), action, approval: approved },
          1,
        )
      ).success,
      false,
    );
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test("a bound denied operation remains denied after policy expansion and rejects changed material", async () => {
  const f = await deliveryFixture();
  try {
    const request = {
      operationId: randomUUID(),
      action: {
        kind: "issue.labels",
        target: { repositoryId: "R1", number: 1, nodeId: "I1" },
        add: ["progress"],
        remove: [],
      },
    };
    assert.equal(
      (await f.call("ensemble_external_action", request)).success,
      false,
    );
    assert.equal(
      f.service
        .delivery()
        .actions(f.taskId)
        .find((a) => a.operationId === request.operationId)?.state,
      "denied",
    );
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "issue.labels", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    assert.equal(
      (await f.call("ensemble_external_action", request)).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    assert.equal(
      (
        await f.call("ensemble_external_action", {
          ...request,
          action: { ...request.action, add: ["other"] },
        })
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

function coordinatorFixture() {
  const root = mkdtempSync(join(tmpdir(), "ensemble-delivery-races-")),
    file = join(root, "state.sqlite");
  let db = new DatabaseSync(file);
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    tasks = [randomUUID(), randomUUID(), randomUUID()];
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "P",
    leadProfileId: null,
  });
  for (const taskId of tasks)
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
    });
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  let store = new DeliveryStore(db);
  store.migrate();
  const caller = (index: number): DeliveryCaller => ({
    projectId,
    taskId: String(tasks[index]),
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: `w${index}`,
    workRevision: 1,
    conversationRevision: 1,
  });
  const request = (number = 1) => ({
    operationId: randomUUID(),
    action: {
      kind: "issue.comment" as const,
      target: { repositoryId: "R1", nodeId: `I${number}`, number },
      body: "B",
    },
  });
  return {
    caller,
    request,
    store: () => store,
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      store = new DeliveryStore(db);
      store.migrate();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("positively confirmed transient failures retry only twice including persisted prior attempts", async () => {
  const f = coordinatorFixture();
  let effects = 0;
  const request = f.request(),
    caller = f.caller(0);
  const provider: GitHubDeliveryProvider = {
    async preflight() {
      return {};
    },
    async performAction() {
      effects++;
      return {
        state: "confirmed-failure",
        reason: "confirmed-transient-no-effect",
        receipt: null,
        retryable: true,
      };
    },
    async inspectAction() {
      throw new Error("unused");
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const options = {
    providerFactory: () => provider,
    authorize: () => {},
    approved: () => false,
  };
  let coordinator: DeliveryCoordinator | undefined;
  try {
    f.store().prepareAction(request, caller, false);
    f.store().beginAttempt(request.operationId, {});
    f.store().recordObservation(request.operationId, {
      state: "confirmed-failure",
      reason: "confirmed-transient-no-effect",
      receipt: null,
      retryable: true,
    });
    f.reopen();
    coordinator = new DeliveryCoordinator(f.store(), options);
    await coordinator.reconcile();
    assert.equal(effects, 2);
    assert.equal(f.store().action(request.operationId).attempts, 3);
    await coordinator.stop();
    f.reopen();
    coordinator = new DeliveryCoordinator(f.store(), options);
    await coordinator.reconcile();
    assert.equal(effects, 2);
    assert.equal(
      f.store().action(request.operationId).state,
      "confirmed-failure",
    );
  } finally {
    await coordinator?.stop();
    f.close();
  }
});
test("reconciliation serializes the exact target against other task writes while unrelated targets proceed", async () => {
  const f = coordinatorFixture(),
    old = f.request(),
    caller = f.caller(0);
  f.store().prepareAction(old, caller, false);
  f.store().beginAttempt(old.operationId, {});
  f.store().recordObservation(old.operationId, {
    state: "uncertain",
    reason: "lost-response",
    receipt: null,
  });
  let release!: () => void, entered!: () => void;
  const inspectStarted = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const effects: number[] = [];
  const provider: GitHubDeliveryProvider = {
    async preflight() {
      return {};
    },
    async inspectAction() {
      entered();
      await readGate;
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "C1" },
      };
    },
    async performAction(record) {
      effects.push(
        "number" in record.request.action.target
          ? record.request.action.target.number
          : 0,
      );
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "C2" },
      };
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const coordinator = new DeliveryCoordinator(f.store(), {
    providerFactory: () => provider,
    authorize: () => {},
    approved: () => false,
  });
  try {
    const reconciliation = coordinator.reconcile();
    await inspectStarted;
    const same = coordinator.submit(f.request(1), f.caller(1));
    await coordinator.submit(f.request(2), f.caller(2));
    assert.deepEqual(effects, [2]);
    release();
    await Promise.all([same, reconciliation]);
    assert.deepEqual(effects, [2, 1]);
  } finally {
    release();
    await coordinator.stop();
    f.close();
  }
});
test("newly configured delivery credentials inherited by the current runtime hold activation until restart", async () => {
  const key = "S07A_ACTIVATION_SENTINEL",
    previous = process.env[key];
  process.env[key] = "private-activation-value";
  const f = await deliveryFixture();
  try {
    assert.equal(
      f.spawn()?.spawnEnvironment()[key],
      "private-activation-value",
    );
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: `env:${key}`,
      grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    const response = await f.call("ensemble_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", nodeId: "I1", number: 1 },
        body: "B",
      },
    });
    assert.equal(response.success, false);
    assert.equal(f.effects.length, 0);
    assert.doesNotMatch(
      JSON.stringify(f.service.delivery().publicTask(f.taskId)),
      /private-activation-value|S07A_ACTIVATION_SENTINEL/,
    );
  } finally {
    await f.close();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

import { StandaloneService } from "../src/standalone/service.js";
test("restart retains one unavailable PR binding while independent feedback and operator views continue", async () => {
  const f = await deliveryFixture();
  try {
    const register = (p: ReturnType<typeof f.getPr>) =>
      f.call("ensemble_register_pr", {
        repositoryId: p.repositoryId,
        prNumber: p.number,
        expectedPrNodeId: p.nodeId,
        expectedHeadSha: p.headSha,
      });
    assert.equal((await register(f.getPr())).success, true);
    f.turns[0]?.release();
    const waitCompleted = async (index: number) => {
      const deadline = Date.now() + 3000;
      while (
        !f.service
          .list()
          .some(
            (i) =>
              i.turnId === f.turns[index]?.turnId && i.state === "completed",
          )
      ) {
        if (Date.now() > deadline) throw new Error("Lead terminal not settled");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    await waitCompleted(0);
    const healthyTaskId = randomUUID();
    f.domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: healthyTaskId,
      title: "Healthy",
      outcome: "Healthy",
      ready: true,
    });
    await f.service.provisionTask(healthyTaskId);
    await f.waitTurn(1);
    const healthyPr = {
      ...f.getPr(),
      nodeId: "P8",
      number: 8,
      headRef: "cb/healthy",
    };
    f.setOtherPr(healthyPr);
    assert.equal((await register(healthyPr)).success, true);
    f.turns[1]?.release();
    await waitCompleted(1);
    await f.service.stop();
    f.failReads(true);
    f.setOtherPr({
      ...healthyPr,
      checks: [
        {
          name: "build",
          status: "failure",
          sha: healthyPr.headSha,
          appId: null,
        },
      ],
    });
    await f.service.start();
    const held = f.service.coordinationView().readTask(f.taskId).delivery;
    assert.equal(held?.binding?.readError, "provider-read-unavailable");
    assert.ok(held?.blockers.includes("delivery-provider-read-unavailable"));
    assert.equal(
      f.service.coordinationView().readTask(healthyTaskId).delivery?.binding
        ?.readError,
      null,
    );
    await f.waitTurn(2);
    assert.equal(f.turns[2]?.threadId, f.turns[1]?.threadId);
    const binding = f.service.delivery().delivery(f.taskId);
    assert.ok(binding);
    await assert.rejects(
      () =>
        f.service.settleHandback({
          actor: "operator",
          key: randomUUID(),
          taskId: f.taskId,
          expectedTaskVersion: Number(
            f.service.domain().task(f.taskId).version,
          ),
          expectedDeliveryRevision: binding.revision,
          expectedPolicyVersion: 2,
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
          decision: "accepted",
        }),
      /inspection unavailable/,
    );
    assert.equal(f.service.domain().task(f.taskId).state, "open");
  } finally {
    await f.close();
  }
});
test("failed startup releases delivery state before a clean retry", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-delivery-startup-")),
  );
  let fail = true;
  const runtime = {
    async start() {
      if (fail) throw new Error("unavailable");
    },
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "t";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed" as const;
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    { power: { enabled: false } },
  );
  try {
    await assert.rejects(() => service.start());
    assert.throws(() => service.delivery(), /Service is not started/);
    fail = false;
    await service.start();
    assert.deepEqual(service.delivery().actions(), []);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
