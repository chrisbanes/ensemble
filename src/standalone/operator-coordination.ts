import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CoordinationTaskView } from "./coordination-view.js";
import type { CoordinationView } from "./coordination-view.js";
import type { DomainStore } from "../core/domain.js";
import type { OperatorRoute } from "./operator-routes.js";
import type { RoutingAvailability } from "./service.js";
import type {
  ConversationHistoryAssignmentRead,
  ConversationHistoryBinding,
  ConversationHistoryEntry,
  ConversationHistoryTurnOmission,
} from "./conversation-history.js";
import { escapeHtml, hidden } from "./operator-html.js";

const uuid = z.string().uuid();
const positiveInteger = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const messageFields = z
  .object({
    key: uuid,
    taskId: uuid,
    recipientAssignmentId: uuid,
    expectedAssignmentVersion: positiveInteger,
    message: z.string().trim().min(1).max(16000),
  })
  .strict();
const questionFields = z
  .object({
    key: uuid,
    taskId: uuid,
    interactionId: uuid,
    expectedRevision: positiveInteger,
    answer: z.string().trim().min(1).max(16000),
  })
  .strict();
const approvalFields = z
  .object({
    key: uuid,
    taskId: uuid,
    interactionId: uuid,
    expectedRevision: positiveInteger,
    decision: z.enum(["approved", "denied"]),
    action: z.string().trim().min(1).max(512),
    target: z.string().trim().min(1).max(2000).optional(),
    materialJson: z.string().max(8192).optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.decision === "approved" && command.materialJson === undefined)
      context.addIssue({
        code: "custom",
        message: "Approval material is required to approve",
        path: ["materialJson"],
      });
  });
const resultRecipientFields = z
  .object({
    key: uuid,
    taskId: uuid,
    resultId: uuid,
    expectedRevision: positiveInteger,
    recipientAssignmentId: uuid,
  })
  .strict();

type OperatorDomain = Pick<
  DomainStore,
  | "assignment"
  | "assignments"
  | "profile"
  | "profiles"
  | "project"
  | "projects"
  | "routing"
  | "task"
  | "tasks"
>;

export interface CoordinationOperatorApi {
  view(): Pick<
    CoordinationView,
    | "answerQuestion"
    | "decideApproval"
    | "postOperatorMessage"
    | "readAssignmentHistory"
    | "readTask"
    | "reconcileResultRecipient"
    | "settleHandback"
    | "refreshDelivery"
  >;
  domain(): OperatorDomain;
  routingAvailability(projectId: string): RoutingAvailability;
}

const settlementFields = z
  .object({
    key: uuid,
    taskId: uuid,
    expectedTaskVersion: positiveInteger,
    expectedDeliveryRevision: positiveInteger,
    expectedPolicyVersion: positiveInteger,
    repositoryId: z.string().min(1).max(512),
    prNumber: positiveInteger,
    expectedPrNodeId: z.string().min(1).max(512),
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    decision: z.enum(["accepted", "closed"]),
  })
  .strict();
function deliverySection(
  view: CoordinationTaskView,
  csrfToken: string,
): string {
  const delivery = view.delivery;
  if (!delivery) return "";
  const issue = delivery.issueObservation;
  const sourceFacts = issue
    ? `<p>Issue ${issue.issueNumber} (${escapeHtml(issue.nodeId)}): observed ${escapeHtml(issue.observedState)}. Labels: ${escapeHtml(issue.labels.join(", "))}.</p>`
    : "<p>No imported issue observation.</p>";
  const fieldFacts = `<p>Project field observations: ${escapeHtml(delivery.projectFieldObservations.map((f) => `${f.projectNodeId}/${f.fieldNodeId}: ${f.optionNodeId}`).join("; ") || "None observed")}.</p>`;
  const b = delivery.binding,
    p = b?.observation;
  const actions = delivery.actions
    .map(
      (a) =>
        `<li>${escapeHtml(a.kind)}: ${escapeHtml(a.state)}; attempts ${a.attempts}; ${escapeHtml(a.reason ?? "")}<time>${escapeHtml(new Date(a.updatedAt).toISOString())}</time>${a.receipt ? ` — confirmed identity ${escapeHtml(a.receipt.nodeId)}` : ""}</li>`,
    )
    .join("");
  const pr = p
    ? `<p>PR ${p.number} (${escapeHtml(p.nodeId)}); head ${escapeHtml(p.headSha)}; ${p.draft ? "Draft" : "Ready for review"}; provider state ${escapeHtml(p.state)}; ${p.merged ? "Confirmed merged" : "Not merged"}.</p><p>Review: ${escapeHtml(p.reviewDecision ?? "No decision")}. Checks: ${escapeHtml(p.checks.map((c) => `${c.name}: ${c.status}`).join(", ") || "None observed")}.</p><p>Merge gates: ${escapeHtml(p.mergeBlockers.join(", ") || "No blockers observed")}. Settlement: ${escapeHtml(b?.settlement?.decision ?? "Waiting")}. ${escapeHtml(b?.readError ?? "")}</p>` +
      `<p>Provider feedback: ${escapeHtml((p.feedback ?? []).map((f) => `${f.kind} ${f.nodeId}: ${f.body}`).join("; ") || "None observed")}.</p>`
    : "<p>No PR delivery registered.</p>";
  const fields =
    b && p
      ? ([
          ["taskId", view.task.id],
          ["expectedTaskVersion", String(view.task.version)],
          ["expectedDeliveryRevision", String(b.revision)],
          ["expectedPolicyVersion", String(delivery.policyVersion)],
          ["repositoryId", p.repositoryId],
          ["prNumber", String(p.number)],
          ["expectedPrNodeId", p.nodeId],
          ["expectedHeadSha", p.headSha],
        ] as Array<[string, string]>)
      : [];
  const settlement =
    b && p && b.mode === "reviewable-pr"
      ? form(
          "/coordination/control/delivery/settle",
          [...fields, ["decision", "accepted"]],
          csrfToken,
          "Accept handback",
        ) +
        form(
          "/coordination/control/delivery/settle",
          [...fields, ["decision", "closed"]],
          csrfToken,
          "Settle outcome as closed",
        )
      : "";
  return `<section><h2>GitHub delivery</h2><p>Completion mode: ${escapeHtml(delivery.mode)}. Local task: ${escapeHtml(view.task.state)}. Delivery holds: ${escapeHtml(delivery.blockers.join(", ") || "None")}.</p>${sourceFacts}${fieldFacts}${pr}${actions ? `<ul>${actions}</ul>` : "<p>No external actions.</p>"}${settlement}${form("/coordination/control/delivery/refresh", [["taskId", view.task.id]], csrfToken, "Refresh delivery observations")}</section>`;
}
function form(
  action: string,
  fields: Array<[string, string]>,
  csrfToken: string,
  label: string,
): string {
  return `<form method="post" action="${action}">${hidden("key", randomUUID())}${hidden("csrfToken", csrfToken)}${fields
    .map(([name, value]) => hidden(name, value))
    .join("")}<button type="submit">${escapeHtml(label)}</button></form>`;
}

function textForm(
  action: string,
  fields: Array<[string, string]>,
  name: string,
  label: string,
  csrfToken: string,
): string {
  return `<form method="post" action="${action}">${hidden("key", randomUUID())}${hidden("csrfToken", csrfToken)}${fields
    .map(([field, value]) => hidden(field, value))
    .join(
      "",
    )}<label>${escapeHtml(label)} <textarea name="${escapeHtml(name)}"></textarea></label><button type="submit">Submit</button></form>`;
}

function taskHref(taskId: string): string {
  return `/coordination/task/${encodeURIComponent(taskId)}`;
}

function assignmentHref(assignmentId: string): string {
  return `/coordination/assignment/${encodeURIComponent(assignmentId)}`;
}

function assignmentLabel(assignmentId: string, domain: OperatorDomain): string {
  const assignment = domain.assignment(assignmentId);
  const profile = domain.profile(String(assignment.profileId));
  return String(profile.name);
}

function executionStatus(
  assignment: CoordinationTaskView["assignments"][number],
  view: CoordinationTaskView,
): string {
  const history = view.history.filter(
    (entry) =>
      entry.assignmentId === assignment.assignmentId &&
      entry.assignmentVersion === assignment.version,
  );
  const requests = view.requests.filter(
    (candidate) => candidate.assignmentId === assignment.assignmentId,
  );
  const latestRequest = (candidates: typeof requests) =>
    candidates.reduce<(typeof view.requests)[number] | undefined>(
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
        (candidate) => candidate.assignmentVersion === assignment.version,
      ),
    );
  const current = request
    ? view.history.find((entry) => entry.workId === request.workId)
    : history.reduce<CoordinationTaskView["history"][number] | undefined>(
        (latest, candidate) =>
          !latest ||
          candidate.conversationRevision > latest.conversationRevision
            ? candidate
            : latest,
        undefined,
      );
  if (
    assignment.state === "held" ||
    request?.state === "held" ||
    current?.state === "held"
  )
    return "Held; recovery evidence remains in runtime history";
  if (current?.state === "running") return "Running";
  if (current?.state === "submitting") return "Starting";
  if (current?.state === "resolved-failed")
    return "Failed; inspect runtime recovery history";
  if (current?.state === "completed" || request?.state === "completed")
    return "Completed";
  if (current?.state === "reconciled")
    return "Reconciled; no active turn is reported";
  if (current?.state === "capacity-waiting" || request?.state === "queued")
    return "Queued; waiting for capacity admission";
  if (current?.state === "ready") return "Queued; not admitted to runtime";
  if (request?.state === "active")
    return "Admitted; runtime state is not confirmed";
  if (assignment.state === "running")
    return "Admitted; runtime state is not confirmed";
  if (assignment.state === "completed") return "Completed";
  if (assignment.state === "pending") return "Selected; not yet admitted";
  return `No active execution is reported (${assignment.state})`;
}

function questionSection(
  taskId: string,
  view: CoordinationTaskView,
  domain: OperatorDomain,
  csrfToken: string,
  webEnabled = false,
): string {
  const rows = view.questions
    .map((question) => {
      const requestingAssignment = question.requestingAssignmentId;
      const requesterLink = `<a href="${assignmentHref(requestingAssignment)}">${escapeHtml(assignmentLabel(requestingAssignment, domain))}</a>`;
      const full =
        view.questionForms?.some(
          (q) => q.interactionId === question.interactionId,
        ) ||
        view.runtimeQuestions?.some(
          (q) => q.interactionId === question.interactionId,
        );
      const answer = full
        ? webEnabled
          ? `<p><a href="/app/tasks/${encodeURIComponent(taskId)}?request=${encodeURIComponent(question.interactionId)}">Open exact structured question</a>. Answer recording is separate from runtime delivery.</p>`
          : `<p>Structured response unavailable in web-disabled diagnostic HTML; request remains unresolved until the shared web form is available.</p>`
        : question.status === "open"
          ? textForm(
              "/coordination/control/question/answer",
              [
                ["taskId", taskId],
                ["interactionId", question.interactionId],
                ["expectedRevision", String(question.revision)],
              ],
              "answer",
              "Answer",
              csrfToken,
            )
          : `<p>Response: ${escapeHtml(question.response ?? question.status)}.</p>`;
      return `<li><p>${requesterLink} asks: ${escapeHtml(question.prompt)} (${escapeHtml(question.status)}).</p>${answer}</li>`;
    })
    .join("");
  return `<section><h2>Questions</h2>${rows ? `<ul>${rows}</ul>` : "<p>No questions.</p>"}</section>`;
}

function approvalForm(
  taskId: string,
  approval: CoordinationTaskView["approvals"][number],
  decision: "approved" | "denied",
  csrfToken: string,
): string {
  return form(
    "/coordination/control/approval/decision",
    [
      ["taskId", taskId],
      ["interactionId", approval.interactionId],
      ["expectedRevision", String(approval.revision)],
      ["decision", decision],
      ["action", approval.action ?? ""],
      ...(approval.target === null
        ? []
        : [["target", approval.target] as [string, string]]),
      ...(approval.materialJson === null
        ? []
        : [["materialJson", approval.materialJson] as [string, string]]),
    ],
    csrfToken,
    decision === "approved" ? "Approve this exact material" : "Deny",
  );
}

function approvalSection(
  taskId: string,
  view: CoordinationTaskView,
  csrfToken: string,
): string {
  const rows = view.approvals
    .map((approval) => {
      const status = escapeHtml(approval.status);
      if (approval.materialJson === null) {
        const action =
          approval.status === "open"
            ? `<p>Legacy approval: original material was not retained, so it cannot be approved. It may only be denied.</p>${approvalForm(taskId, approval, "denied", csrfToken)}`
            : "";
        return `<li><p>${escapeHtml(approval.prompt)} — ${status} (pre-material record).</p>${action}</li>`;
      }
      let validMaterial = true;
      try {
        JSON.parse(approval.materialJson);
      } catch {
        validMaterial = false;
      }
      if (!validMaterial)
        return `<li><p>${escapeHtml(approval.action)} — ${status}; stored approval material is invalid and no decision is available.</p></li>`;
      const actions =
        approval.status === "open"
          ? `${approvalForm(taskId, approval, "approved", csrfToken)}${approvalForm(taskId, approval, "denied", csrfToken)}`
          : `<p>Decision: ${status}.</p>`;
      return `<li><p>Approval requested: ${escapeHtml(approval.action)}${approval.target === null ? "" : ` on ${escapeHtml(approval.target)}`} — ${status}. Requested by <a href="${assignmentHref(approval.requestingAssignmentId)}">the task-scoped assignment</a>.</p><pre>${escapeHtml(approval.materialJson)}</pre>${actions}</li>`;
    })
    .join("");
  return `<section><h2>Approvals</h2>${rows ? `<ul>${rows}</ul>` : "<p>No approval requests.</p>"}</section>`;
}

function routingSection(
  task: CoordinationTaskView,
  domain: OperatorDomain,
  availability: RoutingAvailability,
): string {
  const routing = domain.routing(task.task.projectId);
  const candidateIds = z
    .array(uuid)
    .parse(JSON.parse(String(routing.candidateProfileIds)));
  const candidates = candidateIds
    .map((profileId) => domain.profile(profileId))
    .map((profile) => {
      const revoked = Number(profile.revoked) !== 0;
      const eligibility = revoked
        ? "unavailable: profile revoked"
        : "eligible routing candidate";
      return `<li>${escapeHtml(profile.name)} — capabilities: ${escapeHtml(profile.capabilities || "none specified")}; ${eligibility}</li>`;
    })
    .join("");
  const reason = {
    disabled: "disabled",
    "missing-client-credentials": "missing client credentials",
    "no-eligible-candidates": "no eligible candidates",
  } as const;
  const effective = availability.available
    ? "available"
    : `unavailable (${availability.reason ? reason[availability.reason] : "unknown"})`;
  const dispositions = task.routing.dispositions
    .map((disposition) => {
      const selected = disposition.assignmentId
        ? `<a href="${assignmentHref(disposition.assignmentId)}">${escapeHtml(assignmentLabel(disposition.assignmentId, domain))}</a>`
        : "no assignment selected";
      return `<li>Routing operation ${escapeHtml(disposition.disposition)} selected ${selected}; intended result destination: ${escapeHtml(disposition.resultDestination)}.</li>`;
    })
    .join("");
  const attempts = task.routing.attempts
    .map(
      (attempt) =>
        `<li>Routing status: ${escapeHtml(attempt.status)}; attempts used: ${escapeHtml(attempt.attemptsUsed)}; outcome: ${escapeHtml(attempt.outcome ?? "not recorded")}.</li>`,
    )
    .join("");
  return `<section><h2>Routing</h2><p>Automatic routing is ${availability.enabled ? "enabled" : "disabled"}.</p><p>Credential reference: ${availability.credentialReferenceConfigured ? "configured" : "not configured"}. Routing client: ${availability.routingClientAvailable ? "available" : "unavailable"}. The credential reference is not displayed.</p><p>Effective routing availability: ${effective}.</p><p>Project routing guidance: ${escapeHtml(routing.guidance)}</p><p>Configured candidates:</p>${candidates ? `<ul>${candidates}</ul>` : "<p>None.</p>"}<p>Routing selection is not execution admission; assignment runtime state appears separately.</p>${dispositions || attempts ? `<ul>${dispositions}${attempts}</ul>` : "<p>No routing decision has been recorded.</p>"}</section>`;
}

function resultSection(
  taskId: string,
  view: CoordinationTaskView,
  domain: OperatorDomain,
  csrfToken: string,
): string {
  const unresolved = new Set(
    view.unresolvedResults.map((result) => result.resultId),
  );
  const results = view.results
    .map((result) => {
      const sourceAssignment = domain.assignment(result.assignmentId);
      const project = domain.project(String(sourceAssignment.projectId));
      const lead = view.assignments.find(
        (item) => item.profileId === String(project.leadProfileId),
      );
      const exactDestination = view.assignments.find(
        (item) =>
          item.assignmentId === String(sourceAssignment.resultDestination),
      );
      const permittedRecipient = sourceAssignment.requesterAssignmentId
        ? view.assignments.find(
            (item) =>
              item.assignmentId ===
              String(sourceAssignment.requesterAssignmentId),
          )
        : (exactDestination ?? lead);
      const source = `<a href="${assignmentHref(result.assignmentId)}">${escapeHtml(assignmentLabel(result.assignmentId, domain))}</a>`;
      const destination = result.recipientAssignmentId
        ? `<a href="${assignmentHref(result.recipientAssignmentId)}">${escapeHtml(assignmentLabel(result.recipientAssignmentId, domain))}</a>`
        : "unresolved";
      const select = unresolved.has(result.resultId)
        ? permittedRecipient
          ? form(
              "/coordination/control/result/recipient",
              [
                ["taskId", taskId],
                ["resultId", result.resultId],
                [
                  "expectedRevision",
                  String(
                    view.unresolvedResults.find(
                      (item) => item.resultId === result.resultId,
                    )?.revision ?? 0,
                  ),
                ],
                ["recipientAssignmentId", permittedRecipient.assignmentId],
              ],
              csrfToken,
              `Reconcile to ${assignmentLabel(permittedRecipient.assignmentId, domain)}`,
            )
          : "<p>No same-task lead or requester is available; destination remains unresolved.</p>"
        : "";
      return `<li>${source} result: ${escapeHtml(result.summary)}. Destination: ${destination} (${escapeHtml(result.destinationDisposition)}).${select}</li>`;
    })
    .join("");
  return `<section><h2>Results and destinations</h2>${results ? `<ul>${results}</ul>` : "<p>No results.</p>"}</section>`;
}

function messageSection(
  taskId: string,
  view: CoordinationTaskView,
  domain: OperatorDomain,
  csrfToken: string,
): string {
  const messages = view.messages
    .map((message) => {
      const recipient = `<a href="${assignmentHref(message.recipientAssignmentId)}">${escapeHtml(assignmentLabel(message.recipientAssignmentId, domain))}</a>`;
      const text = message.text ? `: ${escapeHtml(message.text)}` : "";
      return `<li>${escapeHtml(message.eventType)} to ${recipient}; ${escapeHtml(message.deliveryState)}${text}.</li>`;
    })
    .join("");
  const forms = view.assignments
    .filter((assignment) => ["pending", "running"].includes(assignment.state))
    .map((assignment) =>
      textForm(
        "/coordination/control/message",
        [
          ["taskId", taskId],
          ["recipientAssignmentId", assignment.assignmentId],
          ["expectedAssignmentVersion", String(assignment.version)],
        ],
        "message",
        `Message ${assignmentLabel(assignment.assignmentId, domain)} next turn`,
        csrfToken,
      ),
    )
    .join("");
  return `<section><h2>Durable messages</h2>${messages ? `<ul>${messages}</ul>` : "<p>No messages.</p>"}${forms || "<p>No pending or running assignment can receive an operator message.</p>"}</section>`;
}

function taskPage(
  taskId: string,
  api: CoordinationOperatorApi,
  csrfToken: string,
  webEnabled = false,
): string {
  const view = api.view().readTask(uuid.parse(taskId));
  const domain = api.domain();
  const project = domain.project(view.task.projectId);
  const leadProfileId =
    project.leadProfileId === null ? null : String(project.leadProfileId);
  const leadAssignment = view.assignments.find(
    (assignment) => assignment.profileId === leadProfileId,
  );
  const lead = leadProfileId
    ? `<p>Accountable project lead: ${escapeHtml(domain.profile(leadProfileId).name)}${leadAssignment ? `; <a href="${assignmentHref(leadAssignment.assignmentId)}">task-scoped lead history</a>` : ""}.</p>`
    : "<p>No project lead is configured.</p>";
  const assignments = view.assignments
    .map((assignment) => {
      const profile = domain.profile(assignment.profileId);
      const isLead = assignment.profileId === leadProfileId;
      const status = executionStatus(assignment, view);
      return `<li><a href="${assignmentHref(assignment.assignmentId)}">${escapeHtml(profile.name)}${isLead ? " (project lead)" : ""}</a> — selected assignment state ${escapeHtml(assignment.state)}; execution: ${escapeHtml(status)}.</li>`;
    })
    .join("");
  const histories = view.history
    .map((entry) => {
      const label = assignmentLabel(entry.assignmentId, domain);
      return `<li><a href="${assignmentHref(entry.assignmentId)}">${escapeHtml(label)} history</a> — assignment revision ${escapeHtml(entry.assignmentVersion)}, conversation revision ${escapeHtml(entry.conversationRevision)}; runtime intent ${escapeHtml(entry.state)}.</li>`;
    })
    .join("");
  const fallbackCount = view.attention.routingFallbacks.length;
  const availability = api.routingAvailability(String(view.task.projectId));
  return `<main><h1>${escapeHtml(view.task.title)} coordination</h1><p>Task state: ${escapeHtml(view.task.state)}; ${view.task.ready ? "Ready" : "Not ready"}.</p><p>Project: <a href="/project/${encodeURIComponent(String(project.id))}">${escapeHtml(project.name)}</a>. <a href="/runtime/task/${encodeURIComponent(taskId)}">Task-scoped runtime controls and recovery</a>.</p>${lead}<section><h2>Assignments and admission</h2>${assignments ? `<ul>${assignments}</ul>` : "<p>No assignments.</p>"}<p>A selected or queued assignment is not a running turn; runtime intent and held/recovery state are separate evidence.</p></section><section><h2>Lead and assignee histories</h2>${histories ? `<ul>${histories}</ul>` : "<p>No runtime history is recorded.</p>"}</section>${deliverySection(view, csrfToken)}${routingSection(view, domain, availability)}${resultSection(taskId, view, domain, csrfToken)}${questionSection(taskId, view, domain, csrfToken, webEnabled)}${approvalSection(taskId, view, csrfToken)}${messageSection(taskId, view, domain, csrfToken)}<section><h2>Coordination history</h2>${view.completionRequests.length ? `<p>Completion requests: ${view.completionRequests.map((item) => `${escapeHtml(item.status)} (revision ${escapeHtml(item.revision)})`).join(", ")}.</p>` : "<p>No completion requests.</p>"}${fallbackCount ? `<p>${fallbackCount} routing fallback event(s) need review.</p>` : "<p>No routing fallback needs review.</p>"}</section></main>`;
}

function capturedHistory(history: ConversationHistoryAssignmentRead): string {
  const generations = new Map<
    string,
    {
      binding: ConversationHistoryBinding;
      items: ConversationHistoryEntry[];
      omissions: ConversationHistoryTurnOmission[];
    }
  >();
  const generation = (binding: ConversationHistoryBinding) => {
    const key = JSON.stringify([
      binding.workId,
      binding.threadId,
      binding.turnId,
    ]);
    let value = generations.get(key);
    if (!value) {
      value = { binding, items: [], omissions: [] };
      generations.set(key, value);
    }
    return value;
  };
  for (const item of history.items) generation(item).items.push(item);
  for (const omission of history.turnOmissions)
    generation(omission).omissions.push(omission);
  const groups = [...generations.values()]
    .map(({ binding, items, omissions }) => {
      const messages = items
        .map((item) => {
          let content: string;
          if (item.lifecycle === "completed")
            content = `<pre>${escapeHtml(item.text ?? "")}</pre>`;
          else if (item.lifecycle === "omitted")
            content = `Assistant item omitted: ${escapeHtml(item.omissionReason)}.`;
          else
            content = `Partial assistant item; ${escapeHtml(item.deltaBytes)} streamed bytes; text not retained.`;
          return `<li data-conversation-item="${escapeHtml(item.itemId)}">${content}</li>`;
        })
        .join("");
      const gaps = omissions
        .map(
          (omission) =>
            `<p>History may be incomplete: ${escapeHtml(omission.reason)}.</p>`,
        )
        .join("");
      return `<section><h4>Conversation revision ${escapeHtml(binding.conversationRevision)}; work revision ${escapeHtml(binding.workRevision)}</h4><p>Assignment revision ${escapeHtml(binding.assignmentVersion)}; instruction revision ${escapeHtml(binding.instructionsRevision)}; profile revision ${escapeHtml(binding.profileRevision)}.</p><p>Work ${escapeHtml(binding.workId)}; thread ${escapeHtml(binding.threadId)}; turn ${escapeHtml(binding.turnId)}.</p>${messages ? `<ol>${messages}</ol>` : ""}${gaps}</section>`;
    })
    .join("");
  return `<h3>Captured assistant messages</h3><p>History is diagnostic and may be incomplete. It does not establish completion, active execution or safe recovery.</p>${history.omittedItemCount ? `<p>${escapeHtml(history.omittedItemCount)} older history item(s) not shown; only the latest 200 items are displayed.</p>` : ""}${groups || "<p>No captured assistant messages are recorded.</p>"}`;
}

function assignmentPage(
  assignmentId: string,
  api: CoordinationOperatorApi,
  csrfToken: string,
): string {
  const domain = api.domain();
  const assignment = domain.assignment(uuid.parse(assignmentId));
  const taskId = String(assignment.taskId);
  const view = api.view().readTask(taskId);
  const summary = view.assignments.find(
    (item) => item.assignmentId === assignmentId,
  );
  if (!summary) throw new Error("Assignment is not in its task view");
  const profile = domain.profile(String(assignment.profileId));
  const conversation = capturedHistory(
    api.view().readAssignmentHistory(assignmentId),
  );
  const history = view.history
    .filter((entry) => entry.assignmentId === assignmentId)
    .map(
      (entry) =>
        `<li>Assignment revision ${escapeHtml(entry.assignmentVersion)}; conversation revision ${escapeHtml(entry.conversationRevision)}; runtime intent ${escapeHtml(entry.state)}.</li>`,
    )
    .join("");
  const messages = view.messages
    .filter((item) => item.recipientAssignmentId === assignmentId)
    .map(
      (item) =>
        `<li>${escapeHtml(item.eventType)} — ${escapeHtml(item.deliveryState)}${item.text ? `: ${escapeHtml(item.text)}` : ""}.</li>`,
    )
    .join("");
  const interactions = [...view.questions, ...view.approvals]
    .filter((item) => item.requestingAssignmentId === assignmentId)
    .map(
      (item) =>
        `<li>${escapeHtml(item.kind)} — ${escapeHtml(item.status)}${item.kind === "question" ? `: ${escapeHtml(item.prompt)}` : `: ${escapeHtml(item.action)}`}.</li>`,
    )
    .join("");
  const results = view.results
    .filter(
      (item) =>
        item.assignmentId === assignmentId ||
        item.recipientAssignmentId === assignmentId,
    )
    .map(
      (item) =>
        `<li>${escapeHtml(item.summary)} — destination ${escapeHtml(item.destinationDisposition)}.</li>`,
    )
    .join("");
  const nextTurnMessage = ["pending", "running"].includes(summary.state)
    ? textForm(
        "/coordination/control/message",
        [
          ["taskId", taskId],
          ["recipientAssignmentId", assignmentId],
          ["expectedAssignmentVersion", String(summary.version)],
        ],
        "message",
        "Durable message for the next turn",
        csrfToken,
      )
    : "<p>Messages are only queued for a pending or running assignment.</p>";
  return `<main><h1>${escapeHtml(profile.name)} task assignment</h1><p>Task: <a href="${taskHref(taskId)}">${escapeHtml(view.task.title)}</a>.</p><p>Assignment state: ${escapeHtml(summary.state)}; execution: ${escapeHtml(executionStatus(summary, view))}.</p><p>Results remain directed to the configured project lead or requesting assignment; the project lead remains accountable.</p><section><h2>Conversation history</h2>${history ? `<ul>${history}</ul>` : "<p>No conversation history is recorded.</p>"}${conversation}</section><section><h2>Coordination messages</h2>${messages ? `<ul>${messages}</ul>` : "<p>No messages.</p>"}${nextTurnMessage}</section><section><h2>Questions and approvals</h2>${interactions ? `<ul>${interactions}</ul>` : "<p>No questions or approvals.</p>"}</section><section><h2>Results</h2>${results ? `<ul>${results}</ul>` : "<p>No results.</p>"}</section><p><a href="${taskHref(taskId)}">Back to task coordination</a></p></main>`;
}

function overview(domain: OperatorDomain): string {
  const projects = domain.projects();
  return `<main><h1>Coordination</h1>${projects
    .map((project) => {
      const tasks = domain.tasks(String(project.id));
      const items = tasks
        .map(
          (task) =>
            `<li><a href="${taskHref(String(task.id))}">${escapeHtml(task.title)}</a> — ${escapeHtml(task.state)}; ${task.ready ? "Ready" : "Not ready"}.</li>`,
        )
        .join("");
      return `<section><h2>${escapeHtml(project.name)}</h2>${items ? `<ul>${items}</ul>` : "<p>No tasks.</p>"}</section>`;
    })
    .join("")}</main>`;
}

export class CoordinationOperatorRoutes {
  constructor(private readonly api: CoordinationOperatorApi) {}

  get routes(): OperatorRoute[] {
    return [
      {
        method: "POST",
        path: "/coordination/control/delivery/settle",
        handler: async ({ fields }) => {
          const input = settlementFields.parse(fields);
          await this.api.view().settleHandback(input);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "POST",
        path: "/coordination/control/delivery/refresh",
        handler: async ({ fields }) => {
          const input = z
            .object({ key: uuid, taskId: uuid })
            .strict()
            .parse(fields);
          await this.api.view().refreshDelivery(input.taskId);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "GET",
        path: "/coordination",
        handler: () => ({ kind: "html", body: overview(this.api.domain()) }),
      },
      {
        method: "GET",
        path: "/coordination/task/:taskId",
        handler: ({ params, csrfToken, webEnabled }) => ({
          kind: "html",
          body: taskPage(params.taskId ?? "", this.api, csrfToken, webEnabled),
        }),
      },
      {
        method: "GET",
        path: "/coordination/assignment/:assignmentId",
        handler: ({ params, csrfToken }) => ({
          kind: "html",
          body: assignmentPage(params.assignmentId ?? "", this.api, csrfToken),
        }),
      },
      {
        method: "POST",
        path: "/coordination/control/message",
        handler: async ({ fields }) => {
          const input = messageFields.parse(fields);
          await this.api.view().postOperatorMessage(input);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "POST",
        path: "/coordination/control/question/answer",
        handler: async ({ fields }) => {
          const input = questionFields.parse(fields);
          await this.api.view().answerQuestion(input);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "POST",
        path: "/coordination/control/approval/decision",
        handler: async ({ fields }) => {
          const input = approvalFields.parse(fields);
          let material: unknown;
          if (input.materialJson !== undefined) {
            if (new TextEncoder().encode(input.materialJson).byteLength > 8192)
              throw new Error("Approval material exceeds the 8 KiB limit");
            try {
              material = JSON.parse(input.materialJson) as unknown;
            } catch {
              throw new Error("Approval material is not valid JSON");
            }
          }
          await this.api.view().decideApproval({
            taskId: input.taskId,
            key: input.key,
            interactionId: input.interactionId,
            expectedRevision: input.expectedRevision,
            decision: input.decision,
            action: input.action,
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.materialJson === undefined ? {} : { material }),
          });
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
      {
        method: "POST",
        path: "/coordination/control/result/recipient",
        handler: async ({ fields }) => {
          const input = resultRecipientFields.parse(fields);
          await this.api.view().reconcileResultRecipient(input);
          return { kind: "redirect", location: taskHref(input.taskId) };
        },
      },
    ];
  }
}

export function coordinationOperatorRoutes(
  view: CoordinationView,
  domain: DomainStore,
  routingAvailability: (projectId: string) => RoutingAvailability,
): OperatorRoute[] {
  return new CoordinationOperatorRoutes({
    view: () => view,
    domain: () => domain,
    routingAvailability,
  }).routes;
}
