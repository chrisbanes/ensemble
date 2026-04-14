import type { ConversationMessage, InteractionDetail } from "@/generated/models";
import type { WsEventData } from "@/ws-types";

export interface TranscriptSource {
  conversation: ConversationMessage[];
  interaction: InteractionDetail | null;
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

export interface ToolActivityEntry extends TranscriptEntryBase {
  kind: "tool_activity";
  event: WsEventData;
}

export type TranscriptEntry =
  | StepEventEntry
  | VerdictEntry
  | AgentQuestionEntry
  | AgentMessageEntry
  | ToolActivityEntry;

export interface ToolActivityGroupEntry extends TranscriptEntryBase {
  kind: "tool_activity_group";
  entries: ToolActivityEntry[];
  count: number;
  defaultExpanded: false;
}

export type GroupedTranscriptEntry = TranscriptEntry | ToolActivityGroupEntry;

type SortableEntry = {
  entry: TranscriptEntry;
  sortTimestamp: number;
  sortSequence: number;
  sortPriority: number;
};

const HIGH_SORT_NUMBER = Number.MAX_SAFE_INTEGER;

function toMs(timestamp: string | null | undefined): number {
  if (!timestamp) return HIGH_SORT_NUMBER;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? HIGH_SORT_NUMBER : ms;
}

function eventPriority(eventType: string): number {
  if (eventType === "step_started" || eventType === "step_completed") return 0;
  if (eventType === "verdict") return 4;
  if (eventType === "tool_call" || eventType === "output") return 2;
  return 1;
}

function entryPriority(entry: TranscriptEntry): number {
  switch (entry.kind) {
    case "step_event":
      return 0;
    case "agent_question":
      return 1;
    case "agent_message":
      return 2;
    case "tool_activity":
      return 3;
    case "verdict":
      return 4;
  }
}

export function buildTranscriptEntries(source: TranscriptSource): TranscriptEntry[] {
  const sortable: SortableEntry[] = [];

  for (const event of source.events) {
    const kind: TranscriptEntry["kind"] =
      event.type === "verdict"
        ? "verdict"
        : event.type === "tool_call" || event.type === "output"
          ? "tool_activity"
          : "step_event";

    const entry: TranscriptEntry =
      kind === "verdict"
        ? {
            kind,
            id: `event:${event.runId ?? "run"}:${event.sequence ?? event.timestamp}:${event.type}`,
            event,
            timestamp: event.timestamp,
          }
        : kind === "tool_activity"
          ? {
              kind,
              id: `event:${event.runId ?? "run"}:${event.sequence ?? event.timestamp}:${event.type}`,
              event,
              timestamp: event.timestamp,
            }
          : {
              kind,
              id: `event:${event.runId ?? "run"}:${event.sequence ?? event.timestamp}:${event.type}`,
              event,
              timestamp: event.timestamp,
            };

    sortable.push({
      entry,
      sortTimestamp: toMs(event.timestamp),
      sortSequence: event.sequence ?? HIGH_SORT_NUMBER,
      sortPriority: eventPriority(event.type),
    });
  }

  if (source.interaction) {
    const interaction = source.interaction;
    const timestamp = interaction.requested_at;
    sortable.push({
      entry: {
        kind: "agent_question",
        id: `interaction:${interaction.id}`,
        interaction,
        timestamp: timestamp ?? undefined,
      },
      sortTimestamp: toMs(timestamp),
      sortSequence: HIGH_SORT_NUMBER - 2,
      sortPriority: 1,
    });
  }

  const fallbackConversationTimestamp = source.interaction?.requested_at ?? null;

  for (const message of source.conversation) {
    const explicitTimestamp =
      typeof (message as { timestamp?: unknown }).timestamp === "string"
        ? ((message as { timestamp: string }).timestamp)
        : typeof (message as { created_at?: unknown }).created_at === "string"
          ? ((message as { created_at: string }).created_at)
          : null;

    const maybeTimestamp = explicitTimestamp ?? fallbackConversationTimestamp;

    sortable.push({
      entry: {
        kind: "agent_message",
        id: `message:${message.index}`,
        message,
        timestamp: maybeTimestamp ?? undefined,
      },
      sortTimestamp: toMs(maybeTimestamp),
      sortSequence: explicitTimestamp ? message.index : HIGH_SORT_NUMBER - 1,
      sortPriority: 2,
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
