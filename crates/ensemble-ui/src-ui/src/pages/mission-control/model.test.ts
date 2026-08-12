import { describe, expect, it } from "vitest";
import type { AttentionItem, RuntimeSnapshot } from "@/generated/models";
import {
  deriveMissionControlState,
  filterMissionControlIssues,
  getSystemFreshness,
  isRateLimitLow,
  regroupMissionControlIssues,
  type MissionControlFilters,
} from "./model";

function attentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    identity: {
      producer_key: "runtime.interaction",
      subject_ref: "repo#3",
      kind: "runtime.interaction.awaiting_input",
    },
    presentation: {
      summary: "Agent needs a decision",
      remedy: "Reply in the issue panel.",
      references: ["interaction:ask-1"],
    },
    evidence: { fingerprint: "abc123" },
    state: "open",
    opened_at: "2026-07-09T09:10:00Z",
    updated_at: "2026-07-09T09:10:00Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_totals: {
      input_tokens: 1000,
      output_tokens: 2500,
      total_tokens: 3500,
      seconds_running: 95,
    },
    attention_items: [],
    counts: { running: 1, retrying: 1, waiting_on_human: 1, completed: 1 },
    generated_at: "2026-07-09T09:30:00Z",
    last_tick_at: "2026-07-09T09:29:58Z",
    poll_interval_ms: 3000,
    rate_limits: { limit: 100, remaining: 8, reset_at: "2026-07-09T10:00:00Z" },
    running: [
      {
        issue_id: "issue-running",
        issue_identifier: "repo#1",
        last_event: "tool_call",
        last_event_at: "2026-07-09T09:29:50Z",
        last_message: "Running tests",
        session_id: "session-1",
        started_at: "2026-07-09T09:00:00Z",
        state: "running",
        step_name: "build",
        tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        turn_count: 3,
      },
    ],
    retrying: [
      {
        issue_id: "issue-retry",
        issue_identifier: "repo#2",
        attempt: 2,
        due_at_ms: 1000,
        error: "clippy failed",
      },
    ],
    waiting_on_human: [
      {
        interaction_request_id: "ask-1",
        issue_id: "issue-waiting",
        issue_identifier: "repo#3",
        requested_at: "2026-07-09T09:10:00Z",
        step_name: "review",
      },
    ],
    completed: [
      {
        issue_id: "issue-completed",
        issue_identifier: "repo#4",
        completed_at: "2026-07-09T09:20:00Z",
        status: "completed_succeeded",
      },
    ],
    ...overrides,
  };
}

describe("mission-control model", () => {
  it("groups runtime snapshot rows into operational columns", () => {
    const state = deriveMissionControlState(snapshot());

    expect(state.groups.map((group) => [group.id, group.issues.map((issue) => issue.identifier)])).toEqual([
      ["running", ["repo#1"]],
      ["retrying", ["repo#2"]],
      ["waiting_on_human", ["repo#3"]],
      ["failed_or_blocked", []],
      ["completed_recently", ["repo#4"]],
    ]);
  });

  it("uses only persisted attention records, including unknown kinds and multiple producers", () => {
    const state = deriveMissionControlState(
      snapshot({
        attention_items: [
          attentionItem(),
          attentionItem({
            identity: {
              producer_key: "adapter.policy",
              subject_ref: "repo#3",
              kind: "adapter.policy.escalation",
            },
            presentation: {
              summary: "External approval is required",
              remedy: "Review the linked policy record.",
              references: ["policy:42", "run:run-7"],
            },
            opened_at: "2026-07-09T09:12:00Z",
          }),
        ],
      }),
    );

    expect(state.attentionItems).toMatchObject([
      {
        issueIdentifier: "repo#3",
        kind: "runtime.interaction.awaiting_input",
        title: "Agent needs a decision",
        detail: "Reply in the issue panel.",
        references: ["interaction:ask-1"],
        requestedAt: "2026-07-09T09:10:00Z",
        canNavigate: true,
      },
      {
        issueIdentifier: "repo#3",
        kind: "adapter.policy.escalation",
        title: "External approval is required",
        detail: "Review the linked policy record.",
        references: ["policy:42", "run:run-7"],
        requestedAt: "2026-07-09T09:12:00Z",
        canNavigate: true,
      },
    ]);
    expect(state.issues.find((issue) => issue.identifier === "repo#2")?.attention).toBe(false);
    expect(state.issues.find((issue) => issue.identifier === "repo#3")?.attention).toBe(true);
  });

  it("keeps persisted orphan attention visible but not navigable", () => {
    const state = deriveMissionControlState(
      snapshot({
        attention_items: [attentionItem({
          identity: {
            producer_key: "adapter.policy",
            subject_ref: "repo#orphan",
            kind: "adapter.policy.escalation",
          },
        })],
      }),
    );

    expect(state.attentionItems[0]).toMatchObject({
      issueIdentifier: "repo#orphan",
      canNavigate: false,
    });
  });

  it("classifies synthetic halted waits as blocked failures instead of human input", () => {
    const state = deriveMissionControlState(
      snapshot({
        counts: { running: 0, retrying: 0, waiting_on_human: 1, completed: 0 },
        running: [],
        retrying: [],
        waiting_on_human: [
          {
            interaction_request_id: "halted:issue-halted:review",
            issue_id: "issue-halted",
            issue_identifier: "repo#halted",
            requested_at: "2026-07-09T09:15:00Z",
            step_name: "review",
          },
        ],
        completed: [],
      }),
    );

    expect(state.groups.find((group) => group.id === "waiting_on_human")?.issues).toEqual([]);
    expect(state.groups.find((group) => group.id === "failed_or_blocked")?.issues).toEqual([
      expect.objectContaining({
        identifier: "repo#halted",
        statusLabel: "Halted",
        activity: "Pipeline halted after review failed",
        attention: false,
      }),
    ]);
    expect(state.attentionItems).toEqual([]);
    expect(state.stats).toMatchObject({ waitingOnHuman: 0, failed: 1 });
  });

  it("derives compact system stats", () => {
    const state = deriveMissionControlState(snapshot());

    expect(state.stats).toMatchObject({
      running: 1,
      retrying: 1,
      waitingOnHuman: 1,
      completed: 1,
      generatedAt: "2026-07-09T09:30:00Z",
      lastTickAt: "2026-07-09T09:29:58Z",
      pollIntervalMs: 3000,
      rateLimitRemaining: 8,
      rateLimitLimit: 100,
      rateLimitResetAt: "2026-07-09T10:00:00Z",
    });
  });

  it("marks system health stale after three poll intervals with a ten-second floor", () => {
    const { stats } = deriveMissionControlState(snapshot());

    expect(getSystemFreshness(stats, new Date("2026-07-09T09:30:08Z").getTime())).toBe(
      "fresh",
    );
    expect(getSystemFreshness(stats, new Date("2026-07-09T09:30:08.001Z").getTime())).toBe(
      "stale",
    );
  });

  it("warns when remaining rate capacity is ten percent or lower", () => {
    expect(isRateLimitLow(10, 100)).toBe(true);
    expect(isRateLimitLow(11, 100)).toBe(false);
    expect(isRateLimitLow(null, 100)).toBe(false);
    expect(isRateLimitLow(0, 0)).toBe(false);
  });

  it("filters by search text and operational status", () => {
    const state = deriveMissionControlState(snapshot());
    const filters: MissionControlFilters = { query: "repo#2", status: "retrying", attentionOnly: false };

    expect(filterMissionControlIssues(state.issues, filters).map((issue) => issue.identifier)).toEqual([
      "repo#2",
    ]);
  });

  it("filters to issues with persisted attention only", () => {
    const state = deriveMissionControlState(
      snapshot({ attention_items: [attentionItem()] }),
    );
    const filters: MissionControlFilters = { query: "", status: "all", attentionOnly: true };

    expect(filterMissionControlIssues(state.issues, filters).map((issue) => issue.identifier)).toEqual([
      "repo#3",
    ]);
  });

  it("searches status label, step name, and activity", () => {
    const state = deriveMissionControlState(snapshot({ attention_items: [attentionItem()] }));

    expect(
      filterMissionControlIssues(state.issues, { query: "completed_succeeded", status: "all", attentionOnly: false })
        .map((issue) => issue.identifier),
    ).toEqual(["repo#4"]);
    expect(
      filterMissionControlIssues(state.issues, { query: "review", status: "all", attentionOnly: false })
        .map((issue) => issue.identifier),
    ).toEqual(["repo#3"]);
    expect(
      filterMissionControlIssues(state.issues, { query: "running tests", status: "all", attentionOnly: false })
        .map((issue) => issue.identifier),
    ).toEqual(["repo#1"]);
  });

  it("regroups filtered issues by operational status", () => {
    const state = deriveMissionControlState(snapshot());
    const filteredIssues = filterMissionControlIssues(state.issues, { query: "repo#", status: "all", attentionOnly: true });

    expect(regroupMissionControlIssues(filteredIssues).map((group) => [group.id, group.issues.length])).toEqual([
      ["running", 0],
      ["retrying", 0],
      ["waiting_on_human", 0],
      ["failed_or_blocked", 0],
      ["completed_recently", 0],
    ]);
  });

  it("classifies completed_failed as failed attention instead of recent completion", () => {
    const state = deriveMissionControlState(
      snapshot({
        counts: { running: 0, retrying: 0, waiting_on_human: 0, completed: 2 },
        running: [],
        retrying: [],
        waiting_on_human: [],
        completed: [
          {
            issue_id: "issue-failed",
            issue_identifier: "repo#failed",
            completed_at: "2026-07-09T09:25:00Z",
            status: "completed_failed",
          },
          {
            issue_id: "issue-succeeded",
            issue_identifier: "repo#succeeded",
            completed_at: "2026-07-09T09:20:00Z",
            status: "completed_succeeded",
          },
        ],
      }),
    );

    expect(state.groups.find((group) => group.id === "failed_or_blocked")?.issues).toEqual([
      expect.objectContaining({ identifier: "repo#failed", attention: false }),
    ]);
    expect(state.groups.find((group) => group.id === "completed_recently")?.issues).toEqual([
      expect.objectContaining({ identifier: "repo#succeeded", attention: false }),
    ]);
    expect(state.attentionItems).toEqual([]);
    expect(state.stats).toMatchObject({ completed: 2, failed: 1 });
  });

  it("keeps completed_failed in failed filters without inferring attention", () => {
    const state = deriveMissionControlState(
      snapshot({
        counts: { running: 0, retrying: 0, waiting_on_human: 0, completed: 1 },
        running: [],
        retrying: [],
        waiting_on_human: [],
        completed: [
          {
            issue_id: "issue-failed",
            issue_identifier: "repo#failed",
            completed_at: "2026-07-09T09:25:00Z",
            status: "completed_failed",
          },
        ],
      }),
    );

    expect(
      filterMissionControlIssues(state.issues, {
        query: "",
        status: "failed_or_blocked",
        attentionOnly: false,
      }).map((issue) => issue.identifier),
    ).toEqual(["repo#failed"]);
    expect(filterMissionControlIssues(state.issues, {
      query: "",
      status: "all",
      attentionOnly: true,
    })).toEqual([]);
  });

  it("does not infer retry exhaustion from unspecified completed statuses", () => {
    const state = deriveMissionControlState(
      snapshot({
        completed: [
          {
            issue_id: "issue-unknown",
            issue_identifier: "repo#unknown",
            completed_at: "2026-07-09T09:25:00Z",
            status: "retry_exhausted",
          },
        ],
      }),
    );

    expect(state.issues.find((issue) => issue.identifier === "repo#unknown")).toMatchObject({
      status: "completed_recently",
      attention: false,
    });
  });
});
