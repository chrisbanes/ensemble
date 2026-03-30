import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  StateResponse,
  IssueDetailResponse,
  RefreshResponse,
  StopResponse,
  RetryResponse,
  ConversationResponse,
  HistoryResponse,
  ConfigResponse,
  ApiError,
} from "./types";

const API_BASE = "/api/v1";

class FetchError extends Error {
  status: number;
  body: ApiError | null;

  constructor(status: number, body: ApiError | null) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = "FetchError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    ...init,
  });

  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // response was not JSON
    }
    throw new FetchError(res.status, body);
  }

  return res.json() as Promise<T>;
}

// --- Fetch functions ---

export function fetchState(): Promise<StateResponse> {
  return apiFetch<StateResponse>("/state");
}

export function fetchIssueDetail(identifier: string): Promise<IssueDetailResponse> {
  return apiFetch<IssueDetailResponse>(`/${encodeURIComponent(identifier)}`);
}

export function fetchConversation(
  identifier: string,
  cursor?: string,
  limit = 50,
  direction = "backward",
): Promise<ConversationResponse> {
  const params = new URLSearchParams({ limit: String(limit), direction });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<ConversationResponse>(
    `/${encodeURIComponent(identifier)}/conversation?${params}`,
  );
}

export function fetchHistory(params: {
  cursor?: string;
  limit?: number;
  outcome?: string;
  issue?: string;
  since?: string;
  step?: string;
}): Promise<HistoryResponse> {
  const searchParams = new URLSearchParams();
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.outcome) searchParams.set("outcome", params.outcome);
  if (params.issue) searchParams.set("issue", params.issue);
  if (params.since) searchParams.set("since", params.since);
  if (params.step) searchParams.set("step", params.step);
  return apiFetch<HistoryResponse>(`/history?${searchParams}`);
}

export function fetchConfig(): Promise<ConfigResponse> {
  return apiFetch<ConfigResponse>("/config");
}

export function triggerRefresh(): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>("/refresh", { method: "POST" });
}

export function stopAgent(identifier: string): Promise<StopResponse> {
  return apiFetch<StopResponse>(`/${encodeURIComponent(identifier)}/stop`, {
    method: "POST",
  });
}

export function retryAgent(identifier: string): Promise<RetryResponse> {
  return apiFetch<RetryResponse>(`/${encodeURIComponent(identifier)}/retry`, {
    method: "POST",
  });
}

// --- TanStack Query hooks ---

export function useStateQuery() {
  return useQuery<StateResponse, FetchError>({
    queryKey: ["state"],
    queryFn: fetchState,
    refetchInterval: 3000,
  });
}

export function useIssueDetailQuery(identifier: string) {
  return useQuery<IssueDetailResponse, FetchError>({
    queryKey: ["issue", identifier],
    queryFn: () => fetchIssueDetail(identifier),
    refetchInterval: 2000,
    enabled: identifier.length > 0,
  });
}

export function useConversationQuery(
  identifier: string,
  cursor?: string,
  direction?: string,
) {
  return useQuery<ConversationResponse, FetchError>({
    queryKey: ["conversation", identifier, cursor, direction],
    queryFn: () => fetchConversation(identifier, cursor, 50, direction),
    enabled: identifier.length > 0,
  });
}

export function useHistoryQuery(params: {
  cursor?: string;
  limit?: number;
  outcome?: string;
  issue?: string;
  since?: string;
  step?: string;
}) {
  return useQuery<HistoryResponse, FetchError>({
    queryKey: ["history", params],
    queryFn: () => fetchHistory(params),
  });
}

export function useConfigQuery() {
  return useQuery<ConfigResponse, FetchError>({
    queryKey: ["config"],
    queryFn: fetchConfig,
    staleTime: 60_000, // Config rarely changes.
  });
}

export function useRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation<RefreshResponse, FetchError>({
    mutationFn: triggerRefresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}

export function useStopMutation() {
  const queryClient = useQueryClient();
  return useMutation<StopResponse, FetchError, string>({
    mutationFn: stopAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}

export function useRetryMutation() {
  const queryClient = useQueryClient();
  return useMutation<RetryResponse, FetchError, string>({
    mutationFn: retryAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}
