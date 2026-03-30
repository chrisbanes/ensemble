import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useIssueDetailQuery, useStopMutation, useRetryMutation } from "../api";
import { connectWs } from "../ws";
import type { WsStatus } from "../ws";
import type { WsEventData } from "../types";
import StatusBadge from "../components/StatusBadge";
import ConfirmDialog from "../components/ConfirmDialog";
import EventTimeline from "../components/EventTimeline";
import ConversationViewer from "../components/ConversationViewer";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function IssueDetail() {
  const { identifier = "" } = useParams<{ identifier: string }>();
  const { data, isLoading, isError, error } = useIssueDetailQuery(identifier);
  const stopMutation = useStopMutation();
  const retryMutation = useRetryMutation();

  const [events, setEvents] = useState<WsEventData[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [showStopConfirm, setShowStopConfirm] = useState(false);

  const isLiveRun = data?.running != null;

  useEffect(() => {
    return connectWs({
      identifier,
      enabled: isLiveRun,
      onMessage: (msg) => {
        if (msg.type === "snapshot") {
          setEvents(msg.events);
        } else if (msg.type === "event") {
          setEvents((prev) => [msg as unknown as WsEventData, ...prev]);
        }
      },
      onStatusChange: setWsStatus,
    });
  }, [identifier, isLiveRun]);

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 dark:text-gray-400">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600 dark:text-red-400">Failed to load issue: {error.message}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            &larr; Back
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data.issue_identifier}</h1>
          <StatusBadge status={data.status} />
          {isLiveRun && (
            <span className={`text-xs ${wsStatus === "connected" ? "text-green-500" : wsStatus === "connecting" ? "text-yellow-500" : "text-gray-400"}`}>
              WS: {wsStatus}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {isLiveRun && (
            <button
              onClick={() => setShowStopConfirm(true)}
              className="px-3 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-500"
            >
              Stop Agent
            </button>
          )}
          {data.retry && (
            <button
              onClick={() => retryMutation.mutate(identifier)}
              disabled={retryMutation.isPending}
              className="px-3 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Retry Now
            </button>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Turns</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.running?.turn_count ?? 0}</dd>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Step</dt>
          <dd className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{data.running?.step_name ?? "—"}</dd>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Tokens</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.running ? formatTokens(data.running.tokens.total_tokens) : "—"}</dd>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Attempts</dt>
          <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{data.attempts.restart_count}</dd>
        </div>
      </div>

      {/* Last error */}
      {data.last_error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Last Error</h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{data.last_error}</p>
        </div>
      )}

      {/* Two-column grid: events + conversation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Event Timeline</h2>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 max-h-[600px] overflow-y-auto">
            <EventTimeline events={events} live={isLiveRun} />
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Conversation</h2>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 max-h-[600px] overflow-y-auto">
            <ConversationViewer identifier={identifier} />
          </div>
        </section>
      </div>

      {/* Workspace info */}
      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 text-sm text-gray-600 dark:text-gray-400">
        Workspace: <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">{data.workspace.path}</code>
      </div>

      {/* Stop confirmation */}
      <ConfirmDialog
        open={showStopConfirm}
        title="Stop Agent"
        message={`Are you sure you want to stop the agent for ${identifier}? This action cannot be undone.`}
        confirmLabel="Stop"
        onConfirm={() => {
          stopMutation.mutate(identifier);
          setShowStopConfirm(false);
        }}
        onCancel={() => setShowStopConfirm(false)}
      />
    </div>
  );
}
