// --- REST API types ---

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunningSession {
  issue_id: string;
  issue_identifier: string;
  state: string;
  step_name: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: TokenCounts;
}

export interface RetryEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
}

export interface AgentTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RateLimitSnapshot {
  remaining: number;
  limit: number;
  reset_at: string | null;
}

export interface StateResponse {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningSession[];
  retrying: RetryEntry[];
  agent_totals: AgentTotals;
  rate_limits: RateLimitSnapshot | null;
}

export interface IssueDetailResponse {
  issue_identifier: string;
  issue_id: string;
  status: string;
  workspace: { path: string };
  attempts: {
    restart_count: number;
    current_retry_attempt: number | null;
  };
  running: {
    session_id: string | null;
    step_name: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: TokenCounts;
  } | null;
  retry: {
    attempt: number;
    due_at: string;
    error: string | null;
  } | null;
  last_error: string | null;
}

export interface RefreshResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string;
  operations: string[];
}

export interface StopResponse {
  stopped: boolean;
  issue_identifier: string;
  message: string;
}

export interface RetryResponse {
  retrying: boolean;
  issue_identifier: string;
  attempt: number;
  message: string;
}

// --- Conversation types ---

export type ConversationMessage =
  | {
      role: "system";
      index: number;
      turn: number;
      content: string;
      timestamp: string;
    }
  | {
      role: "assistant";
      index: number;
      turn: number;
      content: string;
      timestamp: string;
      tokens: { input: number; output: number };
    }
  | {
      role: "tool_call";
      index: number;
      turn: number;
      tool_name: string;
      tool_input_summary: string;
      tool_result_summary: string | null;
      tool_result_lines: number | null;
      timestamp: string;
      status?: string;
    };

export interface ConversationResponse {
  issue_identifier: string;
  messages: ConversationMessage[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
    prev_cursor: string | null;
  };
}

// --- History types ---

export interface HistoryRecord {
  issue_identifier: string;
  issue_id: string;
  outcome: string;
  steps_traversed: string[];
  attempts: number;
  tokens: TokenCounts;
  duration_seconds: number;
  started_at: string;
  completed_at: string;
  last_error: string | null;
  verdict: string | null;
}

export interface HistoryResponse {
  records: HistoryRecord[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

// --- Config types (matches EnsembleConfig JSON serialization) ---

export interface AgentConfig {
  executor: string;
  model: string;
  prompt: string | null;
  prompt_template: string | null;
}

export interface StepConfig {
  name: string;
  agent: string;
  depends: string[] | null;
  tracker_state: string | null;
}

export interface EnsembleConfig {
  tracker: {
    kind: string;
    active_states: string[];
    terminal_states: string[];
    path: string | null;
    endpoint: string | null;
    api_key: string | null;
    repository: string | null;
    project_number: number | null;
    labels_filter: string[];
  };
  agents: Record<string, AgentConfig>;
  steps: StepConfig[];
  on_success: string;
  on_failure: string;
  concurrency: {
    max_concurrent_agents: number;
    max_step_parallelism: number;
  };
  max_cycles: number;
  polling: { interval_ms: number };
  workspace: { root: string | null };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    max_turns: number;
    max_retry_backoff_ms: number;
    command: string;
    session_mode: string;
    permission_policy: string;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
}

export interface ConfigResponse {
  valid: boolean;
  errors: string[];
  config_path: string;
  config: EnsembleConfig;
}

// --- WebSocket types ---

export interface WsSnapshot {
  type: "snapshot";
  issue_identifier: string;
  status: string;
  step_name: string | null;
  turn_count: number;
  tokens: TokenCounts;
  started_at: string;
  events: WsEventData[];
}

export interface WsEventMessage {
  type: "event";
  event_type: string;
  timestamp: string;
  turn?: number;
  detail: string;
  conversation_index?: number;
  tokens_delta?: { input: number; output: number };
  step_name?: string;
  tool_name?: string;
  attempt?: number;
  verdict?: string;
  outcome?: string;
}

export interface WsComplete {
  type: "complete";
  outcome: string;
  timestamp: string;
}

export type WsMessage = WsSnapshot | WsEventMessage | WsComplete;

export interface WsEventData {
  type: string;
  timestamp: string;
  detail: string;
  [key: string]: unknown;
}

// --- Notification types ---

export type NotificationSeverity = "failure" | "warning" | "success" | "info";

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  timestamp: string;
  issue_identifier: string;
  read: boolean;
}

// --- API error ---

export interface ApiError {
  error: { code: string; message: string };
}
