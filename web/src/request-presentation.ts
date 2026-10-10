import type { InboxItem } from "../../src/operator/contracts.js";
import {
  clockLabel,
  requestActionLabel,
  requestKindLabel,
} from "./inbox-presentation.js";
export { requestActionLabel, requestKindLabel };
type Request = Pick<
  InboxItem,
  "id" | "kind" | "taskId" | "destination" | "requesterName" | "createdAt"
>;
/** A question opens in the Inbox's own selection; other kinds go to their exact destination. */
export const requestHref = (item: Request) =>
  item.kind === "question"
    ? `/app/inbox?task=${item.taskId}&request=${encodeURIComponent(item.id)}`
    : item.destination;
/** Who is responsible for an uncertain execution: only an intervention request names that. */
export const interventionRequester = (
  items: readonly Pick<InboxItem, "taskId" | "kind" | "requesterName">[],
  taskId: string,
) =>
  items.find((i) => i.taskId === taskId && i.kind === "intervention")
    ?.requesterName ?? null;
export const requestTime = (createdAt: number | null) =>
  createdAt === null ? "Age unknown" : clockLabel(createdAt);
export const requestMeta = (item: Request) =>
  [
    requestKindLabel(item.kind),
    item.requesterName ?? "Responsibility unknown",
    requestTime(item.createdAt),
  ].join(" · ");
