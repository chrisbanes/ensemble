import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubHttpSourceReader } from "../../dist/src/standalone/github-source.js";
import { StandaloneService } from "../../dist/src/standalone/service.js";
import { LocalOperatorUi } from "../../dist/src/standalone/operator.js";

const manifestPath = process.env.ENSEMBLE_S06_FIXTURE_MANIFEST;
if (!manifestPath)
  throw new Error(
    "ENSEMBLE_S06_FIXTURE_MANIFEST is required; no provider request was made",
  );
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.version, 1);
assert.match(manifest.repository?.fullName ?? "", /^[^/]+\/[^/]+$/);
assert.equal(typeof manifest.repository?.id, "string");
assert.equal(typeof manifest.projectNodeId, "string");
assert.equal(typeof manifest.searchQuery, "string");
assert.match(manifest.credentialRef ?? "", /^env:[A-Z][A-Z0-9_]*$/);
assert.ok(Array.isArray(manifest.issues) && manifest.issues.length > 0);
const token = process.env[manifest.credentialRef.slice(4)];
if (!token)
  throw new Error(
    "Configured read-only credential is unavailable; no provider request was made",
  );
let providerWrites = 0;
const guardedFetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (
    url.origin !== "https://api.github.com" ||
    (method !== "GET" &&
      !(
        method === "POST" &&
        url.pathname === "/graphql" &&
        JSON.parse(init.body).query.startsWith("query ")
      ))
  ) {
    providerWrites++;
    throw new Error("Harness refused a provider write or unexpected endpoint");
  }
  return fetch(input, init);
};
const reader = new GitHubHttpSourceReader(token, guardedFetch);
const [owner, name] = manifest.repository.fullName.split("/");
const selections = [
  {
    id: "repository",
    kind: "repository",
    repositoryId: manifest.repository.id,
    owner,
    name,
  },
  { id: "search", kind: "search", query: manifest.searchQuery },
  {
    id: "project",
    kind: "project",
    projectNodeId: manifest.projectNodeId,
    filter: manifest.projectFilter ?? "",
  },
];
const snapshots = new Map();
for (const selection of selections) {
  const snapshot = await reader.readSelection(selection);
  assert.equal(
    snapshot.complete,
    true,
    `${selection.id} selection incomplete: ${snapshot.reason}`,
  );
  snapshots.set(selection.id, snapshot);
}
const byNode = new Map();
for (const selection of selections)
  for (const issue of snapshots.get(selection.id).issues)
    byNode.set(issue.nodeId, issue);
for (const expected of manifest.issues) {
  assert.equal(typeof expected.nodeId, "string");
  assert.ok(Number.isSafeInteger(expected.number));
  assert.ok(Array.isArray(expected.memberships));
  assert.ok(["eligible", "blocked"].includes(expected.expectedAdmission));
  const issue = byNode.get(expected.nodeId);
  assert.ok(issue, `Expected fixture issue ${expected.nodeId} missing`);
  assert.equal(issue.number, expected.number);
  for (const selectionId of expected.memberships)
    assert.ok(
      snapshots
        .get(selectionId)
        .issues.some((item) => item.nodeId === expected.nodeId),
      `${expected.nodeId} missing ${selectionId} membership`,
    );
  const reference = {
    nodeId: issue.nodeId,
    repositoryId: issue.repositoryId,
    repositoryName: issue.repositoryName,
    number: issue.number,
  };
  const blockers = await reader.readBlockers(reference);
  assert.equal(
    blockers.complete,
    true,
    `${expected.nodeId} blocker read incomplete`,
  );
  for (const blocker of expected.blockers ?? [])
    assert.equal(
      blockers.blockers.find((item) => item.nodeId === blocker.nodeId)?.state,
      blocker.state,
    );
  const status = await reader.readIssueStatus(reference);
  assert.equal(status.status, expected.state);
}

const temp = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s06-live-")));
const runtime = () => ({
  async start() {},
  async stop() {},
  onUnexpectedRequest() {},
  async startThread() {
    return "thread";
  },
  async resumeThread() {},
  async startTurn() {
    throw new Error("Paused fixture must not execute");
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
});
const service = new StandaloneService(join(temp, "data"), runtime, undefined, {
  github: { readerFactory: () => reader, intervalMs: 60_000 },
  power: { enabled: false },
});
try {
  await service.start();
  const domain = service.domain();
  const projectId = randomUUID();
  const leadProfileId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: leadProfileId,
    name: "S06 fixture lead",
    instructions: "No execution",
    capabilities: "observe",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "S06 disposable fixture",
    leadProfileId,
  });
  domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: manifest.credentialRef,
    selections,
    readiness: manifest.readiness,
    repositories: [],
  });
  for (const selection of selections)
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: selection.id,
      expectedVersion: 2,
    });
  await service.refreshGitHub();
  const ui = new LocalOperatorUi(domain, undefined, service.githubSources());
  const projectHtml = ui.project(projectId);
  for (const selection of selections)
    assert.match(projectHtml, new RegExp(`${selection.id}.*complete`));
  for (const expected of manifest.issues) {
    const imported = service.githubSources().issue(expected.nodeId);
    assert.ok(imported, `Expected issue ${expected.nodeId} was not imported`);
    const memberships = service
      .githubSources()
      .memberships(expected.nodeId)
      .map((item) => item.selectionId);
    for (const selectionId of expected.memberships)
      assert.ok(memberships.includes(selectionId));
    const admission = domain.admission(String(imported.taskId));
    assert.equal(
      admission.reasons.includes("imported-blockers-blocked"),
      (expected.blockers ?? []).some((item) => item.state === "open"),
    );
    const taskHtml = ui.task(String(imported.taskId));
    assert.ok(
      taskHtml.includes(expected.nodeId) &&
        taskHtml.includes(String(expected.number)),
    );
    assert.match(taskHtml, /GitHub source|Native blockers/);
    if ((expected.blockers ?? []).some((item) => item.state === "open"))
      assert.match(taskHtml, /imported-blockers-blocked/);
    if (expected.expectedAdmission === "blocked")
      assert.equal(admission.eligible, false);
  }
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  for (const expected of manifest.issues) {
    const imported = service.githubSources().issue(expected.nodeId);
    const admission = domain.admission(String(imported.taskId));
    assert.equal(
      admission.eligible,
      expected.expectedAdmission === "eligible",
      `Admission mismatch for ${expected.nodeId}: ${admission.reasons.join(",")}`,
    );
    const taskHtml = ui.task(String(imported.taskId));
    assert.match(
      taskHtml,
      expected.expectedAdmission === "eligible"
        ? /eligible for future admission/
        : /held:/,
    );
  }
  assert.equal(providerWrites, 0);
  process.stdout.write(
    `${JSON.stringify({
      outcome: "passed",
      repositoryId: manifest.repository.id,
      projectNodeId: manifest.projectNodeId,
      observedIssueNodeIds: manifest.issues.map((item) => item.nodeId),
      providerWrites,
      observedAt: new Date().toISOString(),
    })}\n`,
  );
} finally {
  await service.stop();
  rmSync(temp, { recursive: true, force: true });
}
