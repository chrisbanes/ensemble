import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { tmpdir } from "./temp.js";
const evidence = join(tmpdir(), `ensemble-ui03-evidence-${process.pid}`);
async function screenshot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    fullPage: true,
  });
}
async function signIn(
  page: Page,
  origin: string,
  password: string,
  path = "/app/tasks",
) {
  await page.goto(origin + path);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
test("List and Board preserve identical filtered task IDs and never submit commands", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const d = f.service.domain(),
    projectId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Readable project",
    leadProfileId: null,
  });
  const ids = [randomUUID(), randomUUID()];
  for (const [i, taskId] of ids.entries())
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title: i ? "Other task" : "Literal <script>malicious()</script>",
      outcome: "Work",
      ready: false,
    });
  const web = await f.startWeb(),
    browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password);
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts++;
  });
  await page.getByLabel("Search tasks").fill("Literal");
  const links = () =>
    page
      .locator("[data-task-id]")
      .evaluateAll((els) =>
        els.map((e) => ({
          id: e.getAttribute("data-task-id"),
          href: e.querySelector("a")?.getAttribute("href"),
        })),
      );
  const list = await links();
  assert.deepEqual(list, [{ id: ids[0], href: `/task/${ids[0]}` }]);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.deepEqual(await links(), list);
  assert.ok(page.url().includes("q=Literal"));
  await page.reload();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Search tasks").inputValue(), "Literal");
  assert.deepEqual(await links(), list);
  await screenshot(page, "1366-filtered-board");
  assert.equal(posts, 0);
});
