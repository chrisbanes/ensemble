import { useQueryClient } from "@tanstack/react-query";
import { useGetState, getGetStateQueryKey } from "./generated/api/state/state";
import { useGetIssueDetail } from "./generated/api/issues/issues";
import { useGetConfig } from "./generated/api/config/config";
import { useGetHistory } from "./generated/api/history/history";
import {
  usePostRefresh,
  usePostStop,
  usePostRetry,
} from "./generated/api/controls/controls";
import { useGetConversation } from "./generated/api/conversation/conversation";
import type {
  GetHistoryParams,
  RuntimeSnapshot,
  IssueDetailSnapshot,
  ConversationResponse,
  HistoryResponse,
  ConfigResponse,
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

export function useIssueDetailQuery(identifier: string) {
  return useGetIssueDetail<IssueDetailSnapshot>(identifier, {
    query: {
      refetchInterval: 2000,
      enabled: identifier.length > 0,
      select: (resp) => resp.data as IssueDetailSnapshot,
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

export function useConfigQuery() {
  return useGetConfig<ConfigResponse>({
    query: {
      staleTime: 60_000,
      select: (resp) => resp.data as ConfigResponse,
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
