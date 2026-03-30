import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useIssueDetailQuery, useStopMutation, useRetryMutation } from "@/api";
import { connectWs } from "@/ws";
import type { WsStatus } from "@/ws";
import type { WsEventData } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import StatusBadge from "@/components/StatusBadge";
import ConfirmDialog from "@/components/ConfirmDialog";
import EventTimeline from "@/components/EventTimeline";
import ConversationViewer from "@/components/ConversationViewer";

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
    return <div className="text-center py-12 text-muted-foreground">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load issue: {error.message}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-bold">{data.issue_identifier}</h1>
          <StatusBadge status={data.status} />
          {isLiveRun && (
            <span className={`text-xs ${wsStatus === "connected" ? "text-green-500" : wsStatus === "connecting" ? "text-yellow-500" : "text-muted-foreground"}`}>
              WS: {wsStatus}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {isLiveRun && (
            <Button variant="destructive" size="sm" onClick={() => setShowStopConfirm(true)}>
              Stop Agent
            </Button>
          )}
          {data.retry && (
            <Button size="sm" onClick={() => retryMutation.mutate(identifier)} disabled={retryMutation.isPending}>
              Retry Now
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Turns</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.running?.turn_count ?? 0}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Step</dt>
            <dd className="mt-1 text-lg font-semibold">{data.running?.step_name ?? "\u2014"}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Tokens</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.running ? formatTokens(data.running.tokens.total_tokens) : "\u2014"}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Attempts</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.attempts.restart_count}</dd>
          </CardContent>
        </Card>
      </div>

      {data.last_error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Last Error</h3>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{data.last_error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <h2 className="text-lg font-semibold mb-3">Event Timeline</h2>
          <Card className="p-4 max-h-[600px] overflow-y-auto">
            <EventTimeline events={events} live={isLiveRun} />
          </Card>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-3">Conversation</h2>
          <Card className="p-4 max-h-[600px] overflow-y-auto">
            <ConversationViewer identifier={identifier} />
          </Card>
        </section>
      </div>

      <Card className="p-4">
        <span className="text-sm text-muted-foreground">
          Workspace: <code className="bg-muted px-1 rounded">{data.workspace.path}</code>
        </span>
      </Card>

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
