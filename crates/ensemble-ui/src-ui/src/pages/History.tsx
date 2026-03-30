import { useState } from "react";
import { Link } from "react-router-dom";
import { useHistoryQuery } from "../api";
import StatusBadge from "../components/StatusBadge";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function History() {
  const [filters, setFilters] = useState({
    issue: "",
    outcome: "",
    since: "",
    step: "",
  });
  const [cursor, setCursor] = useState<string | undefined>();

  const { data, isLoading, isError } = useHistoryQuery({
    ...filters,
    cursor,
    limit: 20,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">History</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search by issue..."
          value={filters.issue}
          onChange={(e) => { setFilters((f) => ({ ...f, issue: e.target.value })); setCursor(undefined); }}
          className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
        <select
          value={filters.outcome}
          onChange={(e) => { setFilters((f) => ({ ...f, outcome: e.target.value })); setCursor(undefined); }}
          className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option value="">All outcomes</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="stopped">Stopped</option>
        </select>
        <select
          value={filters.since}
          onChange={(e) => { setFilters((f) => ({ ...f, since: e.target.value })); setCursor(undefined); }}
          className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option value="">All time</option>
          <option value="1h">Last hour</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
        </select>
        <input
          type="text"
          placeholder="Filter by step..."
          value={filters.step}
          onChange={(e) => { setFilters((f) => ({ ...f, step: e.target.value })); setCursor(undefined); }}
          className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
      </div>

      {/* Results */}
      {isLoading && <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading...</div>}
      {isError && <div className="text-center py-8 text-red-600 dark:text-red-400">Failed to load history.</div>}

      {data && (
        <>
          <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg shadow">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Issue</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Outcome</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Steps</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Attempts</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Tokens</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Duration</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {data.records.map((r) => (
                  <tr key={`${r.issue_id}-${r.completed_at}`} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-3 text-sm">
                      <Link to={`/issue/${encodeURIComponent(r.issue_identifier)}`} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                        {r.issue_identifier}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm"><StatusBadge status={r.outcome} /></td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{r.steps_traversed.join(" → ")}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{r.attempts}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{formatTokens(r.tokens.total_tokens)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{formatDuration(r.duration_seconds)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{new Date(r.completed_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.records.length === 0 && (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">No records match the current filters.</div>
          )}
          {data.pagination.has_more && data.pagination.next_cursor && (
            <div className="flex justify-center">
              <button
                onClick={() => setCursor(data.pagination.next_cursor ?? undefined)}
                className="px-4 py-2 text-sm font-medium rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Load More
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
