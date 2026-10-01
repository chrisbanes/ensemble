import assert from "node:assert/strict";
import { test } from "node:test";
import { isRoutedTaskSettled } from "./s05/routed-task-settlement.js";

test("routing settlement waits through candidate terminal and lead follow-up enqueue", () => {
  const candidateTerminal = {
    taskState: "open",
    requestStates: ["completed"],
    intentStates: ["completed"],
    assignmentStates: ["running", "completed"],
    messagesDelivered: true,
    activeIntents: 0,
    activeCallbacks: 0,
  } as const;
  assert.equal(isRoutedTaskSettled(candidateTerminal), false);

  const leadFollowUpQueued = {
    ...candidateTerminal,
    requestStates: ["completed", "queued"],
    intentStates: ["completed", "ready"],
    activeIntents: 1,
  } as const;
  assert.equal(isRoutedTaskSettled(leadFollowUpQueued), false);

  const leadTurnFinishedButCompletionNotFinalized = {
    ...leadFollowUpQueued,
    requestStates: ["completed", "completed"],
    intentStates: ["completed", "completed"],
    assignmentStates: ["running", "completed"],
    activeIntents: 0,
  } as const;
  assert.equal(
    isRoutedTaskSettled(leadTurnFinishedButCompletionNotFinalized),
    false,
  );

  const durableCompletion = {
    ...leadTurnFinishedButCompletionNotFinalized,
    taskState: "done",
    assignmentStates: ["completed", "completed"],
  } as const;
  assert.equal(isRoutedTaskSettled(durableCompletion), true);
});

test("routing settlement also waits for delivered inbox and callbacks to drain", () => {
  const complete = {
    taskState: "done",
    requestStates: ["completed"],
    intentStates: ["completed"],
    assignmentStates: ["completed"],
    messagesDelivered: true,
    activeIntents: 0,
    activeCallbacks: 0,
  } as const;
  assert.equal(
    isRoutedTaskSettled({ ...complete, messagesDelivered: false }),
    false,
  );
  assert.equal(isRoutedTaskSettled({ ...complete, activeCallbacks: 1 }), false);
});
