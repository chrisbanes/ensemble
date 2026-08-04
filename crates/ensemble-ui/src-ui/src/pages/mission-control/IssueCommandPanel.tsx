import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import ArtifactsPanel from "@/components/ArtifactsPanel";
import { AcceptanceEvidencePanel } from "@/components/AcceptanceEvidencePanel";
import ConfirmDialog from "@/components/ConfirmDialog";
import FinalizeApprovalDialog from "@/components/FinalizeApprovalDialog";
import EventTimeline from "@/components/EventTimeline";
import IssueInfoSection from "@/components/IssueInfoSection";
import StatusBadge from "@/components/StatusBadge";
import WorkflowStepsSidebar from "@/components/WorkflowStepsSidebar";
import { IssueComposer } from "@/components/issue-detail/IssueComposer";
import { RunTranscript } from "@/components/transcript/RunTranscript";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIssueRuntime } from "./useIssueRuntime";

export type IssueCommandPanelTab =
  | "overview"
  | "respond"
  | "steps"
  | "transcript"
  | "logs"
  | "acceptance"
  | "artifacts";

interface IssueCommandPanelProps {
  identifier: string | null;
  activeTab: IssueCommandPanelTab;
  onActiveTabChange: (tab: IssueCommandPanelTab) => void;
  onClose: () => void;
}

const TABS: Array<{ id: IssueCommandPanelTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "respond", label: "Respond" },
  { id: "steps", label: "Steps" },
  { id: "transcript", label: "Transcript" },
  { id: "logs", label: "Logs" },
  { id: "acceptance", label: "Acceptance" },
  { id: "artifacts", label: "Artifacts" },
];

function formatTokens(value: number | undefined): string {
  if (value == null) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function PanelCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close issue panel">
      <X className="h-4 w-4" />
    </Button>
  );
}

export function IssueCommandPanel({
  identifier,
  activeTab,
  onActiveTabChange,
  onClose,
}: IssueCommandPanelProps) {
  return (
    <IssueCommandPanelContent
      key={identifier === null ? "empty" : `issue:${identifier}`}
      identifier={identifier}
      activeTab={activeTab}
      onActiveTabChange={onActiveTabChange}
      onClose={onClose}
    />
  );
}

function IssueCommandPanelContent({
  identifier,
  activeTab,
  onActiveTabChange,
  onClose,
}: IssueCommandPanelProps) {
  const runtime = useIssueRuntime(identifier ?? "");
  const [stopConfirmationIdentifier, setStopConfirmationIdentifier] = useState<string | null>(
    null,
  );
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false);
  const tabSetId = useId();
  const tabPanelId = `${tabSetId}-panel`;
  const tabId = (tab: IssueCommandPanelTab) => `${tabSetId}-${tab}`;
  const requestedFocusTab = useRef<IssueCommandPanelTab | null>(null);

  useEffect(() => {
    if (requestedFocusTab.current !== activeTab) return;
    document.getElementById(`${tabSetId}-${activeTab}`)?.focus();
    requestedFocusTab.current = null;
  }, [activeTab, tabSetId]);

  const activateTab = (tab: IssueCommandPanelTab, moveFocus = false) => {
    if (moveFocus) requestedFocusTab.current = tab;
    onActiveTabChange(tab);
  };

  if (!identifier) {
    return (
      <aside className="flex h-full min-h-[28rem] w-full flex-col rounded-xl border bg-card p-6 lg:w-[28rem]">
        <h2 className="text-lg font-semibold">Select an issue</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose an issue from the board, list, or attention queue to inspect and intervene.
        </p>
      </aside>
    );
  }

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
    return (
      <aside className="min-h-[28rem] w-full rounded-xl border bg-card p-6 lg:w-[30rem] xl:w-[34rem]">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm text-muted-foreground">Loading issue...</span>
          <PanelCloseButton onClose={onClose} />
        </div>
      </aside>
    );
  }

  if (isError || !data) {
    return (
      <aside className="min-h-[28rem] w-full rounded-xl border bg-card p-6 lg:w-[30rem] xl:w-[34rem]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-destructive">Failed to load issue</div>
            <p className="mt-2 text-sm text-muted-foreground">
              {isError ? errorMessage(error) : "Issue details were not returned."}
            </p>
          </div>
          <PanelCloseButton onClose={onClose} />
        </div>
      </aside>
    );
  }

  const finalizeStatus = data.finalize.status;
  const actionError = [
    stopMutation,
    retryMutation,
    cancelMutation,
    finalizeApproveMutation,
    finalizeRetryMutation,
  ].find((mutation) => mutation.isError)?.error;
  const interactionSubmitting =
    respondMutation.isPending || resumeMutation.isPending || resumeQueued;
  const activeTabId = tabId(activeTab);
  const currentAgent = data.running?.step_name
    ? data.workflow_steps.find((step) => step.name === data.running?.step_name)?.agent
    : undefined;
  const latestEvent = events[events.length - 1];
  const latestActivity = latestEvent?.detail ?? data.running?.last_event ?? data.running?.last_message;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = TABS.length - 1;
        break;
    }

    if (nextIndex == null) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex]!;
    activateTab(nextTab.id, true);
  };

  const tabContent = (() => {
    switch (activeTab) {
      case "overview":
        return (
          <div className="space-y-4">
            {pendingQuestion ? (
              <button
                type="button"
                onClick={() => activateTab("respond", true)}
                className="w-full rounded-lg border border-primary/40 bg-primary/5 p-3 text-left transition-colors hover:bg-primary/10"
              >
                <div className="text-sm font-semibold text-primary">Agent needs input</div>
                <p className="mt-1 text-sm">{pendingQuestion.question}</p>
              </button>
            ) : null}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-muted-foreground">Status</div>
                <div className="mt-1 font-semibold">{data.status}</div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-muted-foreground">Current step</div>
                <div className="mt-1 font-semibold">{data.running?.step_name ?? "--"}</div>
              </div>
              {currentAgent ? (
                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="text-muted-foreground">Current agent</div>
                  <div className="mt-1 font-semibold">{currentAgent}</div>
                </div>
              ) : null}
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-muted-foreground">Attempts</div>
                <div className="mt-1 font-semibold">{data.attempts.restart_count}</div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-muted-foreground">Turns</div>
                <div className="mt-1 font-semibold">{data.running?.turn_count ?? 0}</div>
              </div>
              <div className="col-span-2 rounded-lg border bg-muted/20 p-3">
                <div className="text-muted-foreground">Tokens</div>
                <div className="mt-1 font-semibold">
                  {formatTokens(data.running?.tokens.total_tokens)}
                </div>
              </div>
            </div>

            {data.retry ? (
              <div className="rounded-lg border border-amber-300/70 bg-amber-50/60 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/20">
                <div className="font-medium">Scheduled retry</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  <span>Attempt {data.retry.attempt}</span>
                  <span>{new Date(data.retry.due_at_ms).toLocaleString()}</span>
                </div>
                {data.retry.error ? <p className="mt-2 whitespace-pre-wrap">{data.retry.error}</p> : null}
              </div>
            ) : null}

            {latestActivity ? (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="font-medium">Latest activity</div>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{latestActivity}</p>
              </div>
            ) : null}

            {finalizeStatus !== "not_required" ? (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="font-medium">Finalize</div>
                <div className="mt-1 text-muted-foreground">{finalizeStatus}</div>
              </div>
            ) : null}

            {data.last_error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <div className="font-medium text-destructive">Last error</div>
                <p className="mt-1 whitespace-pre-wrap">{data.last_error}</p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => activateTab("steps", true)}>
                View steps
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => activateTab("transcript", true)}
              >
                View transcript
              </Button>
              <Button variant="outline" size="sm" onClick={() => activateTab("logs", true)}>
                View logs
              </Button>
            </div>
          </div>
        );
      case "respond":
        return (
          <div className="space-y-3">
            {interactionIsLoading ? (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                Loading interaction...
              </div>
            ) : interactionIsError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
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
              <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                No response is currently available. Use Transcript or Steps to inspect the issue.
              </div>
            )}
            {!interactionIsLoading && !interactionIsError && interaction?.status === "open" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancelMutation.mutate({ id: interaction.id })}
                disabled={cancelMutation.isPending}
              >
                Cancel Request
              </Button>
            ) : null}
          </div>
        );
      case "steps":
        return data.workflow_steps.length > 0 ? (
          <WorkflowStepsSidebar
            steps={data.workflow_steps}
            issueIdentifier={identifier}
            currentStep={data.running?.step_name ?? undefined}
          />
        ) : (
          <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
            No workflow steps available.
          </div>
        );
      case "transcript":
        return transcriptIsError && transcriptEntries.length === 0 ? (
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
        );
      case "logs":
        return (
          <div className="space-y-3">
            {timelineIsError ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Could not load saved timeline history; showing live events only.
              </p>
            ) : null}
            <EventTimeline
              events={events}
              live={isLiveRun}
              onViewConversation={(index) => {
                setActiveEntryIdForConversationIndex(index);
                activateTab("transcript", true);
              }}
            />
          </div>
        );
      case "acceptance":
        return <AcceptanceEvidencePanel attempts={data.acceptance_attempts} />;
      case "artifacts":
        return (
          <div className="space-y-3">
            {data.artifacts ? (
              <ArtifactsPanel
                identifier={identifier}
                workspacePath={data.workspace.path}
                artifacts={data.artifacts}
              />
            ) : (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                No run artifacts recorded.
              </div>
            )}
            <IssueInfoSection issue={data.issue} />
          </div>
        );
    }
  })();

  return (
    <aside className="flex h-full min-h-[34rem] w-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:w-[30rem] xl:w-[34rem]">
      <div className="border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{data.issue_identifier}</h2>
              <StatusBadge status={data.status} />
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">{data.issue.title}</p>
          </div>
          <PanelCloseButton onClose={onClose} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isLiveRun ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setStopConfirmationIdentifier(identifier)}
            >
              Stop
            </Button>
          ) : null}
          {data.retry ? (
            <Button
              size="sm"
              onClick={() => retryMutation.mutate({ identifier })}
              disabled={retryMutation.isPending}
            >
              Retry
            </Button>
          ) : null}
          {finalizeStatus === "pending_approval" ? (
            <Button
              size="sm"
              onClick={() => setShowFinalizeConfirm(true)}
              disabled={finalizeApproveMutation.isPending}
            >
              Approve finalize
            </Button>
          ) : null}
          {finalizeStatus === "failed" ? (
            <Button
              size="sm"
              onClick={() => finalizeRetryMutation.mutate({ identifier })}
              disabled={finalizeRetryMutation.isPending}
            >
              Retry finalize
            </Button>
          ) : null}
          <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">
            WS: {isLiveRun ? wsStatus : "inactive"}
          </span>
        </div>

        {actionError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {errorMessage(actionError)}
          </p>
        ) : null}
      </div>

      <div role="tablist" aria-label="Issue command views" className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={tabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={tabPanelId}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => onActiveTabChange(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
              activeTab === tab.id && "bg-muted text-foreground",
              tab.id === "respond" && pendingQuestion && "text-primary",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={activeTabId}
        className="min-h-0 flex-1 overflow-auto p-4"
      >
        {tabContent}
      </div>

      <ConfirmDialog
        open={stopConfirmationIdentifier === identifier}
        title="Stop Agent"
        message={`Are you sure you want to stop the agent for ${identifier}? This action cannot be undone.`}
        confirmLabel="Stop"
        onConfirm={() => {
          stopMutation.mutate({ identifier });
          setStopConfirmationIdentifier(null);
        }}
        onCancel={() => setStopConfirmationIdentifier(null)}
      />
      <FinalizeApprovalDialog
        open={showFinalizeConfirm}
        status={data.finalize.status}
        repos={data.finalize.repos}
        isPending={finalizeApproveMutation.isPending}
        onConfirm={() => {
          finalizeApproveMutation.mutate({ identifier });
          setShowFinalizeConfirm(false);
        }}
        onCancel={() => setShowFinalizeConfirm(false)}
      />
    </aside>
  );
}
