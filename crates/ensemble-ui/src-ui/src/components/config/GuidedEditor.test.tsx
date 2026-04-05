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
    active_states: [],
    terminal_states: [],
    labels_filter: [],
  },
  repos: [],
  agents: [
    {
      name: "builder",
      acpx_agent: "claude",
      prompt: "Build it",
      permission_mode: "approve_reads",
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
};

describe("GuidedEditor", () => {
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
});
