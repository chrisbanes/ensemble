import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getNotifications, markAllRead, subscribe } from "@/notifications";
import type { AppNotification, NotificationSeverity } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const severityDot: Record<NotificationSeverity, string> = {
  failure: "bg-red-500",
  warning: "bg-yellow-500",
  success: "bg-green-500",
  info: "bg-blue-500",
};

export default function NotificationPanel() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<AppNotification[]>(getNotifications);

  useEffect(() => {
    return subscribe(() => setNotifications(getNotifications()));
  }, []);

  function handleClick(n: AppNotification) {
    navigate(`/issue/${encodeURIComponent(n.issue_identifier)}`);
  }

  return (
    <div>
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="text-sm font-semibold">Notifications</h3>
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={markAllRead}>
          Mark all read
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className="p-4 text-sm text-center text-muted-foreground">No notifications</div>
      ) : (
        <ul className="max-h-80 overflow-y-auto divide-y">
          {notifications.map((n) => (
            <li
              key={n.id}
              onClick={() => handleClick(n)}
              className={cn(
                "p-3 cursor-pointer hover:bg-muted/50 transition-colors",
                !n.read && "bg-accent/50",
              )}
            >
              <div className="flex items-start gap-2">
                <span className={cn("mt-1.5 flex-shrink-0 w-2 h-2 rounded-full", severityDot[n.severity])} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{n.detail}</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
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
