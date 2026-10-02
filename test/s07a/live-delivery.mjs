import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { z } from "zod";
import {
  FixtureGuard,
  qualificationDisposition,
  qualificationTaskIdle,
} from "../../dist/test/s07a/fixture.js";
import { StandaloneDataDirectory } from "../../dist/src/standalone/data-directory.js";
import { DomainStore } from "../../dist/src/core/domain.js";
import { Store } from "../../dist/src/core/store.js";
import { GitHubSourceStore } from "../../dist/src/core/github-source.js";
import { CodexRuntime } from "../../dist/src/standalone/codex.js";
import { StandaloneService } from "../../dist/src/standalone/service.js";
import { OperatorAuth } from "../../dist/src/standalone/operator-auth.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../dist/src/standalone/operator.js";
import { OperatorRouteRegistry } from "../../dist/src/standalone/operator-routes.js";
import { coordinationOperatorRoutes } from "../../dist/src/standalone/operator-coordination.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import { canonicalMaterial } from "../../dist/src/core/delivery.js";

const args = process.argv.slice(2);
function argument(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
if (
  !args.includes("--live") ||
  !isAbsolute(argument("--manifest") ?? "") ||
  !isAbsolute(argument("--grant") ?? "") ||
  args.length !== 5
)
  throw new Error(
    "Refusing execution: require --live --manifest ABSOLUTE_PATH --grant ABSOLUTE_PATH",
  );
// Validation happens before credential access, process creation or provider requests.
const guard = new FixtureGuard(
    readFileSync(argument("--manifest"), "utf8"),
    JSON.parse(readFileSync(argument("--grant"), "utf8")),
  ),
  m = guard.manifest;
guard.assertCredentialReference(m.credentialRef);
const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s07a-live-"))),
  data = join(root, "data");
mkdirSync(data, { mode: 0o700 });
const evidence = {
  version: 1,
  source: {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
    npm: JSON.parse(readFileSync("package.json", "utf8")).packageManager,
    codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    files: Object.fromEntries(
      [
        "src/core/delivery.ts",
        "src/core/coordination.ts",
        "src/core/github-source.ts",
        "src/standalone/delivery.ts",
        "src/standalone/github-delivery.ts",
        "src/standalone/service.ts",
        "src/standalone/codex.ts",
        "test/s07a/fixture.ts",
        "test/s07a/live-delivery.mjs",
      ].map((path) => [
        path,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]),
    ),
  },
  manifestSha256: guard.grant.manifestSha256,
  provider: {
    accountNodeId: m.account.nodeId,
    repositoryNodeId: m.repository.nodeId,
    repositoryVisibility: null,
    projectNodeId: m.project.nodeId,
    api: "2022-11-28",
  },
  results: {
    handback: "unproved",
    throughMerge: "unproved",
    cleanup: "unproved",
  },
  journeys: [],
  runtime: {
    turns: [],
    terminals: [],
    callbacks: [],
    spawnSnapshotFiltered: false,
    processes: [],
  },
  cleanup: { remote: [], processes: [] },
  failure: null,
  limits: [
    "Prepared remote refs; no workspace Git publication",
    "Existing-login Codex App Server, accepted host and ambient-read limits retained",
    "No TypeSafe or API-paid inference",
    "S07b, redesigned UI, physical sleep/wake, recovery release and cutover unqualified",
    "Fixture repository/Project retained unless a separate explicit disposal grant exists",
  ],
};
function save() {
  writeFileSync(
    join(root, "evidence.json"),
    JSON.stringify(
      { ...evidence, disposition: qualificationDisposition(evidence.results) },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
function command(domain, value) {
  return domain.execute({ actor: "operator", key: randomUUID(), ...value });
}
function actionTarget(j) {
  return {
    repositoryId: m.repository.nodeId,
    nodeId: j.pr.nodeId,
    number: j.pr.number,
    baseRef: j.pr.baseRef,
    headRef: j.pr.headRef,
    expectedHeadSha: j.pr.headSha,
  };
}
function credential() {
  const value = process.env[m.credentialRef.slice(4)];
  if (!value) throw new Error("Named fixture credential unavailable");
  return value;
}
async function provider(path, method = "GET", body, cleanup = false) {
  const url = `https://api.github.com${path}`,
    init = {
      method,
      headers: {
        authorization: `Bearer ${credential()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  guard.assertRequest(url, init, cleanup);
  const response = await fetch(url, init);
  if (!response.ok) throw new Error("Fixture provider request rejected");
  return response.status === 204 ? null : response.json();
}
const repoPath = `/repos/${m.repository.fullName}`;
const issueSchema = z.object({
  node_id: z.string(),
  number: z.number().int(),
  repository_url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
});
async function issueSnapshot(j) {
  const raw = issueSchema.parse(
    await provider(`${repoPath}/issues/${j.issue.number}`),
  );
  assert.equal(raw.node_id, j.issue.nodeId);
  assert.equal(raw.number, j.issue.number);
  assert.equal(raw.repository_url, `https://api.github.com${repoPath}`);
  return {
    providerInstance: "github.com",
    nodeId: raw.node_id,
    repositoryId: m.repository.nodeId,
    repositoryName: m.repository.fullName,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    labels: raw.labels.map((l) => l.name),
    projectFields: [],
  };
}
const sourceReader = (reference) => {
  guard.assertCredentialReference(reference);
  return {
    async readSelection(selection) {
      assert.equal(selection.repositoryId, m.repository.nodeId);
      const j = m.journeys.find((j) => j.serviceProjectId === selection.id);
      assert.ok(j);
      const issue = await issueSnapshot(j);
      return {
        complete: true,
        issues: issue.state === "open" ? [issue] : [],
        reason: null,
      };
    },
    async readBlockers(reference) {
      const j = m.journeys.find((j) => j.issue.nodeId === reference.nodeId);
      assert.ok(j);
      const blockers = z
        .array(z.unknown())
        .parse(
          await provider(
            `${repoPath}/issues/${j.issue.number}/dependencies/blocked_by`,
          ),
        );
      if (blockers.length)
        throw new Error("Fixture has unexpected native dependency");
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus(reference) {
      const j = m.journeys.find((j) => j.issue.nodeId === reference.nodeId);
      assert.ok(j);
      return { status: (await issueSnapshot(j)).state };
    },
  };
};
async function waitFor(predicate, stage) {
  const deadline = Date.now() + 90000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Fixture wait unproved: ${stage}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
class BoundedRuntime extends CodexRuntime {
  constructor(context) {
    super("codex", context);
  }
  async startTurn(threadId, workspace, prompt) {
    guard.beginRuntimeTurn();
    const turnId = await super.startTurn(threadId, workspace, prompt);
    evidence.runtime.turns.push({ threadId, turnId });
    save();
    return turnId;
  }
  async waitForTurn(threadId, turnId) {
    const outcome = await super.waitForTurn(threadId, turnId);
    evidence.runtime.terminals.push({ threadId, turnId, outcome });
    save();
    return outcome;
  }
  onToolCall(listener) {
    super.onToolCall(async (call) => {
      const result = await listener(call);
      evidence.runtime.callbacks.push({
        threadId: call.threadId,
        turnId: call.turnId,
        callId: call.callId,
        tool: call.tool,
        success: result.success,
      });
      save();
      return result;
    });
  }
}
const password = randomBytes(32).toString("base64url"),
  authFile = join(root, "operator-auth.json");
let service, runtime, http, browser, page, origin;
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function start() {
  service = new StandaloneService(
    data,
    (context) => {
      const env = context.spawnEnvironment(),
        key = m.credentialRef.slice(4),
        value = credential();
      assert.equal(env[key], undefined);
      assert.ok(!Object.values(env).includes(value));
      assert.equal(env.HOME, process.env.HOME);
      assert.equal(env.PATH, process.env.PATH);
      evidence.runtime.spawnSnapshotFiltered = true;
      runtime = new BoundedRuntime(context);
      return runtime;
    },
    undefined,
    {
      routingClient: null,
      delivery: { fetcher: guard.fetcher() },
      github: { readerFactory: sourceReader, intervalMs: 1000000 },
      power: { enabled: false },
      conversationHistoryExclusions: () => [
        password,
        credential(),
        m.credentialRef,
        m.credentialRef.slice(4),
      ],
    },
  );
  await service.start();
  const identity = await runtime.processIdentity();
  assert.ok(identity);
  evidence.runtime.processes.push(identity);
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  const auth = await OperatorAuth.open({ authFile, origin });
  const routes = new OperatorRouteRegistry();
  routes.registerSlot(
    "coordination",
    coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (project) => service.routingAvailability(project),
    ),
  );
  http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
    routes,
  });
  await http.start(port);
  if (!browser) browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`${origin}/login`);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  save();
}
async function stop() {
  await page?.close();
  await http?.stop();
  const identity = await runtime?.processIdentity();
  await service?.stop();
  if (identity) {
    const result = await new MacProcessTerminationVerifier().verify(identity);
    evidence.cleanup.processes.push({ identity, result: result.kind });
    assert.equal(result.kind, "verified");
  }
  save();
}
async function formMaterial(taskId, selector) {
  await page.goto(`${origin}/coordination/task/${taskId}`);
  return page
    .locator(selector)
    .first()
    .locator("input")
    .evaluateAll((inputs) =>
      Object.fromEntries(inputs.map((input) => [input.name, input.value])),
    );
}
async function post(path, fields) {
  return page.request.post(`${origin}${path}`, {
    headers: { origin },
    form: fields,
    maxRedirects: 0,
  });
}
async function decide(taskId, decision, wrong = false) {
  const fields = await formMaterial(
    taskId,
    `form[action="/coordination/control/approval/decision"]:has(input[name="decision"][value="${decision}"])`,
  );
  if (wrong) fields.materialJson = "{}";
  const response = await post(
    "/coordination/control/approval/decision",
    fields,
  );
  assert.ok(wrong ? response.status() >= 400 : response.status() === 303);
}
function idle(taskId) {
  return qualificationTaskIdle(taskId, service.turnRequests(), service.list());
}
function projectInstructions(j, ids) {
  const target = actionTarget(j),
    register = {
      repositoryId: m.repository.nodeId,
      prNumber: j.pr.number,
      expectedPrNodeId: j.pr.nodeId,
      expectedHeadSha: j.pr.headSha,
    },
    edit = {
      kind: "pr.edit",
      target,
      fields: { title: `S07a approved ${j.mode}` },
    },
    merge = {
      kind: "pr.merge",
      target,
      method: "squash",
      reviewedResultIds: [],
    };
  return `You own only this synthetic GitHub delivery task. No filesystem edits, Git commands, delegation, source/policy configuration, runtime tools, arbitrary URLs or credentials. Use the bound Ensemble tools. Every waiting turn calls ensemble_register_pr with ${JSON.stringify(register)} and ends with a short final message immediately; do not poll within a turn. Do not report_result as task lead. Use reviewedResultIds=[] for this child-free fixture. INITIAL: register the prepared PR, use ensemble_external_action for issue.comment ${JSON.stringify({ operationId: ids.comment, action: { kind: "issue.comment", target: { repositoryId: m.repository.nodeId, nodeId: j.issue.nodeId, number: j.issue.number }, body: "S07a confirmed progress" } })}, issue.labels ${JSON.stringify({ operationId: ids.labels, action: { kind: "issue.labels", target: { repositoryId: m.repository.nodeId, nodeId: j.issue.nodeId, number: j.issue.number }, add: [m.progressLabel], remove: [] } })}, project.field ${JSON.stringify({ operationId: ids.field, action: { kind: "project.field", target: { repositoryId: m.repository.nodeId, nodeId: j.issue.nodeId, number: j.issue.number }, projectNodeId: m.project.nodeId, itemNodeId: j.issue.itemNodeId, fieldNodeId: m.project.fieldNodeId, optionNodeId: m.project.progressOptionId } })}. Mark the PR ready using ${JSON.stringify({ operationId: ids.ready, action: { kind: "pr.ready", target } })} if currently draft. Attempt ${JSON.stringify({ operationId: ids.blockedMerge, action: merge })} once; handback policy denies merge and through-merge's failing s07a-ci holds it. ${j.mode === "reviewable-pr" ? `Then request exact approval with ensemble_request_approval arguments ${JSON.stringify({ action: "pr.edit", target: canonicalMaterial(target), material: edit })}. If denied, request a NEW exact approval for the same edit and end. If approved, submit ${JSON.stringify({ operationId: ids.edit, action: edit })} with the genuine interactionId/current expectedRevision from that approved interaction. Never reuse denial material or invent approval. After confirmed edit, wait. New CI/review feedback: consume and acknowledge the current feedback, re-register and end. Operator accepted/closed handback: request ensemble_request_completion with reviewedResultIds=[] and end.` : `After fresh feedback reports s07a-ci success, submit ${JSON.stringify({ operationId: ids.passingMerge, action: merge })}; do not reuse the permanently held operation. After confirmed merge, end. On the NEXT eligible lead turn with merge/own-closure feedback, request ensemble_request_completion with reviewedResultIds=[] and end.`}`;
}
let stage = "provider-identity";
try {
  const account = z
    .object({ node_id: z.string(), login: z.string() })
    .parse(await provider("/user"));
  assert.equal(account.node_id, m.account.nodeId);
  assert.equal(account.login, m.account.login);
  const repository = z
    .object({
      node_id: z.string(),
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string(),
    })
    .parse(await provider(repoPath));
  assert.equal(repository.node_id, m.repository.nodeId);
  assert.equal(repository.full_name, m.repository.fullName);
  guard.assertRepositoryVisibility(repository.private);
  evidence.provider.repositoryVisibility = repository.private
    ? "private"
    : "public";
  guard.assertDefaultBranch(repository.default_branch);
  for (const j of m.journeys) {
    const pr = z
      .object({
        node_id: z.string(),
        number: z.number(),
        base: z.object({
          ref: z.string(),
          repo: z.object({ node_id: z.string() }),
        }),
        head: z.object({
          ref: z.string(),
          sha: z.string(),
          repo: z.object({ node_id: z.string() }),
        }),
        merged: z.boolean(),
      })
      .parse(await provider(`${repoPath}/pulls/${j.pr.number}`));
    assert.equal(pr.node_id, j.pr.nodeId);
    assert.equal(pr.head.sha, j.pr.headSha);
    assert.equal(pr.head.ref, j.pr.headRef);
    assert.equal(pr.base.ref, m.repository.defaultBranch);
    assert.equal(pr.head.repo.node_id, m.repository.nodeId);
    assert.equal(pr.base.repo.node_id, m.repository.nodeId);
    assert.equal(pr.merged, false);
    assert.equal((await issueSnapshot(j)).state, "open");
    await provider(`${repoPath}/statuses/${j.pr.headSha}`, "POST", {
      context: m.requiredCheck,
      state: "failure",
      description: "S07a required blocking gate",
    });
  }
  stage = "local-policy-seed";
  const owner = StandaloneDataDirectory.openExclusive(data);
  const db = new DatabaseSync(owner.databasePath);
  new Store(db).ensureHost("standalone-codex");
  const domain = new DomainStore(db);
  domain.migrate();
  new GitHubSourceStore(db).migrate();
  for (const j of m.journeys) {
    const ids = Object.fromEntries(
      [
        "comment",
        "labels",
        "field",
        "ready",
        "edit",
        "blockedMerge",
        "passingMerge",
      ].map((k) => [k, randomUUID()]),
    );
    evidence.journeys.push({
      mode: j.mode,
      serviceProjectId: j.serviceProjectId,
      issueNodeId: j.issue.nodeId,
      prNodeId: j.pr.nodeId,
      headSha: j.pr.headSha,
      operationIds: ids,
      taskId: null,
      receipts: [],
      feedback: [],
      restartWaiting: false,
      finalDone: false,
    });
    command(domain, {
      type: "profile.create",
      profileId: j.profileId,
      name: `S07a ${j.mode} lead`,
      instructions:
        "Follow exact project fixture phases using only registered Ensemble tools. End each cooperative waiting turn immediately.",
      capabilities: "GitHub delivery",
    });
    command(domain, {
      type: "project.create",
      projectId: j.serviceProjectId,
      name: `S07a ${j.mode}`,
      leadProfileId: j.profileId,
    });
    command(domain, {
      type: "project.configure",
      projectId: j.serviceProjectId,
      expectedVersion: 1,
      instructions: projectInstructions(j, ids),
    });
    command(domain, {
      type: "delivery.configure",
      projectId: j.serviceProjectId,
      expectedVersion: 1,
      mode: j.mode,
      credentialRef: m.credentialRef,
      grants: m.actions.map((action) => ({
        action,
        repositoryId: m.repository.nodeId,
        mode: action.endsWith(".edit") ? "approval" : "allow",
        ...(action === "project.field"
          ? {
              projectNodeId: m.project.nodeId,
              fieldNodeId: m.project.fieldNodeId,
              optionNodeIds: [m.project.progressOptionId],
            }
          : {}),
      })),
      requiredChecks: [{ name: m.requiredCheck }],
    });
    command(domain, {
      type: "github.configure",
      projectId: j.serviceProjectId,
      expectedVersion: 1,
      credentialRef: m.credentialRef,
      selections: [
        {
          id: j.serviceProjectId,
          kind: "repository",
          repositoryId: m.repository.nodeId,
          owner: "chrisbanes",
          name: "ensemble-s07a-fixture",
        },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: m.readinessLabel }],
      },
      repositories: [],
    });
    command(domain, {
      type: "github.activate",
      projectId: j.serviceProjectId,
      selectionId: j.serviceProjectId,
      expectedVersion: 2,
    });
  }
  db.close();
  owner.close();
  await OperatorAuth.initialize(authFile, password);
  await start();
  for (const j of m.journeys) {
    const item = evidence.journeys.find((item) => item.mode === j.mode),
      taskId = String(service.githubSources().issue(j.issue.nodeId)?.taskId);
    item.taskId = taskId;
    assert.ok(taskId && taskId !== "undefined");
    await service.provisionTask(taskId);
    command(service.domain(), {
      type: "project.configure",
      projectId: j.serviceProjectId,
      expectedVersion: 2,
      paused: false,
    });
    await service.refreshGitHub();
    stage = `${j.mode}-initial`;
    await waitFor(
      () =>
        service.delivery().delivery(taskId) &&
        service
          .delivery()
          .actions(taskId)
          .some((a) => a.operationId === item.operationIds.blockedMerge),
      stage,
    );
    await waitFor(() => idle(taskId), `${stage}-terminal`);
    const held = service.delivery().action(item.operationIds.blockedMerge);
    assert.ok(["denied", "confirmed-failure"].includes(held.state));
    assert.equal(service.delivery().delivery(taskId).observation.merged, false);
    if (j.mode === "reviewable-pr") {
      stage = "handback-exact-approval";
      await waitFor(
        () =>
          service
            .coordinationView()
            .readTask(taskId)
            .approvals.some((a) => a.status === "open"),
        stage,
      );
      await decide(taskId, "approved", true);
      await decide(taskId, "denied");
      await waitFor(
        () =>
          service
            .coordinationView()
            .readTask(taskId)
            .approvals.filter((a) => a.status === "open").length === 1,
        "new-approval-after-denial",
      );
      await waitFor(() => idle(taskId), "approval-waiting-terminal");
      await decide(taskId, "approved");
      await waitFor(
        () =>
          service
            .delivery()
            .actions(taskId)
            .some(
              (a) =>
                a.operationId === item.operationIds.edit &&
                a.state === "confirmed-success",
            ),
        "approved-edit-readback",
      );
      await waitFor(() => idle(taskId), "approved-continuation-terminal");
      const before = service
        .coordinationView()
        .readTask(taskId)
        .messages.filter(
          (message) => message.eventType === "pr-delivery",
        ).length;
      await provider(`${repoPath}/issues/${j.pr.number}/comments`, "POST", {
        body: "S07a feedback: please retain this review observation while s07a-ci is failing.",
      });
      await service.refreshGitHub();
      await waitFor(
        () =>
          service
            .coordinationView()
            .readTask(taskId)
            .messages.filter((message) => message.eventType === "pr-delivery")
            .length > before,
        "new-comment-feedback",
      );
      await waitFor(() => idle(taskId), "feedback-terminal");
      const retained = service.delivery().delivery(taskId);
      assert.equal(service.domain().task(taskId).state, "open");
      await stop();
      await start();
      assert.equal(
        service.delivery().delivery(taskId).observation.nodeId,
        retained.observation.nodeId,
      );
      assert.equal(service.delivery().delivery(taskId).settlement, null);
      item.restartWaiting = true;
      stage = "operator-handback-settlement";
      const fields = await formMaterial(
        taskId,
        'form[action="/coordination/control/delivery/settle"]:has(input[name="decision"][value="accepted"])',
      );
      assert.equal(
        (await post("/coordination/control/delivery/settle", fields)).status(),
        303,
      );
    } else {
      stage = "through-merge-passing-gate";
      await provider(`${repoPath}/statuses/${j.pr.headSha}`, "POST", {
        context: m.requiredCheck,
        state: "success",
        description: "S07a exact-head passing gate",
      });
      await service.refreshGitHub();
      await waitFor(
        () =>
          service
            .delivery()
            .actions(taskId)
            .some(
              (a) =>
                a.operationId === item.operationIds.passingMerge &&
                a.state === "confirmed-success",
            ),
        "merged-readback",
      );
    }
    await waitFor(
      () => service.domain().task(taskId).state === "done",
      `${j.mode}-fresh-completion`,
    );
    assert.equal(
      (await provider(`${repoPath}/pulls/${j.pr.number}`)).merged,
      j.mode === "through-merge",
    );
    if (j.mode === "through-merge") {
      assert.equal((await issueSnapshot(j)).state, "closed");
      assert.equal(service.domain().hasOwnDeliveryClosure(taskId), true);
      const before = service.delivery().actions(taskId);
      await stop();
      await start();
      assert.deepEqual(service.delivery().actions(taskId), before);
      item.restartWaiting = true;
    }
    item.finalDone = true;
    item.receipts = service.delivery().publicTask(taskId).actions;
    item.feedback =
      service.delivery().delivery(taskId).observation.feedback ?? [];
    evidence.results[j.mode === "reviewable-pr" ? "handback" : "throughMerge"] =
      "passed";
    save();
  }
  stage = "cleanup";
  assert.ok(
    service
      .delivery()
      .actions()
      .every((a) => a.state !== "uncertain" && a.state !== "attempting"),
  );
  await stop();
  service = undefined;
  for (const j of m.journeys) {
    if (
      guard.grant.cleanup.closeRecordedPrs &&
      !(await provider(`${repoPath}/pulls/${j.pr.number}`)).merged
    )
      await provider(
        `${repoPath}/pulls/${j.pr.number}`,
        "PATCH",
        { state: "closed" },
        true,
      );
    if (guard.grant.cleanup.closeRecordedIssues)
      await provider(
        `${repoPath}/issues/${j.issue.number}`,
        "PATCH",
        { state: "closed" },
        true,
      );
    if (guard.grant.cleanup.deleteRecordedHeads)
      await provider(
        `${repoPath}/git/refs/heads/${encodeURIComponent(j.pr.headRef)}`,
        "DELETE",
        undefined,
        true,
      );
    assert.equal(
      (await provider(`${repoPath}/pulls/${j.pr.number}`)).state,
      "closed",
    );
    assert.equal((await issueSnapshot(j)).state, "closed");
    evidence.cleanup.remote.push({
      prNodeId: j.pr.nodeId,
      issueNodeId: j.issue.nodeId,
      closed: true,
      headDeleted: guard.grant.cleanup.deleteRecordedHeads,
    });
  }
  evidence.results.cleanup = "passed";
} catch {
  evidence.failure = {
    stage,
    reason:
      "Focused live boundary failed or remained unproved; private transport/runtime detail excluded",
  };
  if (stage.startsWith("handback") || stage.startsWith("operator-handback"))
    evidence.results.handback = "failed";
  else if (stage.startsWith("through-merge"))
    evidence.results.throughMerge = "failed";
  try {
    if (service) await stop();
  } catch {
    evidence.cleanup.processes.push({ result: "unproved" });
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  save();
  process.stdout.write(
    `S07a ${qualificationDisposition(evidence.results)}; retained evidence ${join(root, "evidence.json")}\n`,
  );
}
