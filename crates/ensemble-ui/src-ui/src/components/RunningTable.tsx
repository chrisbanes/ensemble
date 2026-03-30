import { Link } from "react-router-dom";
import type { RunningSession } from "../types";
import StatusBadge from "./StatusBadge";

interface RunningTableProps {
  sessions: RunningSession[];
}

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function RunningTable({ sessions }: RunningTableProps) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 dark:text-gray-400">
        No agents currently running.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Issue</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Step</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Turns</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Last Event</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Tokens</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Runtime</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {sessions.map((s) => (
            <tr key={s.issue_id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
              <td className="px-4 py-3 text-sm">
                <Link to={`/issue/${encodeURIComponent(s.issue_identifier)}`} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                  {s.issue_identifier}
                </Link>
              </td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{s.step_name ?? "—"}</td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{s.turn_count}</td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 max-w-xs truncate">{s.last_event ?? "—"}</td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{formatTokens(s.tokens.total_tokens)}</td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{formatDuration(s.started_at)}</td>
              <td className="px-4 py-3 text-sm"><StatusBadge status={s.state} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
