import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import WorkflowStepsSidebar from "./WorkflowStepsSidebar";

describe("WorkflowStepsSidebar", () => {
  it("renders skipped work as a distinct terminal state", () => {
    render(
      <MemoryRouter>
        <WorkflowStepsSidebar
          issueIdentifier="ensemble#423"
          steps={[
            {
              name: "escalate",
              agent: "adjudicator",
              kind: "agent",
              dependencies: ["choose_review_path"],
              state: "skipped",
              can_navigate: false,
              capabilities: { inspect: { enabled: false, disabled_reason: "Skipped by route." } },
              route_provenance: [
                { route_step: "choose_review_path", source_step: "compare", selected_case: "agreement" },
              ],
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("↷")).toBeInTheDocument();
    expect(screen.getByLabelText("escalate: Skipped by route.")).toBeInTheDocument();
    expect(screen.getByText("route: agreement")).toBeInTheDocument();
  });
});
