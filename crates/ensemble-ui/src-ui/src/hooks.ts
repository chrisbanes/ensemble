import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getState } from "./generated/api/state/state";
import { getIssueDetail } from "./generated/api/issues/issues";
import { getHistory } from "./generated/api/history/history";
import { listDirectory } from "./generated/api/filesystem/filesystem";
import {
  postRefresh,
  postResumeIssue,
  postStop,
  postRetry,
} from "./generated/api/controls/controls";
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
import { getConversation } from "./generated/api/conversation/conversation";
import type {
  GetConversationParams,
  GetHistoryParams,
  RuntimeSnapshot,
  IssueDetailSnapshot,
  ConversationResponse,
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
  FsEntry,
} from "./generated/models";
import { customFetch } from "./fetch-client";

/**
 * Query key constants (replaces generated orval keys that were removed in v8.16.0).
 */
const STATE_QUERY_KEY = ["/api/v1/state"] as const;
const CONFIG_QUERY_KEY = ["getConfig"] as const;
const LIST_OPEN_INTERACTIONS_KEY = ["listOpenInteractions"] as const;

function issueDetailQueryKey(identifier: string) {
  return ["getIssueDetail", identifier] as const;
}

function interactionByIdQueryKey(id: string) {
  return ["getInteractionById", id] as const;
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
      const resp = await getIssueDetail(identifier);
      return resp.data as IssueDetailSnapshot;
    },
  });
}

export interface TimelineEventRecord {
  run_id: string;
  issue_identifier: string;
  sequence: number;
  timestamp: string;
  event_type: string;
  step_name?: string | null;
  attempt: number;
  detail: string;
  verdict?: string | null;
  tool_name?: string | null;
}

export interface TimelineResponse {
  events: TimelineEventRecord[];
  total: number;
  next_cursor?: number | null;
}

export function useTimelineQuery(identifier: string, runId?: string, limit = 200) {
  return useQuery({
    queryKey: ["timeline", identifier, runId, limit],
    enabled: identifier.length > 0 && (runId?.length ?? 0) > 0,
    queryFn: async (): Promise<TimelineResponse> => {
      const params = new URLSearchParams({
        run_id: runId ?? "",
        limit: String(limit),
      });
      const response = await customFetch<{ data: TimelineResponse }>(
        `/api/v1/${encodeURIComponent(identifier)}/timeline?${params.toString()}`,
      );
      return response.data;
    },
  });
}

export interface StepDetailSnapshot {
  issue_identifier: string;
  issue_id: string;
  step_name: string;
  status: string;
  agent: string;
  dependencies: string[];
  can_navigate: boolean;
  verdict: string | null;
  recent_events: TimelineEventRecord[];
}

export function useStepDetailQuery(identifier: string, stepName: string) {
  return useQuery({
    queryKey: ["stepDetail", identifier, stepName],
    enabled: identifier.length > 0 && stepName.length > 0,
    queryFn: async (): Promise<StepDetailSnapshot> => {
      const response = await customFetch<{ data: StepDetailSnapshot }>(
        `/api/v1/${encodeURIComponent(identifier)}/step/${encodeURIComponent(stepName)}`,
      );
      return response.data;
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
    queryFn: async (): Promise<InteractionDetail> => {
      const resp = await getInteractionById(id);
      return resp.data as InteractionDetail;
    },
  });
}

export function useConversationQuery(identifier: string, cursor?: string) {
  const params: GetConversationParams = {
    cursor: cursor ? Number(cursor) : undefined,
    limit: 50,
  };

  return useQuery({
    queryKey: ["getConversation", identifier, cursor],
    enabled: identifier.length > 0,
    queryFn: async (): Promise<ConversationResponse> => {
      const resp = await getConversation(identifier, params);
      return resp.data as ConversationResponse;
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
    mutationFn: (params: { identifier: string }) => postStop(params.identifier),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
    },
  });
}

export function useRetryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string }) => postRetry(params.identifier),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
    },
  });
}

export function useRespondToInteractionMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string } & InteractionResponseBody) => respondToInteraction(params.id, params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY });
      if (identifier) {
        queryClient.invalidateQueries({
          queryKey: issueDetailQueryKey(identifier),
        });
      }
    },
  });
}

export function useCancelInteractionMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string }) => cancelInteraction(params.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY });
      if (identifier) {
        queryClient.invalidateQueries({
          queryKey: issueDetailQueryKey(identifier),
        });
      }
    },
  });
}

export function useResumeIssueMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { identifier: string }) => postResumeIssue(params.identifier),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY });
      if (identifier) {
        queryClient.invalidateQueries({
          queryKey: issueDetailQueryKey(identifier),
        });
      }
    },
  });
}

export function useIssueInputMutation(identifier?: string, interactionId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (response: string) => {
      if (!identifier) {
        throw new Error("issue identifier is required");
      }
      return customFetch(`/api/v1/issues/${encodeURIComponent(identifier)}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ response }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: LIST_OPEN_INTERACTIONS_KEY });
      if (identifier) {
        queryClient.invalidateQueries({
          queryKey: issueDetailQueryKey(identifier),
        });
      }
      if (interactionId) {
        queryClient.invalidateQueries({
          queryKey: interactionByIdQueryKey(interactionId),
        });
      }
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
      return resp.data.entries;
    },
  });
}
