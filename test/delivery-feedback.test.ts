import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";
import { DatabaseSync } from "node:sqlite";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import {
  DeliveryStore,
  type DeliveryCaller,
  type PrDeliveryObservation,
} from "../src/core/delivery.js";
import { DeliveryCoordinator } from "../src/standalone/delivery.js";
import type { GitHubDeliveryProvider } from "../src/standalone/github-delivery.js";

test("unchanged feedback is deduplicated and cached settlement never qualifies a changed provider head", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-feedback-restart-"));
  let db = new DatabaseSync(join(root, "state.sqlite"));
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
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
  let store = new DeliveryStore(db);
  store.migrate();
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId,
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  let p: PrDeliveryObservation = {
    repositoryId: "R1",
    nodeId: "P7",
    number: 7,
    baseRef: "main",
    headRef: "cb/change",
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    state: "OPEN",
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash"],
  };
  let fail = false;
  let feedbackFailure = false;
  const events: string[] = [];
  const provider: GitHubDeliveryProvider = {
    async inspectPr() {
      if (fail) throw new Error("raw provider detail");
      return p;
    },
    async preflight() {
      return {};
    },
    async performAction() {
      throw new Error("unused");
    },
    async inspectAction() {
      throw new Error("unused");
    },
  };
  const options = {
    providerFactory: () => provider,
    authorize: () => {},
    approved: () => false,
    taskVersion: () => 1,
    feedback: (_task: string, _reason: string, key: string) => {
      if (feedbackFailure) throw new Error("feedback-transaction-fault");
      events.push(key);
    },
  };
  let coordinator = new DeliveryCoordinator(store, options);
  try {
    await coordinator.registerPr(
      {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: p.headSha,
      },
      caller,
    );
    assert.ok(
      store
        .completionBlockers(taskId, 1)
        .includes("reviewable-pr-awaiting-current-settlement"),
    );
    await coordinator.settleHandback({
      actor: "operator",
      key: randomUUID(),
      taskId,
      expectedTaskVersion: 1,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: p.headSha,
      decision: "accepted",
    });
    assert.deepEqual((await coordinator.qualifyCompletion(taskId))(), []);
    const count = events.length;
    await coordinator.refresh();
    await coordinator.refresh();
    assert.equal(events.length, count);
    p = {
      ...p,
      feedback: [
        {
          kind: "comment",
          nodeId: "C1",
          author: "U1",
          updatedAt: "2026-10-01T10:00:00Z",
          state: "COMMENTED",
          body: "Please address the failing scenario",
          commitSha: null,
        },
      ],
    } as PrDeliveryObservation;
    await coordinator.refresh();
    assert.equal(events.length, count + 1);
    await coordinator.refresh();
    assert.equal(events.length, count + 1);
    p = { ...p, headSha: "3".repeat(40) };
    assert.ok((await coordinator.qualifyCompletion(taskId))().length > 0);
    assert.equal(store.delivery(taskId)?.settlement, null);
    const changedCount = events.length;
    await coordinator.refresh();
    assert.equal(events.length, changedCount);
    await coordinator.stop();
    db.close();
    db = new DatabaseSync(join(root, "state.sqlite"));
    store = new DeliveryStore(db);
    store.migrate();
    coordinator = new DeliveryCoordinator(store, options);
    await coordinator.refresh();
    assert.equal(events.length, changedCount);
    p = { ...p, headSha: "1".repeat(40) };
    await coordinator.refresh();
    assert.equal(events.length, changedCount + 1);
    p = { ...p, headSha: "3".repeat(40) };
    await coordinator.refresh();
    assert.equal(events.length, changedCount + 2);
    assert.equal(new Set(events).size, events.length);
    feedbackFailure = true;
    p = { ...p, headSha: "4".repeat(40) };
    await assert.rejects(
      () => coordinator.refresh(),
      /feedback-transaction-fault/,
    );
    assert.equal(store.delivery(taskId)?.readError, null);
    feedbackFailure = false;
    fail = true;
    assert.deepEqual((await coordinator.qualifyCompletion(taskId))(), [
      "delivery-provider-read-unavailable",
    ]);
  } finally {
    await coordinator.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
