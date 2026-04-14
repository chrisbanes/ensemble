import { describe, expect, it } from "vitest";
import {
  buildTranscriptEntries,
  groupTranscriptEntries,
  type TranscriptSource,
} from "./transcript-model";

describe("buildTranscriptEntries", () => {
  it("merges messages, interaction items, and timeline events into one ordered stream", () => {
    const source: TranscriptSource = {
      conversation: [
        {
          index: 10,
          role: "assistant",
          content: "I need the API key.",
          tool_calls: null,
        },
      ],
      interaction: {
        id: "ask-1",
        status: "pending",
        question: "What API key should I use?",
        why_blocked: "Deployment requires credentials",
        suggested_answer: "Use staging key",
        extra_context: null,
        step_name: "deploy",
        requested_at: "2026-04-14T10:00:02Z",
        resolved_at: null,
      },
      events: [
        {
          type: "step_started",
          timestamp: "2026-04-14T10:00:00Z",
          detail: "Started deploy",
          stepName: "deploy",
          runId: "run-1",
          sequence: 1,
        },
        {
          type: "verdict",
          timestamp: "2026-04-14T10:00:04Z",
          detail: "approved",
          verdict: "pass",
          stepName: "deploy",
          runId: "run-1",
          sequence: 4,
        },
      ],
    };

    const entries = buildTranscriptEntries(source);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "step_event",
      "agent_question",
      "agent_message",
      "verdict",
    ]);
  });

  it("collapses adjacent low-level activity into one grouped entry", () => {
    const source: TranscriptSource = {
      conversation: [],
      interaction: null,
      events: [
        {
          type: "tool_call",
          timestamp: "2026-04-14T10:00:00Z",
          detail: "rg src",
          runId: "run-1",
          sequence: 1,
        },
        {
          type: "output",
          timestamp: "2026-04-14T10:00:01Z",
          detail: "match 1",
          runId: "run-1",
          sequence: 2,
        },
        {
          type: "output",
          timestamp: "2026-04-14T10:00:02Z",
          detail: "match 2",
          runId: "run-1",
          sequence: 3,
        },
      ],
    };

    const entries = groupTranscriptEntries(buildTranscriptEntries(source));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "tool_activity_group",
      defaultExpanded: false,
      count: 3,
    });
  });
});
