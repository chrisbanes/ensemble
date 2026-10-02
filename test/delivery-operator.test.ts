import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import { LocalOperatorUi } from "../src/standalone/operator.js";

test("operator policy form exposes current version and grants without credential reference names", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID();
  try {
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "P",
      leadProfileId: null,
    });
    const ui = new LocalOperatorUi(domain);
    assert.match(ui.project(projectId), /data-command="delivery.configure"/);
    await ui.submit({
      type: "delivery.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: "1",
      mode: "reviewable-pr",
      credentialRef: "env:PRIVATE_DELIVERY_KEY",
      grants:
        '[{"action":"issue.comment","repositoryId":"R1","mode":"approval"}]',
      requiredChecks: "[]",
    });
    assert.doesNotMatch(ui.project(projectId), /PRIVATE_DELIVERY_KEY/);
    assert.match(ui.project(projectId), /Credential reference configured/);
  } finally {
    db.close();
  }
});

import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { browserSuite } from "./fixtures/browser-diagnostics.js";
const browserTest = browserSuite("delivery");
import { deliveryFixture } from "./delivery-fixture.js";
import { OperatorAuth } from "../src/standalone/operator-auth.js";
import { LocalOperatorHttp } from "../src/standalone/operator.js";
import { OperatorRouteRegistry } from "../src/standalone/operator-routes.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";

browserTest(
  "authenticated Chromium settlement rejects an externally changed head and escapes feedback",
  async (_t, journey) => {
    const f = await journey.start("fixture.start", () => deliveryFixture());
    let http: LocalOperatorHttp | undefined;
    const server = createServer();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let auth: OperatorAuth | undefined;
    journey.ownLocal({
      browser: async () => {
        await browser?.close();
      },
      listeners: [
        {
          name: "http.stop",
          close: async () => {
            await http?.stop();
          },
        },
        {
          name: "probe.close",
          close: async () => {
            if (server.listening)
              await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
          },
        },
      ],
      auth: () => auth?.close(),
      state: () => f.close(),
    });
    assert.equal(
      (
        await f.call("ensemble_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
        })
      ).success,
      true,
    );
    await journey.start(
      "probe.listen",
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        }),
    );
    const port = (server.address() as AddressInfo).port;
    await journey.closeStep(
      "probe.close",
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const origin = `http://127.0.0.1:${port}`,
      authFile = join(f.root, "operator-auth.json");
    await journey.start("auth.initialize", () =>
      OperatorAuth.initialize(authFile, "delivery browser password"),
    );
    auth = await journey.start("auth.open", () =>
      OperatorAuth.open({ authFile, origin }),
    );
    const routes = new OperatorRouteRegistry();
    routes.registerSlot(
      "coordination",
      coordinationOperatorRoutes(
        f.service.coordinationView(),
        f.domain,
        f.service.routingAvailability.bind(f.service),
      ),
    );
    http = new LocalOperatorHttp(new LocalOperatorUi(f.domain), auth, {
      routes,
    });
    await journey.start("http.start", http.start.bind(http, port));
    browser = await journey.start("browser.launch", () =>
      chromium.launch({ headless: true }),
    );
    const context = await browser.newContext(),
      page = await context.newPage();
    journey.observe(page);
    const taskPath = `/coordination/task/${f.taskId}`;
    const unauth = await context.request.post(
      `${origin}/coordination/control/delivery/settle`,
      { headers: { origin }, form: { taskId: f.taskId } },
    );
    assert.ok(unauth.status() >= 400);
    await page.goto(`${origin}/login`);
    await page
      .locator('input[name="password"]')
      .fill("delivery browser password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto(`${origin}${taskPath}`);
    const form = page
      .locator('form[action="/coordination/control/delivery/settle"]')
      .first();
    const material = await form
      .locator("input")
      .evaluateAll((inputs) =>
        Object.fromEntries(
          inputs.map((input) => [
            (input as HTMLInputElement).name,
            (input as HTMLInputElement).value,
          ]),
        ),
      );
    for (const headers of [{ origin: "https://attacker.example" }, {}]) {
      const response = await context.request.post(
        `${origin}/coordination/control/delivery/settle`,
        { headers, form: material, maxRedirects: 0 },
      );
      assert.equal(response.status(), 403);
    }
    const badCsrf = await context.request.post(
      `${origin}/coordination/control/delivery/settle`,
      {
        headers: { origin },
        form: { ...material, csrfToken: "wrong" },
        maxRedirects: 0,
      },
    );
    assert.equal(badCsrf.status(), 403);
    f.setPr({
      ...f.getPr(),
      headSha: "3".repeat(40),
      feedback: [
        {
          kind: "comment",
          nodeId: "C1",
          author: "U1",
          updatedAt: "2026-10-01T12:00:00Z",
          state: "COMMENTED",
          body: "<script>hostile()</script>",
          commitSha: null,
        },
      ],
    });
    const changed = await context.request.post(
      `${origin}/coordination/control/delivery/settle`,
      { headers: { origin }, form: material, maxRedirects: 0 },
    );
    assert.ok(changed.status() >= 400);
    assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
    assert.equal(f.domain.task(f.taskId).state, "open");
    await page.goto(`${origin}${taskPath}`);
    assert.match(
      await page.locator("body").innerText(),
      /3333333333333333333333333333333333333333/,
    );
    assert.equal(
      await page.locator("script").filter({ hasText: "hostile" }).count(),
      0,
    );
    assert.match(
      await page.locator("body").innerText(),
      /<script>hostile\(\)<\/script>/,
    );
    const fresh = await page
      .locator('form[action="/coordination/control/delivery/settle"]')
      .first()
      .locator("input")
      .evaluateAll((inputs) =>
        Object.fromEntries(
          inputs.map((input) => [
            (input as HTMLInputElement).name,
            (input as HTMLInputElement).value,
          ]),
        ),
      );
    f.failReads(true);
    const outage = await context.request.post(
      `${origin}/coordination/control/delivery/settle`,
      { headers: { origin }, form: fresh, maxRedirects: 0 },
    );
    assert.ok(outage.status() >= 400);
    assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
  },
);
