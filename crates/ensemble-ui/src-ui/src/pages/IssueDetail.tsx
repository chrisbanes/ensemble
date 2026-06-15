import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import {
  useCancelInteractionMutation,
  useInteractionDetailQuery,
  useIssueDetailQuery,
  useIssueInputMutation,
  useRetryMutation,
  useStepConversationQuery,
  useStopMutation,
  useTimelineQuery,
} from "@/hooks";
import { connectWs } from "@/ws";
import type { WsStatus } from "@/ws";
import type { WsEventData, WsPipelineEvent } from "@/ws-types";
import {
  isCompletionEvent,
  normalizePipelineEvent,
  timelineRecordToEventData,
  transcriptRecordKey,
} from "@/ws-events";
import { addNotification, requestPermissionIfNeeded } from "@/notifications";
import type { TranscriptRecord } from "@/generated/models";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import StatusBadge from "@/components/StatusBadge";
import ConfirmDialog from "@/components/ConfirmDialog";
import EventTimeline from "@/components/EventTimeline";
import IssueInfoSection from "@/components/IssueInfoSection";
import WorkflowStepsSidebar from "@/components/WorkflowStepsSidebar";
import { IssueComposer } from "@/components/issue-detail/IssueComposer";
import { IssueContextPanel } from "@/components/issue-detail/IssueContextPanel";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import {
  reconcileGroupedTranscriptEntries,
  type GroupedTranscriptEntry,
} from "@/components/transcript/transcript-model";

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
  const interactionId =
    data?.pending_input?.ask_id ??
    data?.current_interaction?.interaction_request_id ??
    "";
  const { data: interaction } = useInteractionDetailQuery(interactionId);
  const stopMutation = useStopMutation();
  const retryMutation = useRetryMutation();
  const inputMutation = useIssueInputMutation(identifier, interactionId);
  const cancelMutation = useCancelInteractionMutation(identifier);

  const [liveEvents, setLiveEvents] = useState<WsEventData[]>([]);
  const [liveTranscriptRecords, setLiveTranscriptRecords] = useState<TranscriptRecord[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [lastKnownRunId, setLastKnownRunId] = useState("");
  const [lastKnownStepName, setLastKnownStepName] = useState("");

  const isLiveRun = data?.running != null;
  const currentRunId = (data?.running as { run_id?: string } | undefined)?.run_id;
  const currentStepName = data?.running?.step_name ?? null;

  useEffect(() => {
    if (currentRunId) {
      setLastKnownRunId((previousRunId) =>
        previousRunId === currentRunId ? previousRunId : currentRunId,
      );
    }
  }, [currentRunId]);

  useEffect(() => {
    if (currentStepName) {
      setLastKnownStepName((previousStepName) =>
        previousStepName === currentStepName ? previousStepName : currentStepName,
      );
    }
  }, [currentStepName]);

  const effectiveRunId = currentRunId ?? lastKnownRunId;
  const activeStepName = currentStepName ?? lastKnownStepName;
  const transcriptQuery = useStepConversationQuery(identifier, effectiveRunId, activeStepName ?? "", {
    limit: 200,
  });
  const refetchTranscript = transcriptQuery.refetch;
  const transcriptSessionKey = `${identifier}:${effectiveRunId || "no-run"}:${activeStepName ?? "no-step"}`;
  const activeEntrySessionKeyRef = useRef(transcriptSessionKey);
  const timelineQuery = useTimelineQuery(identifier, effectiveRunId);
  const refetchTimeline = timelineQuery.refetch;
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
          setLiveTranscriptRecords([]);
          void refetchTranscript?.();
          void refetchTimeline?.();
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
        } else if (msg.type === "transcript_record") {
          setLiveTranscriptRecords((prev) => {
            const next = new Map(prev.map((record) => [transcriptRecordKey(record), record] as const));
            next.set(transcriptRecordKey(msg.data), msg.data);
            return Array.from(next.values()).sort((a, b) => a.sequence - b.sequence);
          });
        }
      },
      onStatusChange: setWsStatus,
    });
  }, [identifier, isLiveRun, refetchTimeline, refetchTranscript]);

  const transcriptRecords = useMemo(() => {
    const byKey = new Map<string, TranscriptRecord>();
    for (const record of transcriptQuery.data?.records ?? []) {
      byKey.set(transcriptRecordKey(record), record);
    }
    for (const record of liveTranscriptRecords) {
      if (record.run_id !== effectiveRunId || record.step_name !== activeStepName) continue;
      byKey.set(transcriptRecordKey(record), record);
    }
    return Array.from(byKey.values()).sort((a, b) => a.sequence - b.sequence);
  }, [activeStepName, effectiveRunId, liveTranscriptRecords, transcriptQuery.data?.records]);

  const activeTranscriptEntryId =
    activeEntrySessionKeyRef.current === transcriptSessionKey ? activeEntryId : null;

  const transcriptEntriesRef = useRef<GroupedTranscriptEntry[] | undefined>(undefined);
  const transcriptEntriesSessionKeyRef = useRef<string | undefined>(undefined);
  const transcriptEntries = useMemo(() => {
    const previousEntries =
      transcriptEntriesSessionKeyRef.current === transcriptSessionKey
        ? transcriptEntriesRef.current
        : undefined;

    const nextEntries = reconcileGroupedTranscriptEntries(previousEntries, {
      conversation: [],
      transcriptRecords,
      interactions: interaction ? [interaction] : [],
      events,
    });

    transcriptEntriesRef.current = nextEntries;
    transcriptEntriesSessionKeyRef.current = transcriptSessionKey;

    return nextEntries;
  }, [transcriptRecords, interaction, events, transcriptSessionKey]);

  const transcriptEntryIdForConversationIndex = (index: number) =>
    activeStepName
      ? `transcript:${effectiveRunId}:${activeStepName}:${index}`
      : `message:${index}`;

  useEffect(() => {
    activeEntrySessionKeyRef.current = transcriptSessionKey;
    setActiveEntryId(null);
    setLiveTranscriptRecords([]);
  }, [transcriptSessionKey]);

  const pendingQuestion = interaction
    ? {
        interactionId: interaction.id,
        question: interaction.question,
        whyBlocked: interaction.why_blocked,
        suggestedAnswer: interaction.suggested_answer ?? null,
        stepName: interaction.step_name,
      }
    : null;

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="py-12 text-center">
        <p className="text-destructive">
          Failed to load issue: {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (!data) return null;

  const logsPanel = (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="font-medium">Run status</div>
        <div className="mt-1 text-muted-foreground">
          {isLiveRun ? `Live websocket: ${wsStatus}` : "No active run"}
        </div>
      </div>
      {data.last_error ? (
        <div className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-red-900 dark:border-red-900 dark:bg-red-950/20 dark:text-red-100">
          <div className="font-medium">Last error</div>
          <p className="mt-1 whitespace-pre-wrap text-sm">{data.last_error}</p>
        </div>
      ) : (
        <div className="rounded-lg border bg-muted/20 p-3 text-muted-foreground">
          No errors recorded for this issue.
        </div>
      )}
      <div className="rounded-lg border bg-muted/20 p-3 text-muted-foreground">
        Transcript entries: {transcriptEntries.length}
      </div>
    </div>
  );

  const artifactsPanel = (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="font-medium">Workspace</div>
        <code className="mt-2 block rounded bg-background px-2 py-1 text-xs">{data.workspace.path}</code>
      </div>
      {data.issue ? <IssueInfoSection issue={data.issue} /> : null}
    </div>
  );

  const rawEventsPanel = timelineQuery.isError ? (
    <div className="space-y-3">
      <p className="text-sm text-amber-700">
        Couldn&apos;t load saved timeline history; showing live events only.
      </p>
      <EventTimeline
        events={events}
        live={isLiveRun}
        onViewConversation={(index) => {
        activeEntrySessionKeyRef.current = transcriptSessionKey;
        setActiveEntryId(transcriptEntryIdForConversationIndex(index));
      }}
      />
    </div>
  ) : (
    <EventTimeline
      events={events}
      live={isLiveRun}
      onViewConversation={(index) => {
        activeEntrySessionKeyRef.current = transcriptSessionKey;
        setActiveEntryId(transcriptEntryIdForConversationIndex(index));
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold">{data.issue_identifier}</h1>
              <StatusBadge status={data.status} />
              {isLiveRun ? (
                <span
                  className={`text-xs ${
                    wsStatus === "connected"
                      ? "text-green-500"
                      : wsStatus === "connecting"
                        ? "text-yellow-500"
                        : "text-muted-foreground"
                  }`}
                >
                  WS: {wsStatus}
                </span>
              ) : null}
            </div>
            {data.issue?.title ? (
              <p className="truncate text-sm text-muted-foreground">{data.issue.title}</p>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          {isLiveRun ? (
            <Button variant="destructive" size="sm" onClick={() => setShowStopConfirm(true)}>
              Stop Agent
            </Button>
          ) : null}
          {data.retry ? (
            <Button
              size="sm"
              onClick={() => retryMutation.mutate({ identifier })}
              disabled={retryMutation.isPending}
            >
              Retry Now
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Turns</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.running?.turn_count ?? 0}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Step</dt>
            <dd className="mt-1 text-lg font-semibold">{data.running?.step_name ?? "—"}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Tokens</dt>
            <dd className="mt-1 text-2xl font-semibold">
              {data.running ? formatTokens(data.running.tokens.total_tokens) : "—"}
            </dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Attempts</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.attempts.restart_count}</dd>
          </CardContent>
        </Card>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <RunTranscript
              entries={transcriptEntries}
              activeEntryId={activeTranscriptEntryId}
              onJumpToEntry={(entryId) => {
                activeEntrySessionKeyRef.current = transcriptSessionKey;
                setActiveEntryId(entryId);
              }}
              transcriptSessionKey={transcriptSessionKey}
            />
          </div>
          <div className="border-t bg-background">
            <IssueComposer
              pendingQuestion={pendingQuestion}
              onSubmitReply={(value) => inputMutation.mutate(value)}
              onSubmitFollowUp={(value) => inputMutation.mutate(value)}
              isSubmitting={inputMutation.isPending}
            />
            {interaction && interaction.status !== "resolved" ? (
              <div className="px-4 pb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancelMutation.mutate({ id: interaction.id })}
                  disabled={cancelMutation.isPending}
                >
                  Cancel Request
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        <IssueContextPanel
          workflow={
            <div className="space-y-4">
              {data.workflow_steps && data.workflow_steps.length > 0 ? (
                <WorkflowStepsSidebar
                  steps={data.workflow_steps}
                  issueIdentifier={identifier}
                  currentStep={data.running?.step_name ?? undefined}
                />
              ) : (
                <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                  No workflow steps available.
                </div>
              )}
            </div>
          }
          logs={logsPanel}
          artifacts={artifactsPanel}
          rawEvents={rawEventsPanel}
        />
      </div>

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
