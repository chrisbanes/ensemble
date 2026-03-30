import type { IssueDetailSnapshot } from "./generated/models";

export interface WsPipelineEvent {
  event_type: string;
  timestamp: string;
  detail?: string;
  outcome?: string;
  conversation_index?: number;
  [key: string]: unknown;
}

export interface WsSnapshotMessage {
  type: "snapshot";
  data: IssueDetailSnapshot | null;
}

export interface WsEventMessage {
  type: "event";
  data: WsPipelineEvent;
}

export interface WsEventData {
  type: string;
  timestamp: string;
  detail: string;
  conversationIndex?: number;
}

export function normalizePipelineEvent(event: WsPipelineEvent): WsEventData {
  if (event.event_type === "complete") {
    return {
      type: "complete",
      timestamp: event.timestamp,
      detail: `Run ${event.outcome ?? "completed"}`,
    };
  }

  return {
    type: event.event_type,
    timestamp: event.timestamp,
    detail: event.detail ?? event.event_type,
    conversationIndex:
      typeof event.conversation_index === "number" ? event.conversation_index : undefined,
  };
}

export function isCompletionEvent(event: WsPipelineEvent): boolean {
  return event.event_type === "complete";
}
