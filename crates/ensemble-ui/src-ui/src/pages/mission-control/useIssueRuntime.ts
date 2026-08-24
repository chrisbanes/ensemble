import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useCancelInteractionMutation,
  useFinalizeApproveMutation,
  useFinalizeRetryMutation,
  useInteractionDetailQuery,
  useIssueDetailQuery,
  useRespondToInteractionMutation,
  useResumeIssueMutation,
  useRetryMutation,
  useStepConversationQuery,
  useStopMutation,
  useTimelineQuery,
} from "@/hooks";
import { connectWs, type WsStatus } from "@/ws";
import type { WsEventData, WsPipelineEvent } from "@/ws-types";
import {
  isCompletionEvent,
  normalizePipelineEvent,
  timelineRecordToEventData,
  transcriptRecordKey,
} from "@/ws-events";
import { addNotification, requestPermissionIfNeeded } from "@/notifications";
import { FetchError } from "@/fetch-client";
import type {
  InteractionDetail,
  InteractionKind,
  InteractionResponseBody,
  IssueDetailSnapshot,
  TranscriptRecord,
} from "@/generated/models";
import {
  reconcileGroupedTranscriptEntries,
  type GroupedTranscriptEntry,
} from "@/components/transcript/transcript-model";
import type { IssueInteractionReply } from "@/components/issue-detail/IssueComposer";
import { isSyntheticHaltedInteractionId } from "./interactionIds";

export interface PendingRuntimeQuestion {
  interactionId: string;
  kind: InteractionKind;
  status: InteractionDetail["status"];
  awaitingResume: boolean;
  question: string;
  whyBlocked: string;
  suggestedAnswer: string | null;
  stepName: string;
}

export interface IssueRuntimeState {
  identifier: string;
  data: IssueDetailSnapshot | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  interaction: InteractionDetail | undefined;
  interactionIsLoading: boolean;
  interactionIsError: boolean;
  interactionError: unknown;
  pendingQuestion: PendingRuntimeQuestion | null;
  isLiveRun: boolean;
  wsStatus: WsStatus;
  effectiveRunId: string;
  activeStepName: string | null;
  events: WsEventData[];
  transcriptEntries: GroupedTranscriptEntry[];
  activeTranscriptEntryId: string | null;
  transcriptSessionKey: string;
  transcriptIsError: boolean;
  timelineIsError: boolean;
  retryMutation: ReturnType<typeof useRetryMutation>;
  stopMutation: ReturnType<typeof useStopMutation>;
  respondMutation: ReturnType<typeof useRespondToInteractionMutation>;
  resumeMutation: ReturnType<typeof useResumeIssueMutation>;
  cancelMutation: ReturnType<typeof useCancelInteractionMutation>;
  finalizeApproveMutation: ReturnType<typeof useFinalizeApproveMutation>;
  finalizeRetryMutation: ReturnType<typeof useFinalizeRetryMutation>;
  composerError: string | null;
  resumeQueued: boolean;
  submitInteractionReply: (reply: IssueInteractionReply) => Promise<boolean>;
  resumeInteraction: () => Promise<boolean>;
  submitFollowUpInput: () => Promise<boolean>;
  setActiveEntryIdForConversationIndex: (index: number) => void;
  setActiveEntryId: (entryId: string | null) => void;
}

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function interactionResponseBody(reply: IssueInteractionReply): InteractionResponseBody {
  switch (reply.kind) {
    case "question":
      return {
        kind: "question",
        response_schema_version: 1,
        selected_option: null,
        text: reply.text,
      };
    case "approval":
      return {
        kind: "approval",
        response_schema_version: 1,
        approved: reply.approved,
        reason: reply.reason || null,
      };
    case "handoff":
      return {
        kind: "handoff",
        response_schema_version: 1,
        completed: reply.completed,
        notes: reply.notes || null,
      };
    default: {
      const exhaustive: never = reply;
      return exhaustive;
    }
  }
}

function latestTerminalStepName(data: IssueDetailSnapshot | undefined): string | null {
  if (!data || data.running) return null;

  for (let index = data.workflow_steps.length - 1; index >= 0; index -= 1) {
    const step = data.workflow_steps[index];
    if (step && (step.state === "passed" || step.state === "skipped" || step.state === "failed")) return step.name;
  }

  return null;
}

function persistedTranscriptStepName(data: IssueDetailSnapshot | undefined): string | null {
  if (!data?.artifacts || data.running) return null;

  const transcripts = data.artifacts.transcripts.filter(
    (transcript) => transcript.run_id === data.artifacts?.run_id,
  );
  // Artifact order is stable; prefer the last persisted transcript before workflow fallback.
  return transcripts[transcripts.length - 1]?.step_name ?? null;
}

export function useIssueRuntime(identifier: string): IssueRuntimeState {
  const { data, isLoading, isError, error } = useIssueDetailQuery(identifier);
  const candidateInteractionId =
    data?.pending_input?.ask_id ??
    data?.current_interaction?.interaction_request_id ??
    "";
  const interactionId = isSyntheticHaltedInteractionId(candidateInteractionId)
    ? ""
    : candidateInteractionId;
  const interactionQuery = useInteractionDetailQuery(interactionId);
  const interaction = interactionQuery.data;
  const stopMutation = useStopMutation();
  const retryMutation = useRetryMutation();
  const respondMutation = useRespondToInteractionMutation(identifier);
  const resumeMutation = useResumeIssueMutation(identifier);
  const finalizeApproveMutation = useFinalizeApproveMutation(identifier);
  const finalizeRetryMutation = useFinalizeRetryMutation(identifier);
  const cancelMutation = useCancelInteractionMutation(identifier);

  const [liveEventBuffer, setLiveEventBuffer] = useState<{
    sessionKey: string;
    events: WsEventData[];
  }>({ sessionKey: "", events: [] });
  const [liveTranscriptBuffer, setLiveTranscriptBuffer] = useState<{
    sessionKey: string;
    records: TranscriptRecord[];
  }>({ sessionKey: "", records: [] });
  const [wsState, setWsState] = useState<{ identifier: string; status: WsStatus }>({
    identifier,
    status: "disconnected",
  });
  const [activeEntry, setActiveEntry] = useState<{
    sessionKey: string;
    entryId: string | null;
  }>({ sessionKey: "", entryId: null });
  const [lastKnownRun, setLastKnownRun] = useState({ identifier, value: "" });
  const [lastKnownStep, setLastKnownStep] = useState({ identifier, runId: "", value: "" });
  const [composerErrorState, setComposerErrorState] = useState<{
    sessionKey: string;
    message: string;
  } | null>(null);
  const [awaitingResumeState, setAwaitingResumeState] = useState<{
    sessionKey: string;
    interactionId: string;
  } | null>(null);
  const [resumeQueuedState, setResumeQueuedState] = useState<{
    sessionKey: string;
    interactionId: string;
  } | null>(null);
  const [committedTranscriptEntries, setCommittedTranscriptEntries] = useState<{
    sessionKey: string;
    entries: GroupedTranscriptEntry[];
  }>({ sessionKey: "", entries: [] });

  const isLiveRun = data?.running != null;
  const currentRunId = data?.running?.run_id ?? (data?.running ? undefined : data?.artifacts?.run_id);
  const currentStepName = data?.running?.step_name ?? null;
  const selectedStepName =
    currentStepName ?? persistedTranscriptStepName(data) ?? latestTerminalStepName(data);

  useEffect(() => {
    setLastKnownRun((previous) => {
      const value = currentRunId ?? (previous.identifier === identifier ? previous.value : "");
      return previous.identifier === identifier && previous.value === value
        ? previous
        : { identifier, value };
    });
  }, [currentRunId, identifier]);

  const effectiveRunId =
    currentRunId ?? (lastKnownRun.identifier === identifier ? lastKnownRun.value : "");

  useEffect(() => {
    setLastKnownStep((previous) => {
      const sameSession =
        previous.identifier === identifier && previous.runId === effectiveRunId;
      const value = selectedStepName ?? (sameSession ? previous.value : "");
      return sameSession && previous.value === value
        ? previous
        : { identifier, runId: effectiveRunId, value };
    });
  }, [effectiveRunId, identifier, selectedStepName]);

  const activeStepName =
    selectedStepName ??
    (lastKnownStep.identifier === identifier && lastKnownStep.runId === effectiveRunId
      ? lastKnownStep.value
      : "");
  const transcriptQuery = useStepConversationQuery(identifier, effectiveRunId, activeStepName ?? "", {
    limit: 200,
  });
  const refetchTranscript = transcriptQuery.refetch;
  const transcriptSessionKey = `${identifier}:${effectiveRunId || "no-run"}:${activeStepName ?? "no-step"}`;
  const liveEventSessionKey = `${identifier}:${effectiveRunId || "no-run"}`;
  const liveEvents =
    liveEventBuffer.sessionKey === liveEventSessionKey ? liveEventBuffer.events : [];
  const liveTranscriptRecords =
    liveTranscriptBuffer.sessionKey === transcriptSessionKey
      ? liveTranscriptBuffer.records
      : [];
  const wsStatus =
    isLiveRun && wsState.identifier === identifier ? wsState.status : "disconnected";
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
    if (!identifier) return;

    let active = true;
    requestPermissionIfNeeded();
    const disconnect = connectWs({
      identifier,
      enabled: isLiveRun,
      onMessage: (msg) => {
        if (!active) return;

        if (msg.type === "snapshot") {
          setLiveEventBuffer({ sessionKey: liveEventSessionKey, events: [] });
          setLiveTranscriptBuffer({ sessionKey: transcriptSessionKey, records: [] });
          void refetchTranscript?.();
          void refetchTimeline?.();
        } else if (msg.type === "event") {
          const event = normalizePipelineEvent(msg.data);
          if (event.runId && effectiveRunId && event.runId !== effectiveRunId) {
            return;
          }
          setLiveEventBuffer((previous) => ({
            sessionKey: liveEventSessionKey,
            events: [
              ...(previous.sessionKey === liveEventSessionKey ? previous.events : []),
              event,
            ],
          }));
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
          if (
            msg.data.issue_identifier !== identifier ||
            msg.data.run_id !== effectiveRunId ||
            msg.data.step_name !== activeStepName
          ) {
            return;
          }
          setLiveTranscriptBuffer((previous) => {
            const records =
              previous.sessionKey === transcriptSessionKey ? previous.records : [];
            const next = new Map(
              records.map((record) => [transcriptRecordKey(record), record] as const),
            );
            next.set(transcriptRecordKey(msg.data), msg.data);
            return {
              sessionKey: transcriptSessionKey,
              records: Array.from(next.values()).sort((a, b) => a.sequence - b.sequence),
            };
          });
        }
      },
      onStatusChange: (status) => {
        if (active) setWsState({ identifier, status });
      },
    });

    return () => {
      active = false;
      disconnect();
    };
  }, [
    activeStepName,
    effectiveRunId,
    identifier,
    isLiveRun,
    liveEventSessionKey,
    refetchTimeline,
    refetchTranscript,
    transcriptSessionKey,
  ]);

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
    activeEntry.sessionKey === transcriptSessionKey ? activeEntry.entryId : null;
  const previousTranscriptEntries =
    committedTranscriptEntries.sessionKey === transcriptSessionKey
      ? committedTranscriptEntries.entries
      : undefined;

  const transcriptEntries = useMemo(
    () =>
      reconcileGroupedTranscriptEntries(previousTranscriptEntries, {
        conversation: [],
        transcriptRecords,
        interactions: interaction ? [interaction] : [],
        events,
      }),
    [previousTranscriptEntries, transcriptRecords, interaction, events],
  );

  useLayoutEffect(() => {
    setCommittedTranscriptEntries((previous) => {
      const entriesUnchanged =
        previous.sessionKey === transcriptSessionKey &&
        previous.entries.length === transcriptEntries.length &&
        previous.entries.every((entry, index) => entry === transcriptEntries[index]);
      return entriesUnchanged
        ? previous
        : { sessionKey: transcriptSessionKey, entries: transcriptEntries };
    });
  }, [transcriptEntries, transcriptSessionKey]);

  const transcriptEntryIdForConversationIndex = (index: number) =>
    activeStepName
      ? `transcript:${effectiveRunId}:${activeStepName}:${index}`
      : `message:${index}`;

  useEffect(() => {
    setActiveEntry({ sessionKey: transcriptSessionKey, entryId: null });
  }, [transcriptSessionKey]);

  const actionSessionKey = `${identifier}:${interactionId}`;
  const committedActionSessionKeyRef = useRef(actionSessionKey);
  const resumeRequestSessionKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    committedActionSessionKeyRef.current = actionSessionKey;
    resumeRequestSessionKeyRef.current = null;
    setComposerErrorState(null);
    setAwaitingResumeState(null);
    setResumeQueuedState(null);
  }, [actionSessionKey]);

  const composerError =
    composerErrorState?.sessionKey === actionSessionKey ? composerErrorState.message : null;
  const awaitingResumeInteractionId =
    awaitingResumeState?.sessionKey === actionSessionKey
      ? awaitingResumeState.interactionId
      : null;

  const isAwaitingResume = Boolean(
    interaction?.awaiting_resume &&
      (interaction.status === "resolved" || awaitingResumeInteractionId === interaction.id),
  );
  const resumeQueued = Boolean(
    resumeQueuedState?.sessionKey === actionSessionKey &&
      resumeQueuedState.interactionId === interactionId,
  );

  useEffect(() => {
    if (interaction?.awaiting_resume !== false) return;
    if (resumeRequestSessionKeyRef.current === actionSessionKey) {
      resumeRequestSessionKeyRef.current = null;
    }
    setResumeQueuedState((previous) =>
      previous?.sessionKey === actionSessionKey ? null : previous,
    );
  }, [actionSessionKey, interaction?.awaiting_resume]);

  const pendingQuestion = interaction && (interaction.status === "open" || isAwaitingResume)
    ? {
        interactionId: interaction.id,
        kind: interaction.kind,
        status: isAwaitingResume ? "resolved" : interaction.status,
        awaitingResume: interaction.awaiting_resume,
        question: interaction.question,
        whyBlocked: interaction.why_blocked,
        suggestedAnswer: interaction.suggested_answer ?? null,
        stepName: interaction.step_name,
      }
    : null;

  const queueResume = async (
    submittedActionSessionKey: string,
    submittedIdentifier: string,
    submittedInteractionId: string,
  ) => {
    if (resumeRequestSessionKeyRef.current === submittedActionSessionKey) return;
    resumeRequestSessionKeyRef.current = submittedActionSessionKey;
    try {
      await resumeMutation.mutateAsync({
        identifier: submittedIdentifier,
        interactionId: submittedInteractionId,
      });
    } catch (error) {
      if (resumeRequestSessionKeyRef.current === submittedActionSessionKey) {
        resumeRequestSessionKeyRef.current = null;
      }
      if (committedActionSessionKeyRef.current === submittedActionSessionKey) {
        setResumeQueuedState(null);
      }
      throw error;
    }
    if (
      committedActionSessionKeyRef.current === submittedActionSessionKey &&
      resumeRequestSessionKeyRef.current === submittedActionSessionKey
    ) {
      setResumeQueuedState({
        sessionKey: submittedActionSessionKey,
        interactionId: submittedInteractionId,
      });
    }
  };

  const resumeInteraction = async () => {
    if (!interactionId || !interaction || !isAwaitingResume) {
      setComposerErrorState({
        sessionKey: actionSessionKey,
        message: "No resolved interaction is awaiting resume.",
      });
      return false;
    }

    const submittedActionSessionKey = actionSessionKey;
    const submittedIdentifier = identifier;
    setComposerErrorState(null);
    try {
      await queueResume(submittedActionSessionKey, submittedIdentifier, interactionId);
      if (committedActionSessionKeyRef.current === submittedActionSessionKey) {
        setAwaitingResumeState(null);
      }
      return true;
    } catch (err) {
      if (committedActionSessionKeyRef.current === submittedActionSessionKey) {
        setComposerErrorState({
          sessionKey: submittedActionSessionKey,
          message: errorMessage(err),
        });
      }
      return false;
    }
  };

  const submitInteractionReply = async (reply: IssueInteractionReply) => {
    if (!interactionId) {
      setComposerErrorState({
        sessionKey: actionSessionKey,
        message: "No pending interaction to answer.",
      });
      return false;
    }
    if (!interaction) {
      setComposerErrorState({
        sessionKey: actionSessionKey,
        message: "Interaction details are still loading.",
      });
      return false;
    }
    if (isAwaitingResume) return resumeInteraction();
    if (interaction.status !== "open" || interaction.kind !== reply.kind) {
      setComposerErrorState({
        sessionKey: actionSessionKey,
        message: "The interaction response no longer matches the pending request.",
      });
      return false;
    }

    const submittedActionSessionKey = actionSessionKey;
    const submittedIdentifier = identifier;
    setComposerErrorState(null);
    try {
      if (awaitingResumeInteractionId !== interactionId) {
        try {
          await respondMutation.mutateAsync({
            id: interactionId,
            ...interactionResponseBody(reply),
          });
        } catch (responseError) {
          if (responseError instanceof FetchError && responseError.status < 500) {
            throw responseError;
          }
          let refreshedInteraction: InteractionDetail | undefined;
          try {
            refreshedInteraction = (await interactionQuery.refetch()).data;
          } catch {
            // Preserve the response error when authority cannot be refreshed.
          }
          if (
            refreshedInteraction?.status !== "resolved" ||
            !refreshedInteraction.awaiting_resume
          ) {
            throw responseError;
          }
        }
        if (committedActionSessionKeyRef.current === submittedActionSessionKey) {
          setAwaitingResumeState({
            sessionKey: submittedActionSessionKey,
            interactionId,
          });
        }
      }
      await queueResume(submittedActionSessionKey, submittedIdentifier, interactionId);
      if (committedActionSessionKeyRef.current === submittedActionSessionKey) {
        setAwaitingResumeState(null);
      }
      return true;
    } catch (err) {
      if (committedActionSessionKeyRef.current === submittedActionSessionKey) {
        setComposerErrorState({
          sessionKey: submittedActionSessionKey,
          message: errorMessage(err),
        });
      }
      return false;
    }
  };

  const submitFollowUpInput = async () => {
    setComposerErrorState({
      sessionKey: actionSessionKey,
      message: "Follow-up input is not available for this issue state.",
    });
    return false;
  };

  const setActiveEntryId = (entryId: string | null) => {
    setActiveEntry({ sessionKey: transcriptSessionKey, entryId });
  };

  const setActiveEntryIdForConversationIndex = (index: number) => {
    setActiveEntryId(transcriptEntryIdForConversationIndex(index));
  };

  return {
    identifier,
    data,
    isLoading,
    isError,
    error,
    interaction,
    interactionIsLoading: interactionQuery.isLoading,
    interactionIsError: interactionQuery.isError,
    interactionError: interactionQuery.error,
    pendingQuestion,
    isLiveRun,
    wsStatus,
    effectiveRunId,
    activeStepName,
    events,
    transcriptEntries,
    activeTranscriptEntryId,
    transcriptSessionKey,
    transcriptIsError: transcriptQuery.isError,
    timelineIsError: timelineQuery.isError,
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
    submitFollowUpInput,
    setActiveEntryIdForConversationIndex,
    setActiveEntryId,
  };
}
