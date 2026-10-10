import type { InboxItem } from "../../src/operator/contracts.js";
// ponytail: Inbox (#838) words these requests too; the second PR to merge imports the other module.
type Request = Pick<
  InboxItem,
  "id" | "kind" | "taskId" | "destination" | "requesterName" | "createdAt"
>;
const kindLabels = {
  question: "Question",
  approval: "Approval",
  intervention: "Intervention",
} satisfies Record<InboxItem["kind"], string>;
const actionLabels = {
  question: "Answer question",
  approval: "Review material & decide",
  intervention: "Inspect execution",
} satisfies Record<InboxItem["kind"], string>;
export const requestKindLabel = (kind: InboxItem["kind"]) => kindLabels[kind];
export const requestActionLabel = (kind: InboxItem["kind"]) =>
  actionLabels[kind];
/** A question opens in the Inbox's own selection; other kinds go to their exact destination. */
export const requestHref = (item: Request) =>
  item.kind === "question"
    ? `/app/inbox?task=${item.taskId}&request=${encodeURIComponent(item.id)}`
    : item.destination;
const two = (n: number) => String(n).padStart(2, "0");
export function requestTime(createdAt: number | null) {
  if (createdAt === null) return "Age unknown";
  const date = new Date(createdAt);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}
export const requestMeta = (item: Request) =>
  [
    requestKindLabel(item.kind),
    item.requesterName ?? "Responsibility unknown",
    requestTime(item.createdAt),
  ].join(" · ");
