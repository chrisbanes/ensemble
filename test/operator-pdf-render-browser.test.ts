import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { tmpdir } from "./temp.js";

test("production Vite bundle renders a synthetic PDF in its local worker without export or external fetch", async (t) => {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const outputDirectory = mkdtempSync(join(tmpdir(), "ensemble-pdf-proof-"));
  let browser: Browser | undefined;
  let server: Server | undefined;
  t.after(async () => {
    await browser?.close();
    if (server) {
      await new Promise<void>((resolveClose, reject) =>
        server!.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
    rmSync(outputDirectory, { recursive: true, force: true });
  });

  await build({
    configFile: join(repositoryRoot, "web/vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      rollupOptions: {
        input: join(repositoryRoot, "web/pdf-compatibility.html"),
      },
    },
  });

  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
  };
  server = createServer((request, response) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://local").pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = resolve(outputDirectory, `.${pathname}`);
    if (!file.startsWith(`${outputDirectory}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.writeHead(200, {
        "content-type":
          contentTypes[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const workerUrls: string[] = [];
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin)
      externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("worker", (worker) => workerUrls.push(worker.url()));
  await page.goto(`${origin}/pdf-compatibility.html`);
  await page.waitForFunction(
    () => document.documentElement.dataset.renderState !== undefined,
    undefined,
    { timeout: 10_000 },
  );

  assert.equal(
    await page.locator("html").getAttribute("data-render-state"),
    "rendered",
  );
  assert.equal(
    await page.locator("html").getAttribute("data-pdf-version"),
    "6.4.299",
  );
  assert.equal(await page.locator("html").getAttribute("data-pdf-pages"), "1");
  assert.ok(
    Number(await page.locator("html").getAttribute("data-red-pixels")) > 100,
  );
  assert.ok(
    Number(await page.locator("html").getAttribute("data-blue-pixels")) > 100,
  );
  assert.ok(
    workerUrls.some((url) => url.includes("pdf.worker")),
    workerUrls.join("\n"),
  );
  assert.ok(workerUrls.every((url) => new URL(url).origin === origin));
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(consoleErrors, []);
  assert.equal(
    await page.locator("a[download], button, object, embed, iframe").count(),
    0,
  );
  assert.equal(await page.locator("canvas").count(), 1);
  assert.equal(
    await page
      .locator("html")
      .getAttribute("data-worker-asset")
      .then((url) => new URL(url ?? "", origin).origin),
    origin,
  );
});
