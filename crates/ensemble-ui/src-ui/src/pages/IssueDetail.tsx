import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  useIssueDetailQuery,
  useStopMutation,
  useRetryMutation,
  useInteractionDetailQuery,
  useRespondToInteractionMutation,
  useCancelInteractionMutation,
  useResumeIssueMutation,
  useTimelineQuery,
} from "@/hooks";
import { connectWs } from "@/ws";
import type { WsStatus } from "@/ws";
import type { WsEventData, WsPipelineEvent } from "@/ws-types";
import { isCompletionEvent, normalizePipelineEvent, timelineRecordToEventData } from "@/ws-events";
import { addNotification, requestPermissionIfNeeded } from "@/notifications";
import type { InteractionResponseBody } from "@/generated/models";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import StatusBadge from "@/components/StatusBadge";
import ConfirmDialog from "@/components/ConfirmDialog";
import EventTimeline from "@/components/EventTimeline";
import ConversationViewer from "@/components/ConversationViewer";
import InteractionPanel from "@/components/InteractionPanel";

function triggerNotification(event: WsPipelineEvent, identifier: string) {
  const detail = event.detail ?? event.event_type;

  if (event.event_type === "error") {
    addNotification("failure", "Agent error", detail, identifier);
  } else if (event.event_type === "retry_scheduled") {
    addNotification("warning", "Retry scheduled", detail, identifier);
  } else if (event.event_type === "verdict" && event.verdict) {
    addNotification("info", `Verdict: ${event.verdict}`, detail, identifier);
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function IssueDetail() {
  const { identifier = "" } = useParams<{ identifier: string }>();
  const { data, isLoading, isError, error } = useIssueDetailQuery(identifier);
  const interactionId = data?.current_interaction?.interaction_request_id ?? "";
  const { data: interaction } = useInteractionDetailQuery(interactionId);
  const stopMutation = useStopMutation();
  const retryMutation = useRetryMutation();
  const respondMutation = useRespondToInteractionMutation(identifier);
  const cancelMutation = useCancelInteractionMutation(identifier);
  const resumeMutation = useResumeIssueMutation(identifier);

  const [liveEvents, setLiveEvents] = useState<WsEventData[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | undefined>();
  const [lastKnownRunId, setLastKnownRunId] = useState("");

  const isLiveRun = data?.running != null;
  const currentRunId = (data?.running as { run_id?: string } | undefined)?.run_id;
  useEffect(() => {
    if (currentRunId) {
      setLastKnownRunId((previousRunId) =>
        previousRunId === currentRunId ? previousRunId : currentRunId,
      );
    }
  }, [currentRunId]);

  const effectiveRunId = currentRunId ?? lastKnownRunId;
  const timelineQuery = useTimelineQuery(identifier, effectiveRunId);
  const persistedEvents = useMemo(
    () => (timelineQuery.data?.events ?? []).map(timelineRecordToEventData),
    [timelineQuery.data?.events],
  );

  const events = useMemo(() => {
    const merged = [...persistedEvents, ...liveEvents];
    const seen = new Set<string>();
    const deduped: WsEventData[] = [];
    for (const event of merged) {
      const key =
        event.runId && event.sequence != null
          ? `${event.runId}:${event.sequence}`
          : [
              event.type,
              event.timestamp,
              event.detail,
              event.stepName ?? "",
              event.attempt ?? "",
              event.conversationIndex ?? "",
            ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }
    return deduped.sort((a, b) => {
      if (a.runId && b.runId && a.runId === b.runId && a.sequence != null && b.sequence != null) {
        return a.sequence - b.sequence;
      }
      const tsDelta = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (tsDelta !== 0) {
        return tsDelta;
      }
      return (a.sequence ?? 0) - (b.sequence ?? 0);
    });
  }, [liveEvents, persistedEvents]);

  useEffect(() => {
    requestPermissionIfNeeded();
    return connectWs({
      identifier,
      enabled: isLiveRun,
      onMessage: (msg) => {
        if (msg.type === "snapshot") {
          setLiveEvents([]);
        } else if (msg.type === "event") {
          const event = normalizePipelineEvent(msg.data);
          setLiveEvents((prev) => [...prev, event]);
          triggerNotification(msg.data, identifier);

          if (isCompletionEvent(msg.data)) {
            const severity = msg.data.outcome === "succeeded" ? "success" : "failure";
            addNotification(
              severity,
              `Run ${msg.data.outcome}`,
              `${identifier} ${msg.data.outcome}`,
              identifier,
            );
          }
        }
      },
      onStatusChange: setWsStatus,
    });
  }, [identifier, isLiveRun]);

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load issue: {error instanceof Error ? error.message : "Unknown error"}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-bold">{data.issue_identifier}</h1>
          <StatusBadge status={data.status} />
          {isLiveRun && (
            <span className={`text-xs ${wsStatus === "connected" ? "text-green-500" : wsStatus === "connecting" ? "text-yellow-500" : "text-muted-foreground"}`}>
              WS: {wsStatus}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {isLiveRun && (
            <Button variant="destructive" size="sm" onClick={() => setShowStopConfirm(true)}>
              Stop Agent
            </Button>
          )}
          {data.retry && (
            <Button size="sm" onClick={() => retryMutation.mutate({ identifier })} disabled={retryMutation.isPending}>
              Retry Now
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Turns</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.running?.turn_count ?? 0}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Step</dt>
            <dd className="mt-1 text-lg font-semibold">{data.running?.step_name ?? "\u2014"}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Tokens</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.running ? formatTokens(data.running.tokens.total_tokens) : "\u2014"}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Attempts</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.attempts.restart_count}</dd>
          </CardContent>
        </Card>
      </div>

      {data.last_error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Last Error</h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{data.last_error}</p>
        </div>
      )}

      {interaction && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Interaction</h2>
          <Card className="p-4">
            <InteractionPanel
              interaction={interaction}
              issueIdentifier={identifier}
              onRespond={(payload: InteractionResponseBody) =>
                respondMutation.mutate({ id: interaction.id, data: payload })
              }
              onCancel={() => cancelMutation.mutate({ id: interaction.id })}
              onResume={() => resumeMutation.mutate({ identifier })}
              isResponding={respondMutation.isPending}
              isCancelling={cancelMutation.isPending}
              isResuming={resumeMutation.isPending}
            />
          </Card>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h2 className="text-lg font-semibold mb-3">Event Timeline</h2>
          {timelineQuery.isError && (
            <p className="mb-2 text-sm text-amber-700">
              Couldn&apos;t load saved timeline history; showing live events only.
            </p>
          )}
          <Card className="p-4 max-h-[600px] overflow-y-auto">
            <EventTimeline events={events} live={isLiveRun} onViewConversation={(idx) => setHighlightIndex(idx)} />
          </Card>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-3">Conversation</h2>
          <Card className="p-4 max-h-[600px] overflow-y-auto">
            <ConversationViewer identifier={identifier} scrollToIndex={highlightIndex} />
          </Card>
        </section>
      </div>

      <Card className="p-4">
        <span className="text-sm text-muted-foreground">
          Workspace: <code className="bg-muted px-1 rounded">{data.workspace.path}</code>
        </span>
      </Card>

      <ConfirmDialog
        open={showStopConfirm}
        title="Stop Agent"
        message={`Are you sure you want to stop the agent for ${identifier}? This action cannot be undone.`}
        confirmLabel="Stop"
        onConfirm={() => {
          stopMutation.mutate({ identifier });
          setShowStopConfirm(false);
        }}
        onCancel={() => setShowStopConfirm(false)}
      />
    </div>
  );
}
