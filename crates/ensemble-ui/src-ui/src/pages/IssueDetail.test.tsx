import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import type { GroupedTranscriptEntry } from "@/components/transcript/transcript-model";

describe("RunTranscript", () => {
  it("renders an agent question and grouped low-level summary entries", () => {
    const entries: GroupedTranscriptEntry[] = [
      {
        kind: "agent_question",
        id: "interaction:ask-1",
        timestamp: "2026-04-14T10:00:00Z",
        interaction: {
          id: "ask-1",
          status: "pending",
          question: "Which environment should I deploy to?",
          why_blocked: "Needs a deployment target",
          suggested_answer: "Use staging",
          extra_context: null,
          step_name: "deploy",
          requested_at: "2026-04-14T10:00:00Z",
          resolved_at: null,
        },
      },
      {
        kind: "tool_activity_group",
        id: "tool-group:event:run-1:1:tool_call:2",
        timestamp: "2026-04-14T10:00:01Z",
        count: 2,
        defaultExpanded: false,
        entries: [
          {
            kind: "tool_activity",
            id: "event:run-1:1:tool_call",
            timestamp: "2026-04-14T10:00:01Z",
            event: {
              type: "tool_call",
              timestamp: "2026-04-14T10:00:01Z",
              detail: "rg src",
              runId: "run-1",
              sequence: 1,
            },
          },
          {
            kind: "tool_activity",
            id: "event:run-1:2:output",
            timestamp: "2026-04-14T10:00:02Z",
            event: {
              type: "output",
              timestamp: "2026-04-14T10:00:02Z",
              detail: "match found",
              runId: "run-1",
              sequence: 2,
            },
          },
        ],
      },
    ];

    render(<RunTranscript entries={entries} activeEntryId={null} onJumpToEntry={() => {}} />);

    expect(screen.getByText("Which environment should I deploy to?")).toBeInTheDocument();
    expect(screen.getByText("2 low-level activities")).toBeInTheDocument();
  });
});
