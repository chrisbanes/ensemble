import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetState, getGetStateQueryKey } from "./generated/api/state/state";
import { useGetIssueDetail } from "./generated/api/issues/issues";
import { getGetIssueDetailQueryKey } from "./generated/api/issues/issues";
import { useGetConfig } from "./generated/api/config/config";
import { useGetHistory } from "./generated/api/history/history";
import { useListDirectory } from "./generated/api/filesystem/filesystem";
import {
  usePostRefresh,
  usePostResumeIssue,
  usePostStop,
  usePostRetry,
} from "./generated/api/controls/controls";
import {
  getListOpenInteractionsQueryKey,
  useGetInteractionById,
  useListOpenInteractions,
  useRespondToInteraction,
  useCancelInteraction,
} from "./generated/api/interactions/interactions";
import {
  useSaveSetup,
  useValidateSetup,
  useSaveYaml,
  useValidateYaml,
  getGetConfigQueryKey,
  useValidateGuidedForm,
  useSaveGuidedForm,
} from "./generated/api/config/config";
import { useGetConversation } from "./generated/api/conversation/conversation";
import type {
  GetHistoryParams,
  RuntimeSnapshot,
  IssueDetailSnapshot,
  ConversationResponse,
  HistoryResponse,
  ConfigStateResponse,
  GuidedConfigForm,
  InteractionRequest,
} from "./generated/models";

/**
 * The generated orval hooks wrap responses in { data, status, headers }.
 * Since customFetch throws on non-2xx, the data is always the success type.
 * These wrappers use `select` to unwrap `.data` and cast to the success type
 * so that consumers get the domain type directly.
 */

export function useStateQuery() {
  return useGetState<RuntimeSnapshot>({
    query: {
      refetchInterval: 3000,
      select: (resp) => resp.data as RuntimeSnapshot,
    },
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
  return useGetIssueDetail<IssueDetailSnapshot>(identifier, {
    query: {
      refetchInterval: 2000,
      enabled: identifier.length > 0,
      select: (resp) => resp.data as IssueDetailSnapshot,
    },
  });
}

export function useInteractionsQuery() {
  return useListOpenInteractions<InteractionRequest[]>({
    query: {
      refetchInterval: 3000,
      select: (resp) => resp.data as InteractionRequest[],
    },
  });
}

export function useInteractionDetailQuery(id: string) {
  return useGetInteractionById<InteractionRequest>(id, {
    query: {
      enabled: id.length > 0,
      select: (resp) => resp.data as InteractionRequest,
    },
  });
}

export function useConversationQuery(identifier: string, cursor?: string) {
  return useGetConversation<ConversationResponse>(identifier, {
    cursor: cursor ? Number(cursor) : undefined,
    limit: 50,
  }, {
    query: {
      enabled: identifier.length > 0,
      select: (resp) => resp.data as ConversationResponse,
    },
  });
}

export function useHistoryQuery(params: GetHistoryParams) {
  return useGetHistory<HistoryResponse>(params, {
    query: {
      select: (resp) => resp.data as HistoryResponse,
    },
  });
}

export function useConfigStateQuery() {
  return useGetConfig<ConfigStateResponse>({
    query: {
      staleTime: 60_000,
      select: (resp) => resp.data as ConfigStateResponse,
    },
  });
}

export function useValidateYamlDraftMutation() {
  return useValidateYaml();
}

export function useSaveYamlDraftMutation() {
  const queryClient = useQueryClient();
  return useSaveYaml({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
      },
    },
  });
}

export function useValidateSetupMutation() {
  return useValidateSetup();
}

export function useSaveSetupMutation() {
  const queryClient = useQueryClient();
  return useSaveSetup({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
      },
    },
  });
}

export function useRefreshMutation() {
  const queryClient = useQueryClient();
  return usePostRefresh({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStateQueryKey() });
      },
    },
  });
}

export function useStopMutation() {
  const queryClient = useQueryClient();
  return usePostStop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStateQueryKey() });
      },
    },
  });
}

export function useRetryMutation() {
  const queryClient = useQueryClient();
  return usePostRetry({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStateQueryKey() });
      },
    },
  });
}

export function useRespondToInteractionMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useRespondToInteraction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStateQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOpenInteractionsQueryKey() });
        if (identifier) {
          queryClient.invalidateQueries({
            queryKey: getGetIssueDetailQueryKey(identifier),
          });
        }
      },
    },
  });
}

export function useCancelInteractionMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return useCancelInteraction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStateQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOpenInteractionsQueryKey() });
        if (identifier) {
          queryClient.invalidateQueries({
            queryKey: getGetIssueDetailQueryKey(identifier),
          });
        }
      },
    },
  });
}

export function useResumeIssueMutation(identifier?: string) {
  const queryClient = useQueryClient();
  return usePostResumeIssue({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetStateQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListOpenInteractionsQueryKey() });
        if (identifier) {
          queryClient.invalidateQueries({
            queryKey: getGetIssueDetailQueryKey(identifier),
          });
        }
      },
    },
  });
}

export function useValidateGuidedFormMutation() {
  const generatedMutation = useValidateGuidedForm();
  
  return {
    mutateAsync: async (params: { baseRawYaml: string; form: GuidedConfigForm }) => {
      return generatedMutation.mutateAsync({
        data: {
          base_raw_yaml: params.baseRawYaml,
          form: params.form,
        },
      });
    },
    isPending: generatedMutation.isPending,
  };
}

export function useSaveGuidedFormMutation() {
  const queryClient = useQueryClient();
  const generatedMutation = useSaveGuidedForm({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
      },
    },
  });
  
  return {
    mutateAsync: async (params: { baseRawYaml: string; form: GuidedConfigForm }) => {
      return generatedMutation.mutateAsync({
        data: {
          base_raw_yaml: params.baseRawYaml,
          form: params.form,
        },
      });
    },
    isPending: generatedMutation.isPending,
  };
}

// Re-export filesystem hook for convenience
export { useListDirectory };
