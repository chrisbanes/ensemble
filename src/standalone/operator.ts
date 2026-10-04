import type { OperatorWebBoundary } from "./operator-web.js";
import { OperatorApiError } from "./operator-api.js";
import { apiErrorSchema, sessionSchema } from "../operator/contracts.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  DomainCommands,
  DomainConflictError,
  type DomainCommand,
  type DomainStore,
} from "../core/domain.js";
import type { OperatorAuth, OperatorSession } from "./operator-auth.js";
import {
  GitHubHttpSourceReader,
  type GitHubSourceReader,
} from "./github-source.js";
import {
  selectionSchema,
  type GitHubSourceStore,
} from "../core/github-source.js";
import {
  OperatorRouteRegistry,
  type OperatorRouteResult,
} from "./operator-routes.js";
import { escapeHtml, hidden } from "./operator-html.js";

function containsControlCharacters(value: string): boolean {
  return value.split("").some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function field(
  name: string,
  value = "",
  kind = "text",
  checked = false,
  label = name,
): string {
  return `<label>${escapeHtml(label)} <input name="${escapeHtml(name)}" type="${kind}" value="${escapeHtml(value)}"${checked ? " checked" : ""}></label>`;
}

function textarea(name: string, value = ""): string {
  return `<label>${escapeHtml(name)} <textarea name="${escapeHtml(name)}">${escapeHtml(value)}</textarea></label>`;
}

function selectField(
  name: string,
  options: { value: string; label: string; disabled?: boolean }[],
  selected: string,
): string {
  return `<label>${escapeHtml(name)} <select name="${escapeHtml(name)}">${options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}${option.disabled ? " disabled" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("")}</select></label>`;
}

function form(
  type: string,
  fields: string,
  createId?: string,
  csrfToken = "",
): string {
  return `<form method="post" action="/command" data-command="${escapeHtml(type)}">${hidden("type", type)}${hidden("key", randomUUID())}${createId ? hidden(createId, randomUUID()) : ""}${csrfToken ? hidden("csrfToken", csrfToken) : ""}${fields}<button type="submit">Save</button></form>`;
}

/** Local operator surface for the authenticated UI foundation to mount. */
export class LocalOperatorUi {
  private readonly commands: DomainCommands;

  constructor(
    private readonly store: DomainStore,
    private readonly githubPreviewReader: (
      credentialRef: string,
    ) => Pick<GitHubSourceReader, "readSelection"> = (credentialRef) =>
      new GitHubHttpSourceReader(process.env[credentialRef.slice(4)]),
    private readonly githubSources?: GitHubSourceStore,
    private readonly githubRefresh?: () => Promise<void>,
  ) {
    this.commands = new DomainCommands(store);
  }

  home(csrfToken = ""): string {
    const projects = this.store
      .projects()
      .map(
        (project) =>
          `<li><a href="/project/${escapeHtml(project.id)}">${escapeHtml(project.name)}</a> (${project.paused ? "paused" : "active"})</li>`,
      )
      .join("");
    const profiles = this.store
      .profiles()
      .map(
        (profile) =>
          `<li><a href="/profile/${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</a> (${profile.revoked ? "revoked" : "active"})</li>`,
      )
      .join("");
    const leadProfiles = this.store
      .profiles()
      .filter((profile) => !profile.revoked)
      .map((profile) => ({
        value: String(profile.id),
        label: String(profile.name),
      }));
    return `<main><h1>Ensemble</h1><h2>Projects</h2><ul>${projects}</ul>${form("project.create", field("name") + selectField("leadProfileId", [{ value: "", label: "Unconfigured" }, ...leadProfiles], ""), "projectId", csrfToken)}<h2>Profiles</h2><ul>${profiles}</ul>${form("profile.create", field("name") + textarea("instructions") + textarea("capabilities"), "profileId", csrfToken)}</main>`;
  }

  project(projectId: string, csrfToken = ""): string {
    const project = this.store.project(projectId);
    const routing = this.store.routing(projectId);
    const github = this.store.githubConfiguration(projectId);
    const activeGithub = new Set(
      this.store.githubActiveSelectionIds(projectId),
    );
    const previewForms = github.selections
      .map((raw) => {
        const selection = selectionSchema.parse(raw);
        const sync = this.githubSources?.syncState(projectId, selection.id);
        const status = !sync
          ? "never synced"
          : Number(sync.complete) === 1
            ? "complete"
            : `partial: ${escapeHtml(sync.reason)}`;
        return `<li>${escapeHtml(selection.id)} (${escapeHtml(selection.kind)}; ${activeGithub.has(selection.id) ? "active" : "inactive"}; ${status}; ${escapeHtml(sync?.refreshedAt ?? "never")})${form("github.preview", field("projectId", projectId, "hidden") + field("selectionId", selection.id, "hidden") + field("expectedVersion", String(github.version), "hidden"), undefined, csrfToken)}</li>`;
      })
      .join("");
    const conflicts =
      this.githubSources
        ?.conflicts()
        .filter((conflict) => conflict.projectIds.includes(projectId))
        .map((conflict) => {
          const task = this.store.task(conflict.taskId);
          return `<li>Issue ${escapeHtml(conflict.nodeId)}: unresolved placement among ${escapeHtml(conflict.projectIds.join(", "))}${form(
            "github.place",
            field("projectId", String(task.projectId), "hidden") +
              field("taskId", conflict.taskId, "hidden") +
              field("expectedVersion", String(task.version), "hidden") +
              selectField(
                "chosenProjectId",
                conflict.projectIds.map((id) => ({ value: id, label: id })),
                String(task.projectId),
              ),
            undefined,
            csrfToken,
          )}</li>`;
        })
        .join("") ?? "";
    const profiles = this.store.profiles();
    const currentLead = profiles.find(
      (profile) => profile.id === project.leadProfileId,
    );
    const leadOptions = [
      { value: "", label: "Unconfigured" },
      ...(currentLead?.revoked
        ? [
            {
              value: String(currentLead.id),
              label: `${String(currentLead.name)} (revoked)`,
              disabled: true,
            },
          ]
        : []),
      ...profiles
        .filter((profile) => !profile.revoked)
        .map((profile) => ({
          value: String(profile.id),
          label: String(profile.name),
        })),
    ];
    const tasks = this.store
      .tasks(projectId)
      .map(
        (task) =>
          `<li><a href="/app/tasks/${escapeHtml(task.id)}">${escapeHtml(task.title)}</a> (${task.ready ? "ready" : "unready"}; ${escapeHtml(task.state)}; blockers ${escapeHtml(task.importedBlockers)}). <a href="/runtime/task/${escapeHtml(task.id)}">Runtime</a> · <a href="/coordination/task/${escapeHtml(task.id)}">Coordination</a></li>`,
      )
      .join("");
    const candidateProfileIds = JSON.stringify(
      JSON.parse(String(routing.candidateProfileIds)) as string[],
      null,
      2,
    );
    const delivery = this.store.deliveryConfiguration(projectId);
    const credentialReferenceStatus = routing.credentialAvailable
      ? "credential reference configured"
      : "credential reference not configured";
    return `<main><h1>${escapeHtml(project.name)}</h1><p>${project.paused ? "Paused" : "Active"}. Lead profile ${escapeHtml(project.leadProfileId ?? "unconfigured")}. Instructions revision ${escapeHtml(project.instructionsRevision)}.</p><h2>Tasks</h2><ul>${tasks}</ul>${form("task.create", field("projectId", projectId, "hidden") + field("title") + textarea("outcome") + field("ready", "1", "checkbox", false, "Create and start (mark Ready)"), "taskId", csrfToken)}<h2>Project configuration</h2>${form("project.configure", field("projectId", projectId, "hidden") + field("expectedVersion", String(project.version), "hidden") + field("instructionsRevision", String(project.instructionsRevision), "hidden") + field("name", String(project.name)) + selectField("leadProfileId", leadOptions, String(project.leadProfileId ?? "")) + textarea("instructions", String(project.instructions)) + field("paused", "1", "checkbox", Boolean(project.paused)), undefined, csrfToken)}<h2>Routing</h2><p>${routing.enabled ? "Enabled" : "Disabled"}; ${credentialReferenceStatus}</p>${form("routing.configure", field("projectId", projectId, "hidden") + field("expectedVersion", String(routing.version), "hidden") + field("enabled", "1", "checkbox", Boolean(routing.enabled)) + textarea("guidance", String(routing.guidance)) + field("credentialRef") + field("clearCredentialRef", "1", "checkbox") + textarea("candidateProfileIds", candidateProfileIds), undefined, csrfToken)}<h2>GitHub delivery</h2><p>${delivery.credentialConfigured ? "Credential reference configured" : "Credential reference not configured"}. Mode: ${escapeHtml(delivery.mode)}; external actions default to denied.</p>${form(
      "delivery.configure",
      hidden("projectId", projectId) +
        hidden("expectedVersion", String(delivery.version)) +
        selectField(
          "mode",
          [
            { value: "reviewable-pr", label: "Reviewable PR" },
            { value: "through-merge", label: "Through merge" },
          ],
          delivery.mode,
        ) +
        field("credentialRef") +
        field("clearCredentialRef", "1", "checkbox") +
        textarea("grants", JSON.stringify(delivery.grants, null, 2)) +
        textarea(
          "requiredChecks",
          JSON.stringify(delivery.requiredChecks, null, 2),
        ),
      undefined,
      csrfToken,
    )}<h2>GitHub discovery</h2><p>${github.credentialRef ? "Credential reference configured" : "Credential reference not configured"}. Selections require preview before activation.</p>${form(
      "github.configure",
      field("projectId", projectId, "hidden") +
        field("expectedVersion", String(github.version), "hidden") +
        field("credentialRef") +
        field("clearCredentialRef", "1", "checkbox") +
        textarea("selections", JSON.stringify(github.selections, null, 2)) +
        textarea("readiness", JSON.stringify(github.readiness, null, 2)) +
        textarea(
          "repositories",
          JSON.stringify(
            github.repositories.map(
              ({ gitCommonDirectory: _ignored, ...repository }) => repository,
            ),
            null,
            2,
          ),
        ),
      undefined,
      csrfToken,
    )}<ul>${previewForms}</ul>${this.githubRefresh ? form("github.refresh", field("projectId", projectId, "hidden"), undefined, csrfToken) : ""}<h3>Unresolved placement</h3><ul>${conflicts}</ul></main>`;
  }

  task(taskId: string, csrfToken = ""): string {
    const task = this.store.task(taskId);
    const admission = this.store.admission(taskId);
    const imported = this.store.importedTask(taskId);
    const external = imported
      ? this.githubSources?.issue(String(imported.nodeId))
      : undefined;
    const memberships = imported
      ? (this.githubSources?.memberships(String(imported.nodeId)) ?? [])
      : [];
    const blockers = imported
      ? (this.githubSources?.nativeBlockers(String(imported.nodeId)) ?? [])
      : [];
    const review = imported
      ? this.githubSources?.review(String(imported.nodeId))
      : undefined;
    const hold = imported
      ? this.githubSources?.hold(String(imported.nodeId))
      : undefined;
    const provenance = external
      ? `<h2>GitHub source</h2><p>${escapeHtml(external.providerInstance)} ${escapeHtml(external.repositoryName)}#${escapeHtml(external.issueNumber)} (${escapeHtml(external.nodeId)}); observed ${escapeHtml(external.observedState)}.</p><p>Observed title: ${escapeHtml(external.observedTitle)}. Observed body: ${escapeHtml(external.observedBody)}</p><p>Memberships: ${escapeHtml(memberships.map((item) => `${item.projectId}/${item.selectionId}`).join(", ") || "none")}. Fields: ${escapeHtml(memberships.map((item) => item.projectFields).join(", "))}</p><p>Native blockers: ${escapeHtml(blockers.map((item) => `${item.repositoryName}#${item.issueNumber}: ${item.status}`).join(", ") || task.importedBlockers)}</p><p>Source hold: ${hold?.active ? escapeHtml(hold.reason) : "none"}.</p>${
          review &&
          (review.observedDigest !== review.acceptedDigest || hold?.active)
            ? form(
                "source.review",
                field("projectId", String(task.projectId), "hidden") +
                  field("taskId", taskId, "hidden") +
                  field("expectedVersion", String(task.version), "hidden") +
                  field(
                    "observedDigest",
                    String(review.observedDigest),
                    "hidden",
                  ) +
                  selectField(
                    "decision",
                    [
                      { value: "clarification", label: "Clarification" },
                      {
                        value: "accept-revised-scope",
                        label: "Accept revised scope",
                      },
                      {
                        value: "resume-source-hold",
                        label: "Resume source hold",
                      },
                    ],
                    review.observedDigest !== review.acceptedDigest
                      ? "accept-revised-scope"
                      : "resume-source-hold",
                  ),
                undefined,
                csrfToken,
              )
            : ""
        }`
      : "";
    return `<main><h1>${escapeHtml(task.title)}</h1><p>Outcome: ${escapeHtml(task.outcome)}</p><p>${task.ready ? "Ready" : "Not ready"}; ${escapeHtml(task.state)}.</p><p>Configuration eligibility only: ${admission.eligible ? "eligible for future admission" : `held: ${escapeHtml(admission.reasons.join(", "))}`}.</p><p>Readiness and configuration eligibility do not confirm runtime admission or execution.</p>${provenance}<p><a href="/runtime/task/${escapeHtml(taskId)}">Runtime status, controls and recovery evidence</a> · <a href="/coordination/task/${escapeHtml(taskId)}">Task-scoped coordination and history</a></p>${imported ? "" : form("task.configure", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("expectedVersion", String(task.version), "hidden") + field("title", String(task.title)) + textarea("outcome", String(task.outcome)) + field("ready", "1", "checkbox", Boolean(task.ready)), undefined, csrfToken)}</main>`;
  }

  profile(profileId: string, csrfToken = ""): string {
    const profile = this.store.profile(profileId);
    return `<main><h1>${escapeHtml(profile.name)}</h1><p>Revision ${escapeHtml(profile.version)}; ${profile.revoked ? "revoked" : "active"}</p>${form("profile.configure", field("profileId", profileId, "hidden") + field("expectedVersion", String(profile.version), "hidden") + field("name", String(profile.name)) + textarea("instructions", String(profile.instructions)) + textarea("capabilities", String(profile.capabilities)) + field("revoked", "1", "checkbox", Boolean(profile.revoked)), undefined, csrfToken)}</main>`;
  }

  assignment(assignmentId: string): string {
    const assignment = this.store.assignment(assignmentId);
    const task = this.store.task(String(assignment.taskId));
    const profile = this.store.profile(String(assignment.profileId));
    return `<main><h1>${escapeHtml(profile.name)} assignment</h1><p>Task: <a href="/app/tasks/${escapeHtml(task.id)}?assignment=${escapeHtml(assignment.id)}">${escapeHtml(task.title)}</a>. Assignment lifecycle state: ${escapeHtml(assignment.state)}; this does not confirm runtime admission or execution.</p><p><a href="/runtime/assignment/${escapeHtml(assignment.id)}">Runtime status, controls and recovery evidence</a> · <a href="/coordination/assignment/${escapeHtml(assignment.id)}">Conversation and coordination history</a></p></main>`;
  }

  runtime(): string {
    return "<main><h1>Runtime</h1><p>Unavailable. This operator surface does not start or control execution.</p></main>";
  }

  coordination(): string {
    return "<main><h1>Coordination</h1><p>Unavailable. Coordination state is not implemented in this operator surface.</p></main>";
  }

  async submit(fields: Record<string, string>): Promise<unknown> {
    if (fields.type === "github.refresh") {
      if (!this.githubRefresh) throw new Error("GitHub refresh unavailable");
      await this.githubRefresh();
      return { refreshed: true };
    }
    const common = {
      key: fields.key || randomUUID(),
      actor: "operator" as const,
    };
    const required = (name: string) => {
      const value = fields[name];
      if (!value) throw new Error(`Missing ${name}`);
      return value;
    };
    const version = () => Number(required("expectedVersion"));
    let command: DomainCommand;
    switch (fields.type) {
      case "project.create":
        command = {
          ...common,
          type: "project.create",
          projectId: fields.projectId || randomUUID(),
          name: required("name"),
          leadProfileId: fields.leadProfileId || null,
        };
        break;
      case "project.configure": {
        const projectId = required("projectId");
        const instructions = fields.instructions;
        const capturedRevision = Number(fields.instructionsRevision);
        const capturedInstructions =
          Number.isSafeInteger(capturedRevision) && capturedRevision > 0
            ? this.store.instructionRevision(projectId, capturedRevision)
            : undefined;
        command = {
          ...common,
          type: "project.configure",
          projectId,
          expectedVersion: version(),
          name: required("name"),
          leadProfileId:
            fields.leadProfileId === undefined
              ? undefined
              : fields.leadProfileId || null,
          ...(instructions === undefined ||
          instructions === capturedInstructions
            ? {}
            : { instructions }),
          paused: fields.paused === "1",
        };
        break;
      }
      case "task.create":
        command = {
          ...common,
          type: "task.create",
          projectId: required("projectId"),
          taskId: fields.taskId || randomUUID(),
          title: required("title"),
          outcome: required("outcome"),
          ready: fields.ready === "1",
        };
        break;
      case "task.configure":
        command = {
          ...common,
          type: "task.configure",
          projectId: required("projectId"),
          taskId: required("taskId"),
          expectedVersion: version(),
          title: required("title"),
          outcome: required("outcome"),
          ready: fields.ready === "1",
        };
        break;
      case "profile.create":
        command = {
          ...common,
          type: "profile.create",
          profileId: fields.profileId || randomUUID(),
          name: required("name"),
          instructions: fields.instructions ?? "",
          capabilities: fields.capabilities ?? "",
        };
        break;
      case "profile.configure":
        command = {
          ...common,
          type: "profile.configure",
          profileId: required("profileId"),
          expectedVersion: version(),
          name: required("name"),
          instructions: fields.instructions ?? "",
          capabilities: fields.capabilities ?? "",
          revoked: fields.revoked === "1",
        };
        break;
      case "routing.configure":
        command = {
          ...common,
          type: "routing.configure",
          projectId: required("projectId"),
          expectedVersion: version(),
          enabled: fields.enabled === "1",
          guidance: fields.guidance ?? "",
          credentialRef:
            fields.clearCredentialRef === "1"
              ? null
              : fields.credentialRef || undefined,
          candidateProfileIds: fields.candidateProfileIds
            ? JSON.parse(fields.candidateProfileIds)
            : [],
        };
        break;
      case "delivery.configure": {
        const projectId = required("projectId"),
          current = this.store.deliveryCredentialReference(projectId);
        command = {
          ...common,
          type: "delivery.configure",
          projectId,
          expectedVersion: version(),
          mode: required("mode") as "reviewable-pr" | "through-merge",
          credentialRef:
            fields.clearCredentialRef === "1"
              ? null
              : fields.credentialRef || current,
          grants: JSON.parse(required("grants")),
          requiredChecks: JSON.parse(required("requiredChecks")),
        };
        break;
      }
      case "github.configure": {
        command = {
          ...common,
          type: "github.configure",
          projectId: required("projectId"),
          expectedVersion: version(),
          ...(fields.clearCredentialRef === "1"
            ? { credentialRef: null }
            : fields.credentialRef
              ? { credentialRef: fields.credentialRef }
              : {}),
          selections: JSON.parse(required("selections")),
          readiness: JSON.parse(required("readiness")),
          repositories: JSON.parse(required("repositories")),
        };
        break;
      }
      case "github.preview": {
        const projectId = required("projectId");
        const config = this.store.githubConfiguration(projectId);
        if (config.version !== version())
          throw new DomainConflictError("Version conflict");
        const selection = config.selections
          .map((raw) => selectionSchema.parse(raw))
          .find((item) => item.id === required("selectionId"));
        if (!selection)
          throw new DomainConflictError("Unknown GitHub selection");
        if (!config.credentialRef)
          throw new DomainConflictError("GitHub credential reference required");
        const preview = await this.githubPreviewReader(
          config.credentialRef,
        ).readSelection(selection);
        if (!preview.complete)
          throw new DomainConflictError(
            `GitHub preview incomplete: ${preview.reason}`,
          );
        command = {
          ...common,
          type: "github.activate",
          projectId,
          selectionId: selection.id,
          expectedVersion: config.version,
        };
        break;
      }
      case "source.review":
        command = {
          ...common,
          type: "source.review",
          projectId: required("projectId"),
          taskId: required("taskId"),
          expectedVersion: version(),
          observedDigest: required("observedDigest"),
          decision: z
            .enum([
              "clarification",
              "accept-revised-scope",
              "resume-source-hold",
            ])
            .parse(required("decision")),
        };
        break;
      case "github.place":
        command = {
          ...common,
          type: "github.place",
          projectId: required("projectId"),
          taskId: required("taskId"),
          chosenProjectId: required("chosenProjectId"),
          expectedVersion: version(),
        };
        break;
      case "assignment.create":
        command = {
          ...common,
          type: "assignment.create",
          projectId: required("projectId"),
          taskId: required("taskId"),
          assignmentId: fields.assignmentId || randomUUID(),
          profileId: required("profileId"),
          brief: required("brief"),
          resultDestination: required("resultDestination"),
          requesterAssignmentId: null,
        };
        break;
      case "assignment.apply":
        command = {
          ...common,
          type: "assignment.apply",
          projectId: required("projectId"),
          assignmentId: required("assignmentId"),
          expectedVersion: version(),
        };
        break;
      case "dependency.add":
        command = {
          ...common,
          type: "dependency.add",
          projectId: required("projectId"),
          taskId: required("taskId"),
          blockerTaskId: required("blockerTaskId"),
          expectedVersion: version(),
        };
        break;
      case "dependency.remove":
        command = {
          ...common,
          type: "dependency.remove",
          projectId: required("projectId"),
          taskId: required("taskId"),
          blockerTaskId: required("blockerTaskId"),
          expectedVersion: version(),
        };
        break;
      case "imported-blockers.set":
        command = {
          ...common,
          type: "imported-blockers.set",
          projectId: required("projectId"),
          taskId: required("taskId"),
          expectedVersion: version(),
          state: required("state") as "clear" | "blocked" | "unknown",
        };
        break;
      default:
        throw new Error("Unknown form command");
    }
    return this.commands.execute(command);
  }
}

type OperatorHttpOptions = {
  routes?: OperatorRouteRegistry;
  web?: OperatorWebBoundary;
};

const SESSION_COOKIE = "ensemble_operator_session";
const MAX_FORM_BYTES = 64 * 1024;
const MAX_FORM_FIELDS = 128;
const MAX_FORM_VALUE_LENGTH = 8 * 1024;
const COMMANDS = new Set([
  "project.create",
  "project.configure",
  "profile.create",
  "profile.configure",
  "routing.configure",
  "delivery.configure",
  "github.configure",
  "github.preview",
  "github.refresh",
  "github.place",
  "source.review",
  "task.create",
  "task.configure",
]);
const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

class OperatorHttpError extends Error {
  constructor(readonly status: number) {
    super();
  }
}

function cookieId(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]?.slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function cookieHeader(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function clearedCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function decodePathSegment(value: string): string | undefined {
  try {
    const result = decodeURIComponent(value);
    if (
      !result ||
      result === "." ||
      result === ".." ||
      result.includes("/") ||
      result.includes("\\") ||
      containsControlCharacters(result)
    )
      return undefined;
    return result;
  } catch {
    return undefined;
  }
}

function publicMessage(code: string): string {
  const messages: Record<string, string> = {
    unauthenticated: "Sign in required.",
    forbidden: "Request denied.",
    "not-found": "Not found.",
    "method-not-allowed": "Method not allowed.",
    "invalid-input": "Review the request fields.",
    "unsupported-media": "JSON input required.",
    "body-too-large": "Request is too large.",
    conflict:
      "Saved state conflicts with this request. Review before retrying.",
    unavailable: "Service unavailable. Try again.",
    "command-outcome-unknown":
      "Command outcome is unknown. Reconcile the same key and input.",
  };
  return messages[code] ?? "Request unavailable.";
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      String(request.headers["content-type"] ?? ""),
    )
  ) {
    request.resume();
    throw new OperatorHttpError(415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) {
      request.resume();
      throw new OperatorHttpError(413);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new OperatorHttpError(400);
  }
}

async function readForm(
  request: IncomingMessage,
): Promise<Record<string, string>> {
  if (request.headers["content-type"] !== "application/x-www-form-urlencoded") {
    request.resume();
    throw new OperatorHttpError(415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) {
      request.resume();
      throw new OperatorHttpError(413);
    }
    chunks.push(buffer);
  }
  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new OperatorHttpError(400);
  }
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let count = 0;
  for (const pair of encoded.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = decodeFormComponent(
      separator < 0 ? pair : pair.slice(0, separator),
    );
    const value = decodeFormComponent(
      separator < 0 ? "" : pair.slice(separator + 1),
    );
    count += 1;
    if (
      count > MAX_FORM_FIELDS ||
      !key ||
      key.length > 128 ||
      value.length > MAX_FORM_VALUE_LENGTH ||
      Object.hasOwn(fields, key)
    )
      throw new OperatorHttpError(400);
    fields[key] = value;
  }
  return fields;
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw new OperatorHttpError(400);
  }
}

function cleanQuery(searchParams: URLSearchParams): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let count = 0;
  for (const [key, value] of searchParams) {
    count += 1;
    if (
      count > MAX_FORM_FIELDS ||
      !key ||
      key.length > 128 ||
      value.length > MAX_FORM_VALUE_LENGTH ||
      Object.hasOwn(fields, key)
    )
      throw new OperatorHttpError(400);
    fields[key] = value;
  }
  return fields;
}

function writeHtml(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...RESPONSE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function document(
  body: string,
  session: OperatorSession,
  webEnabled = false,
  stylesheets: readonly string[] = [],
): string {
  const logout = session.authenticated
    ? `<form method="post" action="/logout">${hidden("csrfToken", session.csrfToken)}<button type="submit">Log out</button></form>`
    : "";
  const navigation = session.authenticated
    ? `<nav>${webEnabled ? '<a href="/app">New interface</a> ' : ""}<a href="/">Existing operator controls</a> <a href="/runtime">Runtime</a> <a href="/coordination">Coordination</a></nav>${logout}`
    : "";
  const styles = webEnabled
    ? stylesheets
        .map((href) => `<link rel="stylesheet" href="${href}">`)
        .join("")
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ensemble</title>${styles}</head><body${webEnabled ? ' class="legacy-operator"' : ""}>${navigation}${body}</body></html>`;
}

function loginContent(session: OperatorSession, message = "Sign in"): string {
  return `<main><h1>Ensemble</h1><p>${escapeHtml(message)}</p><form method="post" action="/login">${hidden("csrfToken", session.csrfToken)}${field("password", "", "password")}<button type="submit">Sign in</button></form></main>`;
}

function isSafeRedirect(location: string): boolean {
  return (
    location.startsWith("/") &&
    !location.startsWith("//") &&
    !location.includes("\\") &&
    !containsControlCharacters(location)
  );
}

/** Authenticated loopback HTTP server for the standalone operator surface. */
export class LocalOperatorHttp {
  private server: Server | undefined;
  private readonly routes: OperatorRouteRegistry;
  private readonly secureCookie: boolean;
  private readonly web: OperatorWebBoundary | undefined;

  constructor(
    private readonly ui: LocalOperatorUi,
    private readonly auth: OperatorAuth,
    options: OperatorHttpOptions = {},
  ) {
    this.web = options.web;
    this.routes = options.routes ?? new OperatorRouteRegistry();
    this.secureCookie = new URL(auth.origin).protocol === "https:";
  }

  async start(port = 0): Promise<number> {
    if (this.server) throw new Error("Operator UI already started");
    this.routes.mount();
    const server = createServer(async (request, response) => {
      let session: OperatorSession | undefined;
      try {
        const address = server.address();
        const localOrigin =
          address && typeof address !== "string"
            ? `http://127.0.0.1:${address.port}`
            : "";
        const loopbackHost = localOrigin.slice("http://".length);
        const expectedHost = new URL(this.auth.origin).host;
        if (
          request.headers.host !== expectedHost &&
          request.headers.host !== loopbackHost
        ) {
          request.resume();
          writeHtml(response, 403, "<main><h1>Request denied</h1></main>");
          return;
        }
        const requestTarget = request.url ?? "/";
        if (
          !requestTarget.startsWith("/") ||
          requestTarget.startsWith("//") ||
          requestTarget.includes("\\") ||
          containsControlCharacters(requestTarget) ||
          requestTarget.includes("#")
        ) {
          request.resume();
          writeHtml(response, 400, "<main><h1>Request rejected</h1></main>");
          return;
        }
        const url = new URL(requestTarget, localOrigin || "http://127.0.0.1");
        if (
          url.pathname
            .split("/")
            .slice(1)
            .some((part) => part && decodePathSegment(part) === undefined)
        ) {
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }
        const id = cookieId(request);
        session = id ? this.auth.getSession(id) : undefined;

        if (this.web && (await this.handleWeb(request, response, url, session)))
          return;

        if (url.pathname === "/login" && request.method === "GET") {
          if (session?.authenticated) {
            response
              .writeHead(303, {
                ...RESPONSE_HEADERS,
                location: "/",
              })
              .end();
            return;
          }
          session ??= this.auth.createAnonymousSession();
          writeHtml(
            response,
            200,
            document(
              loginContent(session),
              session,
              Boolean(this.web),
              this.web?.bundle.stylesheets,
            ),
            {
              "set-cookie": cookieHeader(session.id, this.secureCookie),
            },
          );
          return;
        }

        if (url.pathname === "/login" && request.method === "POST") {
          if (
            !id ||
            !session ||
            session.authenticated ||
            request.headers.origin !== this.auth.origin
          ) {
            request.resume();
            writeHtml(response, 403, "<main><h1>Request denied</h1></main>");
            return;
          }
          const fields = await readForm(request);
          const csrfToken = fields.csrfToken ?? "";
          delete fields.csrfToken;
          if (!this.auth.validateCsrf(id, csrfToken)) {
            writeHtml(response, 403, "<main><h1>Request denied</h1></main>");
            return;
          }
          const authenticated = await this.auth.authenticate(
            id,
            fields.password ?? "",
          );
          if (!authenticated) {
            writeHtml(
              response,
              401,
              document(
                loginContent(session, "Sign in failed"),
                session,
                Boolean(this.web),
                this.web?.bundle.stylesheets,
              ),
            );
            return;
          }
          response
            .writeHead(303, {
              ...RESPONSE_HEADERS,
              location: "/",
              "set-cookie": cookieHeader(authenticated.id, this.secureCookie),
            })
            .end();
          return;
        }

        if (url.pathname === "/login") {
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }

        if (url.pathname === "/logout" && request.method === "POST") {
          const authorized = await this.authorizeWrite(
            request,
            response,
            session,
          );
          if (!authorized) return;
          const fields = await readForm(request);
          if (!this.auth.validateCsrf(authorized.id, fields.csrfToken ?? "")) {
            writeHtml(response, 403, "<main><h1>Request denied</h1></main>");
            return;
          }
          this.auth.logout(authorized.id);
          response
            .writeHead(303, {
              ...RESPONSE_HEADERS,
              location: "/login",
              "set-cookie": clearedCookie(this.secureCookie),
            })
            .end();
          return;
        }

        if (url.pathname === "/logout") {
          const authorized = await this.authorizeRead(
            request,
            response,
            session,
          );
          if (!authorized) return;
          writeHtml(response, 405, "<main><h1>Method not allowed</h1></main>");
          return;
        }

        if (request.method === "GET") {
          const authorized = await this.authorizeRead(
            request,
            response,
            session,
          );
          if (!authorized) return;
          const parts =
            url.pathname === "/" ? [] : url.pathname.slice(1).split("/");
          const kind = parts[0] ?? "";
          const slot =
            kind === "runtime" || kind === "coordination" ? kind : undefined;
          const slotRoute = slot
            ? this.routes.matchSlot(slot, "GET", url.pathname)
            : undefined;
          if (slotRoute) {
            const result = await slotRoute.handler({
              params: slotRoute.params,
              fields: cleanQuery(url.searchParams),
              csrfToken: authorized.csrfToken,
            });
            this.writeRouteResult(response, result, authorized);
            return;
          }
          const value = parts[1] ? decodePathSegment(parts[1]) : undefined;
          if (parts.length > 2 || (parts.length === 2 && value === undefined)) {
            writeHtml(response, 404, "<main><h1>Not found</h1></main>");
            return;
          }
          let html: string | undefined;
          if (kind === "project" && value)
            html = this.ui.project(value, authorized.csrfToken);
          else if (kind === "task" && value)
            html = this.ui.task(value, authorized.csrfToken);
          else if (kind === "profile" && value)
            html = this.ui.profile(value, authorized.csrfToken);
          else if (kind === "assignment" && value)
            html = this.ui.assignment(value);
          else if (kind === "runtime" && parts.length === 1)
            html = this.ui.runtime();
          else if (kind === "coordination" && parts.length === 1)
            html = this.ui.coordination();
          else if (url.pathname === "/")
            html = this.ui.home(authorized.csrfToken);
          if (html !== undefined) {
            writeHtml(
              response,
              200,
              document(
                html,
                authorized,
                Boolean(this.web),
                this.web?.bundle.stylesheets,
              ),
            );
            return;
          }
          const extension = this.routes.match("GET", url.pathname);
          if (extension) {
            const result = await extension.handler({
              params: extension.params,
              fields: cleanQuery(url.searchParams),
              csrfToken: authorized.csrfToken,
            });
            this.writeRouteResult(response, result, authorized);
            return;
          }
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }

        if (request.method !== "POST") {
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }
        const authorized = await this.authorizeWrite(
          request,
          response,
          session,
        );
        if (!authorized) return;
        const fields = await readForm(request);
        const csrfToken = fields.csrfToken ?? "";
        delete fields.csrfToken;
        if (!this.auth.validateCsrf(authorized.id, csrfToken)) {
          writeHtml(response, 403, "<main><h1>Request denied</h1></main>");
          return;
        }
        if (url.pathname === "/command") {
          if (!COMMANDS.has(fields.type ?? "")) {
            writeHtml(response, 400, "<main><h1>Command rejected</h1></main>");
            return;
          }
          await this.ui.submit(fields);
          response.writeHead(303, { ...RESPONSE_HEADERS, location: "/" }).end();
          return;
        }
        const firstSegment = url.pathname.slice(1).split("/", 1)[0];
        const slot =
          firstSegment === "runtime" || firstSegment === "coordination"
            ? firstSegment
            : undefined;
        const extension =
          (slot && this.routes.matchSlot(slot, "POST", url.pathname)) ||
          this.routes.match("POST", url.pathname);
        if (!extension) {
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }
        const result = await extension.handler({
          params: extension.params,
          fields,
          csrfToken: authorized.csrfToken,
        });
        this.writeRouteResult(response, result, authorized);
      } catch (error) {
        if (!response.headersSent) {
          const status =
            error instanceof OperatorHttpError
              ? error.status
              : error instanceof DomainConflictError
                ? 409
                : 400;
          const body =
            error instanceof DomainConflictError
              ? "<main><h1>Change conflict</h1><p>Saved state or a prior command conflicts with this request. Reload the page and review before retrying.</p></main>"
              : "<main><h1>Request rejected</h1></main>";
          writeHtml(response, status, body);
        } else if (!response.writableEnded) response.end();
      }
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Unexpected operator UI address");
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }

  private writeRouteResult(
    response: ServerResponse,
    result: OperatorRouteResult,
    session: OperatorSession,
  ): void {
    if (result.kind === "redirect") {
      if (!isSafeRedirect(result.location)) throw new Error();
      response
        .writeHead(303, {
          ...RESPONSE_HEADERS,
          location: result.location,
        })
        .end();
    } else if (result.kind === "html" && result.body.length <= 1_000_000) {
      writeHtml(
        response,
        200,
        document(
          result.body,
          session,
          Boolean(this.web),
          this.web?.bundle.stylesheets,
        ),
      );
    } else {
      throw new Error();
    }
  }

  private async handleWeb(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    session: OperatorSession | undefined,
  ): Promise<boolean> {
    const web = this.web;
    if (!web?.owns(url.pathname)) return false;
    const path = url.pathname,
      method = request.method;
    const headers = {
      ...RESPONSE_HEADERS,
      "content-security-policy":
        "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    };
    const json = (
      status: number,
      value: unknown,
      extra: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        ...headers,
        "content-type": "application/json; charset=utf-8",
        ...extra,
      });
      response.end(JSON.stringify(value));
    };
    const deny = (status: number, code: string) => {
      request.resume();
      json(
        status,
        apiErrorSchema.parse({ error: { code, message: publicMessage(code) } }),
      );
    };
    if (!path.startsWith("/api")) {
      if (path === "/login" && method !== "GET") return false;
      if (method !== "GET" && method !== "HEAD") {
        deny(405, "method-not-allowed");
        return true;
      }
      const asset = web.bundle.asset(web.shell(path) ? "/app" : path);
      if (!asset) {
        deny(404, "not-found");
        return true;
      }
      response.writeHead(200, { ...headers, "content-type": asset.type });
      response.end(method === "HEAD" ? undefined : asset.body);
      return true;
    }
    try {
      if (!web.knownApi(path)) {
        deny(404, "not-found");
        return true;
      }
      const expected = [
        "/api/operator/login",
        "/api/operator/logout",
        "/api/operator/commands",
        "/api/operator/source-refresh",
      ].includes(path)
        ? "POST"
        : "GET";
      if (method !== expected) {
        deny(405, "method-not-allowed");
        return true;
      }
      if (path === "/api/operator/session") {
        const current = session ?? this.auth.createAnonymousSession();
        json(
          200,
          sessionSchema.parse({
            authenticated: current.authenticated,
            csrfToken: current.csrfToken,
          }),
          { "set-cookie": cookieHeader(current.id, this.secureCookie) },
        );
        return true;
      }
      if (path !== "/api/operator/login" && !session?.authenticated) {
        deny(401, "unauthenticated");
        return true;
      }
      if (method === "POST") {
        if (
          !session ||
          request.headers.origin !== this.auth.origin ||
          !this.auth.validateCsrf(
            session.id,
            String(request.headers["x-csrf-token"] ?? ""),
          )
        ) {
          deny(403, "forbidden");
          return true;
        }
        const body = await readJson(request);
        if (path === "/api/operator/login") {
          const input = z
            .object({ password: z.string().max(8192) })
            .strict()
            .parse(body);
          if (session.authenticated) {
            deny(403, "forbidden");
            return true;
          }
          const current = await this.auth.authenticate(
            session.id,
            input.password,
          );
          if (!current) {
            deny(401, "unauthenticated");
            return true;
          }
          json(
            200,
            sessionSchema.parse({
              authenticated: true,
              csrfToken: current.csrfToken,
            }),
            { "set-cookie": cookieHeader(current.id, this.secureCookie) },
          );
          return true;
        }
        if (path === "/api/operator/logout") {
          z.object({}).strict().parse(body);
          this.auth.logout(session.id);
          json(
            200,
            { authenticated: false },
            { "set-cookie": clearedCookie(this.secureCookie) },
          );
          return true;
        }
        if (path === "/api/operator/source-refresh") {
          z.object({}).strict().parse(body);
          json(200, await web.api.refreshSources());
          return true;
        }
        json(200, await web.api.execute(body));
        return true;
      }
      const artifact = path.match(
        /^\/api\/operator\/tasks\/([^/]+)\/artifacts\/([^/]+)$/,
      );
      if (artifact) {
        if ([...url.searchParams].length)
          throw new OperatorApiError(400, "invalid-input");
        const data = await web.api.readArtifact(
          artifact[1] ?? "",
          artifact[2] ?? "",
        );
        const current = session && this.auth.getSession(session.id);
        if (
          !current?.authenticated ||
          current.csrfToken !== session?.csrfToken
        ) {
          deny(401, "unauthenticated");
          return true;
        }
        response.writeHead(200, {
          ...headers,
          "content-type": data.type,
          "x-content-type-options": "nosniff",
        });
        response.end(data.body);
        return true;
      }
      const data = await web.read(path, url.searchParams);
      if (path === "/api/operator/search") {
        const current = session && this.auth.getSession(session.id);
        if (
          !current?.authenticated ||
          current.csrfToken !== session?.csrfToken
        ) {
          deny(401, "unauthenticated");
          return true;
        }
      }
      if (data === undefined) deny(404, "not-found");
      else json(200, data);
    } catch (error) {
      const status =
        error instanceof OperatorApiError
          ? error.status
          : error instanceof OperatorHttpError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 503;
      const code =
        error instanceof OperatorApiError
          ? error.code
          : error instanceof OperatorHttpError
            ? ({
                400: "invalid-input",
                413: "body-too-large",
                415: "unsupported-media",
              }[error.status] ?? "invalid-input")
            : error instanceof z.ZodError
              ? "invalid-input"
              : method === "POST"
                ? "command-outcome-unknown"
                : "unavailable";
      json(
        status,
        apiErrorSchema.parse({
          error: {
            code,
            ...(error instanceof OperatorApiError && error.fieldPaths
              ? { fieldPaths: error.fieldPaths }
              : {}),
            message: publicMessage(code),
            ...(error instanceof z.ZodError
              ? {
                  fieldPaths: [
                    ...new Set(
                      error.issues
                        .map((i) =>
                          i.path
                            .filter(
                              (p) =>
                                typeof p === "string" &&
                                /^[A-Za-z][A-Za-z0-9]*$/.test(p),
                            )
                            .join("."),
                        )
                        .filter(Boolean),
                    ),
                  ],
                }
              : {}),
          },
        }),
      );
    }
    return true;
  }

  private async authorizeRead(
    request: IncomingMessage,
    response: ServerResponse,
    session: OperatorSession | undefined,
  ): Promise<OperatorSession | undefined> {
    if (session?.authenticated) return session;
    request.resume();
    const preLogin = session ?? this.auth.createAnonymousSession();
    writeHtml(
      response,
      200,
      document(
        loginContent(preLogin),
        preLogin,
        Boolean(this.web),
        this.web?.bundle.stylesheets,
      ),
      {
        "set-cookie": cookieHeader(preLogin.id, this.secureCookie),
      },
    );
    return undefined;
  }

  private async authorizeWrite(
    request: IncomingMessage,
    response: ServerResponse,
    session: OperatorSession | undefined,
  ): Promise<OperatorSession | undefined> {
    if (!session?.authenticated) {
      request.resume();
      writeHtml(response, 401, "<main><h1>Sign in required</h1></main>");
      return undefined;
    }
    if (request.headers.origin !== this.auth.origin) {
      request.resume();
      writeHtml(response, 403, "<main><h1>Request denied</h1></main>");
      return undefined;
    }
    return session;
  }
}
