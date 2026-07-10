import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import StatusBadge from "@/components/StatusBadge";
import ConfirmDialog from "@/components/ConfirmDialog";
import FinalizeApprovalDialog from "@/components/FinalizeApprovalDialog";
import EventTimeline from "@/components/EventTimeline";
import IssueInfoSection from "@/components/IssueInfoSection";
import WorkflowStepsSidebar from "@/components/WorkflowStepsSidebar";
import ArtifactsPanel from "@/components/ArtifactsPanel";
import { IssueComposer } from "@/components/issue-detail/IssueComposer";
import { IssueContextPanel } from "@/components/issue-detail/IssueContextPanel";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import { useIssueRuntime } from "./mission-control/useIssueRuntime";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

export default function IssueDetail() {
  const { identifier = "" } = useParams<{ identifier: string }>();

  return <IssueDetailContent key={identifier} identifier={identifier} />;
}

function IssueDetailContent({ identifier }: { identifier: string }) {
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false);
  const runtime = useIssueRuntime(identifier);
  const {
    data,
    isLoading,
    isError,
    error,
    interaction,
    interactionIsLoading,
    interactionIsError,
    interactionError,
    pendingQuestion,
    isLiveRun,
    wsStatus,
    events,
    transcriptEntries,
    activeTranscriptEntryId,
    transcriptSessionKey,
    transcriptIsError,
    timelineIsError,
    retryMutation,
    stopMutation,
    respondMutation,
    resumeMutation,
    cancelMutation,
    finalizeApproveMutation,
    finalizeRetryMutation,
    composerError,
    resumeQueued,
    submitInteractionReply,
    resumeInteraction,
    setActiveEntryIdForConversationIndex,
    setActiveEntryId,
  } = runtime;

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
    <div className="space-y-3">
      <ArtifactsPanel
        identifier={identifier}
        workspacePath={data.workspace.path}
        artifacts={data.artifacts ?? null}
      />
      {data.issue ? <IssueInfoSection issue={data.issue} /> : null}
    </div>
  );

  const finalizeStatus = data.finalize?.status;
  const actionError = [
    stopMutation,
    retryMutation,
    cancelMutation,
    finalizeApproveMutation,
    finalizeRetryMutation,
  ].find((mutation) => mutation.isError)?.error;
  const finalizePanel = finalizeStatus ? (
    <div className="rounded-lg border bg-card p-4 text-sm">
      {finalizeStatus === "pending_approval" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">Finalize approval required</div>
            <p className="text-muted-foreground">Approve publishing finalized workspace changes.</p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowFinalizeConfirm(true)}
            disabled={finalizeApproveMutation.isPending}
          >
            Approve finalize
          </Button>
        </div>
      ) : finalizeStatus === "failed" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">Finalize failed</div>
            <p className="text-muted-foreground">Retry finalizing workspace changes.</p>
          </div>
          <Button
            size="sm"
            onClick={() => finalizeRetryMutation.mutate({ identifier })}
            disabled={finalizeRetryMutation.isPending}
          >
            Retry finalize
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-medium">Finalize status</div>
          <div className="text-muted-foreground">{finalizeStatus}</div>
        </div>
      )}
    </div>
  ) : null;

  const rawEventsPanel = timelineIsError ? (
    <div className="space-y-3">
      <p className="text-sm text-amber-700">
        Couldn&apos;t load saved timeline history; showing live events only.
      </p>
      <EventTimeline
        events={events}
        live={isLiveRun}
        onViewConversation={setActiveEntryIdForConversationIndex}
      />
    </div>
  ) : (
    <EventTimeline
      events={events}
      live={isLiveRun}
      onViewConversation={setActiveEntryIdForConversationIndex}
    />
  );
  const interactionSubmitting =
    respondMutation.isPending || resumeMutation.isPending || resumeQueued;
  const respondPanel = interactionIsLoading ? (
    <div className="m-4 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
      Loading interaction...
    </div>
  ) : interactionIsError ? (
    <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <div className="font-medium text-destructive">Failed to load interaction</div>
      <p className="mt-1 text-muted-foreground">{errorMessage(interactionError)}</p>
    </div>
  ) : pendingQuestion ? (
    <IssueComposer
      key={`${identifier}:${pendingQuestion.interactionId}`}
      pendingQuestion={pendingQuestion}
      onSubmitReply={submitInteractionReply}
      onSubmitFollowUp={() => false}
      onResumeInteraction={resumeInteraction}
      isSubmitting={interactionSubmitting}
      error={composerError}
    />
  ) : (
    <div className="m-4 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
      No response is currently available. Use Transcript or Steps to inspect the issue.
    </div>
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

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(actionError)}
        </p>
      ) : null}

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

      {finalizePanel}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {transcriptIsError && transcriptEntries.length === 0 ? (
              <div className="rounded-lg border border-amber-300/70 bg-amber-50/60 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
                Could not load saved transcript history.
              </div>
            ) : (
              <div className="space-y-3">
                {transcriptIsError ? (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    Could not load saved transcript history; showing live activity only.
                  </p>
                ) : null}
                <RunTranscript
                  entries={transcriptEntries}
                  activeEntryId={activeTranscriptEntryId}
                  onJumpToEntry={setActiveEntryId}
                  transcriptSessionKey={transcriptSessionKey}
                />
              </div>
            )}
          </div>
          <div className="border-t bg-background">
            {respondPanel}
            {!interactionIsLoading && !interactionIsError && interaction?.status === "open" ? (
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
      <FinalizeApprovalDialog
        open={showFinalizeConfirm}
        status={data.finalize?.status ?? "not_required"}
        repos={data.finalize?.repos ?? []}
        isPending={finalizeApproveMutation.isPending}
        onConfirm={() => {
          finalizeApproveMutation.mutate({ identifier });
          setShowFinalizeConfirm(false);
        }}
        onCancel={() => setShowFinalizeConfirm(false)}
      />
    </div>
  );
}
