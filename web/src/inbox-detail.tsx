import { useCallback } from "react";
import {
  taskSchema,
  type InboxItem,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, Button } from "./components.js";
import { holdNotices } from "./inbox-presentation.js";
import { useOperatorResource } from "./resource.js";
import { Alert } from "./ui/alert.js";

/**
 * An approval in the Inbox: the exact action, target and revision, and the independent holds an
 * approval does not clear. Deciding stays at the exact retained destination, where the control lives.
 */
export function ApprovalDetail({
  client,
  session,
  item,
}: {
  client: OperatorClient;
  session: Session;
  item: InboxItem;
}) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        client.read(`/api/operator/tasks/${item.taskId}`, taskSchema, signal),
      [client, item.taskId],
    ),
    resource = useOperatorResource(
      `${session.csrfToken}:inbox-approval:${item.taskId}`,
      loader,
    ),
    task = resource.state.data?.data,
    approval = task?.approvals.find(
      (a) => a.interactionId === (item.interactionId ?? item.id),
    ),
    holds = task ? holdNotices(task) : [],
    unavailable = Boolean(task && (!approval || approval.materialUnavailable));
  return (
    <div className="inbox-approval">
      <div className="inbox-approval-body">
        {approval && !unavailable ? (
          <dl className="inbox-approval-facts">
            <dt>Exact action</dt>
            <dd className="literal">{approval.action ?? "Unavailable"}</dd>
            <dt>Target</dt>
            <dd className="literal">{approval.target ?? "Unavailable"}</dd>
            <dt>Revision</dt>
            <dd>revision {approval.revision}</dd>
            <dt>Requester</dt>
            <dd>{item.requesterName ?? "Responsibility unknown"}</dd>
          </dl>
        ) : task ? (
          <p role="status">Exact approval unavailable</p>
        ) : null}
      </div>
      <div className="inbox-decision">
        {resource.state.error && !task && (
          <Alert variant="destructive" role="alert">
            <p className="body">
              Independent holds could not be read; they remain in effect.
            </p>
            <Button variant="secondary" onClick={resource.refresh}>
              Retry
            </Button>
          </Alert>
        )}
        {holds.map((hold) => (
          <Alert key={hold.id} role="status" className="inbox-hold">
            <p className="body">
              <strong>{hold.title}</strong>
            </p>
            {hold.items.map((name) => (
              <p key={name} className="body">
                {name}
              </p>
            ))}
            <p className="body muted">{hold.detail}</p>
          </Alert>
        ))}
        <p className="metadata muted">
          Your decision is bound to the action, target and revisions in the
          exact approval. Changed material requires a new review.
        </p>
        <ActionLink href={item.destination}>
          Review material & decide
        </ActionLink>
      </div>
    </div>
  );
}

/** An intervention in the Inbox: the recorded reason and the way to inspect the execution. */
export function InterventionDetail({ item }: { item: InboxItem }) {
  return (
    <div className="inbox-approval">
      <div className="inbox-approval-body">
        <p>Review the exact recorded execution state before acting.</p>
      </div>
      <div className="inbox-decision">
        <ActionLink href={item.destination}>Inspect execution</ActionLink>
      </div>
    </div>
  );
}
