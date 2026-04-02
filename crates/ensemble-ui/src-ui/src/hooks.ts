import { useState, useEffect } from "react";
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
  ConfigStateResponse,
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
  return useGetConfig<ConfigStateResponse>({
    query: {
      staleTime: 60_000,
      select: (resp) => resp.data as ConfigStateResponse,
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
