import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import YamlEditor from "./YamlEditor";
import { ValidationIssueKind } from "@/generated/models/validationIssueKind";
import { renderWithProviders } from "@/test/render";

describe("YamlEditor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows YAML recovery mode for syntax errors", async () => {
    const rawYaml = `tracker:
  kind: github
  repository: owner/repo
  project_number: not_a_number`;

    renderWithProviders(
      <YamlEditor 
        rawYaml={rawYaml} 
        isRecoveryMode={true}
        issues={[
          { kind: "Syntax", section: "tracker", message: "project_number must be a number", field: "project_number", path: null },
        ]}
      />,
      { route: "/config" }
    );
    
    // Should show recovery mode title
    expect(screen.getByText(/YAML Recovery Editor/i)).toBeInTheDocument();
    
    // Validation panel should show the error
    expect(screen.getByText(/project_number must be a number/i)).toBeInTheDocument();
    
    // Validate, Save, and Reset buttons should be present
    expect(screen.getByRole("button", { name: /validate/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
  });

  it("renders in normal mode without recovery UI", async () => {
    const rawYaml = `tracker:
  kind: todo_file
  path: /tmp/todo.md`;

    renderWithProviders(
      <YamlEditor 
        rawYaml={rawYaml} 
        isRecoveryMode={false}
        issues={[]}
      />,
      { route: "/config" }
    );

    // Should show normal editor title
    expect(screen.getByText(/Raw YAML Editor/i)).toBeInTheDocument();
    
    // Buttons should be present
    expect(screen.getByRole("button", { name: /validate/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("shows validation issues returned by validate without waiting for save", async () => {
    const user = userEvent.setup();
    const rawYaml = `tracker:\n  kind: todo_file\n  path: /tmp/todo.md`;

    renderWithProviders(
      <YamlEditor
        rawYaml={rawYaml}
        issues={[]}
        onValidate={vi.fn(async () => [
          {
            kind: ValidationIssueKind.Config,
            section: "tracker",
            message: "tracker path is invalid",
            field: "path",
            path: "tracker.path",
          },
        ])}
      />,
      { route: "/config" }
    );

    await user.click(screen.getByRole("button", { name: /validate/i }));

    expect(await screen.findByText(/tracker path is invalid/i)).toBeInTheDocument();
  });

  it("keeps existing issues visible when validate fails", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <YamlEditor
        rawYaml={`tracker:\n  kind: todo_file\n  path: /tmp/todo.md`}
        issues={[
          {
            kind: ValidationIssueKind.Config,
            section: "tracker",
            message: "existing issue",
            field: "path",
            path: "tracker.path",
          },
        ]}
        onValidate={vi.fn(async () => {
          throw new Error("validation failed");
        })}
      />,
      { route: "/config" }
    );

    await user.click(screen.getByRole("button", { name: /validate/i }));

    expect(await screen.findByText(/existing issue/i)).toBeInTheDocument();
  });
});
