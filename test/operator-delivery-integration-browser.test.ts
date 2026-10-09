import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  createReleaseDeliveryFixture,
  until,
} from "./fixtures/s07b-delivery.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
const test = browserSuite("s07b-delivery");

for (const mode of ["reviewable-pr", "through-merge"] as const) {
  test(`${mode} assembled production browser shows exact provider truth and completion on desktop and phone`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createReleaseDeliveryFixture(mode, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    await f.register();
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });
    j.observe(page);
    page.setDefaultTimeout(5000);
    const taskPath = `/app/tasks/${f.taskId}?section=changes`;
    const openTask = async () => {
      await page.goto(web.origin + taskPath);
      await page
        .getByRole("heading", { name: "Release delivery", exact: true })
        .waitFor();
      const data = (
        await new OperatorApi(f.service, [f.directory]).readTask(f.taskId)
      ).data;
      assert.match(
        await page.locator("main .task-workspace header").innerText(),
        new RegExp(data.task.state),
      );
      assert.match(
        await page.locator("main .task-workspace header").innerText(),
        new RegExp(`execution ${data.execution.state}`),
      );
    };
    await page.goto(web.origin + taskPath);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Release delivery", exact: true })
      .waitFor();
    await openTask();
    const changes = page.locator("#changes");
    await changes
      .getByText(
        `PR #7 · org/repo · OPEN · observed head ${f.scripted.state.head}`,
        { exact: true },
      )
      .waitFor();
    await changes
      .getByText(`build: success · head ${f.scripted.state.head}`, {
        exact: true,
      })
      .waitFor();
    assert.equal(f.scripted.state.writes, 0);
    await sharedDestinations(page, web.origin, f.taskId, f.projectId);
    await openTask();
    f.scripted.state.check = "failure";
    await changes
      .getByRole("button", {
        name: "Refresh delivery observation",
        exact: true,
      })
      .click();
    await changes
      .getByText(`build: failure · head ${f.scripted.state.head}`, {
        exact: true,
      })
      .waitFor();
    assert.equal((await f.merge()).success, false);
    assert.equal(f.scripted.state.writes, 0);
    f.scripted.state.feedback = true;
    await changes
      .getByRole("button", {
        name: "Refresh delivery observation",
        exact: true,
      })
      .click();
    await changes
      .getByText("Repair literal feedback C1", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await captureBrowserEvidence(page, `${mode}-phone-feedback-check`);
    await sharedDestinations(page, web.origin, f.taskId, f.projectId);
    await openTask();
    const oldHead = f.scripted.state.head;
    f.scripted.state.head = "3".repeat(40);
    await changes
      .getByRole("button", {
        name: "Refresh delivery observation",
        exact: true,
      })
      .click();
    await changes
      .getByText(
        `PR #7 · org/repo · OPEN · observed head ${f.scripted.state.head}`,
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await changes.getByText(new RegExp(`observed head ${oldHead}`)).count(),
      0,
    );
    f.scripted.state.outage = true;
    await changes
      .getByRole("button", {
        name: "Refresh delivery observation",
        exact: true,
      })
      .click();
    await changes.getByText(/Stale \/ failed read/).waitFor();
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.scripted.state.writes, 0);
    f.scripted.state.outage = false;
    f.scripted.state.check = "success";
    await changes
      .getByRole("button", {
        name: "Refresh delivery observation",
        exact: true,
      })
      .click();
    await changes
      .getByText(`build: success · head ${f.scripted.state.head}`, {
        exact: true,
      })
      .waitFor();
    await f.terminal(1);
    await f.waitTurn(2);
    if (mode === "reviewable-pr") {
      assert.equal((await f.merge()).success, false);
      await page.goto(`${web.origin}/coordination/task/${f.taskId}`);
      const form = page
        .locator('form[action="/coordination/control/delivery/settle"]')
        .first();
      const material = await form
        .locator("input")
        .evaluateAll((inputs) =>
          Object.fromEntries(
            inputs.map((i) => [
              (i as HTMLInputElement).name,
              (i as HTMLInputElement).value,
            ]),
          ),
        );
      const denied = await page.request.post(
        `${web.origin}/coordination/control/delivery/settle`,
        {
          headers: { origin: web.origin },
          form: { ...material, csrfToken: "wrong" },
          maxRedirects: 0,
        },
      );
      assert.equal(denied.status(), 403);
      assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
      f.scripted.state.head = "4".repeat(40);
      const stale = await page.request.post(
        `${web.origin}/coordination/control/delivery/settle`,
        { headers: { origin: web.origin }, form: material, maxRedirects: 0 },
      );
      assert.ok(stale.status() >= 400);
      assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
      await page.reload();
      await form.locator('button[type="submit"]').first().click();
      await until(
        () =>
          f.service.delivery().delivery(f.taskId)?.settlement?.decision ===
          "accepted",
        "authenticated settlement",
      );
      assert.equal(f.scripted.state.writes, 0);
    } else {
      const merged = await f.merge();
      assert.equal(merged.success, true, merged.text);
      assert.equal(f.scripted.state.writes, 1);
      await openTask();
      await changes
        .getByText(
          "PR merged; task completion still requires its recorded completion workflow.",
          { exact: true },
        )
        .waitFor();
      assert.equal(f.service.domain().task(f.taskId).state, "open");
    }
    await f.terminal(2);
    await f.waitTurn(3);
    const completion = await f.call(
      "ensemble_request_completion",
      { reviewedResultIds: [] },
      3,
    );
    assert.equal(completion.success, true, completion.text);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    await f.terminal(3);
    await until(
      () => f.service.domain().task(f.taskId).state === "done",
      "browser Done",
    );
    await openTask();
    const persisted = f.readDb(
      (db) =>
        db
          .prepare("SELECT state FROM domain_tasks WHERE id=?")
          .get(f.taskId) as { state: string },
    );
    assert.equal(persisted.state, "done");
    await captureBrowserEvidence(page, `${mode}-phone-done`);
    await page.setViewportSize({ width: 1366, height: 900 });
    await sharedDestinations(page, web.origin, f.taskId, f.projectId, true);
    await openTask();
    await captureBrowserEvidence(page, `${mode}-desktop-done`);
    await browser.close();
    browser = undefined;
    await web.close();
    const writes = f.scripted.state.writes;
    await f.reopen();
    const reopenedWeb = await j.start("fixture.reopened-web", () =>
      f.startWeb(),
    );
    browser = await j.start("browser.reopened", () => chromium.launch());
    const reopened = await browser.newPage();
    j.observe(reopened);
    await reopened.goto(reopenedWeb.origin + taskPath);
    await reopened.getByLabel("Password").fill(reopenedWeb.password);
    await reopened
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await reopened
      .getByRole("heading", { name: "Release delivery", exact: true })
      .waitFor();
    assert.match(
      await reopened.locator("main .task-workspace header").innerText(),
      /done/,
    );
    assert.equal(f.scripted.state.writes, writes);
    assert.equal(f.runtime.turns, 0);
  });
}

async function sharedDestinations(
  page: Page,
  origin: string,
  taskId: string,
  projectId: string,
  done = false,
) {
  for (const route of ["/app", "/app/tasks", `/app/projects/${projectId}`]) {
    await page.goto(origin + route);
    if (done)
      await page.getByLabel("State", { exact: true }).selectOption("Done");
    const task = page.locator(`[data-task-id="${taskId}"]`).first();
    await task
      .getByRole("link", { name: "Release delivery", exact: true })
      .waitFor();
    assert.match(await task.innerText(), /GitHub org\/repo #1/);
    if (done) assert.match(await task.innerText(), /Done/);
    if (route !== "/app") {
      await page.getByRole("button", { name: "Board", exact: true }).click();
      const status = await page
        .getByRole("toolbar", { name: "Board columns" })
        .getByRole("button")
        .filter({ hasText: /\(1\)/ })
        .first()
        .innerText();
      await page
        .getByRole("toolbar", { name: "Board columns" })
        .getByRole("button", { name: status, exact: true })
        .click();
      try {
        await task
          .getByRole("link", { name: "Release delivery", exact: true })
          .waitFor();
      } catch (error) {
        throw new Error(
          `Board assertion ${route}; DOM: ${(await page.locator("body").innerText()).slice(0, 5000)}`,
          { cause: error },
        );
      }
      assert.match(await task.innerText(), /GitHub source:/);
    }
    await task
      .getByRole("link", { name: "Release delivery", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Release delivery", exact: true })
      .waitFor();
  }
  await page.goto(origin + "/app/inbox");
  // Routine delivery progress never invents an actionable request.
  assert.equal(
    await page.getByText("Repair literal feedback C1", { exact: true }).count(),
    0,
  );
}

test("uncertain effect and independent Stop remain visible after restart; expired session retains composer input without an effect", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createReleaseDeliveryFixture("through-merge", j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  await f.register();
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${f.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Release delivery", exact: true })
    .waitFor();
  await page.goto(`${web.origin}/app/tasks/new?project=${f.projectId}`);
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Retain the exact composer input");
  await page
    .getByLabel("Desired outcome", { exact: true })
    .fill("Retain the supplied outcome");
  const tasksBefore = f.service.domain().tasks(f.projectId).length;
  f.advanceClock(61_000);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  assert.equal(f.scripted.state.writes, 0);
  assert.equal(f.service.domain().tasks(f.projectId).length, tasksBefore);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Retain the exact composer input",
  );
  assert.equal(
    await page.getByLabel("Desired outcome", { exact: true }).inputValue(),
    "Retain the supplied outcome",
  );
  f.scripted.state.unknownEffect = true;
  assert.equal((await f.merge()).success, false);
  await page.goto(`${web.origin}/app/tasks/${f.taskId}?section=changes`);
  await page
    .locator("#changes")
    .getByText(/pr.merge: uncertain/)
    .waitFor();
  assert.equal(f.scripted.state.writes, 1);
  await captureBrowserEvidence(page, "phone-uncertain-effect");
  await page.goto(`${web.origin}/runtime/task/${f.taskId}`);
  await page
    .getByRole("button", { name: "Best-effort Stop", exact: true })
    .click();
  await until(
    () => !f.service.list().some((i) => i.state === "running"),
    "Stop observed",
  );
  await browser.close();
  browser = undefined;
  await web.close();
  await f.reopen();
  const restarted = await j.start("fixture.reopened-web", () => f.startWeb());
  browser = await j.start("browser.reopened", () => chromium.launch());
  page = await browser.newPage();
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${restarted.origin}/app/tasks/${f.taskId}?section=changes`);
  await page.getByLabel("Password").fill(restarted.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator("#changes")
    .getByText(/pr.merge: uncertain/)
    .waitFor();
  await page
    .getByText("task hold — use exact recovery controls", { exact: true })
    .waitFor();
  assert.equal(f.runtime.turns, 0);
  assert.equal(f.scripted.state.writes, 1);
  assert.equal(f.service.domain().task(f.taskId).state, "open");
  await captureBrowserEvidence(page, "desktop-restarted-stop-uncertainty");
});
