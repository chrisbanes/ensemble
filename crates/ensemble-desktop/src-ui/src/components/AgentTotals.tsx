import type { AgentTotals as AgentTotalsType, RateLimitSnapshot } from "../types";

interface AgentTotalsProps {
  totals: AgentTotalsType;
  rateLimits: RateLimitSnapshot | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}

export default function AgentTotals({ totals, rateLimits }: AgentTotalsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <StatCard label="Input Tokens" value={formatTokens(totals.input_tokens)} />
      <StatCard label="Output Tokens" value={formatTokens(totals.output_tokens)} />
      <StatCard label="Total Tokens" value={formatTokens(totals.total_tokens)} />
      <StatCard label="Total Runtime" value={formatSeconds(totals.seconds_running)} />
      {rateLimits && (
        <div className="col-span-2 sm:col-span-4 bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Rate Limit</dt>
          <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
            {rateLimits.remaining}/{rateLimits.limit} remaining
            {rateLimits.reset_at && (
              <span className="ml-2 text-gray-500 dark:text-gray-400">
                (resets {new Date(rateLimits.reset_at).toLocaleTimeString()})
              </span>
            )}
          </dd>
        </div>
      )}
    </div>
  );
}
