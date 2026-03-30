export type NotificationSeverity = "failure" | "warning" | "success" | "info";

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  timestamp: string;
  issue_identifier: string;
  read: boolean;
}
