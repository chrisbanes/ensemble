import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OperatorApiError, type OperatorApi } from "./operator-api.js";
import type { WorkspaceInspectionRequest } from "./workspace-inspection.js";
const mime: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
};
type WorkspaceInspectionQuery = Omit<WorkspaceInspectionRequest, "taskId">;

function parseWorkspaceInspectionQuery(
  query: URLSearchParams,
  rawSearch?: string,
): WorkspaceInspectionQuery {
  const allowed = new Set(["scope", "repositoryId", "path", "showIgnored"]);
  for (const key of query.keys())
    if (!allowed.has(key) || query.getAll(key).length !== 1)
      throw new OperatorApiError(400, "invalid-input");

  const decode = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      throw new OperatorApiError(400, "invalid-input");
    }
  };
  if (rawSearch !== undefined) {
    const rawPathValues: string[] = [];
    for (const field of rawSearch.replace(/^\?/, "").split("&")) {
      if (!field) continue;
      const separator = field.indexOf("=");
      const key = decode(separator < 0 ? field : field.slice(0, separator));
      if (key !== "path") continue;
      const value = separator < 0 ? "" : field.slice(separator + 1);
      if (/%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f)/i.test(value))
        throw new OperatorApiError(400, "invalid-input");
      rawPathValues.push(decode(value));
    }
    if (rawPathValues.length !== query.getAll("path").length)
      throw new OperatorApiError(400, "invalid-input");
  }

  const scope = query.get("scope");
  const repositoryId = query.get("repositoryId");
  const path = query.get("path");
  const showIgnoredValue = query.get("showIgnored");
  if (scope === "workspace") {
    if (repositoryId !== null) throw new OperatorApiError(400, "invalid-input");
  } else if (
    scope !== "repository" ||
    !repositoryId ||
    repositoryId.length > 512
  ) {
    throw new OperatorApiError(400, "invalid-input");
  }
  if (
    showIgnoredValue !== null &&
    showIgnoredValue !== "true" &&
    showIgnoredValue !== "false"
  )
    throw new OperatorApiError(400, "invalid-input");

  const inspectionScope: WorkspaceInspectionQuery["scope"] =
    scope === "workspace"
      ? { kind: "workspace" }
      : { kind: "repository", repositoryId: repositoryId ?? "" };
  return {
    scope: inspectionScope,
    ...(path === null ? {} : { path: path.split("/") }),
    showIgnored: showIgnoredValue === "true",
  };
}
export class OperatorWebBundle {
  private constructor(
    private readonly files: ReadonlyMap<string, { body: Buffer; type: string }>,
    readonly stylesheets: readonly string[],
  ) {}
  static async open(directory: string) {
    const files = new Map<string, { body: Buffer; type: string }>();
    const stylesheets: string[] = [];
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw Error("Operator build unavailable");
    const indexPath = join(directory, "index.html"),
      index = await lstat(indexPath);
    if (!index.isFile() || index.isSymbolicLink())
      throw Error("Operator build unavailable");
    const html = await readFile(indexPath);
    files.set("/app", { body: html, type: "text/html; charset=utf-8" });
    const assetPath = join(directory, "assets"),
      assets = await lstat(assetPath);
    if (!assets.isDirectory() || assets.isSymbolicLink())
      throw Error("Operator build unavailable");
    for (const name of await readdir(assetPath)) {
      if (!/^[A-Za-z0-9_.-]+\.(js|css|woff2)$/.test(name))
        throw Error("Unsupported operator build asset");
      const path = join(assetPath, name),
        stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("Unsafe operator build asset");
      const type = mime[name.split(".").at(-1) ?? ""];
      if (!type) throw Error("Unsupported operator build asset");
      files.set(`/assets/${name}`, { body: await readFile(path), type });
    }
    for (const match of html
      .toString("utf8")
      .matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (!match[1]?.startsWith("/assets/") || !files.has(match[1]))
        throw Error("Operator build references unavailable asset");
      if (match[0].startsWith("href=") && match[1].endsWith(".css"))
        stylesheets.push(match[1]);
    }
    return new OperatorWebBundle(files, Object.freeze(stylesheets));
  }
  asset(path: string) {
    return this.files.get(path);
  }
}
export class OperatorWebBoundary {
  constructor(
    readonly bundle: OperatorWebBundle,
    readonly api: OperatorApi,
  ) {}
  shell(path: string) {
    return (
      path === "/app" ||
      path === "/app/tasks" ||
      path === "/app/tasks/new" ||
      path === "/app/inbox" ||
      path === "/app/search" ||
      /^\/app\/tasks\/[a-f0-9-]{36}$/.test(path) ||
      path === "/app/settings" ||
      /^\/app\/assignments\/[a-f0-9-]{36}\/recovery$/.test(path) ||
      /^\/app\/settings\/(?:projects\/new|profiles\/new|runtime)$/.test(path) ||
      /^\/app\/(?:projects|profiles)\/[a-f0-9-]{36}\/settings$/.test(path) ||
      path === "/login" ||
      /^\/app\/projects\/[a-f0-9-]{36}$/.test(path)
    );
  }
  owns(path: string) {
    return (
      this.shell(path) ||
      path.startsWith("/app/") ||
      path.startsWith("/assets/") ||
      path === "/api" ||
      path.startsWith("/api/")
    );
  }
  async read(path: string, query = new URLSearchParams(), rawSearch?: string) {
    if (path === "/api/operator/search") return this.api.readSearch(query);
    if (path === "/api/operator/inbox") return this.api.readInbox(query);
    const workspaceFiles = path.match(
      /^\/api\/operator\/tasks\/([^/]+)\/files$/,
    );
    const workspacePreview = path.match(
      /^\/api\/operator\/tasks\/([^/]+)\/preview$/,
    );
    if (workspaceFiles) {
      const request = parseWorkspaceInspectionQuery(query, rawSearch);
      return this.api.readWorkspaceDirectory(workspaceFiles[1] ?? "", request);
    }
    if (workspacePreview) {
      const request = parseWorkspaceInspectionQuery(query, rawSearch);
      return this.api.readWorkspacePreview(workspacePreview[1] ?? "", request);
    }
    const question = path.match(
      /^\/api\/operator\/tasks\/([^/]+)\/questions\/([^/]+)$/,
    );
    if (question) {
      if ([...query].length) throw new OperatorApiError(400, "invalid-input");
      return this.api.readQuestion(question[1] ?? "", question[2] ?? "");
    }
    if (path === "/api/operator/task-list")
      return this.api.readTaskListPage(query);
    const history = path.match(
      /^\/api\/operator\/assignments\/([^/]+)\/history$/,
    );
    if (history) {
      if (
        [...query.keys()].some(
          (k) => k !== "beforeSequence" && k !== "beforeOmissionSequence",
        )
      )
        throw new OperatorApiError(400, "invalid-input");
      const value = query.get("beforeSequence");
      const before = value === null ? undefined : Number(value);
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        throw new OperatorApiError(400, "invalid-input");
      const omissionValue = query.get("beforeOmissionSequence");
      const beforeOmission =
        omissionValue === null ? undefined : Number(omissionValue);
      if (
        beforeOmission !== undefined &&
        (!Number.isSafeInteger(beforeOmission) || beforeOmission < 1)
      )
        throw new OperatorApiError(400, "invalid-input");
      return this.api.readAssignmentHistory(
        history[1] ?? "",
        before,
        beforeOmission,
      );
    }
    const selectedReview = path.match(
      /^\/api\/operator\/tasks\/([^/]+)(\/review)?$/,
    );
    if (selectedReview) {
      if ([...query.keys()].some((k) => k !== "resultId" && k !== "sourceId"))
        throw new OperatorApiError(400, "invalid-input");
      const parsed = z
        .object({
          resultId: z.uuid().optional(),
          sourceId: z.uuid().optional(),
        })
        .strict()
        .safeParse(Object.fromEntries(query));
      if (
        !parsed.success ||
        [...query.keys()].some((k) => query.getAll(k).length !== 1)
      )
        throw new OperatorApiError(400, "invalid-input");
      const selection = parsed.data;
      return selectedReview[2]
        ? this.api.readReview(selectedReview[1] ?? "", selection)
        : this.api.readTask(selectedReview[1] ?? "", selection);
    }
    if ([...query].length) throw new OperatorApiError(400, "invalid-input");
    if (path === "/api/operator/runtime") return this.api.readRuntimeSettings();
    const recovery = path.match(
      /^\/api\/operator\/assignments\/([^/]+)\/recovery$/,
    );
    if (recovery) return this.api.readAssignmentRecovery(recovery[1] ?? "");
    let config = path.match(
      /^\/api\/operator\/projects\/([^/]+)\/configuration$/,
    );
    if (config) return this.api.readProjectConfiguration(config[1] ?? "");
    config = path.match(/^\/api\/operator\/profiles\/([^/]+)\/configuration$/);
    if (config) return this.api.readProfileConfiguration(config[1] ?? "");
    const options = path.match(
      /^\/api\/operator\/projects\/([^/]+)\/composer-options$/,
    );
    if (options) return this.api.readComposerOptions(options[1] ?? "");
    if (path === "/api/operator/source-observations")
      return this.api.readSourceObservations();
    if (path === "/api/operator/workspace") return this.api.readWorkspace();
    let match = path.match(/^\/api\/operator\/projects\/([^/]+)$/);
    if (match) return this.api.readProject(match[1] ?? "");
    match = path.match(/^\/api\/operator\/assignments\/([^/]+)\/history$/);
    if (match) return this.api.readAssignmentHistory(match[1] ?? "");
    return undefined;
  }
  knownApi(path: string) {
    return (
      [
        "/api/operator/session",
        "/api/operator/runtime",
        "/api/operator/login",
        "/api/operator/logout",
        "/api/operator/workspace",
        "/api/operator/task-list",
        "/api/operator/inbox",
        "/api/operator/search",
        "/api/operator/commands",
        "/api/operator/source-refresh",
        "/api/operator/source-observations",
      ].includes(path) ||
      /^\/api\/operator\/(?:projects|profiles)\/[^/]+\/configuration$/.test(
        path,
      ) ||
      /^\/api\/operator\/(?:projects|tasks)\/[^/]+$/.test(path) ||
      /^\/api\/operator\/tasks\/[^/]+\/(?:review|artifacts\/[^/]+)$/.test(
        path,
      ) ||
      /^\/api\/operator\/tasks\/[^/]+\/(?:files|preview)$/.test(path) ||
      /^\/api\/operator\/tasks\/[^/]+\/questions\/[^/]+$/.test(path) ||
      /^\/api\/operator\/projects\/[^/]+\/composer-options$/.test(path) ||
      /^\/api\/operator\/assignments\/[^/]+\/(?:history|recovery)$/.test(path)
    );
  }
}
