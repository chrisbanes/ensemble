import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CapacityConfigureCommand,
  CapacityLimits,
  DomainCommand,
  DomainStore,
} from "../core/domain.js";
import type { OperatorRoute } from "./operator-routes.js";
import type { RecoveryRecord } from "./recovery-types.js";
import type { TurnRequest } from "./scheduler.js";
import type { ExecutionIntent } from "./state.js";
import type { StandaloneService } from "./service.js";
import type { StopObservation } from "./supervisor.js";
import { escapeHtml, hidden } from "./operator-html.js";

const positiveIntegerString = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const uuid = z.string().uuid();
const dependencyFields = z
  .object({
    key: uuid,
    projectId: uuid,
    taskId: uuid,
    blockerTaskId: uuid,
    expectedVersion: positiveIntegerString,
  })
  .strict();
const instructionFields = z
  .object({
    key: uuid,
    projectId: uuid,
    assignmentId: uuid,
    expectedVersion: positiveIntegerString,
  })
  .strict();
const taskControlFields = z.object({ taskId: uuid }).strict();
const capacityFields = z
  .object({
    key: z.string().uuid(),
    globalLimit: positiveIntegerString,
    projectId: z.union([z.literal(""), z.string().uuid()]),
    projectLimit: z.union([z.literal(""), positiveIntegerString]),
  })
  .strict()
  .superRefine((fields, context) => {
    if (fields.projectId === "" && fields.projectLimit !== "")
      context.addIssue({ code: "custom", message: "Project is required" });
  });

type RuntimeDomain = Pick<
  DomainStore,
  | "assignment"
  | "assignmentAdmission"
  | "assignments"
  | "admission"
  | "dependencies"
  | "execute"
  | "profile"
  | "project"
  | "projects"
  | "task"
  | "tasks"
>;

export interface RuntimeOperatorApi {
  domain(): RuntimeDomain;
  list(): ExecutionIntent[];
  recoveryView(): RecoveryRecord[];
  powerStatus(): ReturnType<StandaloneService["powerStatus"]>;
  runtimeStatus(): ReturnType<StandaloneService["runtimeStatus"]>;
  turnRequests(): TurnRequest[];
  capacityLimits(projectIds?: string[]): CapacityLimits;
  configureCapacity(
    command: Omit<CapacityConfigureCommand, "actor" | "type">,
  ): Promise<CapacityLimits>;
  stopTask(taskId: string): Promise<StopObservation>;
  resumeTask(taskId: string): Promise<void>;
  taskHold(taskId: string): string | undefined;
  adoptHistoricalPreTurnRejection?: StandaloneService["adoptHistoricalPreTurnRejection"];
  adoptHistoricalNoTurnSubmission?: StandaloneService["adoptHistoricalNoTurnSubmission"];
  recoverPreTurnExecution?: StandaloneService["recoverPreTurnExecution"];
  recoverNoTurnExecution?: StandaloneService["recoverNoTurnExecution"];
  replaceConversationCommand?: StandaloneService["replaceConversationCommand"];
}

function overview(api: RuntimeOperatorApi, csrfToken: string): string {
  const domain = api.domain();
  const projects = domain.projects();
  const capacity = api.capacityLimits(
    projects.map((project) => String(project.id)),
  );
  const unavailable =
    api.runtimeStatus().state === "unavailable"
      ? '<p role="alert">Codex runtime unavailable — restart the service</p>'
      : "";
  return `<main><h1>Runtime</h1>${unavailable}<section><h2>Capacity</h2><p>Global active turns: ${capacity.globalLimit}; currently in use: ${capacity.currentUsage.global}.</p><p>Default project active turns: ${capacity.defaultProjectLimit}.</p>${projects
    .map((project) => {
      const projectId = String(project.id);
      const projectCapacity = capacity.effectiveProjectLimits[projectId] ?? 2;
      const usage = capacity.currentUsage.projects[projectId] ?? 0;
      return `<p>Project ${escapeHtml(project.name)}: ${projectCapacity} active turns; currently in use: ${usage}.</p>`;
    })
    .join(
      "",
    )}${capacityForm(capacity, projects, csrfToken)}</section><section><h2>Project tasks</h2>${projects
    .map((project) => {
      const projectId = String(project.id);
      const tasks = domain.tasks(projectId);
      const rows = tasks
        .map((task) => {
          const taskId = String(task.id);
          const admission = domain.admission(taskId);
          const readiness = `${String(task.state)}; ${task.ready ? "Ready" : "Not ready"}`;
          const gate = admission.eligible
            ? "Task admission gates are clear"
            : `Task admission blocked: ${admission.reasons.map(admissionReason).map(escapeHtml).join(", ")}`;
          return `<li><a href="${taskHref(taskId)}">${escapeHtml(task.title)}</a> — ${escapeHtml(readiness)}; ${gate}.</li>`;
        })
        .join("");
      return `<section><h3>${escapeHtml(project.name)} — ${project.paused ? "Paused" : "Active"}</h3>${rows ? `<ul>${rows}</ul>` : "<p>No tasks.</p>"}</section>`;
    })
    .join(
      "",
    )}</section><section><h2>Effective execution policy</h2><p>Default policy: workspace writes with broad host-permitted reads.</p><p>Command network access is disabled. Approval policy is never.</p><p>Stricter isolation, exhaustive ambient access containment, and universal descendant containment are not proved.</p><p>Codex runs with the operator's existing runtime login; Ensemble does not provide an independent execution sandbox.</p></section></main>`;
}

function admissionReason(reason: string): string {
  const labels: Record<string, string> = {
    "project-paused": "Project is paused",
    "project-lead-unconfigured": "Project lead is not configured",
    "project-lead-revoked": "Project lead is revoked",
    "task-unready": "Task is not marked ready",
    "task-not-open": "Task is not open",
    "local-dependency": "A local dependency is incomplete",
  };
  if (reason.startsWith("imported-blockers-"))
    return `Imported blockers are ${reason.slice("imported-blockers-".length)}`;
  return labels[reason] ?? "Admission is blocked";
}

function capacityForm(
  capacity: CapacityLimits,
  projects: ReturnType<RuntimeDomain["projects"]>,
  csrfToken: string,
): string {
  return `<form method="post" action="/runtime/control/capacity">${hidden("key", randomUUID())}${hidden("csrfToken", csrfToken)}<label>Global active turn limit <input name="globalLimit" type="number" min="1" value="${capacity.globalLimit}"></label><label>Project override <select name="projectId"><option value="">No project override</option>${projects
    .map(
      (project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`,
    )
    .join(
      "",
    )}</select></label><label>Project active turn limit; leave blank to remove an override <input name="projectLimit" type="number" min="1"></label><button type="submit">Save capacity</button></form>`;
}

function operationForm(
  action: string,
  fields: Array<[string, string]>,
  csrfToken: string,
  label: string,
  keyed = true,
): string {
  return `<form method="post" action="${action}">${keyed ? hidden("key", randomUUID()) : ""}${hidden("csrfToken", csrfToken)}${fields
    .map(([name, value]) => hidden(name, value))
    .join("")}<button type="submit">${escapeHtml(label)}</button></form>`;
}

function taskHref(taskId: string): string {
  return `/runtime/task/${encodeURIComponent(taskId)}`;
}

function assignmentHref(assignmentId: string): string {
  return `/runtime/assignment/${encodeURIComponent(assignmentId)}`;
}

function statusForAssignment(
  assignment: ReturnType<RuntimeDomain["assignment"]>,
  api: RuntimeOperatorApi,
): string {
  const id = String(assignment.id);
  const requests = api
    .turnRequests()
    .filter((candidate) => candidate.assignmentId === id);
  const latestRequest = (candidates: TurnRequest[]) =>
    candidates.reduce<TurnRequest | undefined>(
      (latest, candidate) =>
        !latest || candidate.sequence > latest.sequence ? candidate : latest,
      undefined,
    );
  const request =
    latestRequest(
      requests.filter((candidate) => candidate.state === "active"),
    ) ??
    latestRequest(
      requests.filter(
        (candidate) =>
          candidate.assignmentVersion === Number(assignment.version),
      ),
    );
  const requestVersion =
    request?.assignmentVersion ?? Number(assignment.version);
  const recoveryRecords = api
    .recoveryView()
    .filter(
      (candidate) =>
        candidate.binding?.assignmentId === id &&
        candidate.binding.assignmentVersion === requestVersion,
    );
  const recovery = request
    ? recoveryRecords.find((candidate) => candidate.workId === request.workId)
    : recoveryRecords.reduce<RecoveryRecord | undefined>(
        (latest, candidate) =>
          !latest ||
          candidate.generation.requestSequence >
            latest.generation.requestSequence
            ? candidate
            : latest,
        undefined,
      );
  const intent = request
    ? api.list().find((candidate) => candidate.workId === request.workId)
    : undefined;
  if (recovery?.holds.stop) return "Stopping; effects may continue";
  if (request?.state === "queued")
    return "Queued; waiting for capacity admission";
  if (request?.state === "active" && intent?.state === "running")
    return "Running";
  if (request?.state === "active" && intent?.state === "submitting")
    return "Starting";
  if (
    request?.state === "held" ||
    assignment.state === "held" ||
    recovery?.holds.uncertainty ||
    recovery?.holds.writer ||
    recovery?.holds.capacity ||
    recovery?.holds.task
  )
    return "Held; recovery is required";
  if (request?.state === "completed" || assignment.state === "completed")
    return "Completed";
  if (request?.state === "active")
    return "Admitted; runtime state is not confirmed";
  if (request?.state === "queued" || assignment.state === "pending") {
    const admission = api.domain().assignmentAdmission(id);
    return admission.eligible
      ? "Selected; waiting for admission"
      : `Selected; blocked from admission: ${admission.reasons.map(admissionReason).join(", ")}`;
  }
  return "No active execution is reported";
}

function recoveryRecordEvidence(
  record: RecoveryRecord,
  taskHold: string | undefined,
): string {
  const binding = record.binding;
  const assignment = binding
    ? `Assignment ${escapeHtml(binding.assignmentId)} (version ${escapeHtml(binding.assignmentVersion)}; instructions revision ${escapeHtml(binding.instructionsRevision)}; profile revision ${escapeHtml(binding.profileRevision)})`
    : "Assignment identity not recorded";
  const workRevision =
    record.generation.workRevision === null
      ? "not recorded"
      : escapeHtml(record.generation.workRevision);
  const requestSequence = escapeHtml(record.generation.requestSequence);
  const thread = record.intent.threadId
    ? `Recorded thread identity: ${escapeHtml(record.intent.threadId)}`
    : "Recorded thread identity: not available";
  const turn = record.intent.turnId
    ? `Recorded turn identity: ${escapeHtml(record.intent.turnId)}`
    : "Recorded turn identity: not available";
  const process = record.processIdentity
    ? `Recorded process identity: process ID ${escapeHtml(record.processIdentity.processId)}; started ${escapeHtml(record.processIdentity.processStartedAt)}; boot identity ${escapeHtml(record.processIdentity.bootId)}`
    : "Recorded process identity: not available";
  const request = record.request;
  const observations = record.observations.length
    ? record.observations
        .map(
          (observation) =>
            `<li>Observation: ${escapeHtml(observation.kind)} — ${escapeHtml(observation.reason ?? "Reason not recorded")}</li>`,
        )
        .join("")
    : "<li>No recovery observations are recorded.</li>";
  const pendingEffects = record.pendingEffects.length
    ? record.pendingEffects
        .map(
          (effect) =>
            `<li>Pending effect: ${escapeHtml(effect.state)} — ${escapeHtml(effect.reason)}</li>`,
        )
        .join("")
    : "<li>No pending effects are recorded for this recovery record.</li>";
  const uncertaintyReason =
    record.intent.reason ??
    request?.reason ??
    "No uncertainty reason is recorded";
  const taskHoldReason = record.holds.task ?? taskHold;
  const noTurn = record.noTurnSubmission
    ? `Recorded historical no-turn submission witness: ${escapeHtml(record.noTurnSubmission.id)}; operator-adopted; an unobserved idle thread may exist. This is evidence, not permission to dispatch.`
    : "";
  const rejection = record.preTurnRejection
    ? `Recorded before-turn rejection witness: ${escapeHtml(record.preTurnRejection.id)}; source: ${escapeHtml(record.preTurnRejection.source)}; predecessor thread: ${escapeHtml(record.preTurnRejection.predecessorThreadId)}`
    : "Recorded before-turn rejection witness: none";
  const receipt = record.receipt
    ? `Recorded recovery receipt: ${escapeHtml(record.receipt.id)}; workspace disposition: ${escapeHtml(record.receipt.workspaceDisposition)}`
    : "Recorded recovery receipt: none";

  return `<li><h3>Recovery record: ${escapeHtml(record.workId)}</h3><ul><li>${assignment}</li><li>Generation: work revision ${workRevision}; request sequence ${requestSequence}</li><li>Runtime intent: ${escapeHtml(record.intent.state)}; intent reason: ${escapeHtml(record.intent.reason ?? "not recorded")}</li><li>Turn request: ${escapeHtml(request?.state ?? "not recorded")}; request reason: ${escapeHtml(request?.reason ?? "not recorded")}</li><li>${thread}; not proof of termination or release</li><li>${turn}; not proof of termination or release</li><li>${process}; not proof of termination or release</li><li>${receipt}; not proof of termination or release</li><li>${rejection}; recovery still requires exact independent evidence</li>${noTurn ? `<li>${noTurn}</li>` : ""}<li>Task hold reason: ${escapeHtml(taskHoldReason ?? "not recorded")}</li><li>Uncertainty hold: ${record.holds.uncertainty ? `active; reason: ${escapeHtml(uncertaintyReason)}` : "not active for this record"}</li><li>Writer hold: ${record.holds.writer ? "active" : "not recorded"}; capacity hold: ${record.holds.capacity ? "active" : "not recorded"}; Stop hold: ${record.holds.stop ? "active" : "not recorded"}</li><li>Observations:<ul>${observations}</ul></li><li>Pending effects:<ul>${pendingEffects}</ul></li></ul></li>`;
}

function executionHoldSection(taskId: string, api: RuntimeOperatorApi): string {
  const records = api
    .recoveryView()
    .filter((record) => record.binding?.taskId === taskId);
  const hold = api.taskHold(taskId);
  const stop = records.some((record) => record.holds.stop);
  const writer = records.some((record) => record.holds.writer);
  const capacity = records.some((record) => record.holds.capacity);
  const uncertainty = records.some((record) => record.holds.uncertainty);
  const held = hold !== undefined || stop || writer || capacity || uncertainty;
  const maximumVisibleRecords = 20;
  const visibleRecords = records.slice(-maximumVisibleRecords);
  const omittedRecords = records.length - visibleRecords.length;
  const recordEvidence = visibleRecords
    .map((record) => recoveryRecordEvidence(record, hold))
    .join("");
  const omittedNotice = omittedRecords
    ? `<p>Showing the newest ${maximumVisibleRecords} of ${records.length} recorded recovery records; ${omittedRecords} older records are omitted from this page.</p>`
    : "";
  const evidenceList = recordEvidence
    ? `<h3>Recorded recovery evidence</h3>${omittedNotice}<ul>${recordEvidence}</ul><p>Recorded identities, observations, receipts, and dispositions are evidence only; they do not prove that a process has terminated or that all effects have been released.</p>`
    : "";
  if (!held)
    return `<section><h2>Execution ownership and recovery</h2><p>No unresolved execution hold is reported.</p>${evidenceList}</section>`;
  return `<section><h2>Execution ownership and recovery</h2><ul><li>${stop ? "Operator Stop remains active" : "Operator Stop is not active"}</li><li>${writer ? "Writer ownership remains held" : "No unresolved writer hold is recorded"}</li><li>${capacity ? "Capacity remains held" : "No unresolved capacity hold is recorded"}</li><li>${uncertainty ? "Execution state is uncertain" : "No uncertainty hold is recorded"}</li></ul>${evidenceList}<p>Effects may continue while an execution is stopping. Elapsed time, interruption acknowledgement, and Resume do not resolve writer ownership. Use independent recovery evidence before allowing another writer.</p></section>`;
}

function dependencyForm(
  task: ReturnType<RuntimeDomain["task"]>,
  candidates: ReturnType<RuntimeDomain["tasks"]>,
  existing: string[],
  csrfToken: string,
): string {
  const taskId = String(task.id);
  const choices = candidates.filter(
    (candidate) =>
      String(candidate.id) !== taskId &&
      !existing.includes(String(candidate.id)),
  );
  if (choices.length === 0) return "";
  return `<form method="post" action="/runtime/control/dependency/add">${hidden("key", randomUUID())}${hidden("csrfToken", csrfToken)}${hidden("projectId", String(task.projectId))}${hidden("taskId", taskId)}${hidden("expectedVersion", String(task.version))}<label>Local blocker <select name="blockerTaskId">${choices
    .map(
      (choice) =>
        `<option value="${escapeHtml(choice.id)}">${escapeHtml(choice.title)}</option>`,
    )
    .join(
      "",
    )}</select></label><button type="submit">Add dependency</button></form>`;
}

function taskPage(
  taskId: string,
  api: RuntimeOperatorApi,
  csrfToken: string,
): string {
  const domain = api.domain();
  const task = domain.task(uuid.parse(taskId));
  const project = domain.project(String(task.projectId));
  const assignments = domain.assignments(taskId);
  const leadProfileId =
    typeof project.leadProfileId === "string"
      ? String(project.leadProfileId)
      : undefined;
  const leadProfile = leadProfileId ? domain.profile(leadProfileId) : undefined;
  const leadAssignment = leadProfileId
    ? assignments.find((assignment) => assignment.profileId === leadProfileId)
    : undefined;
  const dependencyIds = domain.dependencies(taskId);
  const dependencies = dependencyIds.map((id) => domain.task(id));
  const candidates = domain.tasks(String(task.projectId));
  const rows = assignments
    .map((assignment) => {
      const assignmentId = String(assignment.id);
      const profile = domain.profile(String(assignment.profileId));
      const lead = String(assignment.profileId) === leadProfileId;
      const status = statusForAssignment(assignment, api);
      const stale =
        Number(assignment.instructionsRevision) !==
          Number(project.instructionsRevision) ||
        Number(assignment.profileRevision) !== Number(profile.version);
      const apply = stale
        ? operationForm(
            "/runtime/control/instruction-apply",
            [
              ["projectId", String(task.projectId)],
              ["assignmentId", assignmentId],
              ["expectedVersion", String(assignment.version)],
            ],
            csrfToken,
            "Apply current instructions for the next turn",
          )
        : "<p>Current instruction and profile revisions are applied.</p>";
      return `<li><a href="${assignmentHref(assignmentId)}">${escapeHtml(profile.name)}${lead ? " (project lead)" : ""}</a>: ${escapeHtml(status)}. Captured instruction revision ${escapeHtml(assignment.instructionsRevision)}; profile revision ${escapeHtml(assignment.profileRevision)}.${apply}</li>`;
    })
    .join("");
  const dependencyRows = dependencies.length
    ? dependencies
        .map(
          (blocker) =>
            `<li>${escapeHtml(blocker.title)} — ${escapeHtml(blocker.state)}${operationForm(
              "/runtime/control/dependency/remove",
              [
                ["projectId", String(task.projectId)],
                ["taskId", taskId],
                ["blockerTaskId", String(blocker.id)],
                ["expectedVersion", String(task.version)],
              ],
              csrfToken,
              "Remove dependency",
            )}</li>`,
        )
        .join("")
    : "<li>No local task blockers.</li>";
  const stopForm = operationForm(
    "/runtime/control/stop",
    [["taskId", taskId]],
    csrfToken,
    "Best-effort Stop",
    false,
  );
  const resumeForm = operationForm(
    "/runtime/control/resume",
    [["taskId", taskId]],
    csrfToken,
    "Resume task",
    false,
  );
  const lead = leadProfile
    ? `<p>Accountable project lead: ${escapeHtml(leadProfile.name)}${leadAssignment ? `; <a href="${assignmentHref(String(leadAssignment.id))}">task-scoped lead execution</a>` : ""}.</p>`
    : "<p>No project lead is configured.</p>";
  const held = api
    .recoveryView()
    .some(
      (record) =>
        record.binding?.taskId === taskId &&
        (record.holds.stop ||
          record.holds.writer ||
          record.holds.capacity ||
          record.holds.uncertainty ||
          record.holds.task !== null),
    );
  const assignmentStatuses = assignments.map((assignment) =>
    statusForAssignment(assignment, api),
  );
  const taskAdmission = domain.admission(taskId);
  const status = api
    .recoveryView()
    .some((record) => record.binding?.taskId === taskId && record.holds.stop)
    ? "Stopping; effects may continue"
    : assignmentStatuses.includes("Starting")
      ? "Starting"
      : assignmentStatuses.includes("Running")
        ? "Running"
        : held || api.taskHold(taskId)
          ? "Uncertain or held; recovery is required"
          : task.state !== "open"
            ? `Task is ${String(task.state)}`
            : project.paused
              ? "Paused; no new admission"
              : !task.ready
                ? "Not ready for admission"
                : !taskAdmission.eligible
                  ? `Blocked from admission: ${taskAdmission.reasons.map(admissionReason).join(", ")}`
                  : assignmentStatuses.includes(
                        "Queued; waiting for capacity admission",
                      )
                    ? "Queued; waiting for capacity admission"
                    : assignmentStatuses.includes(
                          "Admitted; runtime state is not confirmed",
                        )
                      ? "Admitted; runtime state is not confirmed"
                      : assignmentStatuses.some((value) =>
                            value.startsWith("Selected; waiting"),
                          )
                        ? "Selected; waiting for admission"
                        : assignmentStatuses.some((value) =>
                              value.startsWith("Selected; blocked"),
                            )
                          ? "Selected; blocked from admission"
                          : "No active execution is reported";
  const admissionStatus = taskAdmission.eligible
    ? "Task admission gates are clear"
    : `Task admission blocked: ${taskAdmission.reasons.map(admissionReason).map(escapeHtml).join(", ")}`;
  return `<main><h1>${escapeHtml(task.title)}</h1><p>Project: ${escapeHtml(project.name)}. Project state: ${project.paused ? "Paused" : "Active"}. Task state: ${escapeHtml(task.state)}; ${task.ready ? "Ready" : "Not ready"}.</p><p>${admissionStatus}.</p>${lead}<p>Execution status: ${escapeHtml(status)}.</p><p>Local dependencies gate new execution independently of readiness.</p><section><h2>Task-scoped assignments</h2>${assignments.length ? `<ul>${rows}</ul>` : "<p>No assignments have been selected.</p>"}</section><section><h2>Task dependencies</h2><ul>${dependencyRows}</ul>${dependencyForm(task, candidates, dependencyIds, csrfToken)}</section>${executionHoldSection(taskId, api)}<section><h2>Task controls</h2><p>Stop requests cancellation and observes for a bounded period. Effects may continue. Resume clears only the operator Stop and never releases an unresolved execution hold.</p>${stopForm}${resumeForm}</section></main>`;
}

function assignmentPage(
  assignmentId: string,
  api: RuntimeOperatorApi,
  csrfToken: string,
): string {
  const domain = api.domain();
  const assignment = domain.assignment(uuid.parse(assignmentId));
  const task = domain.task(String(assignment.taskId));
  const project = domain.project(String(assignment.projectId));
  const profile = domain.profile(String(assignment.profileId));
  const leadProfile =
    typeof project.leadProfileId === "string"
      ? domain.profile(String(project.leadProfileId))
      : undefined;
  const status = statusForAssignment(assignment, api);
  const needsApply =
    Number(assignment.instructionsRevision) !==
      Number(project.instructionsRevision) ||
    Number(assignment.profileRevision) !== Number(profile.version);
  const apply = needsApply
    ? operationForm(
        "/runtime/control/instruction-apply",
        [
          ["projectId", String(assignment.projectId)],
          ["assignmentId", assignmentId],
          ["expectedVersion", String(assignment.version)],
        ],
        csrfToken,
        "Apply current instructions for the next turn",
      )
    : "<p>Current instruction and profile revisions are applied.</p>";
  return `<main><h1>${escapeHtml(profile.name)} assignment</h1><p>Task: <a href="${taskHref(String(task.id))}">${escapeHtml(task.title)}</a> in ${escapeHtml(project.name)}.</p><p>Execution status: ${escapeHtml(status)}.</p><p>Accountable project lead: ${leadProfile ? escapeHtml(leadProfile.name) : "No project lead is configured"}; lead accountability remains with the project.</p><p>Captured instruction revision ${escapeHtml(assignment.instructionsRevision)}; profile revision ${escapeHtml(assignment.profileRevision)}.</p><p>Result destination: ${escapeHtml(assignment.resultDestination)}.</p><p><a href="/coordination/assignment/${encodeURIComponent(assignmentId)}">Conversation and coordination history</a></p>${executionHoldSection(String(task.id), api)}<section><h2>Instruction revisions</h2><p>Changing configuration does not change this assignment until explicitly applied for its next turn.</p>${apply}</section></main>`;
}

export class RuntimeOperatorRoutes {
  constructor(private readonly api: RuntimeOperatorApi) {}

  get routes(): OperatorRoute[] {
    return [
      {
        method: "GET",
        path: "/runtime",
        handler: ({ csrfToken }) => ({
          kind: "html",
          body: overview(this.api, csrfToken),
        }),
      },
      ...(this.api.adoptHistoricalPreTurnRejection
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/pre-turn/adopt",
              handler: ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.adoptHistoricalPreTurnRejection;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.recoverPreTurnExecution
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/pre-turn/recover",
              handler: async ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.recoverPreTurnExecution;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                await operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.adoptHistoricalNoTurnSubmission
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/no-turn/adopt",
              handler: ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.adoptHistoricalNoTurnSubmission;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.recoverNoTurnExecution
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/no-turn/recover",
              handler: async ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const { payload } = z
                  .object({ payload: z.string().max(12000) })
                  .strict()
                  .parse(fields);
                const operation = this.api.recoverNoTurnExecution;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                await operation.call(this.api, JSON.parse(payload));
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      ...(this.api.replaceConversationCommand
        ? [
            {
              method: "POST" as const,
              path: "/runtime/control/conversation-replace",
              handler: ({
                fields,
              }: import("./operator-routes.js").OperatorRouteContext) => {
                const input = z
                  .object({
                    key: uuid,
                    assignmentId: uuid,
                    expectedAssignmentVersion: positiveIntegerString,
                    expectedConversationRevision: positiveIntegerString,
                  })
                  .strict()
                  .parse(fields);
                const operation = this.api.replaceConversationCommand;
                if (!operation)
                  throw new Error("Operator recovery operation unavailable");
                operation.call(this.api, input);
                return { kind: "redirect" as const, location: "/runtime" };
              },
            },
          ]
        : []),
      {
        method: "POST",
        path: "/runtime/control/capacity",
        handler: async ({ fields }) => {
          const input = capacityFields.parse(fields);
          const projectOverrides = input.projectId
            ? {
                [input.projectId]:
                  input.projectLimit === "" ? null : input.projectLimit,
              }
            : {};
          await this.api.configureCapacity({
            key: input.key,
            globalLimit: input.globalLimit,
            projectOverrides,
          });
          return { kind: "redirect", location: "/runtime" };
        },
      },
      {
        method: "GET",
        path: "/runtime/task/:taskId",
        handler: ({ params, csrfToken }) => ({
          kind: "html",
          body: taskPage(params.taskId ?? "", this.api, csrfToken),
        }),
      },
      {
        method: "GET",
        path: "/runtime/assignment/:assignmentId",
        handler: ({ params, csrfToken }) => ({
          kind: "html",
          body: assignmentPage(params.assignmentId ?? "", this.api, csrfToken),
        }),
      },
      {
        method: "POST",
        path: "/runtime/control/dependency/add",
        handler: ({ fields }) => {
          const input = dependencyFields.parse(fields);
          this.api.domain().execute({
            ...input,
            type: "dependency.add",
            actor: "operator",
          } as DomainCommand);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "POST",
        path: "/runtime/control/dependency/remove",
        handler: ({ fields }) => {
          const input = dependencyFields.parse(fields);
          this.api.domain().execute({
            ...input,
            type: "dependency.remove",
            actor: "operator",
          } as DomainCommand);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "POST",
        path: "/runtime/control/instruction-apply",
        handler: ({ fields }) => {
          const input = instructionFields.parse(fields);
          this.api.domain().execute({
            ...input,
            type: "assignment.apply",
            actor: "operator",
          } as DomainCommand);
          return {
            kind: "redirect",
            location: assignmentHref(input.assignmentId),
          };
        },
      },
      {
        method: "POST",
        path: "/runtime/control/stop",
        handler: async ({ fields }) => {
          const { taskId } = taskControlFields.parse(fields);
          await this.api.stopTask(taskId);
          return { kind: "redirect", location: taskHref(taskId) };
        },
      },
      {
        method: "POST",
        path: "/runtime/control/resume",
        handler: async ({ fields }) => {
          const { taskId } = taskControlFields.parse(fields);
          await this.api.resumeTask(taskId);
          return { kind: "redirect", location: taskHref(taskId) };
        },
      },
    ];
  }
}

export function runtimeOperatorRoutes(
  api: RuntimeOperatorApi,
): OperatorRoute[] {
  return new RuntimeOperatorRoutes(api).routes;
}
