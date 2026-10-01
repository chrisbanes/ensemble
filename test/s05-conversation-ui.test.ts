import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Browser, chromium } from "playwright";
import type { Runtime } from "../src/standalone/codex.js";
import {
  type ConversationHistoryBinding,
  ConversationHistoryStore,
} from "../src/standalone/conversation-history.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../src/standalone/operator.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
import { OperatorRouteRegistry } from "../src/standalone/operator-routes.js";
import { StandaloneService } from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

const runtime: Runtime = {
  async start() {},
  async stop() {},
  async startThread() {
    throw new Error("Paused UI fixture must not execute");
  },
  async resumeThread() {},
  async startTurn() {
    throw new Error("Paused UI fixture must not execute");
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
  onUnexpectedRequest() {},
};

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ actor: "operator", key: randomUUID(), ...body } as never);
}

test("assignment UI renders bounded sanitized history, omissions and immutable generations after restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-history-ui-"));
  const dataDir = join(root, "data");
  let currentSecret = "";
  const createService = () =>
    new StandaloneService(dataDir, () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      conversationHistoryExclusions: () =>
        currentSecret ? [currentSecret] : [],
    });
  let service = createService();
  let browser: Browser | undefined;
  let http: LocalOperatorHttp | undefined;
  let auth: OperatorAuth | undefined;
  t.after(async () => {
    await browser?.close();
    await http?.stop();
    auth?.close();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const profileId = randomUUID();
  const projectId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Shared history profile",
    instructions: "PRIVATE_HISTORY_PROFILE_CANARY",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "History UI project",
    leadProfileId: profileId,
  });
  const assignments = Array.from({ length: 2 }, (_, index) => {
    const taskId = randomUUID();
    const assignmentId = randomUUID();
    command(service, {
      type: "task.create",
      projectId,
      taskId,
      title: `History task ${index}`,
      outcome: "Inspect retained history.",
      ready: false,
    });
    command(service, {
      type: "assignment.create",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Inspect history.",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    return { taskId, assignmentId };
  });
  const [first, second] = assignments;
  assert.ok(first && second);
  const binding = (
    taskId: string,
    assignmentId: string,
    generation: number,
  ): ConversationHistoryBinding => ({
    workId: `history-work-${assignmentId}-${generation}`,
    taskId,
    assignmentId,
    assignmentVersion: generation,
    instructionsRevision: generation,
    profileRevision: generation,
    conversationRevision: generation,
    workRevision: generation,
    threadId: `history-thread-${assignmentId}-${generation}`,
    turnId: `history-turn-${assignmentId}-${generation}`,
  });
  const escapedCredentialCanaries = [
    "UI_ESCAPED_VALUE_PREFIX_CANARY",
    "UI_ESCAPED_VALUE_SUFFIX_CANARY",
    "UI_SINGLE_ESCAPED_PREFIX_CANARY",
    "UI_SINGLE_ESCAPED_SUFFIX_CANARY",
  ];
  const db = new DatabaseSync(join(dataDir, "standalone.sqlite"));
  try {
    const history = new ConversationHistoryStore(db);
    const original = binding(first.taskId, first.assignmentId, 1);
    for (let index = 0; index < 202; index += 1) {
      history.record(
        original,
        {
          threadId: original.threadId,
          turnId: original.turnId,
          itemId: `message-${index}`,
          kind: "completed",
          text: `Visible history ${index}`,
        },
        [],
      );
    }
    const newer = binding(first.taskId, first.assignmentId, 2);
    const escapedCredential = [
      JSON.stringify({
        token: 'UI_ESCAPED_VALUE_PREFIX_CANARY"UI_ESCAPED_VALUE_SUFFIX_CANARY',
      }),
      "password='UI_SINGLE_ESCAPED_PREFIX_CANARY\\'UI_SINGLE_ESCAPED_SUFFIX_CANARY'",
    ].join(" ");
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "html-message",
        kind: "completed",
        text: `Safe assistant <script>globalThis.HISTORY_INJECTED = true</script> PRIVATE_HISTORY_PROFILE_CANARY ${dataDir} LATER_PRIVATE_VALUE ${escapedCredential}`,
      },
      ["PRIVATE_HISTORY_PROFILE_CANARY", dataDir],
    );
    const persistedEscapedCredential = db
      .prepare(
        "SELECT text FROM conversation_history_items WHERE workId = ? AND itemId = ?",
      )
      .get(newer.workId, "html-message") as { text: string | null } | undefined;
    assert.ok(persistedEscapedCredential?.text);
    for (const canary of escapedCredentialCanaries)
      assert.ok(!persistedEscapedCredential.text.includes(canary));
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "partial-message",
        kind: "started",
      },
      [],
    );
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "partial-message",
        kind: "delta",
        bytes: 12,
      },
      [],
    );
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "omitted-message",
        kind: "omitted",
        reason: "size-limit",
      },
      [],
    );
    history.recordEarlyBufferLimit(newer);
    const other = binding(second.taskId, second.assignmentId, 1);
    history.record(
      other,
      {
        threadId: other.threadId,
        turnId: other.turnId,
        itemId: "other-message",
        kind: "completed",
        text: "OTHER_TASK_HISTORY_CANARY",
      },
      [],
    );
  } finally {
    db.close();
  }
  currentSecret = "LATER_PRIVATE_VALUE";

  const page = async (assignmentId: string) => {
    const routes = coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (id) => service.routingAvailability(id),
    );
    const read = routes.find(
      (route) =>
        route.method === "GET" &&
        route.path === "/coordination/assignment/:assignmentId",
    );
    assert.ok(read);
    const result = await read.handler({
      params: { assignmentId },
      fields: {},
      csrfToken: "ui-test-token",
    });
    assert.equal(result.kind, "html");
    assert.ok(result.kind === "html");
    return result.body;
  };
  const verify = async () => {
    const read = service
      .coordinationView()
      .readAssignmentHistory(first.assignmentId);
    assert.equal(read.items.length, 200);
    assert.equal(read.omittedItemCount, 5);
    const escapedItem = read.items.find(
      (item) => item.itemId === "html-message",
    );
    assert.equal(escapedItem?.lifecycle, "completed");
    assert.ok(escapedItem?.text);
    for (const canary of escapedCredentialCanaries)
      assert.ok(!escapedItem.text.includes(canary));
    const body = await page(first.assignmentId);
    assert.match(body, /5 older history item\(s\) not shown/);
    assert.match(body, /Safe assistant &lt;script&gt;/);
    assert.doesNotMatch(
      body,
      /<script>|PRIVATE_HISTORY_PROFILE_CANARY|LATER_PRIVATE_VALUE|OTHER_TASK_HISTORY_CANARY/,
    );
    for (const canary of escapedCredentialCanaries)
      assert.ok(!body.includes(canary));
    assert.ok(!body.includes(dataDir));
    assert.match(body, /Conversation revision 1; work revision 1/);
    assert.match(body, /Conversation revision 2; work revision 2/);
    assert.match(body, /History may be incomplete: early-buffer-limit/);
    assert.match(
      body,
      /Partial assistant item; 12 streamed bytes; text not retained/,
    );
    assert.match(body, /Assistant item omitted: size-limit/);
    assert.doesNotMatch(body, /Visible history 0</);
    const otherBody = await page(second.assignmentId);
    assert.match(otherBody, /OTHER_TASK_HISTORY_CANARY/);
    assert.doesNotMatch(otherBody, /Safe assistant|Visible history/);
  };
  await verify();
  await service.stop();
  service = createService();
  await service.start();
  await verify();

  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const authFile = join(root, "history-ui-auth.json");
  const password = "Disposable history UI test password";
  await OperatorAuth.initialize(authFile, password);
  auth = await OperatorAuth.open({ authFile, origin });
  const routes = new OperatorRouteRegistry();
  routes.registerSlot(
    "coordination",
    coordinationOperatorRoutes(
      service.coordinationView(),
      service.domain(),
      (id) => service.routingAvailability(id),
    ),
  );
  http = new LocalOperatorHttp(new LocalOperatorUi(service.domain()), auth, {
    routes,
  });
  await http.start(port);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const browserPage = await context.newPage();
  const historyUrl = `${origin}/coordination/assignment/${first.assignmentId}`;
  await browserPage.goto(historyUrl);
  assert.match(await browserPage.locator("body").innerText(), /Sign in/);
  assert.doesNotMatch(
    await browserPage.locator("body").innerText(),
    /Safe assistant|Visible history/,
  );
  await browserPage.locator('input[name="password"]').fill(password);
  const login = browserPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/login" &&
      response.request().method() === "POST",
  );
  await browserPage.getByRole("button", { name: "Sign in" }).click();
  assert.equal((await login).status(), 303);
  const loaded = await browserPage.goto(historyUrl);
  assert.ok(loaded);
  assert.match(
    loaded.headers()["content-security-policy"] ?? "",
    /default-src 'none'/,
  );
  assert.equal(loaded.headers()["cache-control"], "no-store");
  const authenticatedHistoryText = await browserPage
    .locator("body")
    .innerText();
  assert.match(authenticatedHistoryText, /Safe assistant <script>/);
  assert.equal(await browserPage.locator("script").count(), 0);
  assert.equal(
    await browserPage.evaluate(() =>
      Object.hasOwn(globalThis, "HISTORY_INJECTED"),
    ),
    false,
  );
  assert.doesNotMatch(
    authenticatedHistoryText,
    /PRIVATE_HISTORY_PROFILE_CANARY|LATER_PRIVATE_VALUE|OTHER_TASK_HISTORY_CANARY/,
  );
  for (const canary of escapedCredentialCanaries)
    assert.ok(!authenticatedHistoryText.includes(canary));
  const forged = await context.request.get(historyUrl, {
    headers: {
      host: "attacker.example",
      "x-forwarded-host": `127.0.0.1:${port}`,
    },
    maxRedirects: 0,
  });
  assert.equal(forged.status(), 403);
  assert.doesNotMatch(await forged.text(), /Safe assistant|Visible history/);
  const rejectedMessage = await context.request.post(
    `${origin}/coordination/control/message`,
    {
      headers: { origin },
      form: {
        key: randomUUID(),
        taskId: first.taskId,
        recipientAssignmentId: first.assignmentId,
        expectedAssignmentVersion: "1",
        message: "UNAUTHORIZED_MESSAGE_CANARY",
        csrfToken: "wrong",
      },
      maxRedirects: 0,
    },
  );
  assert.equal(rejectedMessage.status(), 403);
  assert.equal(
    service.coordinationView().readTask(first.taskId).messages.length,
    0,
  );
});
