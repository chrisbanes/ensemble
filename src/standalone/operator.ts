import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  DomainCommands,
  type DomainCommand,
  type DomainStore,
} from "../core/domain.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function field(
  name: string,
  value = "",
  kind = "text",
  checked = false,
): string {
  return `<label>${escapeHtml(name)} <input name="${escapeHtml(name)}" type="${kind}" value="${escapeHtml(value)}"${checked ? " checked" : ""}></label>`;
}

function form(type: string, fields: string): string {
  return `<form method="post" action="/command" data-command="${escapeHtml(type)}"><input type="hidden" name="type" value="${escapeHtml(type)}">${fields}<button type="submit">Save</button></form>`;
}

/** Local operator surface for the authenticated UI foundation to mount. */
export class LocalOperatorUi {
  private readonly commands: DomainCommands;

  constructor(private readonly store: DomainStore) {
    this.commands = new DomainCommands(store);
  }

  home(): string {
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
    return `<main><h1>Ensemble</h1><h2>Projects</h2><ul>${projects}</ul>${form("project.create", field("name") + field("leadProfileId"))}<h2>Profiles</h2><ul>${profiles}</ul>${form("profile.create", field("name") + field("instructions") + field("capabilities"))}</main>`;
  }

  project(projectId: string): string {
    const project = this.store.project(projectId);
    const routing = this.store.routing(projectId);
    const tasks = this.store
      .tasks(projectId)
      .map(
        (task) =>
          `<li><a href="/task/${escapeHtml(task.id)}">${escapeHtml(task.title)}</a> (${task.ready ? "ready" : "unready"}; ${escapeHtml(task.state)}; blockers ${escapeHtml(task.importedBlockers)})</li>`,
      )
      .join("");
    return `<main><h1>${escapeHtml(project.name)}</h1><p>${project.paused ? "Paused" : "Active"}. Instructions revision ${escapeHtml(project.instructionsRevision)}.</p><h2>Tasks</h2><ul>${tasks}</ul>${form("task.create", field("projectId", projectId, "hidden") + field("title") + field("outcome") + field("ready", "1", "checkbox"))}${form("project.configure", field("projectId", projectId, "hidden") + field("expectedVersion", String(project.version), "hidden") + field("name", String(project.name)) + field("instructions", String(project.instructions)) + field("paused", "1", "checkbox", Boolean(project.paused)))}<h2>Routing</h2><p>${routing.enabled ? "Enabled" : "Disabled"}; credential ${routing.credentialAvailable ? "configured" : "unavailable"}</p>${form("routing.configure", field("projectId", projectId, "hidden") + field("expectedVersion", String(routing.version), "hidden") + field("enabled", "1", "checkbox", Boolean(routing.enabled)) + field("guidance", String(routing.guidance)) + field("credentialRef") + field("candidateProfileIds", String(routing.candidateProfileIds)))}</main>`;
  }

  task(taskId: string): string {
    const task = this.store.task(taskId);
    const assignments = this.store
      .assignments(taskId)
      .map(
        (assignment) =>
          `<li>${escapeHtml(assignment.id)}: ${escapeHtml(assignment.state)} to ${escapeHtml(assignment.profileId)}; result to ${escapeHtml(assignment.resultDestination)}</li>`,
      )
      .join("");
    const dependencies = this.store
      .dependencies(taskId)
      .map((blocker) => `<li>${escapeHtml(blocker)}</li>`)
      .join("");
    const admission = this.store.admission(taskId);
    return `<main><h1>${escapeHtml(task.title)}</h1><p>${admission.eligible ? "Eligible" : `Held: ${escapeHtml(admission.reasons.join(", "))}`}</p><h2>Assignments</h2><ul>${assignments}</ul>${form("assignment.create", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("profileId") + field("brief") + field("resultDestination"))}<h2>Dependencies</h2><ul>${dependencies}</ul>${form("dependency.add", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("expectedVersion", String(task.version), "hidden") + field("blockerTaskId"))}${form("dependency.remove", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("expectedVersion", String(task.version), "hidden") + field("blockerTaskId"))}${form("imported-blockers.set", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("expectedVersion", String(task.version), "hidden") + field("state", String(task.importedBlockers)))}${form("task.configure", field("projectId", String(task.projectId), "hidden") + field("taskId", taskId, "hidden") + field("expectedVersion", String(task.version), "hidden") + field("title", String(task.title)) + field("outcome", String(task.outcome)) + field("ready", "1", "checkbox", Boolean(task.ready)))}</main>`;
  }

  profile(profileId: string): string {
    const profile = this.store.profile(profileId);
    return `<main><h1>${escapeHtml(profile.name)}</h1><p>Revision ${escapeHtml(profile.version)}; ${profile.revoked ? "revoked" : "active"}</p>${form("profile.configure", field("profileId", profileId, "hidden") + field("expectedVersion", String(profile.version), "hidden") + field("name", String(profile.name)) + field("instructions", String(profile.instructions)) + field("capabilities", String(profile.capabilities)) + field("revoked", "1", "checkbox", Boolean(profile.revoked)))}</main>`;
  }

  assignment(assignmentId: string): string {
    const assignment = this.store.assignment(assignmentId);
    return `<main><h1>Assignment ${escapeHtml(assignment.id)}</h1><p>${escapeHtml(assignment.state)}; profile revision ${escapeHtml(assignment.profileRevision)}; project instructions revision ${escapeHtml(assignment.instructionsRevision)}; result to ${escapeHtml(assignment.resultDestination)}</p>${form("assignment.apply", field("projectId", String(assignment.projectId), "hidden") + field("assignmentId", assignmentId, "hidden") + field("expectedVersion", String(assignment.version), "hidden"))}</main>`;
  }

  async submit(fields: Record<string, string>): Promise<unknown> {
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
      case "project.configure":
        command = {
          ...common,
          type: "project.configure",
          projectId: required("projectId"),
          expectedVersion: version(),
          name: required("name"),
          instructions: fields.instructions ?? "",
          paused: fields.paused === "1",
        };
        break;
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
          credentialRef: fields.credentialRef || undefined,
          candidateProfileIds: fields.candidateProfileIds
            ? JSON.parse(fields.candidateProfileIds)
            : [],
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

/** Explicit loopback-only HTTP adapter; remote authentication belongs to #703. */
export class LocalOperatorHttp {
  private server: Server | undefined;

  constructor(private readonly ui: LocalOperatorUi) {}

  async start(port = 0): Promise<number> {
    if (this.server) throw new Error("Operator UI already started");
    const server = createServer(async (request, response) => {
      try {
        const address = server.address();
        const localOrigin =
          address && typeof address !== "string"
            ? `http://127.0.0.1:${address.port}`
            : "";
        if (request.headers.host !== localOrigin.slice("http://".length)) {
          response.writeHead(403).end("Host denied");
          return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET") {
          const [kind, id] = url.pathname.split("/").slice(1);
          const html =
            kind === "project" && id
              ? this.ui.project(id)
              : kind === "task" && id
                ? this.ui.task(id)
                : kind === "profile" && id
                  ? this.ui.profile(id)
                  : kind === "assignment" && id
                    ? this.ui.assignment(id)
                    : url.pathname === "/"
                      ? this.ui.home()
                      : undefined;
          if (html === undefined) {
            response.writeHead(404).end("Not found");
            return;
          }
          response
            .writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            })
            .end(`<!doctype html><meta charset="utf-8">${html}`);
          return;
        }
        if (request.method !== "POST" || url.pathname !== "/command") {
          response.writeHead(404).end("Not found");
          return;
        }
        const origin = request.headers.origin;
        if (origin !== localOrigin) {
          response.writeHead(403).end("Origin denied");
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 65536) {
            response.writeHead(413).end("Form too large");
            return;
          }
        }
        const fields = Object.fromEntries(new URLSearchParams(body));
        await this.ui.submit(fields);
        response
          .writeHead(303, { location: "/", "cache-control": "no-store" })
          .end();
      } catch {
        response
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end("<p>Command rejected</p>");
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
}
