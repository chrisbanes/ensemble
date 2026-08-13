import type {
  AttentionItem,
  CompletedRow,
  IssueActionCapabilities,
  RetryRow,
  RunningSessionRow,
  RuntimeSnapshot,
  WaitingInteractionRow,
} from "@/generated/models";
import { isSyntheticHaltedInteractionId } from "./interactionIds";

export type MissionIssueStatus =
  | "running"
  | "retrying"
  | "waiting_on_human"
  | "failed_or_blocked"
  | "completed_recently";

export interface MissionIssueSummary {
  id: string;
  identifier: string;
  status: MissionIssueStatus;
  statusLabel: string;
  stepName: string | null;
  activity: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retryAttempt: number | null;
  tokenTotal: number | null;
  turnCount: number | null;
  attention: boolean;
  capabilities: IssueActionCapabilities;
  source: RunningSessionRow | RetryRow | WaitingInteractionRow | CompletedRow;
}

export interface MissionGroup {
  id: MissionIssueStatus;
  title: string;
  issues: MissionIssueSummary[];
}

export interface MissionAttentionItem {
  id: string;
  issueIdentifier: string;
  kind: string;
  title: string;
  detail: string;
  references: string[];
  requestedAt: string;
  canNavigate: boolean;
}

export interface MissionSystemStats {
  running: number;
  retrying: number;
  waitingOnHuman: number;
  completed: number;
  failed: number;
  generatedAt: string;
  lastTickAt: string | null;
  pollIntervalMs: number;
  rateLimitRemaining: number | null;
  rateLimitLimit: number | null;
  rateLimitResetAt: string | null;
}

export interface MissionControlState {
  issues: MissionIssueSummary[];
  groups: MissionGroup[];
  attentionItems: MissionAttentionItem[];
  stats: MissionSystemStats;
}

export interface MissionControlFilters {
  query: string;
  status: MissionIssueStatus | "all";
  attentionOnly: boolean;
}

const SYSTEM_STALE_POLL_MULTIPLIER = 3;
const SYSTEM_STALE_MIN_MS = 10_000;

/** A snapshot is fresh only while both generation and orchestrator tick times are current. */
export function getSystemFreshness(
  stats: MissionSystemStats,
  nowMs = Date.now(),
): "fresh" | "stale" {
  const staleAfterMs = Math.max(
    stats.pollIntervalMs * SYSTEM_STALE_POLL_MULTIPLIER,
    SYSTEM_STALE_MIN_MS,
  );
  const generatedAtMs = new Date(stats.generatedAt).getTime();
  const lastTickAtMs = stats.lastTickAt ? new Date(stats.lastTickAt).getTime() : Number.NaN;

  return Number.isFinite(generatedAtMs) &&
    Number.isFinite(lastTickAtMs) &&
    nowMs - generatedAtMs <= staleAfterMs &&
    nowMs - lastTickAtMs <= staleAfterMs
    ? "fresh"
    : "stale";
}

export function isRateLimitLow(remaining: number | null, limit: number | null): boolean {
  return remaining != null && limit != null && limit > 0 && remaining / limit <= 0.1;
}

const GROUP_TITLES: Record<MissionIssueStatus, string> = {
  running: "Running",
  retrying: "Retrying",
  waiting_on_human: "Waiting on Human",
  failed_or_blocked: "Failed or Blocked",
  completed_recently: "Completed Recently",
};

function runningIssue(row: RunningSessionRow): MissionIssueSummary {
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: "running",
    statusLabel: "Running",
    stepName: row.step_name ?? null,
    activity: row.last_message ?? row.last_event ?? row.state,
    updatedAt: row.last_event_at ?? row.started_at,
    startedAt: row.started_at,
    completedAt: null,
    retryAttempt: null,
    tokenTotal: row.tokens.total_tokens,
    turnCount: row.turn_count,
    attention: false,
    source: row,
    capabilities: row.capabilities,
  };
}

function retryIssue(row: RetryRow): MissionIssueSummary {
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: "retrying",
    statusLabel: "Retrying",
    stepName: null,
    activity: row.error ?? `Retry attempt ${row.attempt}`,
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    retryAttempt: row.attempt,
    tokenTotal: null,
    turnCount: null,
    attention: false,
    source: row,
    capabilities: row.capabilities,
  };
}

function waitingIssue(row: WaitingInteractionRow): MissionIssueSummary {
  const halted = isSyntheticHaltedInteractionId(row.interaction_request_id);
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: halted ? "failed_or_blocked" : "waiting_on_human",
    statusLabel: halted ? "Halted" : "Waiting on Human",
    stepName: row.step_name,
    activity: halted ? `Pipeline halted after ${row.step_name} failed` : "Agent needs input",
    updatedAt: row.requested_at,
    startedAt: null,
    completedAt: null,
    retryAttempt: null,
    tokenTotal: null,
    turnCount: null,
    attention: false,
    source: row,
    capabilities: row.capabilities,
  };
}

function completedIssue(row: CompletedRow): MissionIssueSummary {
  const failed = row.status === "completed_failed";
  return {
    id: row.issue_id,
    identifier: row.issue_identifier,
    status: failed ? "failed_or_blocked" : "completed_recently",
    statusLabel: row.status,
    stepName: null,
    activity: row.status,
    updatedAt: row.completed_at,
    startedAt: null,
    completedAt: row.completed_at,
    retryAttempt: null,
    tokenTotal: null,
    turnCount: null,
    attention: false,
    source: row,
    capabilities: row.capabilities,
  };
}

export function deriveMissionControlState(snapshot: RuntimeSnapshot): MissionControlState {
  const failedRows = snapshot.completed.filter((row) => row.status === "completed_failed");
  const haltedRows = snapshot.waiting_on_human.filter((row) =>
    isSyntheticHaltedInteractionId(row.interaction_request_id),
  );
  const issues = [
    ...snapshot.running.map(runningIssue),
    ...snapshot.retrying.map(retryIssue),
    ...snapshot.waiting_on_human.map(waitingIssue),
    ...snapshot.completed.map(completedIssue),
  ];
  const attentionBySubject = new Set(
    snapshot.attention_items.map((item) => item.identity.subject_ref),
  );
  const issuesWithAttention = issues.map((issue) => ({
    ...issue,
    attention: attentionBySubject.has(issue.identifier),
  }));
  const inspectByIssueIdentifier = new Map(
    issues.map((issue) => [issue.identifier, issue.capabilities.inspect.enabled]),
  );

  return {
    issues: issuesWithAttention,
    groups: regroupMissionControlIssues(issuesWithAttention),
    attentionItems: snapshot.attention_items.map((item) =>
      missionAttentionItem(item, inspectByIssueIdentifier),
    ),
    stats: {
      running: snapshot.counts.running,
      retrying: snapshot.counts.retrying,
      waitingOnHuman: Math.max(0, snapshot.counts.waiting_on_human - haltedRows.length),
      completed: snapshot.counts.completed,
      failed: failedRows.length + haltedRows.length,
      generatedAt: snapshot.generated_at,
      lastTickAt: snapshot.last_tick_at ?? null,
      pollIntervalMs: snapshot.poll_interval_ms,
      rateLimitRemaining: snapshot.rate_limits?.remaining ?? null,
      rateLimitLimit: snapshot.rate_limits?.limit ?? null,
      rateLimitResetAt: snapshot.rate_limits?.reset_at ?? null,
    },
  };
}

function missionAttentionItem(
  item: AttentionItem,
  inspectByIssueIdentifier: Map<string, boolean>,
): MissionAttentionItem {
  return {
    id: JSON.stringify([
      item.identity.producer_key,
      item.identity.subject_ref,
      item.identity.kind,
    ]),
    issueIdentifier: item.identity.subject_ref,
    kind: item.identity.kind,
    title: item.presentation.summary,
    detail: item.presentation.remedy,
    references: item.presentation.references,
    requestedAt: item.opened_at,
    canNavigate: inspectByIssueIdentifier.get(item.identity.subject_ref) === true,
  };
}

export function filterMissionControlIssues(
  issues: MissionIssueSummary[],
  filters: MissionControlFilters,
): MissionIssueSummary[] {
  const query = filters.query.trim().toLowerCase();

  return issues.filter((issue) => {
    if (filters.status !== "all" && issue.status !== filters.status) return false;
    if (filters.attentionOnly && !issue.attention) return false;
    if (!query) return true;

    return [issue.identifier, issue.statusLabel, issue.stepName, issue.activity]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(query));
  });
}

export function regroupMissionControlIssues(issues: MissionIssueSummary[]): MissionGroup[] {
  return (Object.keys(GROUP_TITLES) as MissionIssueStatus[]).map((id) => ({
    id,
    title: GROUP_TITLES[id],
    issues: issues.filter((issue) => issue.status === id),
  }));
}

/** Returns issues in the same left-to-right, top-to-bottom order as the rendered board. */
export function issuesInGroupOrder(groups: MissionGroup[]): MissionIssueSummary[] {
  return groups.flatMap((group) => group.issues);
}
