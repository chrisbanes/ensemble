import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getState } from "./generated/api/state/state";
import { getHistory, getTimeline } from "./generated/api/history/history";
import { listDirectory } from "./generated/api/filesystem/filesystem";
import {
  postFinalizeApprove,
  postFinalizeRetry,
  postRefresh,
  postResumeIssue,
  postRetry,
  postStop,
} from "./generated/api/controls/controls";
import { getStepConversation } from "./generated/api/conversation/conversation";
import { getIssueDetail, getStepDetail } from "./generated/api/issues/issues";
import {
  listOpenInteractions,
  getInteractionById,
  respondToInteraction,
  cancelInteraction,
} from "./generated/api/interactions/interactions";
import {
  saveSetup,
  validateSetup,
  saveYaml,
  validateYaml,
  saveGuidedForm,
  validateGuidedForm,
  getConfig,
  getSetupDefaults,
} from "./generated/api/config/config";
import type {
  GetStepConversationParams,
  GetHistoryParams,
  RuntimeSnapshot,
  IssueDetailSnapshot,
  TranscriptResponse,
  HistoryResponse,
  ConfigStateResponse,
  GuidedConfigForm,
  InteractionRequest,
  InteractionDetail,
  ValidateSetupRequest,
  SaveSetupRequest,
  ValidateYamlRequest,
  SaveYamlRequest,
  ValidateGuidedFormRequest,
  SaveGuidedFormRequest,
  InteractionResponseBody,
  ListDirectoryParams,
  ListResponse,
  FinalizeStatus,
  RepoFinalizeSnapshot,
  StepDetailSnapshot,
  StepTranscriptArtifact,
  TimelineEventRecord,
  TimelineResponse,
} from "./generated/models";

/**
 * Query key constants (replaces generated orval keys that were removed in v8.16.0).
 */
const STATE_QUERY_KEY = ["/api/v1/state"] as const;
const CONFIG_QUERY_KEY = ["getConfig"] as const;
const LIST_OPEN_INTERACTIONS_KEY = ["listOpenInteractions"] as const;

function pathSegment(value: string) {
  return encodeURIComponent(value);
}

function issueDetailQueryKey(identifier: string) {
  return ["getIssueDetail", identifier] as const;
}

function interactionByIdQueryKey(id: string) {
  return ["getInteractionById", id] as const;
}

function aggregateFinalizeStatus(repos: RepoFinalizeSnapshot[]): FinalizeStatus {
  if (repos.every((repo) => repo.status === "succeeded")) return "succeeded";
  if (repos.some((repo) => repo.status === "in_progress")) return "in_progress";
  return "pending_approval";
}

function markFinalizeTransition(
  queryClient: QueryClient,
  identifier: string,
  previousStatus: "pending_approval" | "failed",
) {
  queryClient.setQueryData<IssueDetailSnapshot>(issueDetailQueryKey(identifier), (current) => {
    if (!current) return current;

    const repos = current.finalize.repos.map((repo) =>
      repo.status === previousStatus
        ? {
            ...repo,
            status:
              previousStatus === "failed" && repo.approval_required
                ? ("pending_approval" as const)
                : ("in_progress" as const),
            last_error: null,
          }
        : repo,
    );

    return {
      ...current,
      finalize: {
        ...current.finalize,
        status: aggregateFinalizeStatus(repos),
        repos,
      },
    };
  });
}

export function useStateQuery() {
  return useQuery({
    queryKey: STATE_QUERY_KEY,
    refetchInterval: 3000,
    queryFn: () => getState(),
    select: (resp) => resp.data as RuntimeSnapshot,
  });
}

/**
 * Computes a countdown (in seconds) until the next backend orchestrator poll.
 * Returns null if the orchestrator hasn't ticked yet.
 */
export function useNextPollCountdown(
  lastTickAt: string | null | undefined,
  pollIntervalMs: number | undefined,
): number | null {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!lastTickAt || !pollIntervalMs) {
      setSecondsRemaining(null);
      return;
    }

    const lastTickMs = new Date(lastTickAt).getTime();
    const compute = () => {
      const nextPollMs = lastTickMs + pollIntervalMs;
      const remaining = Math.max(0, Math.ceil((nextPollMs - Date.now()) / 1000));
      setSecondsRemaining(remaining);
    };

    compute();
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [lastTickAt, pollIntervalMs]);

  return secondsRemaining;
}

export function useIssueDetailQuery(identifier: string) {
  return useQuery({
    queryKey: issueDetailQueryKey(identifier),
    refetchInterval: 2000,
    enabled: identifier.length > 0,
    queryFn: async (): Promise<IssueDetailSnapshot> => {
      const resp = await getIssueDetail(pathSegment(identifier));
      return resp.data as IssueDetailSnapshot;
    },
  });
}

export type { StepDetailSnapshot, StepTranscriptArtifact, TimelineEventRecord, TimelineResponse };

export function useTimelineQuery(identifier: string, runId?: string, limit = 200) {
  return useQuery({
    queryKey: ["timeline", identifier, runId, limit],
    enabled: identifier.length > 0 && (runId?.length ?? 0) > 0,
    queryFn: async (): Promise<TimelineResponse> => {
      const response = await getTimeline(pathSegment(identifier), {
        run_id: runId ?? "",
        limit,
      });
      return response.data as TimelineResponse;
    },
  });
}

export function useStepDetailQuery(identifier: string, stepName: string) {
  return useQuery({
    queryKey: ["stepDetail", identifier, stepName],
    enabled: identifier.length > 0 && stepName.length > 0,
    queryFn: async (): Promise<StepDetailSnapshot> => {
      const response = await getStepDetail(pathSegment(identifier), pathSegment(stepName));
      return response.data as StepDetailSnapshot;
    },
  });
}

export function useInteractionsQuery() {
  return useQuery({
    queryKey: LIST_OPEN_INTERACTIONS_KEY,
    refetchInterval: 3000,
    queryFn: async (): Promise<InteractionRequest[]> => {
      const resp = await listOpenInteractions();
      return resp.data as InteractionRequest[];
    },
  });
}

export function useInteractionDetailQuery(id: string) {
  return useQuery({
    queryKey: interactionByIdQueryKey(id),
    enabled: id.length > 0,
    refetchInterval: (query) => {
      const detail = query.state.data;
      return detail?.status === "resolved" && detail.awaiting_resume ? 2000 : false;
    },
    staleTime: (query) => {
      const detail = query.state.data;
      return detail?.status === "resolved" && !detail.awaiting_resume ? Infinity : 0;
    },
    queryFn: async (): Promise<InteractionDetail> => {
      const resp = await getInteractionById(id);
      return resp.data as InteractionDetail;
    },
  });
}

export function useStepConversationQuery(
  identifier: string,
  runId: string,
  stepName: string,
  params: GetStepConversationParams = {},
) {
  return useQuery({
    queryKey: ["getStepConversation", identifier, runId, stepName, params],
    enabled: identifier.length > 0 && runId.length > 0 && stepName.length > 0,
    queryFn: async (): Promise<TranscriptResponse> => {
      const resp = await getStepConversation(
        pathSegment(identifier),
        pathSegment(runId),
        pathSegment(stepName),
        params,
      );
      return resp.data as TranscriptResponse;
    },
  });
}

export function useHistoryQuery(params: GetHistoryParams) {
  return useQuery({
    queryKey: ["getHistory", params],
    queryFn: async (): Promise<HistoryResponse> => {
      const resp = await getHistory(params);
      return resp.data as HistoryResponse;
    },
  });
}

export function useConfigStateQuery() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    staleTime: 60_000,
    queryFn: async (): Promise<ConfigStateResponse> => {
      const resp = await getConfig();
      return resp.data as ConfigStateResponse;
    },
  });
}

export function useSetupDefaultsQuery() {
  return useQuery({
    queryKey: ["getSetupDefaults"],
    queryFn: () => getSetupDefaults(),
  });
}

export function useValidateYamlDraftMutation() {
  return useMutation({
    mutationFn: (params: { data: ValidateYamlRequest }) => validateYaml(params.data),
  });
}

export function useSaveYamlDraftMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { data: SaveYamlRequest }) => saveYaml(params.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY });
    },
  });
}

export function useValidateSetupMutation() {
  return useMutation({
    mutationFn: (params: { data: ValidateSetupRequest }) => validateSetup(params.data),
  });
}

export function useSaveSetupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { data: SaveSetupRequest }) => saveSetup(params.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY });
    },
  });
}

export function useRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postRefresh(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
    },
  });
}

export function useStopMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string }) =>
      postStop(pathSegment(params.identifier)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
    },
  });
}

export function useRetryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string }) =>
      postRetry(pathSegment(params.identifier)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
    },
  });
}

export function useRespondToInteractionMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & InteractionResponseBody) =>
      respondToInteraction(id, body),
    onSuccess: async (response, variables) => {
      const interactionData = response.data;
      if ("status" in interactionData) {
        queryClient.setQueryData<InteractionDetail>(
          interactionByIdQueryKey(variables.id),
          (current) =>
            current
              ? {
                  ...current,
                  status: interactionData.status,
                  awaiting_resume: interactionData.awaiting_resume ?? current.awaiting_resume,
                }
              : current,
        );
      }
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY }),
        queryClient.invalidateQueries({ queryKey: interactionByIdQueryKey(variables.id) }),
      ];
      if (identifier) {
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: issueDetailQueryKey(identifier) }),
        );
      }
      await Promise.all(invalidations);
    },
  });
}

export function useCancelInteractionMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string }) => cancelInteraction(params.id),
    onSuccess: async (response, variables) => {
      const interactionData = response.data;
      if ("status" in interactionData) {
        queryClient.setQueryData<InteractionDetail>(
          interactionByIdQueryKey(variables.id),
          (current) =>
            current
              ? {
                  ...current,
                  status: interactionData.status,
                  awaiting_resume: interactionData.awaiting_resume ?? current.awaiting_resume,
                }
              : current,
        );
      }
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY }),
        queryClient.invalidateQueries({ queryKey: interactionByIdQueryKey(variables.id) }),
      ];
      if (identifier) {
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: issueDetailQueryKey(identifier) }),
        );
      }
      await Promise.all(invalidations);
    },
  });
}

export function useResumeIssueMutation(_identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string; interactionId?: string }) =>
      postResumeIssue(pathSegment(params.identifier)),
    onSuccess: async (_response, variables) => {
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY }),
        queryClient.invalidateQueries({ queryKey: issueDetailQueryKey(variables.identifier) }),
      ];
      if (variables.interactionId) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: interactionByIdQueryKey(variables.interactionId),
          }),
        );
      }
      await Promise.all(invalidations);
    },
  });
}

export function useFinalizeApproveMutation(_identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string }) =>
      postFinalizeApprove(pathSegment(params.identifier)),
    onSuccess: async (_response, variables) => {
      markFinalizeTransition(queryClient, variables.identifier, "pending_approval");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: issueDetailQueryKey(variables.identifier) }),
      ]);
    },
  });
}

export function useFinalizeRetryMutation(_identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string }) =>
      postFinalizeRetry(pathSegment(params.identifier)),
    onSuccess: async (_response, variables) => {
      markFinalizeTransition(queryClient, variables.identifier, "failed");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: issueDetailQueryKey(variables.identifier) }),
      ]);
    },
  });
}

export function useValidateGuidedFormMutation() {
  return useMutation({
    mutationFn: (params: { baseRawYaml: string; form: GuidedConfigForm }) => {
      const request: ValidateGuidedFormRequest = {
        base_raw_yaml: params.baseRawYaml,
        form: params.form,
      };
      return validateGuidedForm(request);
    },
  });
}

export function useSaveGuidedFormMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { baseRawYaml: string; form: GuidedConfigForm }) => {
      const request: SaveGuidedFormRequest = {
        base_raw_yaml: params.baseRawYaml,
        form: params.form,
      };
      return saveGuidedForm(request);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY });
    },
  });
}

export function useListDirectoryQuery(params: ListDirectoryParams) {
  return useQuery({
    queryKey: ["listDirectory", params.path],
    enabled: !!params.path,
    queryFn: async () => {
      const resp = await listDirectory(params);
      return (resp.data as ListResponse).entries;
    },
  });
}
