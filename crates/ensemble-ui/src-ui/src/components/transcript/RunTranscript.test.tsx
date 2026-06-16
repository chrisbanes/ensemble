import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunTranscript } from "./RunTranscript";
import type { GroupedTranscriptEntry } from "./transcript-model";

const humanMessageRender = vi.hoisted(() => ({
  fn: vi.fn(
    ({
      entry,
      isActive,
    }: {
      entry: GroupedTranscriptEntry & { kind: "human_message"; message: string };
      isActive: boolean;
    }) => (
      <div data-testid={`human-message:${entry.id}`} data-active={String(isActive)}>
        {entry.message}
      </div>
    ),
  ),
}));

vi.mock("./entries/HumanMessageEntry", () => ({
  HumanMessageEntry: (props: Parameters<typeof humanMessageRender.fn>[0]) => humanMessageRender.fn(props),
}));

function makeMessageEntry(index: number): GroupedTranscriptEntry {
  return {
    kind: "human_message",
    id: `message:${index}`,
    timestamp: `2026-04-14T10:00:${String(index).padStart(2, "0")}Z`,
    message: `message ${index}`,
  };
}

describe("RunTranscript", () => {
  beforeEach(() => {
    humanMessageRender.fn.mockClear();
  });

  it("renders only the newest batch initially and reveals older entries on demand", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));

    render(
      <RunTranscript
        entries={entries}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="session-1"
      />,
    );

    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
    expect(screen.getByText("message 55")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });

  it("renders all entries immediately when the transcript is smaller than the initial batch", () => {
    const entries = Array.from({ length: 3 }, (_, index) => makeMessageEntry(index + 1));

    render(
      <RunTranscript
        entries={entries}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="session-1"
      />,
    );

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });

  it("expands hidden history to keep an active entry visible", () => {
    const entries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));

    render(
      <RunTranscript
        entries={entries}
        activeEntryId="message:5"
        onJumpToEntry={() => {}}
        transcriptSessionKey="session-1"
      />,
    );

    expect(screen.getByText("message 5")).toBeInTheDocument();
    expect(screen.getByTestId("human-message:message:5")).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
  });

  it("resets the visible history window when the transcript session changes", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));

    const { rerender } = render(
      <RunTranscript
        entries={entries}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="session-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load older activity" }));

    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
    expect(screen.getByText("message 1")).toBeInTheDocument();

    rerender(
      <RunTranscript
        entries={entries}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="session-2"
      />,
    );

    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
  });

  it("reuses rendered rows when new entries append", () => {
    const initialEntries = Array.from({ length: 3 }, (_, index) => makeMessageEntry(index + 1));
    const appendedEntries = [...initialEntries, makeMessageEntry(4)];
    const onJumpToEntry = vi.fn();

    const { rerender } = render(
      <RunTranscript
        entries={initialEntries}
        activeEntryId={null}
        onJumpToEntry={onJumpToEntry}
        transcriptSessionKey="session-1"
      />,
    );

    expect(humanMessageRender.fn).toHaveBeenCalledTimes(3);

    rerender(
      <RunTranscript
        entries={appendedEntries}
        activeEntryId={null}
        onJumpToEntry={onJumpToEntry}
        transcriptSessionKey="session-1"
      />,
    );

    expect(screen.getByText("message 4")).toBeInTheDocument();
    expect(humanMessageRender.fn).toHaveBeenCalledTimes(4);
  });

  it("renders tool activity entries with an icon", () => {
    const entries: GroupedTranscriptEntry[] = [
      {
        kind: "tool_activity",
        id: "tool-1",
        timestamp: "2026-04-14T10:00:00Z",
        event: {
          type: "tool_call",
          timestamp: "2026-04-14T10:00:00Z",
          detail: "Tool call call_123 completed",
        },
      },
      {
        kind: "tool_activity_group",
        id: "tool-group-1",
        timestamp: "2026-04-14T10:00:01Z",
        count: 2,
        defaultExpanded: false,
        entries: [
          {
            kind: "tool_activity",
            id: "tool-2",
            timestamp: "2026-04-14T10:00:01Z",
            event: {
              type: "tool_call",
              timestamp: "2026-04-14T10:00:01Z",
              detail: "Tool call call_456 completed",
            },
          },
        ],
      },
    ];

    render(
      <RunTranscript
        entries={entries}
        activeEntryId={null}
        onJumpToEntry={() => {}}
        transcriptSessionKey="session-1"
      />,
    );

    expect(screen.getAllByTestId("tool-activity-icon")).toHaveLength(2);
  });
});
