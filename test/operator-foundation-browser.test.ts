import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  // #835: the global fallback link is gone; contextual links reach the retained pages.
  assert.equal(
    await desktop
      .getByRole("link", { name: "Existing operator controls", exact: true })
      .count(),
    0,
  );
  await desktop.goto(`${web.origin}/app/projects/${projectId}`);
  await desktop
    .getByRole("link", { name: "Open existing project controls", exact: true })
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
    assert.match(style.family, /Geist/);
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
      const sans = await document.fonts.load('14px "Geist"');
      const mono = await document.fonts.load('14px "Geist Mono"');
      return {
        sans: sans.map((face) => ({
          family: face.family,
          status: face.status,
        })),
        mono: mono.map((face) => ({
          family: face.family,
          status: face.status,
        })),
        sansChecked: document.fonts.check('14px "Geist"'),
        monoChecked: document.fonts.check('14px "Geist Mono"'),
      };
    });
    assert.ok(fontFaces.sans.length > 0, `${path}: Geist face loaded`);
    assert.ok(fontFaces.mono.length > 0, `${path}: Geist Mono face loaded`);
    assert.ok(
      fontFaces.sans.every((face) => face.status === "loaded"),
      path,
    );
    assert.ok(
      fontFaces.mono.every((face) => face.status === "loaded"),
      path,
    );
    assert.equal(fontFaces.sansChecked, true, `${path}: Geist is available`);
    assert.equal(
      fontFaces.monoChecked,
      true,
      `${path}: Geist Mono is available`,
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
      assert.equal(inputStyle.height, "32px");
      assert.match(inputStyle.family, /Geist/);
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
  await phone.locator("main.page h1").waitFor();
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
  await assertPhonePreContained(phone, approvalPre);
  await captureBrowserEvidence(phone, "390-retained-long-approval-material");

  await phone.goto(`${web.origin}/coordination/assignment/${assignmentId}`);
  const historyPre = phone.locator("body.legacy-operator pre").filter({
    hasText: longHistory.slice(0, 30),
  });
  await historyPre.waitFor();
  assert.equal(await historyPre.textContent(), longHistory);
  await assertPhonePreContained(phone, historyPre);
  await captureBrowserEvidence(phone, "390-retained-long-assignment-history");
  await phone.getByRole("link", { name: "New interface", exact: true }).click();
  await phone.locator("main.page h1").waitFor();
  assert.equal(new URL(phone.url()).pathname, "/app");
});

async function assertPhonePreContained(
  page: import("playwright").Page,
  pre: import("playwright").Locator,
) {
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

test("Nova primitives keep 32px controls, the documented radii and tinted destructive tokens", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Nova project",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: randomUUID(),
    title: "Nova task",
    outcome: "Inspect primitives",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks?view=board`);
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator('[data-slot="card"]').first().waitFor();
  // No route renders a destructive control until Stop (U5), so measure the classes the
  // primitives' own destructive variants declare.
  const destructiveClasses = (primitive: string) =>
    /destructive:\s*"([^"]+)"/.exec(
      readFileSync(
        new URL(`../../web/src/ui/${primitive}.tsx`, import.meta.url),
        "utf8",
      ),
    )?.[1] ?? assert.fail(`${primitive} declares no destructive variant`);
  const variants = {
    button: destructiveClasses("button"),
    badge: destructiveClasses("badge"),
  };
  const geometry = await page.evaluate((variants) => {
    const measure = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return { height: style.height, radius: style.borderRadius };
    };
    const primary = document.querySelector('.column-tab[aria-pressed="true"]');
    const outline = document.querySelector('.column-tab[aria-pressed="false"]');
    const tinted = (className: string) => {
      const probe = document.createElement("span");
      probe.className = className;
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = { background: style.backgroundColor, color: style.color };
      probe.remove();
      return result;
    };
    const destructive = {
      button: tinted(variants.button),
      badge: tinted(variants.badge),
    };
    return {
      primary: primary && {
        height: getComputedStyle(primary).height,
        radius: getComputedStyle(primary).borderRadius,
      },
      outline: outline && {
        height: getComputedStyle(outline).height,
        radius: getComputedStyle(outline).borderRadius,
      },
      input: measure('[data-slot="input"]'),
      card: measure('[data-slot="card"]'),
      destructive,
    };
  }, variants);
  assert.deepEqual(geometry.primary, { height: "32px", radius: "10px" });
  assert.deepEqual(geometry.outline, { height: "32px", radius: "10px" });
  assert.deepEqual(geometry.input, { height: "32px", radius: "10px" });
  assert.equal(geometry.card?.radius, "14px");
  const alpha = (value: string) =>
    Number(/,\s*([\d.]+)\)$/.exec(value)?.[1] ?? "1");
  for (const [name, tint] of Object.entries(geometry.destructive)) {
    assert.ok(
      alpha(tint.background) > 0 && alpha(tint.background) < 1,
      `destructive ${name} background is tinted, not solid: ${tint.background}`,
    );
    assert.notEqual(tint.color, tint.background);
  }
  await captureBrowserEvidence(page, "1366-nova-primitives");
});
