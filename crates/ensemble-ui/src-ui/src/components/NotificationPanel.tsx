import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getNotifications, markAllRead, subscribe } from "../notifications";
import type { AppNotification, NotificationSeverity } from "../types";

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
}

const severityDot: Record<NotificationSeverity, string> = {
  failure: "bg-red-500",
  warning: "bg-yellow-500",
  success: "bg-green-500",
  info: "bg-blue-500",
};

export default function NotificationPanel({ open, onClose }: NotificationPanelProps) {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<AppNotification[]>(getNotifications);

  useEffect(() => {
    return subscribe(() => setNotifications(getNotifications()));
  }, []);

  if (!open) return null;

  function handleClick(n: AppNotification) {
    navigate(`/issue/${encodeURIComponent(n.issue_identifier)}`);
    onClose();
  }

  return (
    <div className="absolute right-4 top-14 z-40 w-96 max-h-96 overflow-y-auto bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
        <button
          onClick={markAllRead}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Mark all read
        </button>
      </div>

      {notifications.length === 0 ? (
        <div className="p-4 text-sm text-center text-gray-500 dark:text-gray-400">No notifications</div>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {notifications.map((n) => (
            <li
              key={n.id}
              onClick={() => handleClick(n)}
              className={`p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 ${!n.read ? "bg-blue-50/50 dark:bg-blue-900/20" : ""}`}
            >
              <div className="flex items-start gap-2">
                <span className={`mt-1.5 flex-shrink-0 w-2 h-2 rounded-full ${severityDot[n.severity]}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{n.title}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400 truncate">{n.detail}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    {n.issue_identifier} &middot; {new Date(n.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
