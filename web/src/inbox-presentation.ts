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
  id: string;
  title: string;
  items: string[];
  detail: string;
}

type Reason = TaskRead["data"]["admission"]["reasons"][number];
/** Reasons with no dedicated notice still say what holds execution. */
const heldLabels: Partial<Record<Reason, string>> = {
  "task-unready": "task not ready",
  "task-not-open": "task not open",
  "project-lead-unconfigured": "project lead not configured",
  "project-lead-revoked": "project lead revoked",
  "admission-blocked": "admission blocked",
};

/** Independent holds an approval does not clear, from the task read's admission facts. */
export function holdNotices(task: TaskRead["data"]): HoldNotice[] {
  const reasons = new Set(task.admission.reasons),
    notices: HoldNotice[] = [],
    openBlockers = (task.source?.nativeBlockers ?? [])
      .filter((blocker) => blocker.state === "open")
      .map((blocker) => `${blocker.repositoryName}#${blocker.number}`);
  if (reasons.has("imported-blockers-blocked"))
    notices.push({
      id: "blocked",
      title: "Execution blocked by dependency",
      items: openBlockers,
      detail:
        "Source-owned hold. Approval does not clear it; execution still waits for the GitHub blocker.",
    });
  if (reasons.has("imported-blockers-unknown"))
    notices.push({
      id: "blockers-unknown",
      title: "Execution held: dependencies unconfirmed",
      items: openBlockers,
      detail:
        "GitHub blockers could not be confirmed. Approval does not clear this hold.",
    });
  if (reasons.has("source-held"))
    notices.push({
      id: "source-held",
      title: "Execution held by the source",
      items: [],
      detail:
        "Source review or hold is unresolved. Approval does not clear it.",
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
  for (const reason of task.admission.reasons) {
    const label = heldLabels[reason];
    if (label)
      notices.push({
        id: reason,
        title: `Execution held (${label})`,
        items: [],
        detail: "Approving does not clear it.",
      });
  }
  if (!notices.length && !task.admission.eligible)
    notices.push({
      id: "held",
      title: "Execution held",
      items: [],
      detail: "Approving does not clear it.",
    });
  return notices;
}
