import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import ConfigPage from "./ConfigPage";
import { renderWithProviders } from "@/test/render";

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows setup mode when the config state is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      state: "missing",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: null,
      issues: [],
      active_config: null,
    })));

    renderWithProviders(<ConfigPage />, { route: "/config" });

    expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();
  });

  it("keeps the editors available when parsed config has validation issues", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config")) {
        return jsonResponse({
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
            tracker: {
              kind: "todo_file",
              path: "/tmp/todo.md",
              active_states: [],
              terminal_states: [],
              labels_filter: [],
            },
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
                permission_policy: "auto",
                turn_timeout_ms: 1,
                read_timeout_ms: 1,
                stall_timeout_ms: 1,
              },
            },
            transitions: { on_success: "Done", on_failure: "Failed" },
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<ConfigPage />, { route: "/config" });

    expect(await screen.findByText(/guided configuration editor/i)).toBeInTheDocument();
    expect(screen.getAllByText(/tracker is incomplete/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^yaml$/i })).toBeInTheDocument();
  });

  // NOTE: Full YAML/guided sync test requires backend integration mocking
  // to verify that YAML tab reflects updated values after guided form save.
  // This would require:
  // 1. Mocking useSaveGuidedFormMutation to return updated config
  // 2. Mocking refetch to return new raw_yaml
  // 3. Verifying YAML tab content matches the updated raw_yaml
});
