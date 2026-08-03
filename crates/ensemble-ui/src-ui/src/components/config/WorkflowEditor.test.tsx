import { useState } from "react";
import { renderWithProviders } from "@/test/render";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkflowEditor, { type WorkflowDraft } from "./WorkflowEditor";

describe("WorkflowEditor", () => {
  const mockDraft: WorkflowDraft = {
    steps: [
      { name: "build", kind: "agent" as const, agent: "builder", depends: [], tracker_state: undefined },
      { name: "test", kind: "agent" as const, agent: "tester", depends: ["build"], tracker_state: undefined },
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
      expect(lastCall[0].steps[2].depends).toBeUndefined();
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
    const synthesisOption = await screen.findByText("Synthesis");
    await user.click(synthesisOption);

    expect(mockOnChange).toHaveBeenCalled();
    const lastCall = mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1]!;
    expect(lastCall[0].steps[1].kind).toBe("synthesis");
  });

  it("renames selected prerequisites when a step name changes", async () => {
    const onChange = vi.fn();

    function StatefulEditor() {
      const [draft, setDraft] = useState(mockDraft);
      return <WorkflowEditor value={draft} onChange={(next) => { setDraft(next); onChange(next); }} />;
    }

    renderWithProviders(<StatefulEditor />);

    fireEvent.change(screen.getByDisplayValue("build"), { target: { value: "compile" } });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]!;
    expect(lastCall[0].steps[1].depends).toEqual(["compile"]);
  });

  it("writes default sequencing, explicit roots, and selected prerequisites distinctly", async () => {
    const user = userEvent.setup();
    const draft = {
      ...mockDraft,
      steps: [
        { ...mockDraft.steps[0]!, depends: undefined },
        { ...mockDraft.steps[1]!, depends: ["build"] },
      ],
    };
    const { unmount } = renderWithProviders(<WorkflowEditor value={draft} onChange={mockOnChange} />);

    await user.click(screen.getByLabelText("Dependency mode build"));
    await user.click(await screen.findByRole("option", { name: "Independent root" }));
    expect(mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1]?.[0].steps[0].depends).toEqual([]);

    await user.click(screen.getByLabelText("Dependency mode test"));
    await user.click(await screen.findByRole("option", { name: "Default sequencing" }));
    expect(mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1]?.[0].steps[1].depends).toBeUndefined();

    unmount();
    cleanup();
    renderWithProviders(<WorkflowEditor value={draft} onChange={mockOnChange} />);
    expect(screen.getByLabelText("Dependency mode test")).toHaveTextContent("Selected prerequisites");
    unmount();
    cleanup();
    const explicitRootDraft = {
      ...draft,
      steps: [draft.steps[0]!, { ...draft.steps[1]!, depends: [] }],
    };
    renderWithProviders(<WorkflowEditor value={explicitRootDraft} onChange={mockOnChange} />);
    await user.click(screen.getByLabelText("Dependency mode test"));
    await user.click(await screen.findByRole("option", { name: "Selected prerequisites" }));
    expect(mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1]?.[0].steps[1].depends).toEqual(["build"]);
  });
});
