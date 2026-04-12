import type { WsEventData } from "@/ws-types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface EventTimelineProps {
  events: WsEventData[];
  live: boolean;
  onViewConversation?: (index: number) => void;
}

const dotColors: Record<string, string> = {
  turn_completed: "bg-green-500",
  tool_call: "bg-purple-500",
  output: "bg-indigo-500",
  step_started: "bg-blue-500",
  step_completed: "bg-blue-500",
  verdict: "bg-yellow-500",
  error: "bg-red-500",
};

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

interface AggregatedEvent extends WsEventData {
  aggregatedCount?: number;
}

function getEventContext(event: WsEventData): string {
  return `${event.runId ?? ''}:${event.stepName ?? ''}:${event.attempt ?? 1}`;
}

export function aggregateOutputEvents(events: WsEventData[]): AggregatedEvent[] {
  const result: AggregatedEvent[] = [];
  let outputBuffer: WsEventData[] = [];
  let currentContext: string = '';

  for (const event of events) {
    if (event.type === 'output') {
      const context = getEventContext(event);
      // Start new buffer if context changes (different run/step/attempt)
      if (outputBuffer.length > 0 && context !== currentContext) {
        result.push(flushOutputBuffer(outputBuffer));
        outputBuffer = [];
      }
      currentContext = context;
      outputBuffer.push(event);
    } else {
      if (outputBuffer.length > 0) {
        result.push(flushOutputBuffer(outputBuffer));
        outputBuffer = [];
      }
      result.push(event);
    }
  }

  if (outputBuffer.length > 0) {
    result.push(flushOutputBuffer(outputBuffer));
  }

  return result;
}

function flushOutputBuffer(buffer: WsEventData[]): AggregatedEvent {
  const first = buffer[0]!;
  const content = buffer.map(e => e.detail).join('');
  return {
    type: first.type,
    timestamp: first.timestamp,
    detail: content,
    runId: first.runId,
    sequence: first.sequence,
    stepName: first.stepName,
    attempt: first.attempt,
    conversationIndex: first.conversationIndex,
    aggregatedCount: buffer.length > 1 ? buffer.length : undefined
  };
}

export default function EventTimeline({ events, live, onViewConversation }: EventTimelineProps) {
  const aggregatedEvents = aggregateOutputEvents(events);
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {live ? "Waiting for events..." : "No events recorded."}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {live && (
        <div className="flex items-center gap-2 mb-3 text-xs text-green-600 dark:text-green-400">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          Live
        </div>
      )}
      <div className="flow-root">
        <ul className="-mb-8">
          {aggregatedEvents.map((event, idx) => {
            const dotColor = dotColors[event.type] ?? "bg-gray-400";
            const isLast = idx === aggregatedEvents.length - 1;
            const conversationIndex = event.conversationIndex;

            return (
              <li key={idx}>
                <div className="relative pb-8">
                  {!isLast && (
                    <span className="absolute left-3 top-4 -ml-px h-full w-0.5 bg-border" aria-hidden="true" />
                  )}
                  <div className="relative flex items-start gap-3">
                    <div className="flex-shrink-0">
                      <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full", dotColor)}>
                        <span className="sr-only">{event.type}</span>
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{event.type}</span>
                        {event.stepName && (
                          <span className="text-xs text-muted-foreground">step: {event.stepName}</span>
                        )}
                        {(event.attempt ?? 1) > 1 && (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-900 border-amber-300">
                            Retry • Attempt {event.attempt}
                          </Badge>
                        )}
                        <span className="ml-2 text-muted-foreground text-xs">{formatTime(event.timestamp)}</span>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p>
                      {event.aggregatedCount && (
                        <Badge variant="outline" className="text-xs">
                          {event.aggregatedCount} chunks
                        </Badge>
                      )}
                      {event.type === "turn_completed" && conversationIndex != null && onViewConversation && (
                        <button
                          onClick={() => onViewConversation(conversationIndex)}
                          className="mt-1 text-xs text-primary hover:underline"
                        >
                          View in conversation
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
