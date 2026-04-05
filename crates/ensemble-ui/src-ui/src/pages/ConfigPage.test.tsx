import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ValidationIssue } from "@/generated/models";
import ConfigPage from "./ConfigPage";
import { renderWithProviders } from "@/test/render";

let mockConfigData: any;
const validateGuidedMock = vi.fn();
const saveGuidedMock = vi.fn();
const validateYamlMock = vi.fn();
const saveYamlMock = vi.fn();
const refetchMock = vi.fn();

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
  default: () => <div>Set up Ensemble</div>,
}));

vi.mock("@/components/config/GuidedEditor", () => ({
  default: ({ issues }: { issues: ValidationIssue[] }) => (
    <div>
      <div>Guided Configuration Editor</div>
      {issues.map((issue, index) => (
        <div key={index}>{issue.message}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/config/YamlEditor", () => ({
  default: ({ rawYaml, issues, onValidate }: { rawYaml: string; issues: ValidationIssue[]; onValidate?: (yaml: string) => Promise<ValidationIssue[]> }) => (
    <div>
      <div>Raw YAML Editor</div>
      <button type="button" onClick={() => onValidate?.(rawYaml)}>Validate</button>
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
            permission_request_policy: "auto",
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
            permission_request_policy: "auto",
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
});
