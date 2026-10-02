import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeliveryStore } from "../src/core/delivery.js";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";

test("delivery defaults deny and only the operator can configure versioned grants", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "A",
      leadProfileId: null,
    });
    const delivery = new DeliveryStore(db);
    delivery.migrate();
    assert.equal(delivery.configuration(projectId).mode, "reviewable-pr");
    assert.deepEqual(delivery.configuration(projectId).grants, []);
    const command = {
      type: "delivery.configure" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr" as const,
      credentialRef: "env:TEST_DELIVERY",
      grants: [
        {
          action: "issue.comment" as const,
          repositoryId: "R1",
          mode: "allow" as const,
        },
      ],
      requiredChecks: [],
    };
    assert.throws(
      () => domain.execute({ ...command, actor: "agent" }),
      /operator/i,
    );
    const result = domain.execute(command);
    assert.deepEqual(domain.execute(command), result);
    assert.equal(delivery.configuration(projectId).version, 2);
    assert.throws(
      () => domain.execute({ ...command, key: randomUUID() }),
      /Version conflict/,
    );
    assert.doesNotMatch(JSON.stringify(result), /TEST_DELIVERY/);
  } finally {
    db.close();
  }
});
