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

    render(<RunTranscript entries={entries} activeEntryId={null} onJumpToEntry={() => {}} />);

    expect(screen.queryByText("message 1")).not.toBeInTheDocument();
    expect(screen.getByText("message 55")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });

  it("renders all entries immediately when the transcript is smaller than the initial batch", () => {
    const entries = Array.from({ length: 3 }, (_, index) => makeMessageEntry(index + 1));

    render(<RunTranscript entries={entries} activeEntryId={null} onJumpToEntry={() => {}} />);

    expect(screen.getByText("message 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older activity" })).not.toBeInTheDocument();
  });

  it("expands hidden history to keep an active entry visible", () => {
    const entries = Array.from({ length: 55 }, (_, index) => makeMessageEntry(index + 1));

    render(<RunTranscript entries={entries} activeEntryId="message:5" onJumpToEntry={() => {}} />);

    expect(screen.getByText("message 5")).toBeInTheDocument();
    expect(screen.getByTestId("human-message:message:5")).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "Load older activity" })).toBeInTheDocument();
  });

  it("reuses rendered rows when new entries append", () => {
    const initialEntries = Array.from({ length: 3 }, (_, index) => makeMessageEntry(index + 1));
    const appendedEntries = [...initialEntries, makeMessageEntry(4)];
    const onJumpToEntry = vi.fn();

    const { rerender } = render(
      <RunTranscript entries={initialEntries} activeEntryId={null} onJumpToEntry={onJumpToEntry} />,
    );

    expect(humanMessageRender.fn).toHaveBeenCalledTimes(3);

    rerender(<RunTranscript entries={appendedEntries} activeEntryId={null} onJumpToEntry={onJumpToEntry} />);

    expect(screen.getByText("message 4")).toBeInTheDocument();
    expect(humanMessageRender.fn).toHaveBeenCalledTimes(4);
  });
});
