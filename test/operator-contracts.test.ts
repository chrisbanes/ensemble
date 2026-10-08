import assert from "node:assert/strict";
import { test } from "node:test";
import {
  operatorCommandSchema,
  materialSchema,
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
  const runtime = { state: "available" };
  assert.deepEqual(
    workspaceSchema.parse({
      data: { projects: [], profiles: [], runtime },
      observedAt: 1,
    }).data.projects,
    [],
  );
  assert.deepEqual(
    workspaceSchema.parse({
      data: {
        projects: [],
        profiles: [],
        runtime: { state: "unavailable", since: 5 },
      },
      observedAt: 1,
    }).data.runtime,
    { state: "unavailable", since: 5 },
  );
  for (const invalid of [
    undefined,
    { state: "unavailable" },
    { state: "available", since: 5 },
    { state: "unavailable", since: -1 },
    { state: "unavailable", since: 5, error: "secret" },
  ])
    assert.equal(
      workspaceSchema.safeParse({
        data: { projects: [], profiles: [], runtime: invalid },
        observedAt: 1,
      }).success,
      false,
    );
  assert.equal(
    workspaceSchema.safeParse({
      data: { projects: [], profiles: [], runtime, credentialRef: "secret" },
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

test("all supported command variants validate exact revisions and bounded material without completion convenience", () => {
  const base = { key, taskId: key };
  for (const command of [
    { ...create, ready: false },
    {
      type: "task.configure",
      ...base,
      projectId: key,
      expectedVersion: 1,
      ready: true,
    },
    {
      type: "dependency.add",
      ...base,
      projectId: key,
      blockerTaskId: key,
      expectedVersion: 1,
    },
    {
      type: "dependency.remove",
      ...base,
      projectId: key,
      blockerTaskId: key,
      expectedVersion: 1,
    },
    {
      type: "assignment.apply",
      key,
      projectId: key,
      assignmentId: key,
      expectedVersion: 1,
    },
    {
      type: "message",
      ...base,
      recipientAssignmentId: key,
      expectedAssignmentVersion: 1,
      message: "Retained",
    },
    {
      type: "question.answer",
      ...base,
      interactionId: key,
      expectedRevision: 1,
      answer: "A",
    },
    {
      type: "approval.decide",
      ...base,
      interactionId: key,
      expectedRevision: 1,
      decision: "denied",
      action: "Publish",
    },
    {
      type: "approval.decide",
      ...base,
      interactionId: key,
      expectedRevision: 1,
      decision: "approved",
      action: "Publish",
      material: { version: "next" },
    },
    {
      type: "result.recipient",
      ...base,
      resultId: key,
      expectedRevision: 1,
      recipientAssignmentId: key,
    },
  ])
    assert.equal(operatorCommandSchema.safeParse(command).success, true);
  assert.equal(
    operatorCommandSchema.safeParse({
      type: "task.configure",
      ...base,
      projectId: key,
      expectedVersion: 1,
      state: "done",
    }).success,
    false,
  );
  assert.equal(materialSchema.safeParse("😀".repeat(3000)).success, false);
  let deep: unknown = "value";
  for (let i = 0; i < 13; i++) deep = [deep];
  assert.equal(materialSchema.safeParse(deep).success, false);
});
