import type {
  InboxItem,
  RuntimeInboxItem,
  TaskInboxItem,
  TaskRead,
} from "../../src/operator/contracts.js";
import { type WaitCode, waitLabels } from "../../src/operator/wait-reasons.js";
import {
  attentionNext,
  kindLabels,
  nextAttention,
} from "../../src/operator/attention.js";
import {
  retriesExhausted,
  runtimeSettingsAction,
} from "../../src/operator/runtime-restart-copy.js";
import { clockLabel, midSentence } from "./presentation.js";
import { taskColumnOf } from "./task-overview.js";
import { nextActor } from "./tasks.js";

export const requestKindLabel = (kind: InboxItem["kind"]) => kindLabels[kind];

/** The request's action: its attention code's when it has one, otherwise its kind's. */
export const requestActionLabel = (
  item:
    | Pick<TaskInboxItem, "kind" | "attentionCode">
    | Pick<RuntimeInboxItem, "kind">,
) =>
  item.kind === "runtime"
    ? runtimeSettingsAction
    : attentionNext[
        item.attentionCode ??
          (item.kind === "intervention" ? "execution-uncertain" : item.kind)
      ].inboxAction;

/**
 * What a request is called in the queue and the pane: the question or exact action when the read
 * model carries it, otherwise the task title. The generic question and approval reasons are not
 * shown; the intervention and native-delivery reasons are.
 */
export function requestHeading(
  item:
    | Pick<
        TaskInboxItem,
        | "kind"
        | "headline"
        | "taskTitle"
        | "projectName"
        | "reason"
        | "attentionCode"
      >
    | Pick<RuntimeInboxItem, "kind" | "headline">,
) {
  // A runtime problem names the runtime; the queue says only that retries ran out.
  if (item.kind === "runtime")
    return { title: item.headline, subtitle: null, reason: retriesExhausted };
  const title = item.headline ?? item.taskTitle,
    subtitle = (
      item.headline ? [item.projectName, item.taskTitle] : [item.projectName]
    )
      .filter(Boolean)
      .join(" / ");
  return {
    title,
    subtitle: subtitle || null,
    reason:
      item.kind === "intervention" || item.attentionCode ? item.reason : null,
  };
}

/** Relative age such as "8m", "1h 46m" or "1d 1h"; a future time reads as just now. */
export function ageLabel(createdAt: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Facet counts over every loaded item, so each option shows what choosing it would list. */
export function filterCounts(items: readonly InboxItem[]) {
  const project: Record<string, number> = {},
    kind: Record<string, number> = {};
  for (const item of items) {
    // A runtime item belongs to no project: it counts toward the total and its kind only.
    if (item.kind !== "runtime")
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

/** Reasons with no dedicated notice still say what holds execution. */
const heldLabels: Partial<Record<string, string>> = {
  "task-unready": "task not ready",
  "task-not-open": "task not open",
  "project-lead-unconfigured": "project lead not configured",
  "project-lead-revoked": "project lead revoked",
  "admission-blocked": "waiting to start",
};

/** What answering a question says about each notice; any id not listed falls back to a generic line. */
const answerDetails: Record<string, string> = {
  blocked:
    "Source-owned hold. Answering does not clear it; execution still waits for the GitHub blocker.",
  "blockers-unknown":
    "GitHub blockers could not be confirmed. Answering does not clear this hold.",
  "source-held":
    "Source review or hold is unresolved. Answering does not clear it.",
  dependency: "Dependency hold. Answering does not clear it.",
  paused: "Task paused. Recording answers does not resume execution.",
};

/**
 * Independent holds an approval (or, with "answer", a recorded answer) does not clear, from the
 * task read's waits in the same order as task detail and the CLI. The wording is the only thing the action changes.
 */
export function holdNotices(
  task: TaskRead["data"],
  action: "approve" | "answer",
  /**
   * The approval in view, which is not a hold on itself: its interaction id. Null when no
   * approval is in view, so every pending approval holds.
   */
  deciding: string | null,
): HoldNotice[] {
  const notices: HoldNotice[] = [],
    openBlockers = (task.source?.nativeBlockers ?? [])
      .filter((blocker) => blocker.state === "open")
      .map((blocker) => `${blocker.repositoryName}#${blocker.number}`);
  // The task read's waits in the flow's order, then what makes the task itself not startable.
  const codes = [
    ...task.waits.map((wait) => wait.code),
    ...task.admission.reasons.filter(
      (r) => r === "task-unready" || r === "task-not-open",
    ),
  ];
  for (const code of codes) {
    if (code === "imported-blockers-blocked")
      notices.push({
        id: "blocked",
        title: "Execution blocked by dependency",
        items: openBlockers,
        detail:
          "Source-owned hold. Approval does not clear it; execution still waits for the GitHub blocker.",
      });
    else if (code === "imported-blockers-unknown")
      notices.push({
        id: "blockers-unknown",
        title: "Execution held: dependencies unconfirmed",
        items: openBlockers,
        detail:
          "GitHub blockers could not be confirmed. Approval does not clear this hold.",
      });
    else if (code === "source-held")
      notices.push({
        id: "source-held",
        title: "Execution held by the source",
        items: [],
        detail:
          "Source review or hold is unresolved. Approval does not clear it.",
      });
    else if (code === "local-dependency")
      notices.push({
        id: "dependency",
        title: "Execution blocked by dependency",
        items: task.localDependencies
          .filter((dependency) => dependency.state !== "done")
          .map((dependency) => dependency.title ?? "Unavailable task"),
        detail: "Dependency hold. Approval does not clear it.",
      });
    else if (code === "project-paused")
      notices.push({
        id: "paused",
        title: "Project paused",
        items: [],
        detail: "Approval does not resume work.",
      });
    else if (code === "power-held") {
      const reason = task.waits.find((wait) => wait.code === code)?.detail;
      notices.push({
        id: code,
        title: "Execution held by power supervision",
        items: reason ? [reason] : [],
        detail: "Approving does not clear it.",
      });
    }
    // The request being decided is not a hold on itself; other open approvals still are.
    else if (
      code !== "approval" ||
      deciding === null ||
      task.waits
        .find((wait) => wait.code === code)
        ?.links.some((link) => link.kind !== "request" || link.id !== deciding)
    ) {
      // A wait's detail, such as an assignment's profile, says what the hold is about.
      const about = task.waits.find((wait) => wait.code === code)?.detail;
      notices.push({
        id: code,
        title: `Execution held (${heldLabels[code] ?? midSentence(waitLabels[code as WaitCode])})`,
        items: about ? [about] : [],
        detail: "Approving does not clear it.",
      });
    }
  }
  if (!notices.length && !task.admission.eligible)
    notices.push({
      id: "held",
      title: "Execution held",
      items: [],
      detail: "Approving does not clear it.",
    });
  return action === "answer"
    ? notices.map((notice) => ({
        ...notice,
        detail: answerDetails[notice.id] ?? "Answering does not clear it.",
      }))
    : notices;
}

/**
 * `holdNotices` for surfaces that list every open approval as its own row: the merged approval
 * hold is dropped unless an approval is in view; then only the other open approvals remain.
 */
export function holdNoticesBesideRequests(
  task: TaskRead["data"],
  action: "approve" | "answer",
  deciding: string | null,
): HoldNotice[] {
  return holdNotices(task, action, deciding).filter(
    (notice) => notice.id !== "approval" || deciding !== null,
  );
}

/**
 * The queue's two groups in server order: runtime problems and interventions, then questions and
 * approvals oldest first. A runtime item leads Intervention and counts in its heading.
 */
export function queueGroups<T extends Pick<InboxItem, "kind">>(
  rows: readonly T[],
) {
  const isIntervention = (row: T) =>
      row.kind === "intervention" || row.kind === "runtime",
    interventions = rows.filter(isIntervention),
    requests = rows.filter((row) => !isIntervention(row));
  return [
    {
      id: "intervention",
      heading: `Intervention · ${interventions.length}`,
      items: interventions,
    },
    {
      id: "requests",
      heading: "Questions & approvals · oldest first",
      items: requests,
    },
  ].filter((group) => group.items.length);
}

/** "requester · version N · HH:MM": the identities the read model has; a missing one is omitted. */
export const requestIdentity = (
  item: Pick<TaskInboxItem, "requesterName" | "revision" | "createdAt">,
) =>
  [
    item.requesterName,
    item.revision === null ? null : `version ${item.revision}`,
    item.createdAt === null ? null : clockLabel(item.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");

/** Who asked whom, from the root to the requesting assignment ("Operator → Mira → Jonas"). */
export function assignmentChain(
  task: Pick<TaskRead["data"], "assignments">,
  requestingAssignmentId: string | null,
) {
  const byId = new Map(task.assignments.map((a) => [a.assignmentId, a])),
    chain: string[] = [],
    seen = new Set<string>();
  let id: string | null | undefined = requestingAssignmentId;
  while (id) {
    const assignment = byId.get(id);
    if (!assignment || seen.has(id)) {
      if (chain.length) chain.unshift("Requester unknown");
      return chain;
    }
    seen.add(id);
    chain.unshift(assignment.name ?? "Name unavailable");
    id = assignment.requesterAssignmentId;
  }
  if (chain.length)
    chain.unshift(id === null ? "Operator" : "Requester unknown");
  return chain;
}

/**
 * The inspector's task facts; before the task read lands only the item's facts are known. The
 * next action is the operator's only while the request is still open in the queue.
 */
export const taskContext = (
  task:
    | Pick<
        TaskRead["data"],
        "task" | "execution" | "admission" | "source" | "lead" | "attention"
      >
    | undefined,
  item: Pick<TaskInboxItem, "kind" | "attentionCode">,
  open: boolean,
) => ({
  source: !task
    ? null
    : task.source
      ? `${task.source.repositoryName ?? "repository unavailable"}#${task.source.number ?? "?"}`
      : "Local task",
  // Lead accountability stays visible, in the task views' wording when there is none.
  lead: !task
    ? "Unavailable"
    : task.lead
      ? (task.lead.name ?? "Name unavailable")
      : "No lead configured",
  // The task's next actor once its read lands, as on the List and the task page.
  next: !open
    ? null
    : task
      ? nextActor(task.attention.codes, taskColumnOf(task)).text
      : item.attentionCode
        ? (nextAttention([item.attentionCode])?.text ?? null)
        : `Next: you · ${midSentence(requestActionLabel(item))}`,
});
