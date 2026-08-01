import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GuidedEditor, { type GuidedForm } from "./GuidedEditor";
import { ValidationIssueKind } from "@/generated/models/validationIssueKind";
import { renderWithProviders } from "@/test/render";

const initialForm: GuidedForm = {
  tracker: {
    kind: "todo_file",
    path: "/tmp/todo.md",
    api_key: { state: "unset" },
    active_states: [],
    terminal_states: [],
    labels_filter: [],
  },
  repos: [],
  agents: [
    {
      name: "builder",
      acpx_agent: "claude",
      model: "sonnet",
      reasoning_level: "medium",
      prompt: "Build it",
      permission_mode: "approve_reads",
      available_models: [
        { id: "sonnet", name: "Sonnet" },
        { id: "opus", name: "Opus" },
      ],
      available_modes: [
        { id: "approve_reads", name: "Approve reads" },
        { id: "approve_all", name: "Approve all" },
      ],
    },
  ],
  steps: [{ name: "build", agent: "builder", depends: [] }],
  runtime: {
    max_cycles: 1,
    concurrency: { max_concurrent_agents: 1, max_step_parallelism: 1 },
    polling: { interval_ms: 1000 },
    workspace: {},
    hooks: { timeout_ms: 1000 },
    agent: {
      max_retry_backoff_ms: 1,
      command: "agent",
      session_mode: "code",
      permission_request_policy: { mode: "approve_all" },
      turn_timeout_ms: 1,
      read_timeout_ms: 1,
      stall_timeout_ms: 1,
    },
  },
  transitions: { on_success: "Done", on_failure: "Failed" },
};

describe("GuidedEditor", () => {
  it("preserves an existing secret by default without rendering a token", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_form: GuidedForm, _baseRawYaml: string) => undefined);
    const githubForm: GuidedForm = {
      ...initialForm,
      tracker: {
        kind: "github",
        repository: "acme/repo",
        api_key: { state: "redacted" },
        api_key_edit: { action: "preserve" },
        active_states: ["Todo"],
        terminal_states: ["Done"],
        labels_filter: [],
      },
    };

    renderWithProviders(
      <GuidedEditor
        initialForm={githubForm}
        baseRawYaml={"tracker:\n  kind: github\n  api_key: \"[REDACTED]\"\n"}
        issues={[]}
        onValidate={vi.fn(async () => [])}
        onSave={onSave}
        onReset={vi.fn()}
      />,
      { route: "/config" }
    );

    expect(screen.getByText(/existing secret is configured/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/ghp_/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/repository/i), "-updated");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave.mock.calls[0]?.[0].tracker.api_key_edit).toEqual({ action: "preserve" });
  });

  it("disables validation and save for a blank secret replacement", () => {
    const githubForm: GuidedForm = {
      ...initialForm,
      tracker: {
        kind: "github",
        repository: "acme/repo",
        api_key: { state: "redacted" },
        api_key_edit: { action: "set_literal", value: "" },
        active_states: ["Todo"],
        terminal_states: ["Done"],
        labels_filter: [],
      },
    };

    renderWithProviders(
      <GuidedEditor
        initialForm={githubForm}
        baseRawYaml={"tracker:\n  kind: github\n  api_key: \"[REDACTED]\"\n"}
        issues={[]}
        onValidate={vi.fn(async () => [])}
        onSave={vi.fn(async () => undefined)}
        onReset={vi.fn()}
      />,
      { route: "/config" }
    );

    expect(screen.getByText(/secret replacement must not be blank/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /validate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("disables validation and save for a malformed secret environment name", () => {
    const githubForm: GuidedForm = {
      ...initialForm,
      tracker: {
        kind: "github",
        repository: "acme/repo",
        api_key: { state: "environment", variable: "GITHUB_TOKEN" },
        api_key_edit: { action: "set_environment", variable: "FOO=BAR" },
        active_states: ["Todo"],
        terminal_states: ["Done"],
        labels_filter: [],
      },
    };

    renderWithProviders(
      <GuidedEditor
        initialForm={githubForm}
        baseRawYaml={"tracker:\n  kind: github\n  api_key: \"$GITHUB_TOKEN\"\n"}
        issues={[]}
        onValidate={vi.fn(async () => [])}
        onSave={vi.fn(async () => undefined)}
        onReset={vi.fn()}
      />,
      { route: "/config" }
    );

    expect(screen.getByText(/valid environment variable name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /validate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("shows validation issues returned by validate without waiting for save", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <GuidedEditor
        initialForm={initialForm}
        baseRawYaml={"tracker:\n  kind: todo_file\n"}
        issues={[]}
        onValidate={vi.fn(async () => [
          {
            kind: ValidationIssueKind.Config,
            section: "workflow",
            message: "step agent is invalid",
            field: "agent",
            path: "steps[0].agent",
          },
        ])}
        onSave={vi.fn(async () => undefined)}
        onReset={vi.fn()}
      />,
      { route: "/config" }
    );

    await user.click(screen.getByRole("button", { name: /validate/i }));

    expect(await screen.findByText(/step agent is invalid/i)).toBeInTheDocument();
  });

  it("saves inline agent model reasoning and mode edits", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_form: GuidedForm, _baseRawYaml: string) => undefined);

    renderWithProviders(
      <GuidedEditor
        initialForm={initialForm}
        baseRawYaml={"tracker:\n  kind: todo_file\n"}
        issues={[]}
        onValidate={vi.fn(async () => [])}
        onSave={onSave}
        onReset={vi.fn()}
      />,
      { route: "/config" }
    );

    await user.click(screen.getByLabelText("Model"));
    await user.click(await screen.findByRole("option", { name: "Opus" }));

    await user.click(screen.getByLabelText("Reasoning Level"));
    await user.click(await screen.findByRole("option", { name: "High" }));

    await user.click(screen.getByLabelText("Mode"));
    await user.click(await screen.findByRole("option", { name: "Approve all" }));

    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [
          expect.not.objectContaining({
            available_models: expect.anything(),
            available_modes: expect.anything(),
          }),
        ],
      }),
      "tracker:\n  kind: todo_file\n"
    );
    const savedForm = onSave.mock.calls[0]?.[0];
    expect(savedForm).toBeDefined();
    if (!savedForm) throw new Error("onSave should receive a form");
    const savedAgent = savedForm.agents[0];
    expect(savedAgent).toMatchObject({
      name: "builder",
      model: "opus",
      reasoning_level: "high",
      permission_mode: "approve_all",
    });
  });

  it("does not save unsupported existing permission modes", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_form: GuidedForm, _baseRawYaml: string) => undefined);
    const formWithUnsupportedMode: GuidedForm = {
      ...initialForm,
      agents: [
        {
          ...initialForm.agents[0]!,
          permission_mode: "plan",
          available_modes: [{ id: "plan", name: "Plan" }],
        },
      ],
    };

    renderWithProviders(
      <GuidedEditor
        initialForm={formWithUnsupportedMode}
        baseRawYaml={"tracker:\n  kind: todo_file\n"}
        issues={[]}
        onValidate={vi.fn(async () => [])}
        onSave={onSave}
        onReset={vi.fn()}
      />,
      { route: "/config" }
    );

    await user.click(screen.getByLabelText("Reasoning Level"));
    await user.click(await screen.findByRole("option", { name: "High" }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    const savedForm = onSave.mock.calls[0]?.[0];
    expect(savedForm).toBeDefined();
    if (!savedForm) throw new Error("onSave should receive a form");
    expect(savedForm.agents[0]!.permission_mode).toBeUndefined();
  });
});
