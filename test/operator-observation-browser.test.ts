import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedDeliveryCoverage } from "./fixtures/delivery-coverage.js";
const test = browserSuite("ui04-observation");
test("bounded retained provider lists disclose partial coverage on desktop and phone without inferring complete success", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const task = await seedDeliveryCoverage(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${task.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const check = page.getByText(
    "Provider check coverage is partial; 1 additional retained check is omitted. Omitted checks may be pending or failed.",
    { exact: true },
  );
  await check.waitFor();
  assert.equal(await page.getByText("Check 129:", { exact: false }).count(), 0);
  await page
    .getByText(
      "2 retained provider feedback records omitted; feedback coverage is partial.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByText(
      "3 earlier retained delivery actions omitted; action history is partial.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    f.service.delivery().delivery(task.taskId)?.observation.checks.at(-1)
      ?.status,
    "failure",
  );
  await check.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-partial-provider-checks", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-partial-provider-checks", {
    fullPage: false,
  });
  assert.ok(
    f.service
      .delivery()
      .actions(task.taskId)
      .every((a) => a.state === "denied"),
  );
  assert.equal(f.runtime.turns, 0);
});
