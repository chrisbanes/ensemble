import assert from "node:assert/strict";
import { test } from "node:test";
import {
  operatorCommandSchema,
  workspaceSchema,
  taskSchema,
} from "../src/operator/contracts.js";
const key = "00000000-0000-4000-8000-000000000001";
const create = {
  type: "task.create",
  key,
  projectId: key,
  taskId: key,
  title: "Brief",
  outcome: "Outcome",
  ready: true,
};
test("operator commands accept supported inputs and reject authority or unrestricted payloads", () => {
  assert.equal(operatorCommandSchema.parse(create).type, "task.create");
  for (const extra of [
    { actor: "agent" },
    { credentialRef: "env:SECRET" },
    { payload: {} },
    { taskId: "bad" },
    { type: "imported-blockers.set" },
  ])
    assert.equal(
      operatorCommandSchema.safeParse({ ...create, ...extra }).success,
      false,
    );
  assert.equal(
    operatorCommandSchema.safeParse({
      type: "assignment.apply",
      key,
      projectId: key,
      assignmentId: key,
      expectedVersion: 0,
    }).success,
    false,
  );
});
test("read envelopes reject row fields and invalid states", () => {
  assert.deepEqual(
    workspaceSchema.parse({
      data: { projects: [], profiles: [] },
      observedAt: 1,
    }).data.projects,
    [],
  );
  assert.equal(
    workspaceSchema.safeParse({
      data: { projects: [], profiles: [], credentialRef: "secret" },
      observedAt: 1,
    }).success,
    false,
  );
  assert.equal(
    taskSchema.safeParse({
      data: { task: { state: "fictional" } },
      observedAt: 1,
    }).success,
    false,
  );
});
