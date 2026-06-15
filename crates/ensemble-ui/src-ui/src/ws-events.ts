import type { IssueDetailSnapshot, TranscriptRecord } from "./generated/models";
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

export interface WsTranscriptRecordMessage {
  type: "transcript_record";
  data: TranscriptRecord;
}

export type WsMessage = WsSnapshotMessage | WsEventMessage | WsTranscriptRecordMessage;

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

  const normalized: WsEventData = {
    type: event.event_type,
    timestamp: event.timestamp,
    detail: event.detail ?? event.event_type,
  };

  if (typeof event.run_id === "string") normalized.runId = event.run_id;
  if (typeof event.sequence === "number") normalized.sequence = event.sequence;
  if (typeof event.step_name === "string") normalized.stepName = event.step_name;
  if (typeof event.attempt === "number") {
    normalized.attempt = event.attempt;
  } else if (Number.isFinite(inferredAttempt)) {
    normalized.attempt = inferredAttempt;
  }
  if (typeof event.conversation_index === "number") {
    normalized.conversationIndex = event.conversation_index;
  }

  return normalized;
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

export function transcriptRecordKey(record: TranscriptRecord): string {
  return `${record.run_id}:${record.step_name}:${record.sequence}`;
}
