import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot } from "@/generated/models";
import {
  deriveMissionControlState,
  filterMissionControlIssues,
  getSystemFreshness,
  isRateLimitLow,
  regroupMissionControlIssues,
  type MissionControlFilters,
} from "./model";

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agent_totals: {
      input_tokens: 1000,
      output_tokens: 2500,
      total_tokens: 3500,
      seconds_running: 95,
    },
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

  it("promotes human questions and retry recovery into attention items", () => {
    const state = deriveMissionControlState(snapshot());

    expect(state.attentionItems.map((item) => [item.issueIdentifier, item.kind, item.primaryAction])).toEqual([
      ["repo#3", "human_input", "Reply"],
      ["repo#2", "retry", "Inspect"],
    ]);
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
        attention: true,
      }),
    ]);
    expect(state.attentionItems).toEqual([
      expect.objectContaining({
        issueIdentifier: "repo#halted",
        kind: "failure",
        title: "Pipeline halted",
        detail: "Blocked after review failed",
        primaryAction: "Inspect",
      }),
    ]);
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

  it("filters to attention-only issues", () => {
    const state = deriveMissionControlState(snapshot());
    const filters: MissionControlFilters = { query: "", status: "all", attentionOnly: true };

    expect(filterMissionControlIssues(state.issues, filters).map((issue) => issue.identifier)).toEqual([
      "repo#2",
      "repo#3",
    ]);
  });

  it("searches status label, step name, and activity", () => {
    const state = deriveMissionControlState(snapshot());

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
      ["retrying", 1],
      ["waiting_on_human", 1],
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
      expect.objectContaining({ identifier: "repo#failed", attention: true }),
    ]);
    expect(state.groups.find((group) => group.id === "completed_recently")?.issues).toEqual([
      expect.objectContaining({ identifier: "repo#succeeded", attention: false }),
    ]);
    expect(state.attentionItems).toContainEqual(
      expect.objectContaining({
        issueIdentifier: "repo#failed",
        kind: "failure",
        primaryAction: "Inspect",
      }),
    );
    expect(state.stats).toMatchObject({ completed: 2, failed: 1 });
  });

  it("includes completed_failed in failed and attention-only filters", () => {
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
    expect(
      filterMissionControlIssues(state.issues, {
        query: "",
        status: "all",
        attentionOnly: true,
      }).map((issue) => issue.identifier),
    ).toEqual(["repo#failed"]);
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
