import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";

type ComparisonData = WorkspaceComparisonRead["data"];
type Snapshot = Extract<ComparisonData, { state: "available" }>["comparison"];
type TurnSnapshot = Extract<Snapshot, { target: "turn" }>;
type Assignments = Array<{ assignmentId: string; name: string | null }>;

export function dateLabel(value: number | undefined) {
  return value === undefined
    ? "not retained"
    : new Date(value).toLocaleString();
}

// Never substitute the lead's name for an unlisted or unnamed assignment.
const agentName = (assignments: Assignments, assignmentId: string) =>
  assignments.find((item) => item.assignmentId === assignmentId)?.name ??
  "Agent name unavailable";

/** Actual identity of the latest finished turn capture, including what it could not observe. */
export function FinishedTurn({
  snapshot,
  assignments,
}: {
  snapshot: TurnSnapshot;
  assignments: Assignments;
}) {
  return (
    <section
      className="changes-pending-turn changes-finished-turn"
      aria-label="Last turn identity"
    >
      <h5>Last turn</h5>
      <p>
        Agent {agentName(assignments, snapshot.assignmentId)} · profile{" "}
        {snapshot.profileId} · work {snapshot.workId} · assignment{" "}
        {snapshot.assignmentId}
      </p>
      <p>
        Thread {snapshot.threadId ?? "not retained"} · turn{" "}
        {snapshot.turnId ?? "not retained"} · outcome {snapshot.outcome} ·
        capture {snapshot.state}
      </p>
      <p>
        Capture started {dateLabel(snapshot.startedAt)} · before observation{" "}
        {dateLabel(snapshot.beforeObservedAt)} · after observation{" "}
        {dateLabel(snapshot.observedAt)}
      </p>
      {(snapshot.state !== "available" || snapshot.reason) && (
        <p role="status">
          Capture incomplete
          {snapshot.reason ? `: ${snapshot.reason}` : ""}. Unobserved entries
          stay identified as gaps and this capture does not establish that
          runtime writes ended.
        </p>
      )}
      {snapshot.truncated && (
        <p role="status">This capture is bounded and truncated.</p>
      )}
    </section>
  );
}

export function PendingTurn({
  data,
  assignments,
}: {
  data: Extract<ComparisonData, { state: "unsettled" }>;
  assignments: Assignments;
}) {
  const pending = data.pending;
  const agent = agentName(assignments, pending.identity.assignmentId);
  const finishedAgent = data.latestFinished
    ? agentName(assignments, data.latestFinished.assignmentId)
    : "";
  return (
    <section className="changes-pending-turn" aria-label="Current actual turn">
      <h5>Current actual turn</h5>
      <p>
        Agent {agent} · profile {pending.identity.profileId} · work{" "}
        {pending.identity.workId} · assignment {pending.identity.assignmentId}
      </p>
      <p>
        Turn {pending.turnId ?? "not yet bound"} · thread{" "}
        {pending.threadId ?? "not yet bound"} · outcome {pending.outcome} ·{" "}
        capture {pending.captureState}
      </p>
      <p>
        Capture started {dateLabel(pending.startedAt)} · before observation{" "}
        {pending.beforeObservedAt === undefined
          ? (pending.beforeState ?? "not retained")
          : dateLabel(pending.beforeObservedAt)}
        {" · "}after observation{" "}
        {pending.afterObservedAt === undefined
          ? (pending.afterState ?? "not observed")
          : dateLabel(pending.afterObservedAt)}
      </p>
      {pending.reason && <p>Capture limitation: {pending.reason}</p>}
      {data.latestFinished && (
        <p>
          Latest finished capture remains separate: agent {finishedAgent} · work{" "}
          {data.latestFinished.workId} · turn{" "}
          {data.latestFinished.turnId ?? "not retained"} · outcome{" "}
          {data.latestFinished.outcome} · capture started{" "}
          {dateLabel(data.latestFinished.startedAt)} · before observation{" "}
          {data.latestFinished.beforeObservedAt === undefined
            ? "not retained"
            : dateLabel(data.latestFinished.beforeObservedAt)}{" "}
          · after observation {dateLabel(data.latestFinished.observedAt)}.
        </p>
      )}
      <p>
        A partial or unsettled capture does not establish that runtime writes
        have ended or change a hold.
      </p>
    </section>
  );
}
