import { describe, expect, it } from "vitest";
import {
  buildTranscriptEntries,
  groupTranscriptEntries,
  reconcileGroupedTranscriptEntries,
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
      interactions: [
        {
          agent_name: "builder",
          id: "ask-1",
          issue_id: "issue-1",
          issue_identifier: "todo-1",
          status: "pending",
          question: "What API key should I use?",
          why_blocked: "Deployment requires credentials",
          suggested_answer: "Use staging key",
          extra_context: null,
          step_name: "deploy",
          requested_at: "2026-04-14T10:00:02Z",
        },
      ],
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

  it("classifies user conversation messages as human messages", () => {
    const source: TranscriptSource = {
      conversation: [
        {
          index: 1,
          role: "user",
          content: "Can you wait before deploying?",
          tool_calls: null,
        },
      ],
      interactions: [],
      events: [],
    };

    const entries = buildTranscriptEntries(source);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "human_message",
      message: "Can you wait before deploying?",
    });
  });

  it("maps transcript records into agent and tool activity entries", () => {
    const entries = buildTranscriptEntries({
      conversation: [],
      transcriptRecords: [
        {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "repo#1",
          step_name: "build",
          attempt: 1,
          sequence: 1,
          timestamp: "2026-06-14T00:00:00Z",
          kind: "assistant_message",
          payload: { text: "hello" },
        },
        {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "repo#1",
          step_name: "build",
          attempt: 1,
          sequence: 2,
          timestamp: "2026-06-14T00:00:01Z",
          kind: "tool_call",
          payload: { name: "read_file", arguments: { path: "Cargo.toml" } },
        },
      ],
      interactions: [],
      events: [],
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent_message" }),
        expect.objectContaining({ kind: "tool_activity" }),
      ]),
    );
  });

  it("formats sparse tool-call transcript payloads as readable activity", () => {
    const entries = buildTranscriptEntries({
      conversation: [],
      transcriptRecords: [
        {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "repo#1",
          step_name: "build",
          attempt: 1,
          sequence: 1,
          timestamp: "2026-06-14T00:00:00Z",
          kind: "tool_call",
          payload: {
            arguments: null,
            name: null,
            status: "completed",
            title: null,
            tool_call_id: "call_MW2une4H5kusBk7wSwUglCyS",
          },
        },
      ],
      interactions: [],
      events: [],
    });

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "tool_activity",
        event: expect.objectContaining({
          detail: "Tool call call_MW2une4H5kusBk7wSwUglCyS completed",
        }),
      }),
    ]);
  });

  it("maps non-message transcript records into visible entries", () => {
    const entries = buildTranscriptEntries({
      conversation: [],
      transcriptRecords: [
        {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "repo#1",
          step_name: "build",
          attempt: 1,
          sequence: 1,
          timestamp: "2026-06-14T00:00:00Z",
          kind: "error",
          payload: { text: "tool failed" },
        },
        {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "repo#1",
          step_name: "build",
          attempt: 1,
          sequence: 2,
          timestamp: "2026-06-14T00:00:01Z",
          kind: "permission_request",
          payload: { text: "May I write files?" },
        },
        {
          schema_version: 1,
          run_id: "run-1",
          issue_identifier: "repo#1",
          step_name: "build",
          attempt: 1,
          sequence: 3,
          timestamp: "2026-06-14T00:00:02Z",
          kind: "turn_complete",
          payload: { text: "turn finished" },
        },
      ],
      interactions: [],
      events: [],
    });

    expect(entries).toEqual([
      expect.objectContaining({ kind: "error", message: "tool failed" }),
      expect.objectContaining({
        kind: "tool_activity",
        event: expect.objectContaining({
          type: "permission_request",
          detail: "May I write files?",
        }),
      }),
      expect.objectContaining({
        kind: "workflow_event",
        event: expect.objectContaining({
          type: "turn_complete",
          detail: "turn finished",
        }),
      }),
    ]);
  });

  it("classifies workflow and error events distinctly", () => {
    const source: TranscriptSource = {
      conversation: [],
      interactions: [],
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
          type: "question_asked",
          timestamp: "2026-04-14T10:00:01Z",
          detail: "Need confirmation",
          stepName: "deploy",
          runId: "run-1",
          sequence: 2,
        },
        {
          type: "human_reply_submitted",
          timestamp: "2026-04-14T10:00:02Z",
          detail: "Use staging",
          stepName: "deploy",
          runId: "run-1",
          sequence: 3,
        },
        {
          type: "error",
          timestamp: "2026-04-14T10:00:03Z",
          detail: "Agent crashed",
          runId: "run-1",
          sequence: 4,
        },
      ],
    };

    const entries = buildTranscriptEntries(source);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "step_event",
      "workflow_event",
      "human_reply",
      "error",
    ]);
  });

  it("handles multiple interaction items in timestamp order", () => {
    const source: TranscriptSource = {
      conversation: [],
      interactions: [
        {
          agent_name: "builder",
          id: "ask-2",
          issue_id: "issue-1",
          issue_identifier: "todo-1",
          status: "pending",
          question: "Second question",
          why_blocked: "Need approval",
          suggested_answer: null,
          extra_context: null,
          step_name: "deploy",
          requested_at: "2026-04-14T10:00:03Z",
        },
        {
          agent_name: "builder",
          id: "ask-1",
          issue_id: "issue-1",
          issue_identifier: "todo-1",
          status: "pending",
          question: "First question",
          why_blocked: "Need credentials",
          suggested_answer: null,
          extra_context: null,
          step_name: "deploy",
          requested_at: "2026-04-14T10:00:01Z",
        },
      ],
      events: [],
    };

    const entries = buildTranscriptEntries(source);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "agent_question",
      "agent_question",
    ]);
    expect(entries[0]?.kind === "agent_question" && entries[0].interaction.id).toBe("ask-1");
    expect(entries[1]?.kind === "agent_question" && entries[1].interaction.id).toBe("ask-2");
  });

  it("keeps untimestamped conversation messages in numeric index order", () => {
    const source: TranscriptSource = {
      conversation: [
        {
          index: 10,
          role: "assistant",
          content: "Tenth message",
          tool_calls: null,
        },
        {
          index: 2,
          role: "assistant",
          content: "Second message",
          tool_calls: null,
        },
      ],
      interactions: [],
      events: [],
    };

    const entries = buildTranscriptEntries(source);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "agent_message",
      "agent_message",
    ]);
    expect(entries[0]?.kind === "agent_message" && entries[0].message.index).toBe(2);
    expect(entries[1]?.kind === "agent_message" && entries[1].message.index).toBe(10);
  });

  it("collapses adjacent low-level activity into one grouped entry", () => {
    const source: TranscriptSource = {
      conversation: [],
      interactions: [],
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

  it("reuses unchanged transcript entries and grouped entries across append-only updates", () => {
    const first = reconcileGroupedTranscriptEntries(undefined, {
      conversation: [
        {
          index: 1,
          role: "assistant",
          content: "I have started.",
          tool_calls: null,
        },
      ],
      interactions: [],
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
      ],
    });

    const second = reconcileGroupedTranscriptEntries(first, {
      conversation: [
        {
          index: 1,
          role: "assistant",
          content: "I have started.",
          tool_calls: null,
        },
        {
          index: 2,
          role: "user",
          content: "Please keep going.",
          tool_calls: null,
        },
      ],
      interactions: [],
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
      ],
    });

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[1]);
    expect(second[0]).toMatchObject({
      kind: "tool_activity_group",
      count: 2,
    });
  });

  it("replaces a grouped entry when its semantic payload changes", () => {
    const first = reconcileGroupedTranscriptEntries(undefined, {
      conversation: [],
      interactions: [],
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
      ],
    });

    const second = reconcileGroupedTranscriptEntries(first, {
      conversation: [],
      interactions: [],
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
          detail: "match 2",
          runId: "run-1",
          sequence: 2,
        },
      ],
    });

    expect(second[0]).not.toBe(first[0]);
  });
});
