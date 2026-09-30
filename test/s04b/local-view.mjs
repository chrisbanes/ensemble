import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneService } from "../../dist/src/standalone/service.js";

if (!process.argv.includes("--smoke")) {
  throw new Error(
    "This test-only view supports only the explicit --smoke mode",
  );
}

class SmokeRuntime {
  starts = 0;
  turns = 0;
  outcomes = new Map();

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("completed");
  }

  async startThread() {
    return `smoke-thread-${++this.starts}`;
  }

  async resumeThread() {}

  async startTurn() {
    const turnId = `smoke-turn-${++this.turns}`;
    let finish;
    const promise = new Promise((done) => {
      finish = done;
    });
    this.outcomes.set(turnId, { promise, resolve: finish });
    return turnId;
  }

  async interruptTurn(_threadId, turnId) {
    this.outcomes.get(turnId)?.resolve("failed");
  }

  async waitForTurn(_threadId, turnId) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest() {}

  onToolCall() {}
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function section(title, rows) {
  const content = rows.length
    ? rows.map((row) => `<li>${escapeHtml(row)}</li>`).join("")
    : "<li>None</li>";
  return `<section><h2>${escapeHtml(title)}</h2><ul>${content}</ul></section>`;
}

function render(view) {
  const rows = (items, toText) => items.map(toText);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ensemble local coordination view</title></head><body>
    <h1>Ensemble local coordination view</h1>
    <section><h2>Task identity</h2><dl>
      <dt>Title</dt><dd>${escapeHtml(view.task.title)}</dd>
      <dt>Task ID</dt><dd>${escapeHtml(view.task.id)}</dd>
      <dt>Project ID</dt><dd>${escapeHtml(view.task.projectId)}</dd>
      <dt>State</dt><dd>${escapeHtml(view.task.state)}</dd>
    </dl></section>
    ${section(
      "Work history",
      rows(view.history, (item) => `${item.workId}: ${item.state}`),
    )}
    ${section(
      "Results",
      rows(view.results, (item) => `${item.resultId}: ${item.summary}`),
    )}
    ${section(
      "Unresolved results",
      rows(
        view.unresolvedResults,
        (item) => `${item.resultId}: recipient needs reconciliation`,
      ),
    )}
    ${section(
      "Messages",
      rows(view.messages, (item) => `${item.eventType}: ${item.deliveryState}`),
    )}
    ${section(
      "Questions",
      rows(view.questions, (item) => `${item.id}: ${item.status}`),
    )}
    ${section(
      "Approvals",
      rows(view.approvals, (item) => `${item.id}: ${item.status}`),
    )}
    ${section(
      "Routing disposition",
      rows(
        view.routing.dispositions,
        (item) => `${item.operationId}: ${item.disposition}`,
      ),
    )}
    ${section("Attention", [
      ...view.attention.interactions.map(
        (item) => `interaction ${item.interactionId}: ${item.status}`,
      ),
      ...view.attention.completions.map(
        (item) => `completion ${item.requestId}: ${item.status}`,
      ),
      ...view.attention.routingFallbacks.map(
        (item) => `routing ${item.operationId}: ${item.reason}`,
      ),
    ])}
  </body></html>`;
}

function command(service, body) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...body });
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Local view smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const root = realpathSync(
  mkdtempSync(join(tmpdir(), "ensemble-s04b-local-view-")),
);
const runtime = new SmokeRuntime();
const service = new StandaloneService(
  join(root, "data"),
  () => runtime,
  undefined,
  { power: { enabled: false }, routingClient: null },
);
let server;
try {
  await service.start();
  const leadProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Smoke lead",
    instructions: "Inspect the local test view.",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Disposable local view project",
    leadProfileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "Use the lead when no candidate is configured.",
    candidateProfileIds: [],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Disposable coordination view task",
    outcome: "Verify local read-only sections.",
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await waitUntil(
    () =>
      service.coordinationView().readTask(taskId).routing.dispositions.length >
      0,
  );

  server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== `/task/${taskId}` || url.search) {
      response.writeHead(404).end("Not found");
      return;
    }
    const html = render(service.coordinationView().readTask(taskId));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  assert.ok(address.port > 0);

  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/task/${taskId}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const heading of [
    "Task identity",
    "Work history",
    "Results",
    "Unresolved results",
    "Messages",
    "Questions",
    "Approvals",
    "Routing disposition",
    "Attention",
  ]) {
    assert.ok(
      html.includes(`<h2>${heading}</h2>`),
      `missing ${heading} section`,
    );
  }
  assert.ok(html.includes("Disposable coordination view task"));
  assert.ok(html.includes("lead-review"));
  assert.equal(
    (await fetch(`${origin}/task/${taskId}`, { method: "POST" })).status,
    405,
  );
  assert.equal((await fetch(`${origin}/mutation`)).status, 404);
  console.log("S04b local read-only view smoke passed on 127.0.0.1");
} finally {
  if (server?.listening) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await service.stop();
  rmSync(root, { recursive: true, force: true });
}
