import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import StepDetail from "./StepDetail";

const hooksMock = vi.hoisted(() => ({
  useStepDetailQuery: vi.fn(() => ({
    data: {
      issue_identifier: "todo-1",
      issue_id: "NODE_1",
      run_id: "run-1",
      step_name: "deploy",
      status: "passed",
      agent: "builder",
      dependencies: ["build"],
      can_navigate: true,
      verdict: null,
      transcript: {
        step_name: "deploy",
        run_id: "run-1",
        record_count: 2,
      },
      recent_events: [],
    },
    isLoading: false,
    isError: false,
    error: null,
  })),
}));

vi.mock("@/hooks", () => hooksMock);
vi.mock("@/components/ConversationViewer", () => ({
  default: ({
    identifier,
    runId,
    stepName,
  }: {
    identifier: string;
    runId: string;
    stepName: string;
  }) => (
    <div data-testid="conversation-viewer">
      {identifier} {runId} {stepName}
    </div>
  ),
}));

function renderStepDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/issue/:identifier/step/:stepName" element={<StepDetail />} />
    </Routes>,
    { route: "/issue/todo-1/step/deploy" },
  );
}

describe("StepDetail", () => {
  it("renders the transcript viewer when transcript metadata is available", () => {
    renderStepDetail();

    expect(screen.getByRole("heading", { name: "deploy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByTestId("conversation-viewer")).toHaveTextContent(
      "todo-1 run-1 deploy",
    );
  });

  it("renders an empty state when no transcript was recorded", () => {
    hooksMock.useStepDetailQuery.mockReturnValueOnce({
      data: {
        issue_identifier: "todo-1",
        issue_id: "NODE_1",
        run_id: "run-1",
        step_name: "deploy",
        status: "passed",
        agent: "builder",
        dependencies: [],
        can_navigate: true,
        verdict: null,
        transcript: null,
        recent_events: [],
      } as any,
      isLoading: false,
      isError: false,
      error: null,
    });

    renderStepDetail();

    expect(screen.queryByTestId("conversation-viewer")).not.toBeInTheDocument();
    expect(screen.getByText("No transcript recorded for this step yet.")).toBeInTheDocument();
  });
});
