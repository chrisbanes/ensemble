import type { IssueDetailSnapshot } from "./generated/models";
import type { TimelineEventRecord } from "./hooks";

export interface WsPipelineEvent {
  event_type: string;
  timestamp: string;
  run_id?: string;
  sequence?: number;
  step_name?: string;
  attempt?: number;
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
  runId?: string;
  sequence?: number;
  stepName?: string;
  attempt?: number;
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

  const inferredAttempt =
    typeof event.detail === "string"
      ? Number(event.detail.match(/attempt\s+(\d+)/i)?.[1] ?? NaN)
      : NaN;

  return {
    type: event.event_type,
    timestamp: event.timestamp,
    detail: event.detail ?? event.event_type,
    runId: typeof event.run_id === "string" ? event.run_id : undefined,
    sequence: typeof event.sequence === "number" ? event.sequence : undefined,
    stepName: typeof event.step_name === "string" ? event.step_name : undefined,
    attempt:
      typeof event.attempt === "number"
        ? event.attempt
        : Number.isFinite(inferredAttempt)
          ? inferredAttempt
          : undefined,
    conversationIndex:
      typeof event.conversation_index === "number" ? event.conversation_index : undefined,
  };
}

export function timelineRecordToEventData(event: TimelineEventRecord): WsEventData {
  return {
    type: event.event_type,
    timestamp: event.timestamp,
    detail: event.detail,
    runId: event.run_id,
    sequence: event.sequence,
    stepName: event.step_name ?? undefined,
    attempt: event.attempt,
  };
}

export function isCompletionEvent(event: WsPipelineEvent): boolean {
  return event.event_type === "complete";
}
