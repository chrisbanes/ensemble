import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
const test = browserSuite("ui08-legacy");
import { chromium, type Browser } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";

test("retained HTML routes share the production foundation and native interactions", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const domain = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Foundation lead",
    instructions: "Fixture only",
    capabilities: "Coordinate",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Foundation project",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Foundation task",
    outcome: "Inspect retained controls",
    ready: false,
  });
  domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Inspect retained controls",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });

  const approvalWorkId = randomUUID();
  const approvalInteractionId = randomUUID();
  const approvalMaterial = JSON.stringify({
    command: "Publish approved release notes",
    details: "approved material ".repeat(12),
  });
  const longHistory = "retained assistant history ".repeat(12);
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'fixture','fixture','completed',NULL,'fixture-thread','fixture-turn','chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), approvalWorkId);
    db.prepare(
      "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,action,target,materialHash,materialJson,revision) VALUES (?,?,?, ?,1,1,1,'approval','open','Approve release notes','Publish approved release notes','release-42',?, ?,1)",
    ).run(
      approvalInteractionId,
      taskId,
      assignmentId,
      approvalWorkId,
      "a".repeat(64),
      approvalMaterial,
    );
    db.prepare(
      "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES (?, ?, ?,1,1,1,1,1,'fixture-thread','fixture-turn','foundation-long-history','completed',?,NULL,0,1,1)",
    ).run(approvalWorkId, taskId, assignmentId, longHistory);
  });

  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const desktop = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(desktop);
  desktop.setDefaultTimeout(5000);
  const requestedUrls: string[] = [];
  desktop.on("request", (request) => requestedUrls.push(request.url()));
  await desktop.goto(`${web.origin}/app`);
  await desktop.getByLabel("Password", { exact: true }).fill(web.password);
  await desktop.getByRole("button", { name: "Sign in", exact: true }).click();
  await desktop
    .getByRole("button", { name: "Sign out", exact: true })
    .waitFor();
  await desktop
    .getByRole("link", { name: "Existing operator controls", exact: true })
    .click();
  await desktop
    .getByRole("heading", { name: "Ensemble", exact: true })
    .waitFor();
  await desktop
    .getByRole("link", { name: "Foundation project", exact: true })
    .click();
  await desktop
    .getByRole("heading", { name: "Foundation project", exact: true })
    .waitFor();

  const destinations = [
    "/",
    `/project/${projectId}`,
    `/profile/${profileId}`,
    `/task/${taskId}`,
    `/assignment/${assignmentId}`,
    "/runtime",
    `/runtime/task/${taskId}`,
    `/runtime/assignment/${assignmentId}`,
    "/coordination",
    `/coordination/task/${taskId}`,
    `/coordination/assignment/${assignmentId}`,
  ];
  let stylesheetHref = "";
  let verifiedFonts = false;
  for (const path of destinations) {
    await desktop.goto(web.origin + path);
    await desktop.locator("body.legacy-operator").waitFor();
    const style = await desktop.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel="stylesheet"]',
      );
      const body = getComputedStyle(document.body);
      return {
        href: link?.getAttribute("href") ?? "",
        loaded: link?.sheet !== null,
        background: body.backgroundColor,
        foreground: body.color,
        family: body.fontFamily,
        scripts: document.scripts.length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.match(style.href, /^\/assets\/[A-Za-z0-9_.-]+\.css$/);
    assert.equal(style.loaded, true, path);
    assert.equal(style.background, "rgb(10, 10, 10)", path);
    assert.equal(style.foreground, "rgb(250, 250, 250)", path);
    assert.match(style.family, /Inter/);
    assert.equal(style.scripts, 0, "legacy HTML remains non-hydrated");
    assert.equal(style.overflow, false, path);
    if (path === `/coordination/task/${taskId}`) {
      const requester = desktop.getByRole("link", {
        name: "the task-scoped assignment",
        exact: true,
      });
      assert.equal(
        await requester.evaluate(
          (element) => getComputedStyle(element).textDecorationLine,
        ),
        "underline",
      );
    }
    const fontFaces = await desktop.evaluate(async () => {
      const inter = await document.fonts.load('14px "Inter"');
      const mono = await document.fonts.load('14px "JetBrains Mono"');
      return {
        inter: inter.map((face) => ({
          family: face.family,
          status: face.status,
        })),
        mono: mono.map((face) => ({
          family: face.family,
          status: face.status,
        })),
        interChecked: document.fonts.check('14px "Inter"'),
        monoChecked: document.fonts.check('14px "JetBrains Mono"'),
      };
    });
    assert.ok(fontFaces.inter.length > 0, `${path}: Inter face loaded`);
    assert.ok(fontFaces.mono.length > 0, `${path}: JetBrains Mono face loaded`);
    assert.ok(
      fontFaces.inter.every((face) => face.status === "loaded"),
      path,
    );
    assert.ok(
      fontFaces.mono.every((face) => face.status === "loaded"),
      path,
    );
    assert.equal(fontFaces.interChecked, true, `${path}: Inter is available`);
    assert.equal(
      fontFaces.monoChecked,
      true,
      `${path}: JetBrains Mono is available`,
    );
    if (!verifiedFonts) {
      const response = await desktop.request.get(web.origin + path);
      const csp = response.headers()["content-security-policy"] ?? "";
      assert.match(csp, /font-src 'self'/);
      verifiedFonts = true;
    }
    if (stylesheetHref) assert.equal(style.href, stylesheetHref);
    stylesheetHref = style.href;
    if (path === `/project/${projectId}`) {
      const input = desktop
        .locator('body.legacy-operator input:not([type="hidden"])')
        .first();
      const inputStyle = await input.evaluate((el) => ({
        height: getComputedStyle(el).height,
        family: getComputedStyle(el).fontFamily,
      }));
      assert.equal(inputStyle.height, "36px");
      assert.match(inputStyle.family, /Inter/);
      await captureBrowserEvidence(desktop, "1366-retained-project-editor");
    }
  }
  const cssResponse = await desktop.request.get(web.origin + stylesheetHref);
  assert.equal(cssResponse.status(), 200);
  assert.match(cssResponse.headers()["content-type"] ?? "", /text\/css/);
  assert.ok(
    requestedUrls.every((url) => new URL(url).origin === web.origin),
    "retained routes load same-origin assets only",
  );

  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  journey.observe(phone);
  phone.setDefaultTimeout(5000);
  await phone.goto(`${web.origin}/app`);
  await phone.getByLabel("Password", { exact: true }).fill(web.password);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await phone.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await phone.goto(`${web.origin}/runtime`);
  await phone.locator("body.legacy-operator").waitFor();
  const phoneControl = phone
    .locator('body.legacy-operator input:not([type="hidden"])')
    .first();
  assert.equal(
    await phoneControl.evaluate((el) => getComputedStyle(el).height),
    "44px",
  );
  await phoneControl.focus();
  assert.equal(
    await phoneControl.evaluate((el) => el === document.activeElement),
    true,
  );
  await captureBrowserEvidence(phone, "390-retained-runtime-controls");
  await phone.goto(`${web.origin}/coordination/task/${taskId}`);
  const approvalPre = phone
    .locator("body.legacy-operator pre")
    .filter({ hasText: approvalMaterial.slice(0, 30) });
  await approvalPre.waitFor();
  assert.equal(await approvalPre.textContent(), approvalMaterial);
  const approvalForm = phone
    .locator('form[action="/coordination/control/approval/decision"]')
    .filter({ has: phone.locator('input[name="decision"][value="approved"]') })
    .filter({
      has: phone.locator(
        'input[name="action"][value="Publish approved release notes"]',
      ),
    });
  const approvalFields = await approvalForm
    .locator("input[type=hidden]")
    .evaluateAll((inputs) =>
      Object.fromEntries(
        inputs.map((input) => [
          (input as HTMLInputElement).name,
          (input as HTMLInputElement).value,
        ]),
      ),
    );
  assert.equal(approvalFields.taskId, taskId);
  assert.equal(approvalFields.interactionId, approvalInteractionId);
  assert.equal(approvalFields.expectedRevision, "1");
  assert.equal(approvalFields.decision, "approved");
  assert.equal(approvalFields.action, "Publish approved release notes");
  assert.equal(approvalFields.target, "release-42");
  assert.equal(approvalFields.materialJson, approvalMaterial);
  assert.match(approvalFields.key ?? "", /^[0-9a-f-]{36}$/i);
  assert.ok(approvalFields.csrfToken);
  await assertPhonePreContained(approvalPre);
  await captureBrowserEvidence(phone, "390-retained-long-approval-material");

  await phone.goto(`${web.origin}/coordination/assignment/${assignmentId}`);
  const historyPre = phone.locator("body.legacy-operator pre").filter({
    hasText: longHistory.slice(0, 30),
  });
  await historyPre.waitFor();
  assert.equal(await historyPre.textContent(), longHistory);
  await assertPhonePreContained(historyPre);
  await captureBrowserEvidence(phone, "390-retained-long-assignment-history");
  await phone.getByRole("link", { name: "New interface", exact: true }).click();
  await phone.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  assert.equal(new URL(phone.url()).pathname, "/app");
});

async function assertPhonePreContained(pre: import("playwright").Locator) {
  const dimensions = await pre.evaluate((element) => ({
    preWidth: element.getBoundingClientRect().width,
    preScrollWidth: element.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  assert.equal(dimensions.whiteSpace, "pre-wrap");
  assert.ok(dimensions.preWidth <= dimensions.viewportWidth);
  assert.ok(dimensions.preScrollWidth <= dimensions.preWidth + 1);
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth);
}
