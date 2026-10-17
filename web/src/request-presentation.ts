import {
  CircleQuestionMark,
  Diamond,
  ServerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  InboxItem,
  RuntimeInboxItem,
  TaskInboxItem,
} from "../../src/operator/contracts.js";
import { inboxSelectionHref } from "../../src/operator/attention.js";
import { requestActionLabel, requestKindLabel } from "./inbox-presentation.js";
export { requestActionLabel, requestKindLabel };
/** One symbol per request kind, shared by the Inbox and the Overview cards. */
export const requestKindIcons: Record<InboxItem["kind"], LucideIcon> = {
  question: CircleQuestionMark,
  approval: Diamond,
  intervention: TriangleAlert,
  runtime: ServerOff,
};
type Request =
  | Pick<
      TaskInboxItem,
      "id" | "kind" | "taskId" | "destination" | "requesterName" | "createdAt"
    >
  | Pick<RuntimeInboxItem, "id" | "kind" | "destination" | "createdAt">;
/**
 * A question opens in the Inbox's own selection; other kinds go to their exact destination,
 * which for a runtime is its settings.
 */
export const requestHref = (item: Request) =>
  item.kind === "question" ? inboxSelectionHref(item) : item.destination;
/** Who is responsible for an uncertain execution: only an intervention request names that. */
export const interventionRequester = (
  items: readonly (
    | Pick<TaskInboxItem, "taskId" | "kind" | "requesterName">
    | Pick<RuntimeInboxItem, "kind">
  )[],
  taskId: string,
) => {
  const found = items.find(
    (i) => i.kind === "intervention" && "taskId" in i && i.taskId === taskId,
  );
  return found && "requesterName" in found ? found.requesterName : null;
};
/** A count is a total only when the whole Inbox was read and the last read succeeded. */
export function inboxSummaryOf(state: {
  data: {
    complete: boolean;
    unavailable: boolean;
    items: readonly (
      | Pick<TaskInboxItem, "projectId">
      | Pick<RuntimeInboxItem, "kind">
    )[];
  } | null;
  error: string | null;
}) {
  return state.data?.complete && !state.data.unavailable && !state.error
    ? {
        count: state.data.items.length,
        // A runtime item names no project, so it never adds one.
        projects: new Set(
          state.data.items.flatMap((item) =>
            "projectId" in item ? [item.projectId] : [],
          ),
        ).size,
      }
    : null;
}
