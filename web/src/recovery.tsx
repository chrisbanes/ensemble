import { useCallback, useEffect } from "react";
import {
  runtimeSettingsSchema,
  assignmentRecoverySchema,
} from "../../src/operator/contracts.js";
import { useOperatorResource } from "./resource.js";
import { ResourceStatus, Button, StatusBadge } from "./components.js";
import {
  DraftField,
  DraftCheck,
  DraftOutcome,
  useDraft,
  submitDraft,
  type SettingsProps,
} from "./settings.js";
export function RuntimeSettings(p: SettingsProps) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/runtime", runtimeSettingsSchema, signal),
      [p.client],
    ),
    resource = useOperatorResource(p.session.csrfToken, loader),
    data = resource.state.data?.data,
    d = useDraft(p.drafts, "capacity.configure");
  useEffect(() => {
    if (data)
      d.initialize({
        key: crypto.randomUUID(),
        globalLimit: String(data.globalLimit),
        ...Object.fromEntries(
          data.projects.flatMap((r) => [
            [`override-${r.project.id}`, r.override !== null],
            [`limit-${r.project.id}`, String(r.override ?? r.limit)],
          ]),
        ),
      });
  }, [data, d]);
  return (
    <section className="settings-stack">
      <a href="/app/settings">Settings home</a>
      <h2 className="section-heading">Runtime capacity and recovery</h2>
      <ResourceStatus
        label="Runtime settings"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          <p className="body">
            Global usage {data.globalUsage} / {data.globalLimit}; default
            project limit {data.defaultProjectLimit}.
          </p>
          <p className="body muted">
            Lowering a cap holds new admission without killing active turns.
            Capacity uses a keyed command with no configuration version or
            compare-and-swap guarantee.
          </p>
          <form
            onSubmit={(e) =>
              void submitDraft(
                e,
                d,
                p.client,
                p.session,
                {
                  type: "capacity.configure",
                  key: d.values.key,
                  globalLimit: Number(d.values.globalLimit),
                  projectOverrides: Object.fromEntries(
                    data.projects.map((r) => [
                      r.project.id,
                      d.values[`override-${r.project.id}`]
                        ? Number(d.values[`limit-${r.project.id}`])
                        : null,
                    ]),
                  ),
                },
                resource.refresh,
              )
            }
          >
            <DraftField
              draft={d}
              field="globalLimit"
              label="Global active-turn cap"
              type="number"
            />
            {data.projects.map((r) => (
              <div className="settings-card" key={r.project.id}>
                <h3 className="section-heading">
                  {r.project.name ?? "Project name unavailable"}
                </h3>
                <p className="body">
                  Usage {r.usage} / effective limit {r.limit}.{" "}
                  {r.project.paused ? "Project paused" : "Project enabled"}.
                </p>
                <DraftCheck
                  draft={d}
                  field={`override-${r.project.id}`}
                  label={`Set capacity override for ${r.project.name ?? "project"}`}
                />
                {d.values[`override-${r.project.id}`] && (
                  <DraftField
                    draft={d}
                    field={`limit-${r.project.id}`}
                    label={`Active-turn cap for ${r.project.name ?? "project"}`}
                    type="number"
                  />
                )}
              </div>
            ))}
            <DraftOutcome
              draft={d}
              client={p.client}
              session={p.session}
              label="Save capacity"
            />
            {d.phase === "recorded" && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  d.purge();
                  resource.refresh();
                }}
              >
                Start another capacity change
              </Button>
            )}
          </form>
          <h2 className="section-heading">Task recovery destinations</h2>
          {data.projects.flatMap((r) =>
            r.tasks.map((task) => (
              <div className="settings-card" key={task.taskId}>
                <h3 className="body">
                  {task.title ?? "Task title unavailable"}
                </h3>
                <StatusBadge tone={task.held ? "warning" : "neutral"}>
                  {task.held
                    ? "Execution hold recorded"
                    : task.paused
                      ? "Project paused"
                      : "Review execution evidence"}
                </StatusBadge>
                <div className="settings-actions">
                  <a href={`/task/${task.taskId}`}>Task detail</a>
                  <a href={`/runtime/task/${task.taskId}`}>
                    Stop, Resume, dependencies and Apply
                  </a>
                </div>
                {task.assignments.map((a) => (
                  <p className="body" key={a.assignmentId}>
                    <a href={`/app/assignments/${a.assignmentId}/recovery`}>
                      {a.name ?? "Profile name unavailable"}: recovery evidence
                    </a>
                  </p>
                ))}
              </div>
            )),
          )}
        </>
      )}
    </section>
  );
}
export function AssignmentRecovery(
  p: SettingsProps & { assignmentId: string },
) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          `/api/operator/assignments/${p.assignmentId}/recovery`,
          assignmentRecoverySchema,
          signal,
        ),
      [p.client, p.assignmentId],
    ),
    resource = useOperatorResource(
      `${p.session.csrfToken}:${p.assignmentId}`,
      loader,
    ),
    data = resource.state.data?.data;
  return (
    <section className="settings-stack">
      <a href="/app/settings/runtime">Runtime settings</a>
      <h2 className="section-heading">Assignment recovery evidence</h2>
      <ResourceStatus
        label="Recovery evidence"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          <StatusBadge tone={data.held ? "warning" : "neutral"}>
            {data.held ? "Execution held" : "No unresolved hold reported"}
          </StatusBadge>
          <p className="body">
            {data.assignment.name ?? "Profile name unavailable"} in{" "}
            {data.project.name ?? "Project name unavailable"}.{" "}
            {data.project.paused ? "Project paused" : "Project enabled"}.
          </p>
          <h3 className="section-heading">
            Revisions and actual admitted generation
          </h3>
          <p className="body">
            Configured assignment version {data.assignment.version}; captured
            instruction revision {data.assignment.instructionsRevision}, profile
            revision {data.assignment.profileRevision}. Current next-turn
            instruction revision {data.assignment.currentInstructionsRevision},
            profile revision {data.assignment.currentProfileRevision}.
          </p>
          {data.assignment.executionGeneration ? (
            <p className="body">
              Actual admitted generation: assignment version{" "}
              {data.assignment.executionGeneration.assignmentVersion}, request
              sequence {data.assignment.executionGeneration.requestSequence},
              instruction revision{" "}
              {data.assignment.executionGeneration.instructionsRevision},
              profile revision{" "}
              {data.assignment.executionGeneration.profileRevision}.
            </p>
          ) : (
            <p className="body">
              Admitted generation unavailable. This does not prove execution
              ended.
            </p>
          )}
          <h3 className="section-heading">Independent task-associated holds</h3>
          <ul className="body">
            <li>Operator Stop: {data.holds.stop ? "active" : "not active"}</li>
            <li>Task hold: {data.holds.task ? "active" : "not recorded"}</li>
            <li>
              Writer ownership:{" "}
              {data.holds.writer ? "held" : "no unresolved hold reported"}
            </li>
            <li>
              Capacity:{" "}
              {data.holds.capacity ? "held" : "no unresolved hold reported"}
            </li>
            <li>
              Uncertainty:{" "}
              {data.holds.uncertainty
                ? "active"
                : "no unresolved hold reported"}
            </li>
          </ul>
          <p className="body muted">
            These aggregate all verified task-associated records, including
            omitted generations. Resume does not release writer ownership,
            capacity or uncertainty. A newer receipt, elapsed time or
            interruption acknowledgement provides no termination proof.
          </p>
          <h3 className="section-heading">Recorded evidence</h3>
          {!data.evidenceAvailable && (
            <p className="body">
              Recovery evidence unavailable. Absence of records does not prove
              release.
            </p>
          )}
          {data.omittedCount > 0 && (
            <p className="body">
              {data.omittedCount} older recovery records omitted; their
              unresolved holds remain included above.
            </p>
          )}
          {data.records.map((r) => (
            <article
              className="settings-card"
              key={`${r.workId}-${r.generation.workRevision}-${r.generation.requestSequence}`}
            >
              <h4 className="body">
                Generation {r.generation.workRevision ?? "unavailable"}; request{" "}
                {r.generation.requestSequence}
              </h4>
              <p className="body">
                Intent {r.intentState}; request{" "}
                {r.requestState ?? "unavailable"}; binding{" "}
                {r.binding
                  ? `assignment version ${r.binding.assignmentVersion}, instructions ${r.binding.instructionsRevision}, profile ${r.binding.profileRevision}`
                  : "unavailable"}
                .
              </p>
              <p className="body">
                Observations: {r.observations.join(", ") || "unavailable"}.
                Pending effects: {r.pendingEffectCount}. Receipt{" "}
                {r.receiptRecorded ? "recorded" : "not recorded"}; workspace{" "}
                {r.workspace}.
              </p>
              <p className="metadata">
                Stop {r.holds.stop ? "active" : "inactive"}; writer{" "}
                {r.holds.writer ? "held" : "not recorded"}; capacity{" "}
                {r.holds.capacity ? "held" : "not recorded"}; uncertainty{" "}
                {r.holds.uncertainty ? "active" : "not recorded"}.
              </p>
            </article>
          ))}
          <h3 className="section-heading">Next supported step</h3>
          <p className="body">
            Review independent evidence in the advanced recovery destination.
            Identities, receipts and dispositions are evidence only; this
            read-only view grants no ownership release or proof-submission
            authority. The advanced exact evidence and controls are
            desktop-first.
          </p>
          <div className="settings-actions">
            <a href={`/runtime/assignment/${p.assignmentId}`}>
              Advanced recovery evidence and exact Apply
            </a>
            <a href={`/runtime/task/${data.taskId}`}>
              Task Stop, Resume and dependencies
            </a>
            <a href={`/coordination/assignment/${p.assignmentId}`}>
              Captured assignment history
            </a>
            <a href={`/task/${data.taskId}`}>Task detail and source review</a>
            <a href={`/coordination/task/${data.taskId}`}>
              Messages, results, questions and approvals
            </a>
            <a href={`/assignment/${p.assignmentId}`}>
              Exact captured instructions and result destination
            </a>
          </div>
        </>
      )}
    </section>
  );
}
