import { z } from "zod";
import type {
  InboxItem,
  RuntimeInboxItem,
  TaskInboxItem,
} from "./contracts.js";

/** A task's attention codes, in the precedence that names who acts next. */
export const attentionCodes = [
  "execution-uncertain",
  "approval",
  "question",
  "unresolved-result",
  "completion-rejected",
  "question-delivery",
  "lead-review",
] as const;
export type AttentionCode = (typeof attentionCodes)[number];
export const attentionCodeSchema = z.enum(attentionCodes);

/**
 * Who acts next for each code, shared by the List, the Inbox and the task detail. Ensemble owns
 * `question-delivery` (a recorded answer it is still delivering to the agent) and `lead-review`
 * (a routing fallback it commits to the project lead, or marks stale, on its next coordination
 * pass); the operator owns the rest, and only those raise Inbox interventions. A recorded answer
 * still keeps its Inbox question item, labelled from this table.
 */
export const attentionNext: Record<
  AttentionCode,
  { operator: boolean; action: string; reason: string; inboxAction: string }
> = {
  "execution-uncertain": {
    operator: true,
    action: "inspect execution",
    reason: "Execution ownership is uncertain",
    inboxAction: "Inspect execution",
  },
  approval: {
    operator: true,
    action: "review material & decide",
    reason: "Approval needs a decision",
    inboxAction: "Review material & decide",
  },
  question: {
    operator: true,
    action: "answer question",
    reason: "Question needs an answer",
    inboxAction: "Answer question",
  },
  "unresolved-result": {
    operator: true,
    action: "resolve result destination",
    reason: "Result destination needs attention",
    inboxAction: "Inspect execution",
  },
  "completion-rejected": {
    operator: true,
    action: "review rejected completion",
    reason: "Completion requires review",
    inboxAction: "Inspect execution",
  },
  "question-delivery": {
    operator: false,
    action: "delivering answer",
    reason: "Answer recorded; delivery to the agent is pending",
    inboxAction: "View task",
  },
  "lead-review": {
    operator: false,
    action: "recording routing fallback",
    reason: "Routing fell back to the project lead",
    inboxAction: "View task",
  },
};

/**
 * The leading code and its "Next:" text. `uncertainColumn` adds `execution-uncertain` for a task
 * in the Uncertain column, the List's uncertainty rule.
 */
export function nextAttention(
  codes: readonly AttentionCode[],
  uncertainColumn = false,
) {
  const code = attentionCodes.find(
    (c) =>
      codes.includes(c) || (c === "execution-uncertain" && uncertainColumn),
  );
  if (!code) return undefined;
  const next = attentionNext[code];
  return {
    code,
    operator: next.operator,
    text: `Next: ${next.operator ? "you" : "Ensemble"} · ${next.action}`,
  };
}

/**
 * The operator-owned code an Inbox intervention stands for. Questions and approvals have their
 * own items, and Ensemble-owned codes raise none.
 */
export const interventionCode = (codes: readonly AttentionCode[]) =>
  attentionCodes.find(
    (c) =>
      c !== "question" &&
      c !== "approval" &&
      attentionNext[c].operator &&
      codes.includes(c),
  );

/** One label per Inbox kind; the record keeps every kind visible if the enum grows. */
export const kindLabels: Record<InboxItem["kind"], string> = {
  question: "Question",
  approval: "Approval",
  intervention: "Intervention",
  runtime: "Runtime",
};

/**
 * The identity of one alert: what the Inbox shows, what a push notification is tagged with and
 * what the page keeps open. A question or approval is its interaction (a later delivery code is
 * not new), an intervention is its task and problem, and a runtime is one exhaustion episode.
 */
export function inboxAlertKey(item: InboxItem): string {
  switch (item.kind) {
    case "question":
    case "approval":
      return item.id;
    case "intervention":
      return `${item.id}:${item.attentionCode ?? ""}`;
    case "runtime":
      return `${item.id}:${item.since}`;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

/** The Inbox address that selects one request, used by the page's queue and by push links. */
export function inboxSelectionHref(
  item:
    | Pick<TaskInboxItem, "id" | "kind" | "taskId">
    | Pick<RuntimeInboxItem, "id" | "kind">,
): string {
  switch (item.kind) {
    case "question":
    case "approval":
    case "intervention":
      return `/app/inbox?task=${item.taskId}&request=${encodeURIComponent(item.id)}`;
    case "runtime":
      return `/app/inbox?request=${encodeURIComponent(item.id)}`;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
