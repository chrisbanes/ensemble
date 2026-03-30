import type { AppNotification, NotificationSeverity } from "./types";

let notifications: AppNotification[] = [];
let listeners: Array<() => void> = [];
let idCounter = 0;

function notify() {
  listeners.forEach((fn) => fn());
}

export function addNotification(
  severity: NotificationSeverity,
  title: string,
  detail: string,
  issue_identifier: string,
): void {
  const notification: AppNotification = {
    id: String(++idCounter),
    severity,
    title,
    detail,
    timestamp: new Date().toISOString(),
    issue_identifier,
    read: false,
  };
  notifications = [notification, ...notifications].slice(0, 100);
  notify();

  // Browser notification for failures and warnings.
  if (
    (severity === "failure" || severity === "warning") &&
    document.hidden &&
    Notification.permission === "granted"
  ) {
    new Notification(title, { body: detail });
  }
}

export function markAllRead(): void {
  notifications = notifications.map((n) => ({ ...n, read: true }));
  notify();
}

export function getNotifications(): AppNotification[] {
  return notifications;
}

export function getUnreadCount(): number {
  return notifications.filter((n) => !n.read).length;
}

export function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** Request browser notification permission on first triggering event. */
export function requestPermissionIfNeeded(): void {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}
