import type { InteractionDetail, TranscriptRecord } from "@/generated/models";
import type { WsEventData } from "@/ws-types";

export interface ConversationMessage {
  index: number;
  role: string;
  content: string;
  tool_calls: unknown;
  tool_output?: unknown;
}

export interface TranscriptSource {
  conversation: ConversationMessage[];
  transcriptRecords?: TranscriptRecord[];
  interactions: InteractionDetail[];
  events: WsEventData[];
}

interface TranscriptEntryBase {
  id: string;
  timestamp?: string;
}

export interface StepEventEntry extends TranscriptEntryBase {
  kind: "step_event";
  event: WsEventData;
}

export interface WorkflowEventEntry extends TranscriptEntryBase {
  kind: "workflow_event";
  event: WsEventData;
}

export interface VerdictEntry extends TranscriptEntryBase {
  kind: "verdict";
  event: WsEventData;
}

export interface AgentQuestionEntry extends TranscriptEntryBase {
  kind: "agent_question";
  interaction: InteractionDetail;
}

export interface AgentMessageEntry extends TranscriptEntryBase {
  kind: "agent_message";
  message: ConversationMessage;
}

export interface HumanMessageEntry extends TranscriptEntryBase {
  kind: "human_message";
  message: string;
}

export interface HumanReplyEntry extends TranscriptEntryBase {
  kind: "human_reply";
  reply: string;
}

export interface ErrorEntry extends TranscriptEntryBase {
  kind: "error";
  message: string;
}

export interface ToolActivityEntry extends TranscriptEntryBase {
  kind: "tool_activity";
  event: WsEventData;
}

export type TranscriptEntry =
  | StepEventEntry
  | WorkflowEventEntry
  | VerdictEntry
  | AgentQuestionEntry
  | AgentMessageEntry
  | HumanMessageEntry
  | HumanReplyEntry
  | ErrorEntry
  | ToolActivityEntry;

export interface ToolActivityGroupEntry extends TranscriptEntryBase {
  kind: "tool_activity_group";
  entries: ToolActivityEntry[];
  count: number;
  defaultExpanded: false;
}

export type GroupedTranscriptEntry = TranscriptEntry | ToolActivityGroupEntry;

interface TimestampedConversationMessage extends ConversationMessage {
  timestamp?: string;
  created_at?: string;
}

type SortableEntry = {
  entry: TranscriptEntry;
  sortTimestamp: number;
  sortSequence: number;
  sortPriority: number;
};

const HIGH_SORT_NUMBER = Number.MAX_SAFE_INTEGER;
const TRANSCRIPT_SORT_PRIORITY = {
  stepEvent: 0,
  humanOrQuestion: 1,
  agentOrTool: 2,
  error: 3,
  verdict: 4,
} as const;

function toMs(timestamp: string | null | undefined): number {
  if (!timestamp) return HIGH_SORT_NUMBER;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? HIGH_SORT_NUMBER : ms;
}

function eventPriority(eventType: string): number {
  if (eventType === "step_started" || eventType === "step_completed") {
    return TRANSCRIPT_SORT_PRIORITY.stepEvent;
  }
  if (
    eventType === "human_reply_submitted" ||
    eventType === "question_asked" ||
    eventType === "input_requested" ||
    eventType === "input_submitted" ||
    eventType === "input_resumed" ||
    eventType === "step_resumed_from_human_reply" ||
    eventType === "retry_scheduled"
  ) {
    return TRANSCRIPT_SORT_PRIORITY.humanOrQuestion;
  }
  if (eventType === "verdict") return TRANSCRIPT_SORT_PRIORITY.verdict;
  if (eventType === "tool_call" || eventType === "output") {
    return TRANSCRIPT_SORT_PRIORITY.agentOrTool;
  }
  if (eventType === "error") return TRANSCRIPT_SORT_PRIORITY.error;
  return TRANSCRIPT_SORT_PRIORITY.humanOrQuestion;
}

function interactionSequence(index: number): number {
  return index;
}

function objectPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === "object" && payload != null) {
    return payload as Record<string, unknown>;
  }
  return null;
}

function stringPayloadValue(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function payloadText(payload: unknown): string {
  if (typeof payload === "object" && payload != null && "text" in payload) {
    return String((payload as { text?: unknown }).text ?? "");
  }
  const json = JSON.stringify(payload);
  return json ?? "";
}

export function transcriptRecordDetail(record: TranscriptRecord): string {
  if (record.kind !== "tool_call") {
    return payloadText(record.payload);
  }

  const payload = objectPayload(record.payload);
  if (!payload) {
    return payloadText(record.payload);
  }

  const label =
    stringPayloadValue(payload, "title") ??
    stringPayloadValue(payload, "name") ??
    "Tool call";
  const toolCallId = stringPayloadValue(payload, "tool_call_id");
  const status = stringPayloadValue(payload, "status");
  const args = payload.arguments;

  const parts = [label];
  if (toolCallId && !label.includes(toolCallId)) {
    parts.push(toolCallId);
  }
  if (status) {
    parts.push(status);
  }
  if (args != null) {
    parts.push(compactJson(args));
  }

  return parts.join(" ");
}

function transcriptRecordEvent(record: TranscriptRecord, detail: string): WsEventData {
  return {
    type: record.kind,
    timestamp: record.timestamp,
    detail,
    runId: record.run_id,
    sequence: record.sequence,
    stepName: record.step_name,
    attempt: record.attempt,
  };
}

function entryFromTranscriptRecord(record: TranscriptRecord): TranscriptEntry | null {
  const timestamp = record.timestamp;
  const id = `transcript:${record.run_id}:${record.step_name}:${record.sequence}`;
  const text = transcriptRecordDetail(record);

  if (record.kind === "assistant_message") {
    return {
      kind: "agent_message",
      id,
      message: {
        index: record.sequence,
        role: "assistant",
        content: text,
        tool_calls: null,
        tool_output: null,
      },
      timestamp,
    };
  }

  if (record.kind === "error") {
    return {
      kind: "error",
      id,
      message: text,
      timestamp,
    };
  }

  if (
    record.kind === "reasoning" ||
    record.kind === "tool_call" ||
    record.kind === "tool_result" ||
    record.kind === "prompt" ||
    record.kind === "permission_request" ||
    record.kind === "permission_resolution" ||
    record.kind === "raw"
  ) {
    return {
      kind: "tool_activity",
      id,
      event: transcriptRecordEvent(record, text),
      timestamp,
    };
  }

  return {
    kind: "workflow_event",
    id,
    event: transcriptRecordEvent(record, text),
    timestamp,
  };
}

function earliestInteractionTimestamp(interactions: InteractionDetail[]): string | null {
  let earliest: string | null = null;

  for (const interaction of interactions) {
    if (!interaction.requested_at) continue;
    if (earliest === null || toMs(interaction.requested_at) < toMs(earliest)) {
      earliest = interaction.requested_at;
    }
  }

  return earliest;
}

function sameConversationMessage(
  a: ConversationMessage,
  b: ConversationMessage,
): boolean {
  return (
    a.content === b.content &&
    a.index === b.index &&
    a.role === b.role &&
    a.tool_calls === b.tool_calls &&
    a.tool_output === b.tool_output
  );
}

function sameInteractionDetail(
  a: InteractionDetail,
  b: InteractionDetail,
): boolean {
  return (
    a.agent_name === b.agent_name &&
    a.awaiting_resume === b.awaiting_resume &&
    a.extra_context === b.extra_context &&
    a.id === b.id &&
    a.issue_id === b.issue_id &&
    a.issue_identifier === b.issue_identifier &&
    a.kind === b.kind &&
    a.question === b.question &&
    a.requested_at === b.requested_at &&
    a.status === b.status &&
    a.step_name === b.step_name &&
    a.suggested_answer === b.suggested_answer &&
    a.why_blocked === b.why_blocked
  );
}

function sameEventData(a: WsEventData, b: WsEventData): boolean {
  return (
    a.type === b.type &&
    a.timestamp === b.timestamp &&
    a.detail === b.detail &&
    a.runId === b.runId &&
    a.sequence === b.sequence &&
    a.stepName === b.stepName &&
    a.attempt === b.attempt &&
    a.conversationIndex === b.conversationIndex
  );
}

function sameTranscriptEntry(a: TranscriptEntry, b: TranscriptEntry): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.timestamp !== b.timestamp) {
    return false;
  }

  switch (a.kind) {
    case "step_event":
    case "workflow_event":
    case "verdict":
    case "tool_activity": {
      const next = b as typeof a;
      return sameEventData(a.event, next.event);
    }
    case "agent_question": {
      const next = b as typeof a;
      return sameInteractionDetail(a.interaction, next.interaction);
    }
    case "agent_message": {
      const next = b as typeof a;
      return sameConversationMessage(a.message, next.message);
    }
    case "human_message": {
      const next = b as typeof a;
      return a.message === next.message;
    }
    case "human_reply": {
      const next = b as typeof a;
      return a.reply === next.reply;
    }
    case "error": {
      const next = b as typeof a;
      return a.message === next.message;
    }
  }
}

function sameToolActivityGroup(
  a: ToolActivityGroupEntry,
  b: ToolActivityGroupEntry,
): boolean {
  if (
    a.kind !== b.kind ||
    a.id !== b.id ||
    a.timestamp !== b.timestamp ||
    a.count !== b.count ||
    a.defaultExpanded !== b.defaultExpanded ||
    a.entries.length !== b.entries.length
  ) {
    return false;
  }

  return a.entries.every((entry, index) => entry === b.entries[index]);
}

function reuseTranscriptEntries(
  previousEntries: TranscriptEntry[] | undefined,
  nextEntries: TranscriptEntry[],
): TranscriptEntry[] {
  if (!previousEntries) {
    return nextEntries;
  }

  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry] as const));

  return nextEntries.map((entry) => {
    const previous = previousById.get(entry.id);
    return previous && sameTranscriptEntry(previous, entry) ? previous : entry;
  });
}

function flattenGroupedEntries(entries: GroupedTranscriptEntry[] | undefined): TranscriptEntry[] | undefined {
  if (!entries) return undefined;

  const flattened: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool_activity_group") {
      flattened.push(...entry.entries);
      continue;
    }
    flattened.push(entry);
  }

  return flattened;
}

function reuseGroupedEntries(
  previousEntries: GroupedTranscriptEntry[] | undefined,
  nextEntries: GroupedTranscriptEntry[],
): GroupedTranscriptEntry[] {
  if (!previousEntries) {
    return nextEntries;
  }

  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry] as const));

  return nextEntries.map((entry) => {
    const previous = previousById.get(entry.id);
    if (!previous) return entry;
    if (entry.kind === "tool_activity_group" && previous.kind === "tool_activity_group") {
      return sameToolActivityGroup(previous, entry) ? previous : entry;
    }
    if (entry.kind === "tool_activity_group" || previous.kind === "tool_activity_group") {
      return entry;
    }
    return sameTranscriptEntry(previous, entry) ? previous : entry;
  });
}

export function buildTranscriptEntries(source: TranscriptSource): TranscriptEntry[] {
  const sortable: SortableEntry[] = [];

  for (const record of source.transcriptRecords ?? []) {
    const entry = entryFromTranscriptRecord(record);
    if (entry == null) continue;
    sortable.push({
      entry,
      sortTimestamp: toMs(record.timestamp),
      sortSequence: record.sequence,
      sortPriority: TRANSCRIPT_SORT_PRIORITY.agentOrTool,
    });
  }

  for (const event of source.events) {
    const entryId = `event:${event.runId ?? "run"}:${event.sequence ?? event.timestamp}:${event.type}`;
    let entry: TranscriptEntry;

    if (event.type === "verdict") {
      entry = { kind: "verdict", id: entryId, event, timestamp: event.timestamp };
    } else if (event.type === "error") {
      entry = { kind: "error", id: entryId, message: event.detail, timestamp: event.timestamp };
    } else if (event.type === "human_reply_submitted") {
      entry = { kind: "human_reply", id: entryId, reply: event.detail, timestamp: event.timestamp };
    } else if (event.type === "tool_call" || event.type === "output") {
      entry = { kind: "tool_activity", id: entryId, event, timestamp: event.timestamp };
    } else if (event.type === "step_started" || event.type === "step_completed") {
      entry = { kind: "step_event", id: entryId, event, timestamp: event.timestamp };
    } else {
      entry = { kind: "workflow_event", id: entryId, event, timestamp: event.timestamp };
    }

    sortable.push({
      entry,
      sortTimestamp: toMs(event.timestamp),
      sortSequence: event.sequence ?? HIGH_SORT_NUMBER,
      sortPriority: eventPriority(event.type),
    });
  }

  for (const [index, interaction] of source.interactions.entries()) {
    const timestamp = interaction.requested_at;
    sortable.push({
      entry: {
        kind: "agent_question",
        id: `interaction:${interaction.id}`,
        interaction,
        timestamp: timestamp ?? undefined,
      },
      sortTimestamp: toMs(timestamp),
      sortSequence: interactionSequence(index),
      sortPriority: TRANSCRIPT_SORT_PRIORITY.humanOrQuestion,
    });
  }

  const fallbackConversationTimestamp = earliestInteractionTimestamp(source.interactions);

  for (const message of source.conversation) {
    const messageWithTimestamp = message as TimestampedConversationMessage;
    const explicitTimestamp =
      typeof messageWithTimestamp.timestamp === "string"
        ? messageWithTimestamp.timestamp
        : typeof messageWithTimestamp.created_at === "string"
          ? messageWithTimestamp.created_at
          : null;

    const maybeTimestamp = explicitTimestamp ?? fallbackConversationTimestamp;
    const entry: TranscriptEntry =
      message.role === "user"
        ? {
            kind: "human_message",
            id: `message:${message.index}`,
            message: message.content,
            timestamp: maybeTimestamp ?? undefined,
          }
        : {
            kind: "agent_message",
            id: `message:${message.index}`,
            message,
            timestamp: maybeTimestamp ?? undefined,
          };

    sortable.push({
      entry,
      sortTimestamp: toMs(maybeTimestamp),
      sortSequence: message.index,
      sortPriority:
        entry.kind === "human_message"
          ? TRANSCRIPT_SORT_PRIORITY.humanOrQuestion
          : TRANSCRIPT_SORT_PRIORITY.agentOrTool,
    });
  }

  sortable.sort((a, b) => {
    if (a.sortTimestamp !== b.sortTimestamp) return a.sortTimestamp - b.sortTimestamp;
    if (a.sortSequence !== b.sortSequence) return a.sortSequence - b.sortSequence;
    if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
    if (a.entry.id < b.entry.id) return -1;
    if (a.entry.id > b.entry.id) return 1;
    return 0;
  });

  return sortable.map(({ entry }) => entry);
}

export function groupTranscriptEntries(entries: TranscriptEntry[]): GroupedTranscriptEntry[] {
  const grouped: GroupedTranscriptEntry[] = [];
  let buffer: ToolActivityEntry[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      grouped.push(buffer[0]!);
      buffer = [];
      return;
    }

    grouped.push({
      kind: "tool_activity_group",
      id: `tool-group:${buffer[0]!.id}:${buffer.length}`,
      timestamp: buffer[0]!.timestamp,
      entries: buffer,
      count: buffer.length,
      defaultExpanded: false,
    });
    buffer = [];
  };

  for (const entry of entries) {
    if (entry.kind === "tool_activity") {
      buffer.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }

  flush();
  return grouped;
}

export function reconcileGroupedTranscriptEntries(
  previousEntries: GroupedTranscriptEntry[] | undefined,
  source: TranscriptSource,
): GroupedTranscriptEntry[] {
  const previousTranscriptEntries = flattenGroupedEntries(previousEntries);
  const nextTranscriptEntries = reuseTranscriptEntries(previousTranscriptEntries, buildTranscriptEntries(source));
  const nextGroupedEntries = groupTranscriptEntries(nextTranscriptEntries);

  return reuseGroupedEntries(previousEntries, nextGroupedEntries);
}
