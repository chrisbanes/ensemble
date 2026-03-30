import { useStateQuery, useRefreshMutation, useRetryMutation } from "@/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import RunningTable from "@/components/RunningTable";
import RetryQueue from "@/components/RetryQueue";
import AgentTotals from "@/components/AgentTotals";

export default function Dashboard() {
  const { data, isLoading, isError, error } = useStateQuery();
  const refreshMutation = useRefreshMutation();
  const retryMutation = useRetryMutation();

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load state: {error instanceof Error ? error.message : "Unknown error"}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? "Refreshing..." : "Force Refresh"}
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Running</dt>
            <dd className="mt-1 text-2xl font-semibold text-green-600 dark:text-green-400">{data.counts.running}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Retrying</dt>
            <dd className="mt-1 text-2xl font-semibold text-yellow-600 dark:text-yellow-400">{data.counts.retrying}</dd>
          </CardContent>
        </Card>
      </div>

      <AgentTotals totals={data.agent_totals} rateLimits={data.rate_limits ?? null} />

      <section>
        <h2 className="text-lg font-semibold mb-3">Running Agents</h2>
        <Card>
          <RunningTable sessions={data.running} />
        </Card>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Retry Queue</h2>
        <Card>
          <RetryQueue entries={data.retrying} onRetry={(id) => retryMutation.mutate({ identifier: id })} />
        </Card>
      </section>
    </div>
  );
}
