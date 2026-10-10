import type { InboxItem, TaskRead } from "../../src/operator/contracts.js";

/** One label per request kind; the record keeps every kind visible if the enum grows. */
const kindLabels: Record<InboxItem["kind"], string> = {
  question: "Question",
  approval: "Approval",
  intervention: "Intervention",
};
export const requestKindLabel = (kind: InboxItem["kind"]) => kindLabels[kind];

const actionLabels: Record<InboxItem["kind"], string> = {
  question: "Answer question",
  approval: "Review material & decide",
  intervention: "Inspect execution",
};
export const requestActionLabel = (kind: InboxItem["kind"]) =>
  actionLabels[kind];

/** Relative age such as "8m", "1h 46m" or "1d 1h"; a future time reads as just now. */
export function ageLabel(createdAt: number | null, now: number) {
  if (createdAt === null) return "Age unknown";
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Local HH:MM. */
export function clockLabel(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Facet counts over every loaded item, so each option shows what choosing it would list. */
export function filterCounts(items: readonly InboxItem[]) {
  const project: Record<string, number> = {},
    kind: Record<string, number> = {};
  for (const item of items) {
    project[item.projectId] = (project[item.projectId] ?? 0) + 1;
    kind[item.kind] = (kind[item.kind] ?? 0) + 1;
  }
  return { total: items.length, project, kind };
}

export interface HoldNotice {
  id: "source" | "dependency" | "paused";
  title: string;
  items: string[];
  detail: string;
}

/** Independent holds an approval does not clear, from the task read's admission facts. */
export function holdNotices(task: TaskRead["data"]): HoldNotice[] {
  const reasons = new Set(task.admission.reasons),
    notices: HoldNotice[] = [];
  if (
    reasons.has("imported-blockers-blocked") ||
    reasons.has("imported-blockers-unknown") ||
    reasons.has("source-held")
  )
    notices.push({
      id: "source",
      title: "Execution blocked by dependency",
      items: (task.source?.nativeBlockers ?? [])
        .filter((blocker) => blocker.state === "open")
        .map((blocker) => `${blocker.repositoryName}#${blocker.number}`),
      detail:
        "Source-owned hold. Approval does not clear it; execution still waits for the GitHub blocker.",
    });
  if (reasons.has("local-dependency"))
    notices.push({
      id: "dependency",
      title: "Execution blocked by dependency",
      items: task.localDependencies
        .filter((dependency) => dependency.state !== "done")
        .map((dependency) => dependency.title ?? "Unavailable task"),
      detail: "Dependency hold. Approval does not clear it.",
    });
  if (reasons.has("project-paused"))
    notices.push({
      id: "paused",
      title: "Project paused",
      items: [],
      detail: "Approval does not resume work.",
    });
  return notices;
}
