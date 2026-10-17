import {
  questionCommandRawLimit,
  runtimeSummary,
} from "../operator/contracts.js";
import type { OperatorWebBoundary } from "./operator-web.js";
import {
  OperatorApiError,
  type OperatorReviewSessionContext,
} from "./operator-api.js";
import {
  apiErrorSchema,
  cliCapabilities,
  cliIdentitySchema,
  operatorCredentialIssueRequestSchema,
  operatorCredentialIssuedSchema,
  operatorCredentialListSchema,
  pushNotificationsReadSchema,
  pushSubscriptionResultSchema,
  pushTestResultSchema,
  sessionSchema,
} from "../operator/contracts.js";
import {
  OperatorCredentialError,
  operatorRouteAuthority,
  type OperatorCredentialStore,
  type VerifiedOperatorCredential,
} from "./operator-credentials.js";
import type { OperatorPush } from "./operator-push.js";
import { PushError } from "./web-push.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  closedIssuesSchema,
  type Readiness,
} from "../core/github-source-contracts.js";
import {
  noRuleText,
  ruleText,
  selectionCountsText,
  unmetText,
  zeroMatchWarning,
} from "../operator/readiness-text.js";
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
import type { GitHubSourceReader } from "./github-source.js";
import {
  CredentialGitHubSourceReader,
  gitHubSourceCredentialStatus,
  sourceCredentialExplanation,
  type SourceCredentialReason,
} from "./github-source-credential.js";
import { ghEnvironment } from "./gh-credential.js";
import {
  selectionSchema,
  type GitHubSourceStore,
} from "../core/github-source.js";
import {
  containsControlCharacters,
  decodeSegment,
  OperatorRouteRegistry,
  type OperatorRouteResult,
} from "./operator-routes.js";
import { escapeHtml, hidden } from "./operator-html.js";

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

/** The stored rule as the shared readiness text reads it; this page shows the whole rule. */
const ruleView = (rule: Readiness | null) =>
  rule ? { kind: "rule" as const, ...rule } : { kind: "none" as const };

const closureText = (closure: "held" | "completed" | "unattributed" | null) =>
  closure === "held"
    ? ", closed on GitHub; held"
    : closure === "completed"
      ? ", closed on GitHub"
      : closure === "unattributed"
        ? ", closed on GitHub; closure not attributed to Ensemble; held"
        : "";
const closureDetail = {
  held: "Held · closed on GitHub. Resolve the source hold after the issue reopens.",
  completed: "Done · closed on GitHub, not delivered by Ensemble.",
  unattributed:
    "Held · closed on GitHub; Ensemble could not prove its delivery closed it. Reopen the issue on GitHub, then resolve the source hold.",
};

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
class SourceCredentialConflictError extends DomainConflictError {
  constructor(
    readonly reason: SourceCredentialReason,
    readonly projectId: string,
  ) {
    super(sourceCredentialExplanation(reason));
  }
}

export class LocalOperatorUi {
  private readonly commands: DomainCommands;

  constructor(
    private readonly store: DomainStore,
    private readonly githubPreviewReader: (
      credentialRef: string,
    ) => Pick<GitHubSourceReader, "readSelection"> = (credentialRef) =>
      new CredentialGitHubSourceReader(credentialRef, {
        gh: () => ({
          environment: ghEnvironment(store, { reference: credentialRef }),
        }),
      }),
    private readonly githubSources?: GitHubSourceStore,
    private readonly githubRefresh?: () => Promise<void>,
    private readonly credentialStatus = async (projectId: string) => {
      const config = store.githubConfiguration(projectId);
      const status = await gitHubSourceCredentialStatus(config.credentialRef, {
        gh: () => ({
          environment: ghEnvironment(store, {
            reference: "gh:github.com",
          }),
        }),
      });
      if (status.reason)
        githubSources?.invalidateCredentialFailure(
          {
            projectId,
            configVersion: config.version,
            credentialRef: config.credentialRef,
          },
          status.reason,
        );
      return status;
    },
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

  async projectWithCredentialStatus(projectId: string, csrfToken = "") {
    const fence = () => {
      const configuration = this.store.githubConfiguration(projectId);
      return JSON.stringify([
        configuration.version,
        configuration.credentialRef,
        this.store.githubActiveSelectionIds(projectId).sort(),
      ]);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const source = fence();
      const credential = await this.credentialStatus(projectId);
      if (source === fence())
        return this.project(projectId, csrfToken, credential);
    }
    throw new DomainConflictError(
      "Source configuration changed during read; reload the project.",
    );
  }

  project(
    projectId: string,
    csrfToken = "",
    credential?: Awaited<ReturnType<typeof gitHubSourceCredentialStatus>>,
  ): string {
    const project = this.store.project(projectId);
    const routing = this.store.routing(projectId);
    const github = this.store.githubConfiguration(projectId);
    const activeGithub = new Set(
      this.store.githubActiveSelectionIds(projectId),
    );
    const rule = ruleView(this.githubSources?.readinessRule(projectId) ?? null),
      counted = this.githubSources?.selectionCounts(projectId);
    const previewForms = github.selections
      .map((raw) => {
        const selection = selectionSchema.parse(raw);
        const sync = this.githubSources?.syncState(projectId, selection.id);
        // An unusable credential claims no observation, so no counts either.
        const counts =
          credential?.usable === false
            ? null
            : (counted?.get(selection.id) ?? null);
        const warning = zeroMatchWarning(counts, rule);
        const items = counts
          ? ` ${escapeHtml(selectionCountsText(counts, rule))}.${warning ? ` ${escapeHtml(warning)} <a href="#github-readiness">Check readiness conditions</a>` : ""}`
          : "";
        const status =
          credential?.usable === false
            ? escapeHtml(
                sourceCredentialExplanation(
                  credential.reason ?? "missing-credential",
                ),
              )
            : !sync
              ? "never synced"
              : Number(sync.complete) === 1
                ? "complete"
                : `partial: ${escapeHtml(sync.reason)}`;
        return `<li>${escapeHtml(selection.id)} (${escapeHtml(selection.kind)}; ${activeGithub.has(selection.id) ? "active" : "inactive"}; ${status}; ${escapeHtml(sync?.refreshedAt ?? "never")})${items}${credential?.usable === false ? '<a href="#github-source-credential">Set or change source credential</a>' : ""}${form("github.preview", field("projectId", projectId, "hidden") + field("selectionId", selection.id, "hidden") + field("expectedVersion", String(github.version), "hidden"), undefined, csrfToken)}</li>`;
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
          `<li><a href="/app/tasks/${escapeHtml(task.id)}">${escapeHtml(task.title)}</a> (${task.ready ? "ready" : "unready"}; ${escapeHtml(task.state)}${closureText(this.store.providerClosure(String(task.id)))}; blockers ${escapeHtml(task.importedBlockers)}). <a href="/runtime/task/${escapeHtml(task.id)}">Runtime</a> · <a href="/coordination/task/${escapeHtml(task.id)}">Coordination</a></li>`,
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
    )}<h2 id="github-source-credential">GitHub source</h2><p>Credential: ${credential?.source === "gh" ? "GitHub CLI" : credential?.source === "env" ? "environment variable" : github.credentialRef ? "configured" : "not configured"}. ${credential ? (credential.usable ? "Usable." : escapeHtml(sourceCredentialExplanation(credential.reason ?? "missing-credential"))) : ""} ${credential?.gh.state === "signed-in" ? `Detected GitHub CLI account @${escapeHtml(credential.gh.login)}.` : ""} Selections require preview before activation at the current source version.</p><p>${github.readiness ? `Readiness rule: ${escapeHtml(ruleText({ kind: "rule", ...github.readiness }))}. Set readiness to null to remove it.` : noRuleText}</p>${form(
      "github.configure",
      field("projectId", projectId, "hidden") +
        field("expectedVersion", String(github.version), "hidden") +
        selectField(
          "sourceCredentialMode",
          [
            { value: "keep", label: "Keep current" },
            { value: "gh", label: "GitHub CLI" },
            { value: "env", label: "Environment variable" },
            { value: "clear", label: "Clear" },
          ],
          "keep",
        ) +
        field(
          "credentialRef",
          "",
          "text",
          false,
          "Environment reference (env:NAME); values stay private",
        ) +
        field("clearCredentialRef", "1", "checkbox") +
        textarea("selections", JSON.stringify(github.selections, null, 2)) +
        `<div id="github-readiness">${textarea("readiness", JSON.stringify(github.readiness, null, 2))}</div>` +
        selectField(
          "closedIssues",
          [
            { value: "skip", label: "Skip closed issues" },
            { value: "done", label: "Treat closure as Done" },
          ],
          github.closedIssues,
        ) +
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
    const readiness = imported
      ? this.githubSources?.readinessByTask([taskId]).get(taskId)
      : undefined;
    const unmet =
      readiness &&
      unmetText({
        rule: ruleView(readiness.rule),
        outcome: readiness.outcome,
        unmet: readiness.unmet,
      });
    const hold = imported
      ? this.githubSources?.hold(String(imported.nodeId))
      : undefined;
    const closure = this.store.providerClosure(taskId);
    const provenance = external
      ? `<h2>GitHub source</h2>${closure ? `<p>${closureDetail[closure]}</p>` : ""}<p>${escapeHtml(external.providerInstance)} ${escapeHtml(external.repositoryName)}#${escapeHtml(external.issueNumber)} (${escapeHtml(external.nodeId)}); observed ${escapeHtml(external.observedState)}.</p><p>Observed title: ${escapeHtml(external.observedTitle)}. Observed body: ${escapeHtml(external.observedBody)}</p><p>Memberships: ${escapeHtml(memberships.map((item) => `${item.projectId}/${item.selectionId}`).join(", ") || "none")}. Fields: ${escapeHtml(memberships.map((item) => item.projectFields).join(", "))}</p><p>Native blockers: ${escapeHtml(blockers.map((item) => `${item.repositoryName}#${item.issueNumber}: ${item.status}`).join(", ") || task.importedBlockers)}</p><p>Source hold: ${hold?.active ? escapeHtml(hold.reason) : "none"}.</p>${
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
    return `<main><h1>${escapeHtml(task.title)}</h1><p>Outcome: ${escapeHtml(task.outcome)}</p><p>${task.ready ? "Ready" : `Not ready${unmet ? ` (${escapeHtml(unmet)})` : ""}`}; ${escapeHtml(task.state)}.</p><p>Configuration eligibility only: ${admission.eligible ? "eligible for future admission" : `held: ${escapeHtml(admission.reasons.join(", "))}`}.</p><p>Readiness and configuration eligibility do not confirm runtime admission or execution.</p>${provenance}<p><a href="/runtime/task/${escapeHtml(taskId)}">Runtime status, controls and recovery evidence</a> · <a href="/coordination/task/${escapeHtml(taskId)}">Task-scoped coordination and history</a></p>${imported ? "" : form("task.configure", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("expectedVersion", String(task.version), "hidden") + field("title", String(task.title)) + textarea("outcome", String(task.outcome)) + field("ready", "1", "checkbox", Boolean(task.ready)), undefined, csrfToken)}</main>`;
  }

  profile(profileId: string, csrfToken = ""): string {
    const profile = this.store.profile(profileId);
    return `<main><h1>${escapeHtml(profile.name)}</h1><p>Revision ${escapeHtml(profile.version)}; ${profile.revoked ? "revoked" : "active"}</p><p>Execution runtime: ${escapeHtml(runtimeSummary(this.store.profileRuntime(profileId)))}. Change it in profile Settings; saving here keeps it.</p>${form("profile.configure", field("profileId", profileId, "hidden") + field("expectedVersion", String(profile.version), "hidden") + field("name", String(profile.name)) + textarea("instructions", String(profile.instructions)) + textarea("capabilities", String(profile.capabilities)) + field("revoked", "1", "checkbox", Boolean(profile.revoked)), undefined, csrfToken)}</main>`;
  }

  assignment(assignmentId: string): string {
    const assignment = this.store.assignment(assignmentId);
    const task = this.store.task(String(assignment.taskId));
    const profile = this.store.profile(String(assignment.profileId));
    return `<main><h1>${escapeHtml(profile.name)} assignment</h1><p>Task: <a href="/app/tasks/${escapeHtml(task.id)}?assignment=${escapeHtml(assignment.id)}">${escapeHtml(task.title)}</a>. Assignment lifecycle state: ${escapeHtml(assignment.state)}; this does not confirm runtime admission or execution.</p><p>Captured profile revision runtime: ${escapeHtml(runtimeSummary(this.store.profileRuntime(String(assignment.profileId), Number(assignment.profileRevision))))}.</p><p><a href="/runtime/assignment/${escapeHtml(assignment.id)}">Runtime status, controls and recovery evidence</a> · <a href="/coordination/assignment/${escapeHtml(assignment.id)}">Conversation and coordination history</a></p></main>`;
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
        const mode =
          fields.sourceCredentialMode === undefined
            ? undefined
            : z
                .enum(["keep", "gh", "env", "clear"])
                .parse(fields.sourceCredentialMode);
        command = {
          ...common,
          type: "github.configure",
          projectId: required("projectId"),
          expectedVersion: version(),
          ...(fields.clearCredentialRef === "1" || mode === "clear"
            ? { credentialRef: null }
            : mode === "gh"
              ? { credentialRef: "gh:github.com" }
              : mode === "env"
                ? {
                    credentialRef: z
                      .string()
                      .regex(/^env:[A-Z][A-Z0-9_]*$/)
                      .parse(required("credentialRef")),
                  }
                : mode === "keep"
                  ? {}
                  : fields.credentialRef
                    ? { credentialRef: fields.credentialRef }
                    : {}),
          selections: JSON.parse(required("selections")),
          readiness: JSON.parse(required("readiness")),
          ...(fields.closedIssues === undefined
            ? {}
            : { closedIssues: closedIssuesSchema.parse(fields.closedIssues) }),
          repositories: JSON.parse(required("repositories")),
        };
        break;
      }
      case "github.preview": {
        const projectId = required("projectId");
        command = {
          ...common,
          type: "github.activate",
          projectId,
          selectionId: required("selectionId"),
          expectedVersion: version(),
        };
        const recorded = this.store.recordedCommand(command);
        if (recorded !== undefined) return recorded;
        const config = this.store.githubConfiguration(projectId);
        if (config.version !== version())
          throw new DomainConflictError("Version conflict");
        const selection = config.selections
          .map((raw) => selectionSchema.parse(raw))
          .find((item) => item.id === required("selectionId"));
        if (!selection)
          throw new DomainConflictError("Unknown GitHub selection");
        if (!config.credentialRef) {
          this.githubSources?.invalidateCredentialFailure(
            {
              projectId,
              configVersion: config.version,
              credentialRef: config.credentialRef,
            },
            "missing-credential",
          );
          throw new SourceCredentialConflictError(
            "missing-credential",
            projectId,
          );
        }
        const preview = await this.githubPreviewReader(
          config.credentialRef,
        ).readSelection(selection);
        if (!preview.complete) {
          if (
            [
              "missing-credential",
              "invalid-credential-reference",
              "gh-not-installed",
              "gh-not-signed-in",
              "gh-unreadable",
            ].includes(preview.reason)
          ) {
            this.githubSources?.invalidateCredentialFailure(
              {
                projectId,
                configVersion: config.version,
                credentialRef: config.credentialRef,
              },
              preview.reason as SourceCredentialReason,
            );
            throw new SourceCredentialConflictError(
              preview.reason as SourceCredentialReason,
              projectId,
            );
          }
          throw new DomainConflictError("GitHub preview incomplete");
        }
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
  credentials?: OperatorCredentialStore;
  /** Opt-in browser push; absent, the notification routes answer 404. */
  push?: OperatorPush;
};

const SESSION_COOKIE = "ensemble_operator_session";
const CREDENTIAL_ACTION =
  /^\/api\/operator\/credentials\/([^/]+)\/(rotate|revoke)$/;
const PUSH_ACTION =
  /^\/api\/operator\/notifications\/subscriptions\/([^/]+)\/(revoke|test)$/;
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
    "local-review-batch-too-large":
      "The review is too large to send. Shorten or remove comments.",
    "local-review-recipient-unavailable":
      "The project lead cannot receive reviews now.",
    "local-review-comment-anchor-required":
      "Every review comment needs exact line context. Remove unanchored comments.",
    "credential-invalid": "Operator credential is invalid.",
    "insufficient-scope":
      "Operator credential scope does not allow this request.",
  };
  return messages[code] ?? "Request unavailable.";
}
const API_HEADERS = {
  ...RESPONSE_HEADERS,
  "content-security-policy":
    "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
};

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...API_HEADERS,
    "content-type": "application/json; charset=utf-8",
    ...extra,
  });
  response.end(JSON.stringify(value));
}

function apiError(code: string) {
  return apiErrorSchema.parse({
    error: { code, message: publicMessage(code) },
  });
}

/** Maps an API handler failure to its public JSON error response. */
function apiFailure(
  error: unknown,
  method: string | undefined,
): { status: number; body: unknown } {
  if (error instanceof OperatorCredentialError)
    error = new OperatorApiError(
      error.code === "not-found" ? 404 : 409,
      error.code,
    );
  if (error instanceof PushError)
    error = new OperatorApiError(
      {
        "invalid-input": 400,
        "not-found": 404,
        conflict: 409,
        unavailable: 503,
      }[error.code],
      error.code,
    );
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
  return {
    status,
    body: apiErrorSchema.parse({
      error: {
        code,
        ...(error instanceof OperatorApiError && error.fieldPaths
          ? { fieldPaths: error.fieldPaths }
          : {}),
        ...(error instanceof OperatorApiError && error.credentialReason
          ? { credentialReason: error.credentialReason }
          : {}),
        message:
          error instanceof OperatorApiError && error.credentialReason
            ? sourceCredentialExplanation(error.credentialReason)
            : error instanceof OperatorApiError && error.publicMessage
              ? error.publicMessage
              : publicMessage(code),
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
  };
}

async function readJson(
  request: IncomingMessage,
  commands = false,
): Promise<unknown> {
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
  let oversized = false;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > (commands ? questionCommandRawLimit : MAX_FORM_BYTES)) {
      oversized = true;
      break;
    }
    chunks.push(buffer);
  }
  if (oversized) {
    // The iterator removes its readable listener asynchronously. Resume after
    // that cleanup, otherwise the rejected upload can strand a keepalive socket.
    await new Promise<void>((resolve) => setImmediate(resolve));
    request.resume();
    throw new OperatorHttpError(413);
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const type =
      value !== null && typeof value === "object" && "type" in value
        ? value.type
        : null;
    if (
      commands &&
      size > MAX_FORM_BYTES &&
      type !== "question.form.answer" &&
      type !== "question.native.answer"
    )
      throw new OperatorHttpError(413);
    return value;
  } catch (error) {
    if (error instanceof OperatorHttpError) throw error;
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
  private readonly credentials: OperatorCredentialStore | undefined;
  private readonly push: OperatorPush | undefined;

  constructor(
    private readonly ui: LocalOperatorUi,
    private readonly auth: OperatorAuth,
    options: OperatorHttpOptions = {},
  ) {
    this.web = options.web;
    this.credentials = options.credentials;
    this.push = options.push;
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
            .some((part) => part && decodeSegment(part) === undefined)
        ) {
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }
        // Bearer requests never read or upgrade a cookie session.
        if (request.headers.authorization !== undefined) {
          await this.handleBearer(request, response, url);
          return;
        }
        const id = cookieId(request);
        session = id ? this.auth.getSession(id) : undefined;
        this.purgeExpiredReviewOwners();

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
          const ownerKey = this.auth.logout(authorized.id);
          if (ownerKey) this.web?.api.purgeLocalReviewDrafts(ownerKey);
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
          if (!authorized || !this.requireCurrentSession(response, authorized))
            return;
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
              webEnabled: Boolean(this.web),
            });
            this.writeRouteResult(response, result, authorized);
            return;
          }
          const value = parts[1] ? decodeSegment(parts[1]) : undefined;
          if (parts.length > 2 || (parts.length === 2 && value === undefined)) {
            writeHtml(response, 404, "<main><h1>Not found</h1></main>");
            return;
          }
          let html: string | undefined;
          if (kind === "project" && value)
            html = await this.ui.projectWithCredentialStatus(
              value,
              authorized.csrfToken,
            );
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
          if (!this.requireCurrentSession(response, authorized)) return;
          response.writeHead(303, { ...RESPONSE_HEADERS, location: "/" }).end();
          return;
        }
        const firstSegment = url.pathname.slice(1).split("/", 1)[0];
        const slot =
          firstSegment === "runtime" || firstSegment === "coordination"
            ? firstSegment
            : undefined;
        const extension =
          slot && this.routes.matchSlot(slot, "POST", url.pathname);
        if (!extension) {
          writeHtml(response, 404, "<main><h1>Not found</h1></main>");
          return;
        }
        const result = await extension.handler({
          params: extension.params,
          fields,
          csrfToken: authorized.csrfToken,
          webEnabled: Boolean(this.web),
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
            error instanceof SourceCredentialConflictError
              ? `<main><h1>GitHub source credential unavailable</h1><p>${escapeHtml(sourceCredentialExplanation(error.reason))}</p><a href="/project/${encodeURIComponent(error.projectId)}#github-source-credential">Set or change source credential</a></main>`
              : error instanceof DomainConflictError
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
    this.push?.start();
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await this.push?.stop();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }

  private currentSession(session: OperatorSession | undefined): boolean {
    const current = session && this.auth.getSession(session.id);
    this.purgeExpiredReviewOwners();
    return !!current?.authenticated && current.csrfToken === session?.csrfToken;
  }
  private reviewSession(
    session: OperatorSession | undefined,
  ): OperatorReviewSessionContext | undefined {
    if (!session?.authenticated) return undefined;
    const ownerKey = this.auth.reviewOwnerKey(session.id);
    if (!ownerKey) {
      this.purgeExpiredReviewOwners();
      return undefined;
    }
    return {
      ownerKey,
      current: () => this.auth.reviewOwnerKey(session.id) === ownerKey,
    };
  }
  private purgeExpiredReviewOwners(): void {
    const owners = this.auth.takeInvalidatedReviewOwnerKeys();
    if (!this.web) return;
    for (const ownerKey of owners)
      this.web.api.purgeLocalReviewDrafts(ownerKey);
  }
  private requireCurrentSession(
    response: ServerResponse,
    session: OperatorSession,
  ): boolean {
    if (this.currentSession(session)) return true;
    writeHtml(response, 401, "<main><h1>Sign in required</h1></main>");
    return false;
  }
  private writeRouteResult(
    response: ServerResponse,
    result: OperatorRouteResult,
    session: OperatorSession,
  ): void {
    if (!this.requireCurrentSession(response, session)) return;
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
    const headers = API_HEADERS;
    const json = (
      status: number,
      value: unknown,
      extra: Record<string, string> = {},
    ) => writeJson(response, status, value, extra);
    const deny = (status: number, code: string) => {
      request.resume();
      json(status, apiError(code));
    };
    if (!path.startsWith("/api")) {
      if (path === "/login" && method !== "GET") return false;
      if (method !== "GET" && method !== "HEAD") {
        deny(405, "method-not-allowed");
        return true;
      }
      // An unknown address under /app gets the public shell with 404, so the client can render "Page not found".
      const unknownApp =
        !web.shell(path) && path.startsWith("/app/") && !web.bundle.asset(path);
      const asset = web.bundle.asset(
        web.shell(path) || unknownApp ? "/app" : path,
      );
      if (!asset) {
        deny(404, "not-found");
        return true;
      }
      response.writeHead(unknownApp ? 404 : 200, {
        ...headers,
        "content-type": asset.type,
      });
      response.end(method === "HEAD" ? undefined : asset.body);
      return true;
    }
    try {
      if (!web.knownApi(path)) {
        deny(404, "not-found");
        return true;
      }
      const expected =
        path === "/api/operator/credentials"
          ? ["GET", "POST"]
          : [
                "/api/operator/login",
                "/api/operator/logout",
                "/api/operator/commands",
                "/api/operator/source-refresh",
                "/api/operator/setup/folders",
                "/api/operator/setup/verify-checkout",
              ].includes(path) ||
              CREDENTIAL_ACTION.test(path) ||
              path === "/api/operator/notifications/subscriptions" ||
              PUSH_ACTION.test(path)
            ? ["POST"]
            : ["GET"];
      if (!expected.includes(method ?? "")) {
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
        const body = await readJson(request, path === "/api/operator/commands");
        if (path !== "/api/operator/login" && !this.currentSession(session)) {
          deny(401, "unauthenticated");
          return true;
        }
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
          const ownerKey = this.auth.logout(session.id);
          if (ownerKey) web.api.purgeLocalReviewDrafts(ownerKey);
          json(
            200,
            { authenticated: false },
            { "set-cookie": clearedCookie(this.secureCookie) },
          );
          return true;
        }
        if (path.startsWith("/api/operator/credentials")) {
          const credentials = this.credentials;
          if (!credentials) {
            deny(404, "not-found");
            return true;
          }
          const action = CREDENTIAL_ACTION.exec(path);
          const id = decodeSegment(action?.[1] ?? "") ?? "";
          let data: unknown;
          if (!action)
            data = operatorCredentialIssuedSchema.parse(
              credentials.issue(body),
            );
          else if (action[2] === "rotate")
            data = operatorCredentialIssuedSchema.parse(
              credentials.rotate(
                id,
                z
                  .object({
                    expiresInDays:
                      operatorCredentialIssueRequestSchema.shape.expiresInDays,
                  })
                  .strict()
                  .parse(body).expiresInDays,
              ),
            );
          else {
            z.object({}).strict().parse(body);
            data = { credential: credentials.revoke(id) };
          }
          json(200, data);
          return true;
        }
        if (path.startsWith("/api/operator/notifications")) {
          const push = this.push;
          if (!push) {
            deny(404, "not-found");
            return true;
          }
          const action = PUSH_ACTION.exec(path);
          const id = decodeSegment(action?.[1] ?? "") ?? "";
          let data: unknown;
          if (!action)
            data = pushSubscriptionResultSchema.parse({
              subscription: push.subscribe(body),
            });
          else if (action[2] === "revoke") {
            z.object({}).strict().parse(body);
            data = pushSubscriptionResultSchema.parse({
              subscription: push.revoke(id),
            });
          } else {
            z.object({}).strict().parse(body);
            const outcome = await push.test(id);
            if (!this.currentSession(session)) {
              deny(401, "unauthenticated");
              return true;
            }
            data = pushTestResultSchema.parse({ outcome });
          }
          json(200, data);
          return true;
        }
        if (path === "/api/operator/source-refresh") {
          z.object({}).strict().parse(body);
          const data = await web.api.refreshSources();
          if (!this.currentSession(session)) {
            deny(401, "unauthenticated");
            return true;
          }
          json(200, data);
          return true;
        }
        const data =
          path === "/api/operator/setup/folders"
            ? await web.api.listFolders(body)
            : path === "/api/operator/setup/verify-checkout"
              ? await web.api.verifyCheckout(body)
              : await web.api.execute(body, this.reviewSession(session));
        if (!this.currentSession(session)) {
          deny(401, "unauthenticated");
          return true;
        }
        json(200, data);
        return true;
      }
      if (path === "/api/operator/credentials") {
        if ([...url.searchParams].length || !this.credentials)
          throw new OperatorApiError(
            this.credentials ? 400 : 404,
            this.credentials ? "invalid-input" : "not-found",
          );
        json(
          200,
          operatorCredentialListSchema.parse({
            data: { credentials: this.credentials.list() },
            observedAt: Date.now(),
          }),
        );
        return true;
      }
      if (path === "/api/operator/notifications") {
        if ([...url.searchParams].length || !this.push)
          throw new OperatorApiError(
            this.push ? 400 : 404,
            this.push ? "invalid-input" : "not-found",
          );
        json(
          200,
          pushNotificationsReadSchema.parse({
            data: this.push.read(),
            observedAt: Date.now(),
          }),
        );
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
        if (!this.currentSession(session)) {
          deny(401, "unauthenticated");
          return true;
        }
        response.writeHead(200, {
          ...headers,
          "content-type": data.type,
          "x-content-type-options": "nosniff",
          "x-ensemble-evidence-source": data.source,
          "x-ensemble-sha256": data.sha256,
        });
        response.end(data.body);
        return true;
      }
      const data = await web.read(
        path,
        url.searchParams,
        url.search,
        this.reviewSession(session),
      );
      if (!this.currentSession(session)) {
        deny(401, "unauthenticated");
        return true;
      }
      if (data === undefined) deny(404, "not-found");
      else json(200, data);
    } catch (error) {
      if (session?.authenticated && !this.currentSession(session)) {
        deny(401, "unauthenticated");
        return true;
      }
      const failure = apiFailure(error, method);
      json(failure.status, failure.body);
    }
    return true;
  }

  /** CLI bearer path: route authority decides; no cookie, Origin or CSRF state applies. */
  private async handleBearer(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const path = url.pathname,
      method = request.method;
    const deny = (status: number, code: string) => {
      request.resume();
      writeJson(response, status, apiError(code));
    };
    const web = this.web,
      credentials = this.credentials;
    if (!web || !credentials || !path.startsWith("/api/")) {
      deny(403, "forbidden");
      return;
    }
    const token = /^Bearer ([^\s]+)$/.exec(
      String(request.headers.authorization),
    )?.[1];
    const verify = (): VerifiedOperatorCredential | undefined =>
      token === undefined ? undefined : credentials.verify(token);
    const credential = verify();
    if (!credential) {
      deny(401, "credential-invalid");
      return;
    }
    const authority = operatorRouteAuthority(method, path);
    if (authority === undefined) {
      if (web.knownApi(path)) deny(405, "method-not-allowed");
      else deny(404, "not-found");
      return;
    }
    if (authority === "session-only") {
      deny(403, "forbidden");
      return;
    }
    if (authority === "write" && credential.scope !== "read-write") {
      deny(403, "insufficient-scope");
      return;
    }
    try {
      let data: unknown;
      if (path === "/api/operator/cli") {
        if ([...url.searchParams].length)
          throw new OperatorApiError(400, "invalid-input");
        data = cliIdentitySchema.parse({
          apiVersion: 1,
          capabilities: cliCapabilities,
          service: {
            installationId: credentials.installationId(),
            origin: this.auth.origin,
          },
          credential,
        });
      } else if (method === "POST") {
        const body = await readJson(request, path === "/api/operator/commands");
        if (path === "/api/operator/source-refresh") {
          z.object({}).strict().parse(body);
          data = await web.api.refreshSources();
        } else data = await web.api.execute(body);
      } else {
        const artifact = path.match(
          /^\/api\/operator\/tasks\/([^/]+)\/artifacts\/([^/]+)$/,
        );
        if (artifact) {
          if ([...url.searchParams].length)
            throw new OperatorApiError(400, "invalid-input");
          const file = await web.api.readArtifact(
            artifact[1] ?? "",
            artifact[2] ?? "",
          );
          if (!verify()) {
            deny(401, "credential-invalid");
            return;
          }
          response.writeHead(200, {
            ...API_HEADERS,
            "content-type": file.type,
            "x-content-type-options": "nosniff",
            "x-ensemble-evidence-source": file.source,
            "x-ensemble-sha256": file.sha256,
          });
          response.end(file.body);
          return;
        }
        data = await web.read(path, url.searchParams, url.search);
      }
      // A credential revoked or expired during the call returns no data.
      if (!verify()) {
        deny(401, "credential-invalid");
        return;
      }
      if (data === undefined) deny(404, "not-found");
      else writeJson(response, 200, data);
    } catch (error) {
      if (!verify()) {
        deny(401, "credential-invalid");
        return;
      }
      const failure = apiFailure(error, method);
      writeJson(response, failure.status, failure.body);
    }
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
