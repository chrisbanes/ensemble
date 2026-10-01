import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeConversationEvent } from "../src/standalone/codex.js";
import { CaptureObserver } from "./s05/capture-observer.js";

const threadId = "thread-current";
const turnId = "turn-bound";
const itemId = "message-bound";
const marker = "S05_CAPTURE_OK";

function event(
  kind: RuntimeConversationEvent["kind"],
  currentTurnId = turnId,
): RuntimeConversationEvent {
  const identity = {
    threadId,
    turnId: currentTurnId,
    itemId: currentTurnId === turnId ? itemId : "message-other",
  };
  switch (kind) {
    case "started":
      return { ...identity, kind };
    case "delta":
      return { ...identity, kind, bytes: 4 };
    case "completed":
      return {
        ...identity,
        kind,
        text: currentTurnId === turnId ? marker : "PRIVATE_OTHER_TURN_TEXT",
      };
    case "omitted":
      return { ...identity, kind, reason: "missing-text" };
  }
}

for (const eventOrder of ["response-first", "event-first"] as const) {
  test(`capture observer binds exact response with ${eventOrder} event ordering`, () => {
    const observer = new CaptureObserver(marker);
    observer.bindThread(threadId);

    if (eventOrder === "response-first") observer.bindTurn(turnId);
    observer.observe(event("completed", "turn-other"));
    for (const kind of ["started", "delta", "delta", "completed"] as const)
      observer.observe(event(kind));
    if (eventOrder === "event-first") observer.bindTurn(turnId);

    const snapshot = observer.snapshot();
    assert.deepEqual(snapshot.targetTurn, {
      started: 1,
      deltas: 2,
      deltaBytes: 8,
      completed: 1,
      omitted: 0,
      markerMatched: true,
      identities: [
        { threadId, turnId, itemId, kind: "started", count: 1 },
        { threadId, turnId, itemId, kind: "delta", count: 2 },
        { threadId, turnId, itemId, kind: "completed", count: 1 },
      ],
    });
    assert.deepEqual(snapshot.otherTurns, [
      {
        turnId: "turn-other",
        started: 0,
        deltas: 0,
        completed: 1,
        omitted: 0,
        identities: [
          {
            threadId,
            turnId: "turn-other",
            itemId: "message-other",
            kind: "completed",
            count: 1,
          },
        ],
      },
    ]);
    assert.equal(snapshot.droppedTurnEvents, 0);
    assert.equal(
      JSON.stringify(snapshot).includes("PRIVATE_OTHER_TURN_TEXT"),
      false,
    );
  });
}
