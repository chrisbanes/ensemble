import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import ConfigStatus from "./ConfigStatus";
import { renderWithProviders } from "@/test/render";

vi.mock("@/hooks", () => ({
  useConfigStateQuery: () => ({
    data: {
      state: "parsed",
      config_path: "/tmp/ensemble/config.yaml",
      issues: [],
      guided_form: {
        tracker: { kind: "todo_file", active_states: [], terminal_states: [], labels_filter: [] },
        agents: {},
        steps: [],
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
      },
    },
    isLoading: false,
    isError: false,
  }),
}));

describe("ConfigStatus", () => {
  it("does not display the unsupported maximum-turns setting", () => {
    renderWithProviders(<ConfigStatus />, { route: "/config" });

    expect(screen.queryByText("Max Turns")).not.toBeInTheDocument();
    expect(screen.getByText("Max Concurrent")).toBeInTheDocument();
  });
});
