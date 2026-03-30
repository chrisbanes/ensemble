import { useStateQuery, useRefreshMutation, useRetryMutation } from "../api";
import RunningTable from "../components/RunningTable";
import RetryQueue from "../components/RetryQueue";
import AgentTotals from "../components/AgentTotals";

export default function Dashboard() {
  const { data, isLoading, isError, error } = useStateQuery();
  const refreshMutation = useRefreshMutation();
  const retryMutation = useRetryMutation();

  if (isLoading) {
    return <div className="text-center py-12 text-gray-500 dark:text-gray-400">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600 dark:text-red-400">Failed to load state: {error.message}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        <button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {refreshMutation.isPending ? "Refreshing..." : "Force Refresh"}
        </button>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Running</dt>
          <dd className="mt-1 text-2xl font-semibold text-green-600 dark:text-green-400">{data.counts.running}</dd>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Retrying</dt>
          <dd className="mt-1 text-2xl font-semibold text-yellow-600 dark:text-yellow-400">{data.counts.retrying}</dd>
        </div>
      </div>

      {/* Agent totals */}
      <AgentTotals totals={data.agent_totals} rateLimits={data.rate_limits} />

      {/* Running agents table */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Running Agents</h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <RunningTable sessions={data.running} />
        </div>
      </section>

      {/* Retry queue */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Retry Queue</h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <RetryQueue entries={data.retrying} onRetry={(id) => retryMutation.mutate(id)} />
        </div>
      </section>
    </div>
  );
}
