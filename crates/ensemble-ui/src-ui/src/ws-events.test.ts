import { describe, expect, it } from "vitest";

import { isCompletionEvent, normalizePipelineEvent } from "./ws-events";

describe("normalizePipelineEvent", () => {
  it("maps turn_completed events into timeline events", () => {
    const event = {
      event_type: "turn_completed" as const,
      timestamp: "2026-03-30T15:00:00Z",
      detail: "Turn 3 complete",
      turn: 3,
      conversation_index: 12,
      tokens_delta: { input: 10, output: 20 },
    };

    expect(normalizePipelineEvent(event)).toEqual({
      type: "turn_completed",
      timestamp: "2026-03-30T15:00:00Z",
      detail: "Turn 3 complete",
      conversationIndex: 12,
    });
  });

  it("maps complete events into a timeline-friendly shape", () => {
    const event = {
      event_type: "complete" as const,
      timestamp: "2026-03-30T16:00:00Z",
      outcome: "succeeded",
    };

    expect(normalizePipelineEvent(event)).toEqual({
      type: "complete",
      timestamp: "2026-03-30T16:00:00Z",
      detail: "Run succeeded",
    });
    expect(isCompletionEvent(event)).toBe(true);
  });
});
