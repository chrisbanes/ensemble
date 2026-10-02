import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeliveryStore } from "../src/core/delivery.js";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";

test("immutable intents precede effects and reject denied, readiness, and changed-key material", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID(),
      taskId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "A",
      leadProfileId: null,
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
    });
    const delivery = new DeliveryStore(db);
    delivery.migrate();
    const binding = {
      projectId,
      taskId,
      taskVersion: 1,
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "work",
      workRevision: 1,
      conversationRevision: 1,
    };
    const action = {
      kind: "issue.comment" as const,
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      body: "Reviewed comment",
    };
    const operationId = randomUUID();
    assert.equal(
      delivery.prepareAction(
        { operationId: randomUUID(), action },
        binding,
        false,
      ).state,
      "denied",
    );
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        { action: "issue.comment", repositoryId: "R1", mode: "allow" },
        { action: "issue.labels", repositoryId: "R1", mode: "allow" },
        {
          action: "project.field",
          repositoryId: "R1",
          mode: "allow",
          projectNodeId: "P1",
          fieldNodeId: "F1",
          optionNodeIds: ["O1", "O2"],
        },
      ],
      requiredChecks: [],
    });
    const intent = delivery.prepareAction(
      { operationId, action },
      binding,
      false,
    );
    assert.equal(intent.state, "prepared");
    assert.deepEqual(
      delivery.prepareAction({ operationId, action }, binding, false),
      intent,
    );
    assert.throws(
      () =>
        delivery.prepareAction(
          { operationId, action: { ...action, body: "Other" } },
          binding,
          false,
        ),
      /different/,
    );
    assert.equal(
      delivery.prepareAction(
        {
          operationId: randomUUID(),
          action: {
            ...action,
            target: { ...action.target, repositoryId: "R2" },
          },
        },
        binding,
        false,
      ).state,
      "denied",
    );
    assert.equal(
      delivery.prepareAction(
        {
          operationId: randomUUID(),
          action: {
            kind: "issue.labels",
            target: action.target,
            add: ["ready"],
            remove: [],
          },
        },
        binding,
        false,
      ).state,
      "denied",
    );
    const field = {
      kind: "project.field" as const,
      target: action.target,
      projectNodeId: "P1",
      itemNodeId: "ITEM1",
      fieldNodeId: "F1",
      optionNodeId: "O1",
    };
    for (const change of [
      { projectNodeId: "P2" },
      { fieldNodeId: "F2" },
      { optionNodeId: "O3" },
    ])
      assert.equal(
        delivery.prepareAction(
          { operationId: randomUUID(), action: { ...field, ...change } },
          binding,
          false,
        ).state,
        "denied",
      );
    const projectB = randomUUID(),
      taskB = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId: projectB,
      name: "B",
      leadProfileId: null,
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: projectB,
      taskId: taskB,
      title: "T",
      outcome: "O",
    });
    assert.equal(
      delivery.prepareAction(
        { operationId: randomUUID(), action },
        { ...binding, projectId: projectB, taskId: taskB },
        false,
      ).state,
      "denied",
    );
    assert.throws(() =>
      delivery.prepareAction(
        {
          operationId: randomUUID(),
          action: { ...action, url: "https://attacker.example" },
        },
        binding,
        false,
      ),
    );
    delivery.beginAttempt(operationId, { nodeId: "I1" });
    assert.equal(delivery.action(operationId).state, "attempting");
    delivery.recordObservation(operationId, {
      state: "uncertain",
      reason: "read-unavailable",
      receipt: null,
    });
    assert.deepEqual(delivery.actionBlockers(taskId), [
      "external-action-uncertain",
    ]);
  } finally {
    db.close();
  }
});
