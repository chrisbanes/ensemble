import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
const test = browserSuite("ui04-comments");
test("approval-mode exact operator review and unknown remote comment retain original intent through viewing and provider read reconciliation", async (_t, j) => {
  const issue = {
    providerInstance: "github.com" as const,
    nodeId: "I1",
    repositoryId: "R1",
    repositoryName: "org/repo",
    number: 1,
    title: "Imported comment task",
    body: "Supplied GitHub brief",
    state: "open" as const,
    labels: ["ready"],
    projectFields: [],
  };
  let effects = 0,
    settled = false;
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      () => ({
        async readSelection() {
          return { complete: true, issues: [issue], reason: null };
        },
        async readBlockers() {
          return { complete: true, blockers: [], reason: null };
        },
        async readIssueStatus() {
          return { status: "open" };
        },
      }),
      {
        providerFactory: () => ({
          async preflight() {
            return { nodeId: "I1" };
          },
          async performAction() {
            effects++;
            return {
              state: "uncertain",
              reason: "response-lost",
              receipt: null,
            };
          },
          async inspectAction() {
            return settled
              ? {
                  state: "confirmed-success",
                  reason: null,
                  receipt: { nodeId: "C1" },
                }
              : { state: "uncertain", reason: "unproved", receipt: null };
          },
          async inspectPr() {
            throw Error("No PR in fixture");
          },
        }),
      },
      j.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Accountable lead",
    instructions: "Coordinate",
    capabilities: "review",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Comment project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_SOURCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  await f.service.refreshGitHub();
  const taskId = String(f.service.githubSources().issue("I1")?.taskId);
  d.ensureLeadAssignment(taskId);
  await f.service.provisionTask(taskId);
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "approval" }],
    requiredChecks: [],
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Post GitHub comment", exact: true })
    .click();
  await page.getByLabel("Editable reply").fill("Exact operator comment body");
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isEnabled(),
    false,
  );
  await page
    .getByRole("button", { name: "Review exact GitHub comment", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Exact operator comment review",
      exact: true,
    })
    .waitFor();
  assert.equal(effects, 0);
  await captureBrowserEvidence(page, "1366-exact-comment-review");
  await page
    .getByRole("button", { name: "Confirm exact comment", exact: true })
    .click();
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await page.getByText(/uncertain: response-lost/).waitFor();
  assert.equal(effects, 1);
  const operation = f.service.delivery().actions()[0];
  assert.ok(operation);
  assert.ok("actor" in operation.binding);
  assert.equal(operation.binding.actor, "operator");
  await page
    .getByRole("button", { name: "Set viewing reference", exact: true })
    .click();
  await page
    .getByText("Observation / review receipt recorded", { exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("button", {
        name: "Reconcile original operation",
        exact: true,
      })
      .isEnabled(),
  );
  settled = true;
  await page
    .getByRole("button", { name: "Refresh delivery observation", exact: true })
    .click();
  await page.getByText(/issue.comment: confirmed-success/).waitFor();
  assert.equal(effects, 1);
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact operator comment body",
  );
  await page
    .getByRole("button", { name: "Reconcile original operation", exact: true })
    .click();
  await page
    .getByText(/confirmed-success: provider receipt recorded/)
    .waitFor();
  assert.equal(effects, 1);
  assert.equal(f.service.delivery().actions().length, 1);
  assert.equal(
    f.service.delivery().actions()[0]?.operationId,
    operation.operationId,
  );
  assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
});
