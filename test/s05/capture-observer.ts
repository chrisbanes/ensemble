import type { RuntimeConversationEvent } from "../../src/standalone/codex.js";

interface EventIdentityCount {
  threadId: string;
  turnId: string;
  itemId: string;
  kind: RuntimeConversationEvent["kind"];
  count: number;
}

interface TurnCapture {
  started: number;
  deltas: number;
  deltaBytes: number;
  completed: number;
  omitted: number;
  markerMatched: boolean;
  identities: Map<string, EventIdentityCount>;
}

const maxObservedTurns = 16;
const maxEventIdentitiesPerTurn = 64;

function newTurnCapture(): TurnCapture {
  return {
    started: 0,
    deltas: 0,
    deltaBytes: 0,
    completed: 0,
    omitted: 0,
    markerMatched: false,
    identities: new Map(),
  };
}

function boundedIncrement(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

/** Test-harness observer that binds buffered events only to startTurn's response. */
export class CaptureObserver {
  private threadId: string | undefined;
  private turnId: string | undefined;
  private droppedTurnEvents = 0;
  private readonly turns = new Map<string, TurnCapture>();

  constructor(private readonly marker: string) {}

  bindThread(threadId: string): void {
    this.threadId = threadId;
  }

  bindTurn(turnId: string): void {
    this.turnId = turnId;
  }

  observe(event: RuntimeConversationEvent): void {
    if (!this.threadId || event.threadId !== this.threadId) return;

    let capture = this.turns.get(event.turnId);
    if (!capture) {
      if (this.turns.size >= maxObservedTurns) {
        this.droppedTurnEvents = boundedIncrement(this.droppedTurnEvents);
        return;
      }
      capture = newTurnCapture();
      this.turns.set(event.turnId, capture);
    }

    switch (event.kind) {
      case "started":
        capture.started = boundedIncrement(capture.started);
        break;
      case "delta":
        capture.deltas = boundedIncrement(capture.deltas);
        capture.deltaBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          capture.deltaBytes + event.bytes,
        );
        break;
      case "completed":
        capture.completed = boundedIncrement(capture.completed);
        capture.markerMatched ||= event.text.trim() === this.marker;
        break;
      case "omitted":
        capture.omitted = boundedIncrement(capture.omitted);
        break;
    }

    const key = `${event.itemId}\0${event.kind}`;
    const existing = capture.identities.get(key);
    if (existing) {
      existing.count = boundedIncrement(existing.count);
    } else if (capture.identities.size < maxEventIdentitiesPerTurn) {
      capture.identities.set(key, {
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        kind: event.kind,
        count: 1,
      });
    }
  }

  snapshot() {
    const target = this.turnId ? this.turns.get(this.turnId) : undefined;
    const otherTurns = [...this.turns.entries()]
      .filter(([turnId]) => turnId !== this.turnId)
      .map(([turnId, capture]) => ({
        turnId,
        started: capture.started,
        deltas: capture.deltas,
        completed: capture.completed,
        omitted: capture.omitted,
        identities: [...capture.identities.values()],
      }));

    return {
      targetTurn: target
        ? {
            started: target.started,
            deltas: target.deltas,
            deltaBytes: target.deltaBytes,
            completed: target.completed,
            omitted: target.omitted,
            markerMatched: target.markerMatched,
            identities: [...target.identities.values()],
          }
        : null,
      otherTurns,
      droppedTurnEvents: this.droppedTurnEvents,
    };
  }
}
