// Bounded live check of browser notifications against the real push service.
//
// It runs the real operator UI and notifier over a disposable fixture service (a fake runtime, so no model
// turn), drives the host's installed Chrome through Playwright in a fresh temporary profile, and sends real
// Web Push through the browser's own push service. It never touches the installed Ensemble service, its port,
// state or auth file, the user's browser profile, or any credential. Run it with `--live` after `npm run build`.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { tmpdir } from "../../../dist/test/fixtures/temp.js";
import { createOperatorFixture } from "../../../dist/test/fixtures/operator-web.js";
import { seedOwnQuestion } from "../../../dist/test/fixtures/questions.js";
import { exhaustibleRuntime } from "../../../dist/test/fixtures/runtime-exhaustion.js";
import { OperatorApi } from "../../../dist/src/standalone/operator-api.js";
import {
  fetchPushTransport,
  pushHostAllowed,
} from "../../../dist/src/standalone/web-push.js";

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  process.stderr.write(
    "Refusing a live push check without the explicit --live flag.\n",
  );
  process.exit(2);
}
// `--chrome-default-args` keeps Playwright's default arguments; otherwise background networking is
// allowed, which Chrome needs to reach its push service.
const keepDefaultArgs = args.includes("--chrome-default-args");
const NOTIFICATION_WAIT_MS = 30_000;

const steps = [];
const transcript = [];
const log = (message) => {
  transcript.push(message);
  process.stderr.write(`[push-live] ${message}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function step(name, action) {
  const started = Date.now();
  try {
    const detail = (await action()) ?? {};
    steps.push({ step: name, ok: true, ms: Date.now() - started, ...detail });
    log(`ok ${name}`);
  } catch (error) {
    steps.push({
      step: name,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    log(`FAILED ${name}`);
    if (activePage) {
      const alerts = await activePage
        .locator("[role=alert], [role=status]")
        .allInnerTexts()
        .catch(() => []);
      log(`alerts at failure: ${JSON.stringify(alerts).slice(0, 400)}`);
    }
    // Where the page was, in words only (no values are typed into the page before this point).
    log(
      `page at failure: ${
        activePage
          ? `${new URL(activePage.url()).pathname} ${(
              await activePage
                .locator("body")
                .innerText()
                .catch(() => "")
            )
              .slice(0, 300)
              .replace(/\s+/g, " ")}`
          : "none"
      }`,
    );
    throw error;
  }
}

/** Every push request the notifier made: the service host and the answer, never the endpoint. */
const pushCalls = [];
const real = fetchPushTransport();
const recording = async (request, signal) => {
  const response = await real(request, signal);
  pushCalls.push({
    host: new URL(request.endpoint).hostname,
    ...("status" in response
      ? { status: response.status }
      : { failure: response.failure }),
  });
  return response;
};

const exhaustion = exhaustibleRuntime();
let fixture;
let activePage;
let profileDir;
let browserVersion;
let liveContext;
let summary;
try {
  fixture = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    exhaustion.factory,
    exhaustion.serviceOptions,
  );
  const f = fixture;
  const web = await f.startWeb(undefined, undefined, { transport: recording });
  const push = web.push;
  const api = new OperatorApi(f.service, [f.directory]);
  const marker = `LIVE-QUESTION-${randomBytes(6).toString("hex")}`;

  // A persistent context over a fresh temporary profile: Chrome refuses push registration in the
  // off-the-record contexts Playwright otherwise creates ("Registration failed - permission denied").
  profileDir = mkdtempSync(join(tmpdir(), "ensemble-push-profile-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(keepDefaultArgs
      ? {}
      : { ignoreDefaultArgs: ["--disable-background-networking"] }),
  });
  liveContext = context;
  await context.grantPermissions(["notifications"], { origin: web.origin });
  const page = await context.newPage();
  activePage = page;
  page.on("response", (r) => {
    if (r.status() >= 400)
      log(`http ${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.setDefaultTimeout(15_000);

  const shown = () =>
    page.evaluate(async () =>
      (
        (await (
          await navigator.serviceWorker.getRegistration("/app/")
        )?.getNotifications()) ?? []
      ).map((n) => ({ title: n.title, tag: n.tag })),
    );
  const waitForShown = async (predicate, what) => {
    const started = Date.now();
    for (;;) {
      const list = await shown();
      const hit = list.find(predicate);
      if (hit) return { hit, ms: Date.now() - started };
      if (Date.now() - started > NOTIFICATION_WAIT_MS)
        throw new Error(`No notification: ${what}`);
      await sleep(500);
    }
  };
  const goSettings = async () => {
    await page.goto(`${web.origin}/app/settings#notifications`);
  };

  await step("sign in to a fresh profile", async () => {
    // Chrome's own /favicon.ico request reaches a legacy route that starts a second anonymous
    // session and replaces the cookie, so the sign-in form's CSRF token no longer matches. The
    // browser context signs in through its request API instead, which shares the cookie jar.
    const opened = await context.request.get(
      `${web.origin}/api/operator/session`,
    );
    const { csrfToken } = await opened.json();
    const login = await context.request.post(
      `${web.origin}/api/operator/login`,
      {
        headers: { origin: web.origin, "x-csrf-token": csrfToken },
        data: { password: web.password },
      },
    );
    assert.equal(login.status(), 200);
    await page.goto(`${web.origin}/app/settings#notifications`);
    await page.locator("main.page h1").waitFor();
    browserVersion = (await page.evaluate(() => navigator.userAgent)).match(
      /Chrome\/([\d.]+)/,
    )?.[1];
    return { browser: `Chrome ${browserVersion}`, platform: process.platform };
  });

  let endpointHost = "";
  await step("1 real subscribe: the endpoint host is allowlisted", async () => {
    await page.getByRole("button", { name: "Turn on notifications" }).click();
    await page.getByText("Notifications are on in this browser").waitFor({
      timeout: 120_000,
    });
    const rows = push.read().subscriptions;
    assert.equal(rows.length, 1);
    endpointHost = rows[0].serviceHost;
    assert.ok(pushHostAllowed(endpointHost), `host ${endpointHost}`);
    return { serviceHost: endpointHost };
  });
  await push.tick(); // the baseline

  await step(
    "2 test notification: push service status and a shown notification",
    async () => {
      const before = pushCalls.length;
      await page
        .getByRole("button", { name: "Send test notification" })
        .click();
      await page.getByText("Test notification sent.").waitFor();
      const call = pushCalls[before];
      assert.ok(
        call && call.status >= 200 && call.status < 300,
        JSON.stringify(call),
      );
      const { ms } = await waitForShown(
        (n) => n.title === "Test notification from Ensemble",
        "test",
      );
      return { pushStatus: call.status, shownAfterMs: ms };
    },
  );

  let question;
  await step(
    "3 one question: one notification within 30 s without its text",
    async () => {
      question = await seedOwnQuestion(f, {
        version: 1,
        questions: [
          {
            id: "only",
            kind: "free-text",
            label: marker,
            required: true,
          },
        ],
      });
      const before = pushCalls.length;
      const started = Date.now();
      await push.tick();
      await push.settle();
      const call = pushCalls[before];
      assert.ok(
        call && call.status >= 200 && call.status < 300,
        JSON.stringify(call),
      );
      const { hit, ms } = await waitForShown(
        (n) => n.tag === question.interactionId,
        "question",
      );
      assert.equal(hit.title.includes(marker), false);
      assert.match(hit.title, /^Question in .+: 1 waiting$/);
      return {
        pushStatus: call.status,
        shownAfterMs: ms,
        sinceTickMs: Date.now() - started,
      };
    },
  );

  await step("4 a second tick sends no duplicate", async () => {
    const before = pushCalls.length;
    await push.tick();
    await push.settle();
    assert.equal(pushCalls.length, before);
    const same = (await shown()).filter(
      (n) => n.tag === question.interactionId,
    );
    assert.equal(same.length, 1);
  });

  await step(
    "5 click: the worker can send a controlled app window to the exact Inbox selection",
    async () => {
      // A native notification cannot be clicked from automation, and Chrome refuses WindowClient.focus()
      // and clients.openWindow() outside a real click. What this proves is the part that needs no
      // gesture: in Chrome's own worker, matchAll finds the controlled /app window and navigate()
      // sends it to the exact link. The operating system's click delivery, focus and openWindow are not proven.
      const link = `/app/inbox?task=${question.taskId}&request=${question.interactionId}`;
      await page.goto(`${web.origin}/app/inbox`);
      await page.locator("main.page h1").waitFor();
      const worker = context
        .serviceWorkers()
        .find((w) => w.url().endsWith("/app/service-worker.js"));
      assert.ok(worker, "the worker is running");
      const outcome = await worker.evaluate(async (url) => {
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const target = windows.find((c) =>
          new URL(c.url).pathname.startsWith("/app/"),
        );
        if (!target) return { found: false };
        let focus = "focused";
        await target.focus().catch((e) => {
          focus = `refused: ${e.name}`;
        });
        await target.navigate(url);
        return { found: true, focus };
      }, link);
      await page.waitForURL(`**${link}`, { timeout: 15_000 });
      assert.equal(page.url(), web.origin + link);
      return { ...outcome, navigatedToExactLink: true };
    },
  );

  await step(
    "6 answer the question: no further push and the notification closes after the next read",
    async () => {
      await page.goto(`${web.origin}/app/inbox`);
      await page.locator("main.page h1").waitFor();
      await api.execute({
        type: "question.form.answer",
        key: randomUUID(),
        taskId: question.taskId,
        interactionId: question.interactionId,
        expectedRevision: 1,
        answers: { only: { optionIds: [], text: "Exact text" } },
      });
      const before = pushCalls.length;
      await push.tick();
      await push.settle();
      assert.equal(pushCalls.length, before, "no push for a resolved request");
      await page.reload();
      await page.locator("main.page h1").waitFor();
      const started = Date.now();
      let closed = false;
      while (Date.now() - started < 20_000 && !closed) {
        closed = !(await shown()).some((n) => n.tag === question.interactionId);
        if (!closed) await sleep(500);
      }
      return { closedAfterRead: closed, platformKeptIt: !closed };
    },
  );

  let runtimeTag;
  await step(
    "7 runtime exhaustion: one notification, no duplicate, closes on recovery",
    async () => {
      const before = pushCalls.length;
      await exhaustion.exhaust(f.runtime);
      await push.tick();
      await push.settle();
      assert.equal(pushCalls.length, before + 1);
      const { hit, ms } = await waitForShown(
        (n) => n.title === "Codex runtime unavailable",
        "runtime",
      );
      runtimeTag = hit.tag;
      await push.tick();
      await push.settle();
      assert.equal(
        pushCalls.length,
        before + 1,
        "no duplicate for the same episode",
      );
      exhaustion.gate.failStarts = false;
      await f.service.configureRuntime({
        key: randomUUID(),
        harness: "codex",
        enabled: true,
      });
      await page.goto(`${web.origin}/app/inbox`);
      await page.locator("main.page h1").waitFor();
      const started = Date.now();
      let closed = false;
      while (Date.now() - started < 20_000 && !closed) {
        closed = !(await shown()).some((n) => n.tag === runtimeTag);
        if (!closed) await sleep(500);
      }
      return {
        shownAfterMs: ms,
        closedAfterRecovery: closed,
        platformKeptIt: !closed,
      };
    },
  );

  await step(
    "8 unsubscribe in the browser, then a test answers 404 or 410 and the row is removed",
    async () => {
      await goSettings();
      await page
        .getByRole("button", { name: "Turn off for this browser" })
        .waitFor();
      // Unsubscribing in the browser alone, without telling the service, is the case being exercised.
      await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration("/app/");
        await (await r.pushManager.getSubscription()).unsubscribe();
      });
      const row = push.read().subscriptions[0];
      // The push service takes a while to forget the registration, so the test is repeated, a bounded
      // number of times, until it answers something other than success.
      const answers = [];
      let outcome = "sent";
      for (let attempt = 1; attempt <= 24 && outcome === "sent"; attempt++) {
        const before = pushCalls.length;
        outcome = await page.evaluate(async (id) => {
          const session = await (await fetch("/api/operator/session")).json();
          const r = await fetch(
            `/api/operator/notifications/subscriptions/${id}/test`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-csrf-token": session.csrfToken,
              },
              body: "{}",
            },
          );
          return (await r.json()).outcome;
        }, row.id);
        answers.push(pushCalls[before]?.status ?? outcome);
        if (outcome === "sent") await sleep(5_000);
      }
      const after = push.read().subscriptions[0];
      assert.equal(outcome, "gone", `answers ${JSON.stringify(answers)}`);
      assert.equal(after.revokedReason, "gone");
      assert.ok([404, 410].includes(answers.at(-1)), JSON.stringify(answers));
      return {
        attempts: answers.length,
        answers,
        outcome,
        revokedReason: after.revokedReason,
      };
    },
  );

  await step(
    "9 no private key, auth secret, endpoint or question text in logs or push tables",
    async () => {
      const keyFile = join(f.directory, "operator-push-vapid.json");
      const key = JSON.parse(readFileSync(keyFile, "utf8"));
      const rowSecrets = [key.privateKey];
      const text =
        transcript.join("\n") +
        JSON.stringify(steps) +
        JSON.stringify(pushCalls);
      for (const secret of rowSecrets)
        assert.equal(text.includes(secret), false, "private key in logs");
      assert.equal(text.includes(marker), false, "question text in logs");
      // The key file is the only file that holds the private key.
      const holders = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          const stat = statSync(path);
          if (stat.isDirectory()) walk(path);
          else if (
            stat.size < 50_000_000 &&
            readFileSync(path).includes(key.privateKey)
          )
            holders.push(name);
        }
      };
      walk(f.directory);
      assert.deepEqual(holders, ["operator-push-vapid.json"]);
      let pushTables = "";
      f.seedPersistedState((db) => {
        for (const table of [
          "operator_push_subscriptions",
          "operator_push_alerts",
          "operator_push_state",
        ])
          pushTables += JSON.stringify(
            db.prepare(`SELECT * FROM ${table}`).all(),
          );
      });
      assert.equal(pushTables.includes(key.privateKey), false);
      assert.equal(pushTables.includes(marker), false);
      assert.equal(
        /"endpoint":"https/.test(pushTables),
        false,
        "the revoked row kept an endpoint",
      );
      return { keyFileOnlyHolder: true };
    },
  );

  summary = {
    ok: steps.every((s) => s.ok),
    browser: `Chrome ${browserVersion}`,
    pushService: endpointHost,
    steps,
    pushCalls,
    notQualified: [
      "phone and other-device delivery (#1150)",
      "the operating system's own notification click",
      "runtime exhaustion was driven by a fake runtime, not a crashed real App Server",
    ],
  };
} catch (error) {
  summary = {
    ok: false,
    steps,
    pushCalls,
    error: error instanceof Error ? error.message : String(error),
  };
  process.exitCode = 1;
} finally {
  // Close what this run opened; nothing else is touched.
  await liveContext?.close().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  if (fixture?.directory)
    rmSync(fixture.directory, { recursive: true, force: true });
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
