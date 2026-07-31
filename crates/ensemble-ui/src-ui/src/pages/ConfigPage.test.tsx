import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ValidationIssue } from "@/generated/models";
import { FetchError } from "@/fetch-client";
import ConfigPage from "./ConfigPage";
import { renderWithProviders } from "@/test/render";

let mockConfigData: any;
const validateGuidedMock = vi.fn();
const saveGuidedMock = vi.fn();
const validateYamlMock = vi.fn();
const saveYamlMock = vi.fn();
const refetchMock = vi.fn();
const restartMessage = "Configuration saved; restart Ensemble to apply it";

vi.mock("@/hooks", () => ({
  useConfigStateQuery: () => ({
    data: mockConfigData,
    isLoading: false,
    isError: false,
    refetch: refetchMock,
  }),
  useValidateGuidedFormMutation: () => ({
    mutateAsync: validateGuidedMock,
  }),
  useSaveGuidedFormMutation: () => ({
    mutateAsync: saveGuidedMock,
  }),
  useValidateYamlDraftMutation: () => ({
    mutateAsync: validateYamlMock,
  }),
  useSaveYamlDraftMutation: () => ({
    mutateAsync: saveYamlMock,
  }),
}));

vi.mock("@/components/config/SetupWizard", () => ({
  default: ({
    onComplete,
  }: {
    onComplete?: (completion?: { restartRequiredMessage?: string }) => void;
  }) => (
    <div>
      <div>Set up Ensemble</div>
      <button
        type="button"
        onClick={() => onComplete?.({ restartRequiredMessage: restartMessage })}
      >
        Complete setup with restart required
      </button>
    </div>
  ),
}));

vi.mock("@/components/config/GuidedEditor", () => ({
  default: ({
    initialForm,
    baseRawYaml,
    issues,
    onValidate,
    onSave,
  }: {
    initialForm: any;
    baseRawYaml: string;
    issues: ValidationIssue[];
    onValidate: (form: any, baseRawYaml: string) => Promise<ValidationIssue[]>;
    onSave: (form: any, baseRawYaml: string) => Promise<void>;
  }) => (
    <div>
      <div>Guided Configuration Editor</div>
      <button type="button" onClick={() => onValidate(initialForm, baseRawYaml)}>Validate Guided</button>
      <button type="button" onClick={() => onSave(initialForm, baseRawYaml)}>Save Guided</button>
      {issues.map((issue, index) => (
        <div key={index}>{issue.message}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/config/YamlEditor", () => ({
  default: ({
    rawYaml,
    issues,
    onValidate,
    onSave,
  }: {
    rawYaml: string;
    issues: ValidationIssue[];
    onValidate?: (yaml: string) => Promise<ValidationIssue[]>;
    onSave?: (yaml: string) => Promise<void>;
  }) => (
    <div>
      <div>Raw YAML Editor</div>
      <button type="button" onClick={() => onValidate?.(rawYaml)}>Validate</button>
      <button type="button" onClick={() => onSave?.(rawYaml)}>Save YAML</button>
      {issues.map((issue, index) => (
        <div key={index}>{issue.message}</div>
      ))}
    </div>
  ),
}));

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigData = undefined;
    refetchMock.mockResolvedValue(undefined);
  });

  it("shows setup mode when the config state is missing", async () => {
    mockConfigData = {
      state: "missing",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: null,
      issues: [],
      active_config: null,
      guided_form: null,
    };

    renderWithProviders(<ConfigPage />, { route: "/config" });

    expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();
  });

  it("keeps the editors available when parsed config has validation issues", async () => {
    mockConfigData = {
      state: "parsed",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: "tracker:\n  kind: todo_file\n",
      issues: [
        {
          kind: "Config",
          section: "tracker",
          message: "tracker is incomplete",
          field: null,
          path: null,
        },
      ],
      active_config: null,
      guided_form: {
        tracker: { kind: "todo_file", active_states: [], terminal_states: [], labels_filter: [] },
        repos: [],
        agents: [],
        steps: [],
        runtime: {
          max_cycles: 1,
          concurrency: { max_concurrent_agents: 1, max_step_parallelism: 1 },
          polling: { interval_ms: 1000 },
          workspace: {},
          hooks: { timeout_ms: 1000 },
          agent: {
            max_turns: 1,
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
      },
    };

    renderWithProviders(<ConfigPage />, { route: "/config" });

    expect(await screen.findByText(/guided configuration editor/i)).toBeInTheDocument();
    expect(screen.getAllByText(/tracker is incomplete/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^yaml$/i })).toBeInTheDocument();
  });

  it("updates the page banner from validate results", async () => {
    const user = userEvent.setup();
    mockConfigData = {
      state: "parsed",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: "tracker:\n  kind: todo_file\n",
      issues: [],
      active_config: {},
      guided_form: {
        tracker: { kind: "todo_file", active_states: [], terminal_states: [], labels_filter: [] },
        repos: [],
        agents: [],
        steps: [],
        runtime: {
          max_cycles: 1,
          concurrency: { max_concurrent_agents: 1, max_step_parallelism: 1 },
          polling: { interval_ms: 1000 },
          workspace: {},
          hooks: { timeout_ms: 1000 },
          agent: {
            max_turns: 1,
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
      },
    };

    validateYamlMock.mockResolvedValue({
      data: {
        issues: [
          {
            kind: "Config",
            section: "tracker",
            message: "tracker path is invalid",
            field: "path",
            path: "tracker.path",
          },
        ],
      },
    });

    renderWithProviders(<ConfigPage />, { route: "/config" });

    expect(screen.getByText(/configuration is valid and ready to use/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^yaml$/i }));
    await user.click(screen.getByRole("button", { name: /validate/i }));

    expect(await screen.findByText(/configuration has validation issues/i)).toBeInTheDocument();
    expect(screen.getAllByText(/tracker path is invalid/i).length).toBeGreaterThan(0);
  });

  it("does not send guided capability metadata or unsupported permission modes", async () => {
    const user = userEvent.setup();
    mockConfigData = {
      state: "parsed",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: "tracker:\n  kind: todo_file\n",
      issues: [],
      active_config: {},
      guided_form: {
        tracker: { kind: "todo_file", active_states: [], terminal_states: [], labels_filter: [] },
        repos: [],
        agents: [
          {
            name: "builder",
            acpx_agent: "claude",
            permission_mode: "plan",
            available_models: [{ id: "sonnet", name: "Sonnet" }],
            available_modes: [{ id: "plan", name: "Plan" }],
          },
        ],
        steps: [],
        runtime: {
          max_cycles: 1,
          concurrency: { max_concurrent_agents: 1, max_step_parallelism: 1 },
          polling: { interval_ms: 1000 },
          workspace: {},
          hooks: { timeout_ms: 1000 },
          agent: {
            max_turns: 1,
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
      },
    };
    validateGuidedMock.mockResolvedValue({ data: { issues: [] } });
    saveGuidedMock.mockResolvedValue({ data: {} });

    renderWithProviders(<ConfigPage />, { route: "/config" });

    await user.click(await screen.findByRole("button", { name: /validate guided/i }));
    await user.click(screen.getByRole("button", { name: /save guided/i }));

    const validatedAgent = validateGuidedMock.mock.calls[0]?.[0]?.form.agents[0];
    const savedAgent = saveGuidedMock.mock.calls[0]?.[0]?.form.agents[0];

    expect(validatedAgent).not.toHaveProperty("available_models");
    expect(validatedAgent).not.toHaveProperty("available_modes");
    expect(validatedAgent.permission_mode).toBeUndefined();
    expect(savedAgent).not.toHaveProperty("available_models");
    expect(savedAgent).not.toHaveProperty("available_modes");
    expect(savedAgent.permission_mode).toBeUndefined();
  });

  it("shows restart-required completion after a guided save persists with 409", async () => {
    const user = userEvent.setup();
    mockConfigData = parsedConfigData();
    saveGuidedMock.mockRejectedValue(restartRequiredError());

    renderWithProviders(<ConfigPage />, { route: "/config" });

    await user.click(await screen.findByRole("button", { name: /save guided/i }));

    expect(await screen.findByText("Restart Required")).toBeInTheDocument();
    expect(screen.getByText(/restart Ensemble to apply it/i)).toBeInTheDocument();
    expect(refetchMock).toHaveBeenCalled();
  });

  it("completes missing-config setup when the persisted save requires restart", async () => {
    const user = userEvent.setup();
    mockConfigData = {
      state: "missing",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: null,
      issues: [],
      active_config: null,
      guided_form: null,
    };

    renderWithProviders(<ConfigPage />, { route: "/config" });

    await user.click(
      await screen.findByRole("button", { name: /complete setup with restart required/i }),
    );

    expect(await screen.findByText("Restart Required")).toBeInTheDocument();
    expect(screen.getByText(restartMessage)).toBeInTheDocument();
    expect(screen.queryByText("Set up Ensemble")).not.toBeInTheDocument();
    expect(refetchMock).toHaveBeenCalled();
  });

  it("shows restart-required completion after a YAML save persists with 409", async () => {
    const user = userEvent.setup();
    mockConfigData = parsedConfigData();
    saveYamlMock.mockRejectedValue(restartRequiredError());

    renderWithProviders(<ConfigPage />, { route: "/config" });

    await user.click(await screen.findByRole("button", { name: /^yaml$/i }));
    await user.click(screen.getByRole("button", { name: /save yaml/i }));

    expect(await screen.findByText("Restart Required")).toBeInTheDocument();
    expect(screen.getByText(/restart Ensemble to apply it/i)).toBeInTheDocument();
    expect(refetchMock).toHaveBeenCalled();
  });
});

function parsedConfigData() {
  return {
    state: "parsed",
    config_path: "/tmp/ensemble/config.yaml",
    raw_yaml: "tracker:\n  kind: todo_file\n",
    issues: [],
    active_config: {},
    guided_form: {
      tracker: { kind: "todo_file", active_states: [], terminal_states: [], labels_filter: [] },
      repos: [],
      agents: [],
      steps: [],
      runtime: {
        max_cycles: 1,
        concurrency: { max_concurrent_agents: 1, max_step_parallelism: 1 },
        polling: { interval_ms: 1000 },
        workspace: {},
        hooks: { timeout_ms: 1000 },
        agent: {
          max_turns: 1,
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
    },
  };
}

function restartRequiredError() {
  return new FetchError(409, {
    state: "parsed",
    config_path: "/tmp/ensemble/config.yaml",
    raw_yaml: "tracker:\n  kind: todo_file\n",
    issues: [
      {
        kind: "Config",
        section: "runtime",
        message: restartMessage,
        field: null,
        path: null,
      },
    ],
    guided_form: null,
  });
}
