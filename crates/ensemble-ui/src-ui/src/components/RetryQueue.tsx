import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import type { RetryEntry } from "../types";

interface RetryQueueProps {
  entries: RetryEntry[];
  onRetry: (identifier: string) => void;
}

function formatCountdown(dueAtMs: number): string {
  const diff = Math.max(0, dueAtMs - Date.now());
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export default function RetryQueue({ entries, onRetry }: RetryQueueProps) {
  const [, setTick] = useState(0);

  // Tick every second to update countdowns.
  useEffect(() => {
    if (entries.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 dark:text-gray-400">
        No issues in retry queue.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Issue</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Attempt</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Retry In</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Error</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {entries.map((e) => (
            <tr key={e.issue_id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
              <td className="px-4 py-3 text-sm">
                <Link to={`/issue/${encodeURIComponent(e.issue_identifier)}`} className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                  {e.issue_identifier}
                </Link>
              </td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{e.attempt}</td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{formatCountdown(e.due_at_ms)}</td>
              <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 max-w-xs truncate">{e.error ?? "—"}</td>
              <td className="px-4 py-3 text-sm">
                <button
                  onClick={() => onRetry(e.issue_identifier)}
                  className="text-blue-600 dark:text-blue-400 hover:underline text-sm font-medium"
                >
                  Retry Now
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
