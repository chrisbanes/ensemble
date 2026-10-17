import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { FakePushService, ManualPushClock } from "../fixtures/fake-push.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { signIn } from "../fixtures/operator-settings.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { exhaustibleRuntime } from "../fixtures/runtime-exhaustion.js";

const test = browserSuite("operator-notifications");

/**
 * Stands in for the browser's push service only: `PushManager.subscribe` and `getSubscription`.
 * The page, its service worker registration and the permission flow are real. The subscription
 * keeps real P-256 keys, held by the test, in sessionStorage so a reload still sees it.
 */
const pushStub = (device: {
  endpoint: string;
  p256dh: string;
  auth: string;
}) => {
  const bytes = (b64: string) =>
    Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ).buffer;
  const subscription = (key: ArrayBuffer) => ({
    endpoint: device.endpoint,
    options: { applicationServerKey: key },
    toJSON: () => ({
      endpoint: device.endpoint,
      keys: { p256dh: device.p256dh, auth: device.auth },
    }),
    unsubscribe: async () => {
      sessionStorage.removeItem("fake-push-key");
      sessionStorage.setItem(
        "fake-push-unsubscribed",
        String(
          Number(sessionStorage.getItem("fake-push-unsubscribed") ?? 0) + 1,
        ),
      );
      return true;
    },
  });
  const encode = (key: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(key)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  // Headless Chromium reports "denied" however the context is granted; the stub grants.
  Object.defineProperty(Notification, "permission", { get: () => "granted" });
  Notification.requestPermission = async () => "granted";
  PushManager.prototype.getSubscription = async () => {
    const stored = sessionStorage.getItem("fake-push-key");
    return stored ? (subscription(bytes(stored)) as never) : null;
  };
  PushManager.prototype.subscribe = async (options) => {
    const key = options?.applicationServerKey as ArrayBuffer | Uint8Array;
    const buffer = key instanceof Uint8Array ? key.slice().buffer : key;
    sessionStorage.setItem("fake-push-key", encode(buffer as ArrayBuffer));
    return subscription(buffer as ArrayBuffer) as never;
  };
};

async function start(journey: BrowserJourney) {
  const exhaustion = exhaustibleRuntime();
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      undefined,
      journey.fixtureOptions,
      exhaustion.factory,
      exhaustion.serviceOptions,
    ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const fake = new FakePushService();
  const clock = new ManualPushClock();
  const web = await journey.start("fixture.web", () =>
    f.startWeb(undefined, undefined, { transport: fake.transport, clock }),
  );
  const push = web.push;
  browser = await journey.start("browser.launch", () => chromium.launch());
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  await context.grantPermissions(["notifications"], { origin: web.origin });
  const device = fake.device("This browser");
  await context.addInitScript(pushStub, {
    endpoint: device.endpoint,
    p256dh: device.keys.p256dh,
    auth: device.keys.auth,
  });
  const page = await context.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  return { f, fake, push, web, page, device, exhaustion, context };
}

const section = (page: Page) =>
  page.locator("section.settings-panel").filter({
    has: page.getByRole("heading", { name: "Notifications", level: 2 }),
  });

/** A row's state badge, apart from a fact with the same word. */
const badge = (row: Locator, text: string) =>
  row.locator("[data-slot=badge]", { hasText: text });

/** The sign-in form at the current address, signed in again. */
async function signInAgain(page: Page, password: string) {
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("notifications: turn on, test, deep links through sign-in, turn off and revoke", async (_t, journey) => {
  const { f, fake, push, web, page, device, exhaustion, context } =
    await start(journey);
  await signIn(page, web, "/app/settings#notifications");
  const panel = section(page);
  await panel.waitFor();

  // 1. Off, with the trigger copy including the runtime line.
  await panel.getByRole("button", { name: "Turn on notifications" }).waitFor();
  const copy = await panel.innerText();
  for (const line of [
    "Kind, project and waiting count, or which runtime is unavailable, with a link. No question text, task content or error details.",
    "A new question, approval, problem or runtime whose restarts ran out.",
    "No browsers receive notifications.",
  ])
    assert.ok(copy.includes(line), line);
  assert.equal(push.read().subscriptions.length, 0);
  assert.equal(
    await page.evaluate(
      async () =>
        (await navigator.serviceWorker.getRegistration("/app/")) ?? null,
    ),
    null,
    "nothing is registered before the operator asks",
  );

  // 2. Turn on: the worker is registered at /app/, the server lists one Active row for this
  // browser and the subscription used the served key.
  await panel.getByRole("button", { name: "Turn on notifications" }).click();
  await panel.getByText("Notifications are on in this browser").waitFor();
  assert.equal(
    await page.evaluate(
      async () =>
        (await navigator.serviceWorker.getRegistration("/app/"))?.scope,
    ),
    `${web.origin}/app/`,
  );
  const rows = push.read().subscriptions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "active");
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("fake-push-key")),
    push.read().publicKey,
    "the stub saw the served application server key",
  );
  const mine = panel.getByRole("listitem").filter({ hasText: "This browser" });
  await mine.getByText("Active").waitFor();
  assert.match(await mine.innerText(), /Chrome/);
  assert.match(await mine.innerText(), /fcm\.googleapis\.com/);
  assert.equal(await mine.getByRole("button", { name: /Revoke/ }).count(), 0);
  // Focus moved to the next control, not lost with the one that was pressed.
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Send test notification",
  );
  await push.tick(); // the baseline: what the Inbox holds now is not announced

  // 3. A test notification reaches the fake push service with the test payload.
  await panel.getByRole("button", { name: "Send test notification" }).click();
  await panel.getByText("Test notification sent.").waitFor();
  assert.deepEqual(fake.payloads(device), [
    {
      v: 1,
      title: "Test notification from Ensemble",
      url: "/app/settings#notifications",
      tag: "test:notification",
    },
  ]);

  // 4. A new question is one push whose link is the exact Inbox selection.
  const q = await seedOwnQuestion(f);
  await push.tick();
  await push.settle();
  const sent = fake.payloads(device);
  assert.equal(sent.length, 2);
  const link = sent[1].url as string;
  assert.equal(link, `/app/inbox?task=${q.taskId}&request=${q.interactionId}`);
  assert.match(sent[1].title, /^Question in .+: 1 waiting$/);

  // 5. That address selects the request.
  await page.goto(web.origin + link);
  const detail = page.getByRole("region", { name: "Selected request" });
  await detail.waitFor();
  assert.ok(
    (await detail.innerText()).includes("Explain"),
    "the question's form is shown",
  );
  assert.equal(
    new URL(page.url()).searchParams.get("request"),
    q.interactionId,
  );

  // 6. Signed out, the same address asks for sign-in and returns to the same selection.
  await context.clearCookies();
  await page.goto(web.origin + link);
  await page.getByLabel("Password").waitFor();
  assert.equal(page.url(), web.origin + link);
  await signInAgain(page, web.password);
  await page.getByRole("region", { name: "Selected request" }).waitFor();
  assert.equal(page.url(), web.origin + link);
  assert.ok(
    (
      await page.getByRole("region", { name: "Selected request" }).innerText()
    ).includes("Explain"),
  );

  // 7. An exhausted runtime is one push to its own link, opened after sign-in.
  await exhaustion.exhaust(f.runtime);
  await push.tick();
  await push.settle();
  const after = fake.payloads(device);
  assert.equal(after.length, 3);
  assert.equal(after[2].title, "Codex runtime unavailable");
  assert.equal(after[2].url, "/app/inbox?request=runtime%3Acodex");
  await context.clearCookies();
  await page.goto(web.origin + after[2].url);
  await page.getByLabel("Password").waitFor();
  await signInAgain(page, web.password);
  const runtimeDetail = page.getByRole("region", { name: "Selected request" });
  await runtimeDetail
    .getByRole("heading", { name: "Codex runtime unavailable" })
    .waitFor();
  await runtimeDetail
    .getByRole("link", { name: "Open runtime settings" })
    .waitFor();
  await push.tick();
  assert.equal(
    fake.payloads(device).length,
    3,
    "an unchanged runtime is not announced again",
  );

  // 8. Turn off: the row reads Revoked, the browser unsubscribed and nothing more is sent.
  await page.goto(`${web.origin}/app/settings#notifications`);
  await section(page)
    .getByRole("button", { name: "Turn off for this browser" })
    .click();
  await section(page)
    .getByRole("button", { name: "Turn on notifications" })
    .waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("fake-push-unsubscribed")),
    "1",
  );
  const revoked = section(page).getByRole("listitem").first();
  await badge(revoked, "Revoked").waitFor();
  assert.equal(push.read().subscriptions[0]?.state, "revoked");
  const total = fake.requests.length;
  // The runtime recovers and fails again: a new alert that must still reach no one.
  exhaustion.gate.failStarts = false;
  await f.service.configureRuntime({
    key: randomUUID(),
    harness: "codex",
    enabled: true,
  });
  exhaustion.clock.advance(60_000);
  await exhaustion.exhaust(f.runtime);
  await push.tick();
  await push.settle();
  assert.equal(
    fake.requests.length,
    total,
    "a revoked browser receives nothing",
  );

  // 9. Another device is revoked from its row, after a confirmation.
  const other = fake.device("Work phone", "web.push.apple.com");
  push.subscribe({
    endpoint: other.endpoint,
    keys: other.keys,
    label: "Work phone",
  });
  await page.reload();
  const panelAgain = section(page);
  await panelAgain.getByRole("button", { name: "Revoke Work phone" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke Work phone?" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Revoke device" }).click();
  await dialog.waitFor({ state: "detached" });
  const phoneRow = panelAgain
    .getByRole("listitem")
    .filter({ hasText: "Work phone" });
  await badge(phoneRow, "Revoked").waitFor();
  assert.equal(await phoneRow.getByRole("button").count(), 0);

  // 10. On a phone the section keeps 44 px controls.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${web.origin}/app/settings#notifications`);
  const turnOn = section(page).getByRole("button", {
    name: "Turn on notifications",
  });
  await turnOn.waitFor();
  const box = await turnOn.boundingBox();
  assert.ok(box && box.height >= 44, `Turn on is ${box?.height}px tall`);
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
    "no horizontal overflow",
  );
});
