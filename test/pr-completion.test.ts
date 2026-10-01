import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  type DeliveryCaller,
  type PrDeliveryObservation,
} from "../src/core/delivery.js";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { DeliveryCoordinator } from "../src/standalone/delivery.js";
import type { GitHubDeliveryProvider } from "../src/standalone/github-delivery.js";

test("handback settlement inspects provider-only head changes and rechecks local revisions after await", async () => {
  const db = new DatabaseSync(":memory:");
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
  const store = new DeliveryStore(db);
  store.migrate();
  let observation: PrDeliveryObservation = {
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
  let mutate: (() => void) | undefined;
  const provider: GitHubDeliveryProvider = {
    async inspectPr() {
      mutate?.();
      return observation;
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
  const feedback: string[] = [];
  const coordinator = new DeliveryCoordinator(store, {
    providerFactory: () => provider,
    authorize: () => {},
    approved: () => false,
    taskVersion: () => Number(domain.task(taskId).version),
    feedback: (_task, reason) => {
      feedback.push(reason);
    },
  });
  try {
    await coordinator.registerPr(
      {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: observation.headSha,
      },
      caller,
    );
    const binding = store.delivery(taskId);
    assert.ok(binding);
    const command = {
      actor: "operator" as const,
      key: randomUUID(),
      taskId,
      expectedTaskVersion: 1,
      expectedDeliveryRevision: binding.revision,
      expectedPolicyVersion: 1,
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: observation.headSha,
      decision: "accepted" as const,
    };
    observation = { ...observation, headSha: "3".repeat(40) };
    await assert.rejects(() => coordinator.settleHandback(command), /changed/);
    assert.equal(store.delivery(taskId)?.settlement, null);
    assert.ok(feedback.length > 0);
    const currentBinding = store.delivery(taskId);
    assert.ok(currentBinding);
    const updated = {
      ...command,
      key: randomUUID(),
      expectedDeliveryRevision: currentBinding.revision,
      expectedHeadSha: observation.headSha,
    };
    mutate = () =>
      domain.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        expectedVersion: 1,
        outcome: "Changed",
      });
    await assert.rejects(() => coordinator.settleHandback(updated), /changed/);
    assert.equal(store.delivery(taskId)?.settlement, null);
  } finally {
    await coordinator.stop();
    db.close();
  }
});

import { deliveryFixture } from "./delivery-fixture.js";
test("running retained lead performs explicit through-merge only after all existing action gates pass", async () => {
  const f = await deliveryFixture("through-merge");
  try {
    const p = f.getPr();
    assert.equal(
      (
        await f.call("ensemble_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: p.headSha,
        })
      ).success,
      true,
    );
    const target = {
      repositoryId: "R1",
      number: 7,
      nodeId: "P7",
      baseRef: "main",
      headRef: "cb/change",
      expectedHeadSha: p.headSha,
    };
    f.setPr({ ...p, mergeBlockers: ["check-build-unproved"] });
    assert.equal(
      (
        await f.call("ensemble_external_action", {
          operationId: randomUUID(),
          action: {
            kind: "pr.merge",
            target,
            method: "squash",
            reviewedResultIds: [],
          },
        })
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    f.setPr(p);
    const result = await f.call("ensemble_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.merge",
        target,
        method: "squash",
        reviewedResultIds: [],
      },
    });
    assert.equal(result.success, true, result.text);
    assert.equal(f.effects.length, 1);
    assert.equal(
      f.service.delivery().delivery(f.taskId)?.observation.merged,
      true,
    );
    assert.equal(f.domain.task(f.taskId).state, "open");
  } finally {
    await f.close();
  }
});
test("reviewable delivery retains lead waiting and requires fresh operator settlement", async () => {
  const f = await deliveryFixture();
  try {
    const p = f.getPr();
    assert.equal(
      (
        await f.call("ensemble_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: p.headSha,
        })
      ).success,
      true,
    );
    const completion = await f.call("ensemble_request_completion", {
      reviewedResultIds: [],
    });
    assert.equal(completion.success, false);
    assert.match(completion.text, /awaiting-current-settlement/);
    assert.equal(f.effects.length, 0);
    f.turns[0]?.release();
    const deadline = Date.now() + 3000;
    while (!f.service.list().some((i) => i.state === "completed")) {
      if (Date.now() > deadline) throw new Error("terminal not settled");
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(
      f.service.coordinationView().readTask(f.taskId).attention.completions
        .length,
      0,
    );
    assert.equal(f.domain.task(f.taskId).state, "open");
    const b = f.service.delivery().delivery(f.taskId);
    assert.ok(b);
    await f.service.settleHandback({
      actor: "operator",
      key: randomUUID(),
      taskId: f.taskId,
      expectedTaskVersion: Number(f.domain.task(f.taskId).version),
      expectedDeliveryRevision: b.revision,
      expectedPolicyVersion: 2,
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: p.headSha,
      decision: "accepted",
    });
    await f.waitTurn(1);
    assert.equal(
      (
        await f.call(
          "ensemble_request_completion",
          { reviewedResultIds: [] },
          1,
        )
      ).success,
      true,
    );
    f.turns[1]?.release();
    const finishDeadline = Date.now() + 3000;
    while (f.domain.task(f.taskId).state !== "done") {
      if (Date.now() > finishDeadline)
        throw new Error(
          JSON.stringify(
            f.service.coordinationView().readTask(f.taskId).completionRequests,
          ),
        );
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

import {
  GitHubSourceStore,
  type IssueSnapshot,
} from "../src/core/github-source.js";
test("only confirmed own closure continues a withdrawn open-issue selection while independent source gates remain", () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const sources = new GitHubSourceStore(db);
  sources.migrate();
  const projectId = randomUUID(),
    profileId = randomUUID();
  const execute = (command: object) =>
    domain.execute({
      actor: "operator",
      key: randomUUID(),
      ...command,
    } as never);
  try {
    execute({
      type: "profile.create",
      profileId,
      name: "Lead",
      instructions: "Lead",
      capabilities: "work",
    });
    execute({
      type: "project.create",
      projectId,
      name: "P",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "github.configure",
      projectId,
      expectedVersion: 1,
      credentialRef: null,
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    execute({
      type: "github.activate",
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    const issue: IssueSnapshot = {
      providerInstance: "github.com",
      nodeId: "I1",
      repositoryId: "R1",
      repositoryName: "org/repo",
      number: 1,
      title: "T",
      body: "O",
      state: "open",
      labels: ["ready"],
      projectFields: [],
    };
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [issue],
      reason: null,
    });
    sources.reconcileBlockers("I1", {
      complete: true,
      blockers: [],
      reason: null,
    });
    const taskId = String(sources.issue("I1")?.taskId);
    assert.equal(domain.admission(taskId).eligible, true);
    execute({
      type: "delivery.configure",
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "issue.close", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    const delivery = new DeliveryStore(db),
      operationId = randomUUID();
    delivery.prepareAction(
      {
        operationId,
        action: {
          kind: "issue.close",
          target: { repositoryId: "R1", nodeId: "I1", number: 1 },
          reviewedResultIds: [],
        },
      },
      {
        projectId,
        taskId,
        taskVersion: Number(domain.task(taskId).version),
        assignmentId: randomUUID(),
        assignmentVersion: 1,
        workId: "w",
        workRevision: 1,
        conversationRevision: 1,
      },
      false,
    );
    delivery.beginAttempt(operationId, { state: "open" });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...issue, state: "closed" }],
      reason: null,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [],
      reason: null,
    });
    assert.ok(
      domain.admission(taskId, true).reasons.includes("source-withdrawn"),
    );
    delivery.recordObservation(operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I1", issueClosed: true },
    });
    sources.recordDeliveryClosure(
      projectId,
      2,
      { ...issue, state: "closed" },
      operationId,
      null,
    );
    assert.equal(domain.admission(taskId, true).eligible, true);
    assert.ok(domain.admission(taskId).reasons.includes("task-unready"));
    assert.equal(domain.task(taskId).ready, 0);
    sources.recordDeliveryClosure(
      projectId,
      2,
      { ...issue, state: "closed", labels: [] },
      operationId,
      null,
    );
    assert.ok(domain.admission(taskId, true).reasons.includes("source-hold"));
    sources.reconcileBlockers("I1", {
      complete: false,
      blockers: [],
      reason: "unavailable",
    });
    assert.ok(
      domain
        .admission(taskId, true)
        .reasons.includes("imported-blockers-unknown"),
    );
    sources.reconcileBlockers("I1", {
      complete: true,
      blockers: [],
      reason: null,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: false,
      issues: [],
      reason: "unavailable",
    });
    assert.ok(
      domain.admission(taskId, true).reasons.includes("source-withdrawn"),
    );
  } finally {
    db.close();
  }
});

test("imported service completes after own merge with actual open-only discovery and current closure label proof", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    assert.equal(
      (
        await f.call("ensemble_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
        })
      ).success,
      true,
    );
    const merged = await f.call("ensemble_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.merge",
        target: {
          repositoryId: "R1",
          nodeId: "P7",
          number: 7,
          headRef: "cb/change",
          baseRef: "main",
          expectedHeadSha: f.getPr().headSha,
        },
        method: "squash",
        reviewedResultIds: [],
      },
    });
    assert.equal(merged.success, true);
    assert.equal(
      f.service.githubSources().issue("I1")?.observedState,
      "closed",
    );
    assert.equal(f.service.githubSources().memberships("I1").length, 0);
    assert.equal(f.domain.admission(f.taskId, true).eligible, true);
    assert.equal(f.domain.task(f.taskId).ready, 0);
    f.turns[0]?.release();
    await f.waitTurn(1);
    assert.equal(
      (
        await f.call(
          "ensemble_request_completion",
          { reviewedResultIds: [] },
          1,
        )
      ).success,
      true,
    );
    f.turns[1]?.release();
    const deadline = Date.now() + 5000;
    while (f.domain.task(f.taskId).state !== "done") {
      if (Date.now() > deadline)
        throw new Error("Own-closure completion did not finalize");
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test("own merge cannot hide simultaneous independent readiness label loss", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    assert.equal(
      (
        await f.call("ensemble_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
        })
      ).success,
      true,
    );
    f.setSourceLabels([]);
    assert.equal(
      (
        await f.call("ensemble_external_action", {
          operationId: randomUUID(),
          action: {
            kind: "pr.merge",
            target: {
              repositoryId: "R1",
              nodeId: "P7",
              number: 7,
              headRef: "cb/change",
              baseRef: "main",
              expectedHeadSha: f.getPr().headSha,
            },
            method: "squash",
            reviewedResultIds: [],
          },
        })
      ).success,
      true,
    );
    assert.ok(
      f.domain.admission(f.taskId, true).reasons.includes("source-hold"),
    );
    assert.equal(f.domain.task(f.taskId).state, "open");
  } finally {
    await f.close();
  }
});
