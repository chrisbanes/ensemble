import { describe, expect, it } from "vitest";
import { aggregateOutputEvents } from "./EventTimeline";
import type { WsEventData } from "@/ws-types";

function makeEvent(overrides: Partial<WsEventData> = {}): WsEventData {
  return {
    type: "output",
    timestamp: "2026-04-11T10:00:00Z",
    detail: "",
    ...overrides,
  };
}

describe("aggregateOutputEvents", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateOutputEvents([])).toEqual([]);
  });

  it("passes through non-output events unchanged", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "step_started", detail: "Starting build" }),
      makeEvent({ type: "step_completed", detail: "Build done" }),
    ];
    const result = aggregateOutputEvents(events);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("step_started");
    expect(result[1]!.type).toBe("step_completed");
  });

  it("aggregates consecutive output events into one", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "output", detail: "Hello" }),
      makeEvent({ type: "output", detail: " " }),
      makeEvent({ type: "output", detail: "World" }),
    ];
    const result = aggregateOutputEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0]!.detail).toBe("Hello World");
    expect(result[0]!.aggregatedCount).toBe(3);
  });

  it("shows no badge for single output event", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "output", detail: "Hello" }),
    ];
    const result = aggregateOutputEvents(events);
    expect(result[0]!.aggregatedCount).toBeUndefined();
  });

  it("alternating output and non-output events are not aggregated", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "output", detail: "A" }),
      makeEvent({ type: "step_started", detail: "Next" }),
      makeEvent({ type: "output", detail: "B" }),
    ];
    const result = aggregateOutputEvents(events);
    expect(result).toHaveLength(3);
    expect(result[0]!.detail).toBe("A");
    expect(result[1]!.type).toBe("step_started");
    expect(result[2]!.detail).toBe("B");
  });

  it("flushes output buffer at end of events", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "step_started", detail: "Start" }),
      makeEvent({ type: "output", detail: "One" }),
      makeEvent({ type: "output", detail: "Two" }),
    ];
    const result = aggregateOutputEvents(events);
    expect(result).toHaveLength(2);
    expect(result[1]!.detail).toBe("OneTwo");
    expect(result[1]!.aggregatedCount).toBe(2);
  });

  it("preserves other properties when aggregating", () => {
    const events: WsEventData[] = [
      makeEvent({
        type: "output",
        detail: "Hello",
        stepName: "build",
        attempt: 2,
        runId: "run-123",
      }),
    ];
    const result = aggregateOutputEvents(events);
    expect(result[0]!.stepName).toBe("build");
    expect(result[0]!.attempt).toBe(2);
    expect(result[0]!.runId).toBe("run-123");
  });

  it("does not aggregate output events across step boundaries", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "output", detail: "A", stepName: "build", attempt: 1, runId: "run-1" }),
      makeEvent({ type: "output", detail: "B", stepName: "review", attempt: 1, runId: "run-1" }),
    ];

    const result = aggregateOutputEvents(events);

    expect(result).toHaveLength(2);
    expect(result[0]!.detail).toBe("A");
    expect(result[1]!.detail).toBe("B");
  });

  it("does not aggregate output events across attempt boundaries", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "output", detail: "A", stepName: "build", attempt: 1, runId: "run-1" }),
      makeEvent({ type: "output", detail: "B", stepName: "build", attempt: 2, runId: "run-1" }),
    ];

    const result = aggregateOutputEvents(events);

    expect(result).toHaveLength(2);
  });

  it("does not aggregate output events across run boundaries", () => {
    const events: WsEventData[] = [
      makeEvent({ type: "output", detail: "A", stepName: "build", attempt: 1, runId: "run-1" }),
      makeEvent({ type: "output", detail: "B", stepName: "build", attempt: 1, runId: "run-2" }),
    ];

    const result = aggregateOutputEvents(events);

    expect(result).toHaveLength(2);
  });
});
