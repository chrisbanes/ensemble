import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RunTranscript } from "./RunTranscript";
import type { GroupedTranscriptEntry } from "./transcript-model";

function makeMessageEntry(index: number): GroupedTranscriptEntry {
  return {
    kind: "human_message",
    id: `message:${index}`,
    timestamp: `2026-04-14T10:00:${String(index).padStart(2, "0")}Z`,
    message: `message ${index}`,
  };
}

describe("RunTranscript", () => {
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
});
