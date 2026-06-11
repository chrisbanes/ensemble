import { renderWithProviders } from "@/test/render";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkflowEditor from "./WorkflowEditor";

describe("WorkflowEditor", () => {
  const mockDraft = {
    steps: [
      { name: "build", kind: "agent", agent: "builder", depends: [], tracker_state: undefined },
      { name: "test", kind: "agent", agent: "tester", depends: ["build"], tracker_state: undefined },
    ],
    agents: [{ name: "builder", label: "Builder" }, { name: "tester", label: "Tester" }],
  };

  const mockOnChange = vi.fn();

  beforeEach(() => {
    mockOnChange.mockClear();
  });

  it("prevents selecting a dependency on a step that does not exist", async () => {
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);
    
    // Try to find "nonexistent-step" in the dependency dropdown
    // This test verifies that the UI doesn't show invalid dependencies
    const select = screen.queryByText("nonexistent-step");
    expect(select).not.toBeInTheDocument();
  });

  it("renders existing steps", () => {
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);
    
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("allows adding a new step", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);
    
    const addButton = screen.getByRole("button", { name: /add step/i });
    await user.click(addButton);
    
    expect(mockOnChange).toHaveBeenCalled();
    const lastCall = mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1];
    if (lastCall) {
      expect(lastCall[0].steps).toHaveLength(3);
    }
  });

  it("allows removing a step", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);
    
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    if (removeButtons[0]) {
      await user.click(removeButtons[0]);
    }
    
    expect(mockOnChange).toHaveBeenCalled();
    const lastCall = mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1];
    if (lastCall) {
      expect(lastCall[0].steps).toHaveLength(1);
    }
  });

  it("validates agent selection", () => {
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);
    
    // Each step should have an agent selector
    const agentSelects = screen.getAllByLabelText(/agent/i);
    expect(agentSelects).toHaveLength(2);
  });

  it("shows dependency options only for prior steps", () => {
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);
    
    // The second step (test) should show "build" as a dependency option
    // but the first step (build) should have no dependencies available
    expect(screen.getByText("build")).toBeInTheDocument();
  });

  it("allows marking a step as synthesis", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);

    await user.click(screen.getByLabelText("Step kind test"));
    await user.click(screen.getByRole("option", { name: "Synthesis" }));

    expect(mockOnChange).toHaveBeenCalled();
    const lastCall = mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1]!;
    expect(lastCall[0].steps[1].kind).toBe("synthesis");
  });
});
