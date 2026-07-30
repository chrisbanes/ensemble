import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SetupWizard from "./SetupWizard";
import { renderWithProviders } from "@/test/render";

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

// Mock EventSource for SSE-based agent discovery
class MockEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;

  constructor(_url: string) {
    // Simulate connection opening
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);

    // Simulate receiving agents after a short delay
    setTimeout(() => {
      if (this.onmessage) {
        // Send mock agents one by one to simulate progressive discovery
        const mockAgents = [
          {
            name: "builder",
            label: "Builder Agent",
            version: "1.0.0",
            available_models: [
              { id: "default", name: "Default" },
              { id: "sonnet", name: "Sonnet" },
            ],
            available_modes: [
              { id: "approve_reads", name: "Approve reads" },
              { id: "approve_all", name: "Approve all" },
              { id: "plan", name: "Plan" },
            ],
          },
          {
            name: "reviewer",
            label: "Reviewer Agent",
            version: "1.0.0",
            available_models: [],
            available_modes: [],
          },
        ];
        mockAgents.forEach((agent, index) => {
          setTimeout(() => {
            if (this.onmessage) {
              this.onmessage({ data: JSON.stringify(agent) });
            }
          }, index * 50);
        });

        // Close connection after sending all agents
        setTimeout(() => {
          this.readyState = 2;
          this.onerror?.();
        }, mockAgents.length * 50 + 10);
      }
    }, 10);
  }

  close() {
    this.readyState = 2;
  }
}

describe("SetupWizard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("preserves an existing setup secret without rendering or resubmitting it", async () => {
    const user = userEvent.setup();
    const validateMock = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: {
              kind: "github",
              repository: "owner/repo",
              project_number: null,
              api_key: { state: "redacted" },
              active_states: ["Todo"],
              terminal_states: ["Done"],
            },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "implement", acpx_agent: "builder", model: null }],
            steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
            onSuccess: "Done",
            onFailure: "Failed",
          },
        });
      }
      if (url.includes("/api/v1/config/setup/validate")) {
        validateMock(JSON.parse(String(init?.body)));
        return jsonResponse({
          can_save: true,
          checks: [{ label: "Tracker", passed: true, detail: "ok" }],
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });

    expect(await screen.findByText(/existing secret is configured/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/ghp_/i)).not.toBeInTheDocument();
    for (let step = 0; step < 4; step += 1) {
      await user.click(screen.getByRole("button", { name: /next/i }));
    }
    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => expect(validateMock).toHaveBeenCalled());
    expect(validateMock.mock.calls[0]?.[0]?.setup.tracker.api_key_edit).toEqual({
      action: "preserve",
    });
  });

  it("renders in create mode by default", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: false,
          defaults: {},
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard />, { route: "/config" });

    // Should show create mode title
    expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();
    
    // Should show step indicators
    expect(screen.getByText("Tracker")).toBeInTheDocument();
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("renders in reconfigure mode", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "git_hub", repository: "owner/repo", projectNumber: 1 },
            repos: [{ path: "/existing/repo", branch: "develop" }],
            agents: [{ role: "implement", acpxAgent: "builder", model: "gpt-4" }],
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });

    // Should show reconfigure mode title
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();
  });

  it("shows loading state in reconfigure mode", async () => {
    // Mock with delay to show loading
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // Never resolves

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });

    // Should show loading message
    expect(await screen.findByText(/loading existing configuration/i)).toBeInTheDocument();
  });

  it("walks through setup steps and calls validate before save", async () => {
    const user = userEvent.setup();
    const validateMock = vi.fn();
    const saveMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: false,
          defaults: {},
        });
      }
      if (url.includes("/api/v1/config/setup/validate")) {
        validateMock(JSON.parse(String(init?.body)));
        return jsonResponse({
          can_save: true,
          checks: [
            { label: "Tracker", passed: true, detail: "Valid tracker configuration" },
            { label: "Repositories", passed: true, detail: "1 valid repository" },
            { label: "Agents", passed: true, detail: "1 valid agent" },
          ],
        });
      }
      if (url.includes("/api/v1/config/setup/save")) {
        saveMock(JSON.parse(String(init?.body)));
        return jsonResponse({ success: true });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard />, { route: "/config" });
    expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();

    // Fill in tracker fields (using Todo File tracker type which is default)
    const pathInput = screen.getByPlaceholderText("/path/to/todo.md");
    await user.type(pathInput, "/home/user/todo.md");

    // Navigate to Repositories step
    const nextButton = screen.getByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Fill in repository fields
    const repoPathInput = screen.getByPlaceholderText("Repository path");
    await user.type(repoPathInput, "/test/repo/path");
    
    const branchInput = screen.getByPlaceholderText("Branch");
    await user.clear(branchInput);
    await user.type(branchInput, "main");

    await user.click(screen.getByRole("button", { name: /add repository/i }));

    // Navigate to Agents step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Fill in agent fields - wait for agents to load (skip loading check since mock is synchronous)
    await waitFor(() => {
      const agentSelect = screen.getByLabelText("Agent");
      expect(agentSelect).toBeInTheDocument();
    });

    // Select an agent from dropdown
    const agentSelect = screen.getByLabelText("Agent");
    await user.click(agentSelect);
    const builderOption = await screen.findByRole("option", { name: /builder agent/i });
    await user.click(builderOption);

    await user.click(screen.getByLabelText(/model/i));
    await user.click(await screen.findByRole("option", { name: "Sonnet" }));

    await user.click(screen.getByLabelText(/reasoning/i));
    await user.click(await screen.findByRole("option", { name: "High" }));

    await user.click(screen.getByLabelText("Mode"));
    await user.click(await screen.findByRole("option", { name: "Approve reads" }));

    // Navigate to Workflow step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Navigate to Validation step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Click Validate button
    const validateButton = screen.getByRole("button", { name: /validate/i });
    await user.click(validateButton);

    // Assert validation summary appears
    await waitFor(() => {
      expect(screen.getByText("Validation Passed")).toBeInTheDocument();
    });

    expect(validateMock.mock.calls[0]?.[0]?.setup.agents[0]).toMatchObject({
      acpx_agent: "builder",
      model: "sonnet",
      reasoning_level: "high",
      permission_mode: "approve_reads",
    });

    // Assert check details are displayed (use function matchers because text is split)
    expect(screen.getByText((content) => content.includes("Valid tracker configuration"))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("1 valid repository"))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("1 valid agent"))).toBeInTheDocument();

    // Assert Save is enabled after validation passes
    const saveButton = screen.getByRole("button", { name: /save/i });
    expect(saveButton).toBeEnabled();

    // Click Save
    await user.click(saveButton);

    // Assert save mutation is called
    await waitFor(() => {
      expect(saveMock).toHaveBeenCalled();
    });
    expect(saveMock.mock.calls[0]?.[0]?.setup.agents[0]).toMatchObject({
      acpx_agent: "builder",
      model: "sonnet",
      reasoning_level: "high",
      permission_mode: "approve_reads",
    });
  });

  it("loads reconfigure defaults from existing config", async () => {
    const user = userEvent.setup();
    const onCompleteMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "git_hub", repository: "existing-owner/existing-repo", project_number: 42 },
            repos: [
              { path: "/existing/repo/path1", branch: "main" },
              { path: "/existing/repo/path2", branch: "develop" },
            ],
            agents: [
              { role: "implement", acpx_agent: "builder", model: "gpt-4" },
              { role: "review", acpx_agent: "reviewer", model: "claude-3" },
            ],
            steps: [
              { name: "implement", agent_role: "implement", depends: [], tracker_state: null },
              { name: "review", agent_role: "review", depends: ["implement"], tracker_state: null },
            ],
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(
      <SetupWizard mode="reconfigure" onComplete={onCompleteMock} />,
      { route: "/config" }
    );

    // Assert SetupWizard opens with pre-populated values
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    // Wait for defaults to load
    await waitFor(() => {
      const repoInput = screen.getByDisplayValue("existing-owner/existing-repo");
      expect(repoInput).toBeInTheDocument();
    });

    // Check that tracker is pre-filled (GitHub repo field)
    expect(screen.getByDisplayValue("existing-owner/existing-repo")).toBeInTheDocument();

    // Navigate to Repositories step and verify repos are pre-filled
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("/existing/repo/path1")).toBeInTheDocument();
    expect(screen.getByText("/existing/repo/path2")).toBeInTheDocument();

    // Navigate to Agents step and wait for discovery to complete
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      // Wait for the discovery to complete and agents to appear
      expect(screen.getByText(/found \d+ agent/i)).toBeInTheDocument();
    });

    // Check that agent roles are pre-filled
    const roleInputs = screen.getAllByPlaceholderText("e.g., implement, review");
    expect(roleInputs[0]).toHaveValue("implement");
    expect(roleInputs[1]).toHaveValue("review");
  });

  it("preserves both github repository and project number while editing", async () => {
    const user = userEvent.setup();

    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: {
              kind: "github",
              repository: "",
              project_number: null,
              api_key_env: "GITHUB_TOKEN",
              active_states: ["Todo", "In Progress"],
              terminal_states: ["Done"],
            },
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    const repoInput = await screen.findByLabelText("Repository");
    const projectInput = screen.getByLabelText(/project number/i);

    await user.type(repoInput, "owner/repo");
    await user.type(projectInput, "42");

    expect(repoInput).toHaveValue("owner/repo");
    expect(projectInput).toHaveValue(42);
  });

  it("validates github setup with standard project state names", async () => {
    const user = userEvent.setup();
    const validateMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: {
              kind: "github",
              repository: "owner/repo",
              project_number: null,
              api_key_env: "GITHUB_TOKEN",
              active_states: ["Todo", "In Progress"],
              terminal_states: ["Done"],
            },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "implement", acpx_agent: "builder", model: null }],
            steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
          },
        });
      }
      if (url.includes("/api/v1/config/setup/validate")) {
        validateMock(JSON.parse(String(init?.body)));
        return jsonResponse({
          can_save: true,
          checks: [{ label: "Tracker", passed: true, detail: "ok" }],
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => {
      expect(validateMock).toHaveBeenCalled();
    });

    expect(validateMock.mock.calls[0]?.[0]?.setup.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(validateMock.mock.calls[0]?.[0]?.setup.tracker.terminal_states).toEqual(["Done"]);
  });

  it("offers default model when discovered models omit default", async () => {
    const user = userEvent.setup();

    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: {
              kind: "github",
              repository: "owner/repo",
              project_number: null,
              api_key_env: "GITHUB_TOKEN",
              active_states: ["Todo", "In Progress"],
              terminal_states: ["Done"],
            },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "implement", acpx_agent: "builder", model: null }],
            steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));

    await user.click(await screen.findByLabelText("Model (optional)"));

    expect(await screen.findByRole("option", { name: "Default" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sonnet" })).toBeInTheDocument();
  });

  it("allows a custom model when discovered models are available", async () => {
    const user = userEvent.setup();
    const validateMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "todo_file", path: "/tmp/todo.md" },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "implement", acpx_agent: "builder", model: null }],
            steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
          },
        });
      }
      if (url.includes("/api/v1/config/setup/validate")) {
        validateMock(JSON.parse(String(init?.body)));
        return jsonResponse({
          can_save: true,
          checks: [{ label: "Agents", passed: true, detail: "ok" }],
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(await screen.findByLabelText("Model (optional)"));
    await user.click(await screen.findByRole("option", { name: "Custom..." }));
    await user.type(screen.getByLabelText("Model (optional)"), "gpt-custom");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => {
      expect(validateMock).toHaveBeenCalled();
    });

    expect(validateMock.mock.calls[0]?.[0]?.setup.agents[0].model).toBe("gpt-custom");
  });

  it("uses free text model input when a selected agent has no discovered models", async () => {
    const user = userEvent.setup();
    const validateMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "todo_file", path: "/tmp/todo.md" },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "review", acpx_agent: "reviewer", model: null }],
            steps: [{ name: "review", agent_role: "review", depends: [], tracker_state: null }],
          },
        });
      }
      if (url.includes("/api/v1/config/setup/validate")) {
        validateMock(JSON.parse(String(init?.body)));
        return jsonResponse({
          can_save: true,
          checks: [{ label: "Agents", passed: true, detail: "ok" }],
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    const modelInput = await screen.findByLabelText("Model (optional)");
    await user.type(modelInput, "review-model");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => {
      expect(validateMock).toHaveBeenCalled();
    });

    expect(validateMock.mock.calls[0]?.[0]?.setup.agents[0].model).toBe("review-model");
  });

  it("does not show unsupported discovered modes in the mode dropdown", async () => {
    const user = userEvent.setup();

    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "todo_file", path: "/tmp/todo.md" },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "implement", acpx_agent: "builder", model: null }],
            steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(await screen.findByLabelText("Mode"));

    expect(await screen.findByRole("option", { name: "Approve reads" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Plan" })).not.toBeInTheDocument();
  });

  it("does not submit unsupported setup permission modes from defaults", async () => {
    const user = userEvent.setup();
    const validateMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "todo_file", path: "/tmp/todo.md" },
            repos: [{ path: "/repo", branch: "main" }],
            agents: [{ role: "implement", acpx_agent: "builder", model: null, permission_mode: "plan" }],
            steps: [{ name: "implement", agent_role: "implement", depends: [], tracker_state: null }],
          },
        });
      }
      if (url.includes("/api/v1/config/setup/validate")) {
        validateMock(JSON.parse(String(init?.body)));
        return jsonResponse({
          can_save: true,
          checks: [{ label: "Agents", passed: true, detail: "ok" }],
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => {
      expect(validateMock).toHaveBeenCalled();
    });

    expect(validateMock.mock.calls[0]?.[0]?.setup.agents[0].permission_mode).toBeNull();
  });
});
