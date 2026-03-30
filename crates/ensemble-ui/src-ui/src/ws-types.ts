import type { TokenSnapshot } from "./generated/models";

export interface WsSnapshot {
  type: "snapshot";
  issue_identifier: string;
  status: string;
  step_name: string | null;
  turn_count: number;
  tokens: TokenSnapshot;
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
