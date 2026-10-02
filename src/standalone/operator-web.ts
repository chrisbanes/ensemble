import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OperatorApiError, type OperatorApi } from "./operator-api.js";
const mime: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
};
export class OperatorWebBundle {
  private constructor(
    private readonly files: ReadonlyMap<string, { body: Buffer; type: string }>,
  ) {}
  static async open(directory: string) {
    const files = new Map<string, { body: Buffer; type: string }>();
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
    }
    return new OperatorWebBundle(files);
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
      path === "/app/settings" ||
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
  async read(path: string, query = new URLSearchParams()) {
    if (path === "/api/operator/task-list")
      return this.api.readTaskListPage(query);
    if ([...query].length) throw new OperatorApiError(400, "invalid-input");
    const options = path.match(
      /^\/api\/operator\/projects\/([^/]+)\/composer-options$/,
    );
    if (options) return this.api.readComposerOptions(options[1] ?? "");
    if (path === "/api/operator/workspace") return this.api.readWorkspace();
    let match = path.match(/^\/api\/operator\/projects\/([^/]+)$/);
    if (match) return this.api.readProject(match[1] ?? "");
    match = path.match(/^\/api\/operator\/tasks\/([^/]+)$/);
    if (match) return this.api.readTask(match[1] ?? "");
    match = path.match(/^\/api\/operator\/assignments\/([^/]+)\/history$/);
    if (match) return this.api.readAssignmentHistory(match[1] ?? "");
    return undefined;
  }
  knownApi(path: string) {
    return (
      [
        "/api/operator/session",
        "/api/operator/login",
        "/api/operator/logout",
        "/api/operator/workspace",
        "/api/operator/task-list",
        "/api/operator/commands",
      ].includes(path) ||
      /^\/api\/operator\/(?:projects|tasks)\/[^/]+$/.test(path) ||
      /^\/api\/operator\/projects\/[^/]+\/composer-options$/.test(path) ||
      /^\/api\/operator\/assignments\/[^/]+\/history$/.test(path)
    );
  }
}
