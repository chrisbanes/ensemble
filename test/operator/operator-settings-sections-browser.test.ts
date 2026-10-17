import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  routeTurnStarted,
  startSettings,
} from "../fixtures/operator-settings.js";
import { setupJourney } from "../fixtures/setup-browser.js";

const test = browserSuite("operator-settings-sections-browser");

/** Navigation label, fragment and the heading a section lands on, in the designed order. */
const sections = [
  ["Projects", "projects", "Projects"],
  ["Runtime & recovery", "runtime", "Runtime and recovery"],
  ["Profiles", "profiles", "Profiles"],
  ["Routing", "routing", "Routing"],
  ["GitHub discovery", "github-discovery", "GitHub discovery"],
  ["CLI credentials", "cli-credentials", "CLI credentials"],
  ["Notifications", "notifications", "Notifications"],
  ["Readiness", "readiness", "Readiness"],
] as const;
const designedHeadings = sections.map(([, , heading]) => heading);
const firstRunHeadings = [
  "Readiness",
  ...designedHeadings.filter((h) => h !== "Readiness"),
];

/** A new document at `url`, as a bookmark or typed address would open it. */
async function coldGoto(page: Page, url: string) {
  await page.goto("about:blank");
  await page.goto(url);
}

const nav = (page: Page) =>
  page.getByRole("navigation", { name: "Settings sections" });

/** Two animation frames: whatever the app scheduled for the next frame has run. */
const nextFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );

/** Waits until focus is on a heading with this text; returns whether it is fully on screen. */
async function landed(page: Page, tag: "H2" | "H3", text: string) {
  await page.waitForFunction(
    ([tagName, name]) =>
      document.activeElement?.tagName === tagName &&
      document.activeElement.textContent?.trim() === name,
    [tag, text] as const,
  );
  // The app's own restore runs in the next frame; measure once it has had its say.
  await nextFrames(page);
  return page.evaluate(() => {
    const box = document.activeElement?.getBoundingClientRect();
    return box
      ? { top: box.top, bottom: box.bottom, height: innerHeight }
      : null;
  });
}
const onScreen = (box: Awaited<ReturnType<typeof landed>>) => {
  assert.ok(box, "a focused heading");
  assert.ok(box.top >= 0 && box.bottom <= box.height, JSON.stringify(box));
};
const current = (page: Page) =>
  nav(page).locator('a[aria-current="true"]').allInnerTexts();

test("Settings section links land on each section with its heading focused", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  assert.deepEqual(
    await nav(page).getByRole("link").allInnerTexts(),
    sections.map(([label]) => label),
  );
  for (const [label, id, heading] of sections) {
    await nav(page).getByRole("link", { name: label, exact: true }).click();
    onScreen(await landed(page, "H2", heading));
    assert.ok(page.url().endsWith(`/app/settings#${id}`), page.url());
    assert.deepEqual(await current(page), [label]);
  }
  // Reduced motion has no animation to wait for: landing is instant.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav(page).getByRole("link", { name: "Profiles", exact: true }).click();
  onScreen(await landed(page, "H2", "Profiles"));
  assert.deepEqual(await current(page), ["Profiles"]);
  await captureBrowserEvidence(page, "1366-settings-landed");
});

test("a Settings fragment lands after the reads load and again on reload", async (_t, journey) => {
  // A short window puts the deep sections below the fold, so landing has to scroll.
  const { page, web } = await startSettings(journey, "/app/settings", {
    width: 1366,
    height: 500,
  });
  await coldGoto(page, `${web.origin}/app/settings#cli-credentials`);
  onScreen(await landed(page, "H2", "CLI credentials"));
  // Let the reads above the target finish growing; the heading stays where it landed.
  await page.getByRole("article", { name: "GitHub discovery" }).waitFor();
  onScreen(await landed(page, "H2", "CLI credentials"));
  await page.reload();
  onScreen(await landed(page, "H2", "CLI credentials"));
  await page.getByRole("article", { name: "GitHub discovery" }).waitFor();
  onScreen(await landed(page, "H2", "CLI credentials"));
});

test("a landed section holds while the content above it grows, until the reader scrolls", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/app/settings");
  // Safari has no scroll anchoring; switch it off so Chromium behaves the same way.
  await page.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*{overflow-anchor:none !important}";
      document.head.append(style);
    });
  });
  await coldGoto(page, `${web.origin}/app/settings#profiles`);
  // Grow as soon as the heading has focus: the settle window is a few seconds, so the
  // first growth must not wait on anything else.
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Profiles",
  );
  const grow = () =>
    page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.querySelector(".settings-index")?.prepend(spacer);
    });
  await grow();
  onScreen(await landed(page, "H2", "Profiles"));
  // Once the reader scrolls, later growth no longer pulls the page back.
  await page.mouse.wheel(0, 1);
  await grow();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => done(null))),
  );
  assert.ok(
    await page
      .getByRole("heading", { name: "Profiles", level: 2 })
      .evaluate((h) => h.getBoundingClientRect().top > innerHeight),
  );
});

test("Back and Forward restore Settings sections", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  const link = (name: string) =>
    nav(page).getByRole("link", { name, exact: true });
  await link("Profiles").click();
  await landed(page, "H2", "Profiles");
  const landedAt = await page.evaluate(() => scrollY);
  // The navigation is not sticky: the position saved on leaving is where the link was used.
  const leftAt = 60;
  assert.ok(
    landedAt > leftAt * 2,
    "the Profiles section is well below the top",
  );
  await page.evaluate((y) => scrollTo(0, y), leftAt);
  await link("Readiness").click();
  await landed(page, "H2", "Readiness");
  await page.goBack();
  await page.waitForURL(/#profiles$/);
  await nextFrames(page);
  // The saved position is restored; the section is not landed on again.
  assert.equal(await page.evaluate(() => scrollY), leftAt);
  assert.notEqual(
    await page.evaluate(() => document.activeElement?.tagName),
    "H2",
  );
  // Forward to an entry with no saved position lands the section; the app must not also
  // send the page to the top first (the section's own scroll would hide it for a frame).
  await page.evaluate(() => {
    const calls: unknown[][] = [];
    const scrollTo = window.scrollTo.bind(window) as (...a: unknown[]) => void;
    Object.assign(window, {
      scrollCalls: calls,
      scrollTo: (...a: unknown[]) => {
        calls.push(a);
        scrollTo(...a);
      },
    });
  });
  await page.goForward();
  await page.waitForURL(/#readiness$/);
  onScreen(await landed(page, "H2", "Readiness"));
  assert.deepEqual(
    await page.evaluate(
      () => (window as unknown as { scrollCalls: unknown[] }).scrollCalls,
    ),
    [],
  );
});

test("first run puts Readiness first and an established install keeps the designed order", async (_t, journey) => {
  const first = await startSettings(
    journey,
    "/app/settings",
    desktop,
    undefined,
    { turnStarted: false },
  );
  const headings = (page: Page) => page.locator("main h2").allInnerTexts();
  await nav(first.page).waitFor();
  assert.deepEqual(await headings(first.page), firstRunHeadings);
  assert.deepEqual(await nav(first.page).getByRole("link").allInnerTexts(), [
    "Readiness",
    ...sections.map(([l]) => l).filter((l) => l !== "Readiness"),
  ]);
  // No CSS reordering: reading order is DOM order.
  assert.deepEqual(
    await first.page
      .locator(".settings-index > *")
      .evaluateAll((es) => es.map((e) => getComputedStyle(e).order)),
    Array(sections.length).fill("0"),
  );
  assert.deepEqual(await current(first.page), ["Readiness"]);
  for (const viewport of [desktop, phone]) {
    await first.page.setViewportSize(viewport);
    await first.page.goto(`${first.web.origin}/app/settings`);
    await first.page.getByRole("heading", { name: "Readiness" }).waitFor();
    const box = await first.page
      .getByRole("heading", { name: "Readiness", level: 2 })
      .evaluate((e) => e.getBoundingClientRect().bottom);
    assert.ok(box <= viewport.height, `${viewport.width}: bottom ${box}`);
    assert.equal(await first.page.evaluate(() => scrollY), 0);
  }
  await captureBrowserEvidence(first.page, "390-settings-first-run");
});

test("an empty install puts Readiness first from the service's own first-run signal", async (_t, journey) => {
  // No route override: the real workspace read says no turn has started.
  const { page } = await setupJourney(journey, { path: "/app/settings" });
  await nav(page).waitFor();
  assert.equal(await page.locator("main h2").first().innerText(), "Readiness");
  assert.deepEqual(await current(page), ["Readiness"]);
  assert.equal(
    await nav(page).getByRole("link").first().innerText(),
    "Readiness",
  );
});

test("a first-run flip while Settings is open reorders the sections and keeps focus", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/settings",
    desktop,
    undefined,
    { turnStarted: false },
  );
  await nav(page).waitFor();
  assert.deepEqual(
    await page.locator("main h2").allInnerTexts(),
    firstRunHeadings,
  );
  const run = page.getByRole("button", { name: "Run again" });
  await run.focus();
  // A turn starts elsewhere; the next workspace read moves Readiness to the end. The
  // header Refresh is clicked in script so focus stays on Run again.
  await page.unroute("**/api/operator/workspace");
  await routeTurnStarted(page, true);
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Refresh")
      ?.click(),
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("main h2")].at(-1)?.textContent ===
      "Readiness",
  );
  assert.deepEqual(
    await page.locator("main h2").allInnerTexts(),
    designedHeadings,
  );
  assert.deepEqual(
    await nav(page).getByRole("link").allInnerTexts(),
    sections.map(([l]) => l),
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Run again",
  );
  // The focused control moved with its section; the page follows it into view.
  await page.waitForFunction(() => {
    const box = document.activeElement?.getBoundingClientRect();
    return Boolean(box && box.top >= 0 && box.bottom <= innerHeight);
  });
});

test("an established install keeps Readiness last with the first section current", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/settings",
    desktop,
    undefined,
    { turnStarted: true },
  );
  await nav(page).waitFor();
  assert.deepEqual(
    await page.locator("main h2").allInnerTexts(),
    designedHeadings,
  );
  assert.deepEqual(await current(page), ["Projects"]);
});

test("Settings section navigation is reachable by keyboard in order", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.locator("main.page h1").evaluate((h) => {
    h.tabIndex = -1;
    h.focus();
  });
  const label = () =>
    page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  for (let presses = 0; (await label()) !== "Projects"; presses++) {
    assert.ok(presses < 30, "the first section link is reachable");
    await page.keyboard.press("Tab");
  }
  const names = ["Projects"];
  for (let i = 1; i < sections.length; i++) {
    await page.keyboard.press("Tab");
    names.push(await label());
  }
  assert.deepEqual(
    names,
    sections.map(([l]) => l),
  );
  await page.keyboard.press("Enter");
  onScreen(await landed(page, "H2", "Readiness"));
});

test("a check anchor marks Readiness current and a hash-only change lands with focus", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/app/settings");
  await coldGoto(page, `${web.origin}/app/settings#readiness-codex-login`);
  onScreen(await landed(page, "H3", "Codex login"));
  assert.deepEqual(await current(page), ["Readiness"]);
  // Typing a new fragment into the address bar is a hash-only navigation.
  await page.goto(`${web.origin}/app/settings#profiles`);
  onScreen(await landed(page, "H2", "Profiles"));
  assert.deepEqual(await current(page), ["Profiles"]);
});

/**
 * Enters a history entry the shell never left (no saved scroll position) at `url`, by
 * Forward after Back, and returns the `scrollTo` calls the shell made while doing so.
 */
async function forwardInto(page: Page, url: string) {
  await page.evaluate((target) => {
    const { scrollY, ...state } = history.state;
    history.pushState({ ...state, navKey: crypto.randomUUID() }, "", target);
    history.back();
  }, url);
  await nextFrames(page);
  // Entering the new entry starts from a page with nothing focused.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.evaluate(() => {
    const calls: unknown[][] = [];
    const scrollTo = window.scrollTo.bind(window) as (...a: unknown[]) => void;
    Object.assign(window, {
      scrollCalls: calls,
      scrollTo: (...a: unknown[]) => {
        calls.push(a);
        scrollTo(...a);
      },
    });
    history.forward();
  });
  await nextFrames(page);
  await nextFrames(page);
  return page.evaluate(
    () => (window as unknown as { scrollCalls: unknown[] }).scrollCalls,
  );
}
const focusedHeading = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a && /^H[23]$/.test(a.tagName) ? a.textContent : null;
  });

test("Back to a route with a fragment and no saved position still scrolls to the top", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/tasks");
  await page.locator("main.page h1").waitFor();
  assert.deepEqual(await forwardInto(page, "/app/tasks#elsewhere"), [[0, 0]]);
});

test("Back or Forward into a Settings fragment skips the top restore only for a target the page lands on", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  // A section on this page: the page lands on it and the shell leaves the scroll alone.
  assert.deepEqual(await forwardInto(page, "/app/settings#profiles"), []);
  assert.equal(await focusedHeading(page), "Profiles");
  // A check anchor whose article is drawn is a target too.
  assert.deepEqual(
    await forwardInto(page, "/app/settings#readiness-codex-login"),
    [],
  );
  assert.equal(await focusedHeading(page), "Codex login");
  // No target: unknown, malformed, a check that does not exist, or another route's anchor.
  for (const hash of [
    "unknown",
    "%E0%A4%A",
    "readiness-unknown",
    "add-claude",
  ]) {
    assert.deepEqual(
      await forwardInto(page, `/app/settings#${hash}`),
      [[0, 0]],
      hash,
    );
    assert.equal(await focusedHeading(page), null, hash);
  }
});

test("Back or Forward into a check anchor restores the top while its read has failed, and lands once it is drawn", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.route("**/api/operator/readiness", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    }),
  );
  await page.reload();
  await nav(page).waitFor();
  await page.getByRole("button", { name: "Run again" }).waitFor();
  await page.getByText("Readiness checks are unavailable").waitFor();
  assert.deepEqual(
    await forwardInto(page, "/app/settings#readiness-codex-login"),
    [[0, 0]],
  );
  assert.equal(await focusedHeading(page), null);
  // The read recovers: the article appears and the page lands on it.
  await page.unroute("**/api/operator/readiness");
  await page.getByRole("button", { name: "Run again" }).click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Codex login",
  );
});

test("Back or Forward into an add-claude anchor on the Runtime page skips the restore once the panel is drawn", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings/runtime");
  await page.getByRole("heading", { name: "Add Claude" }).waitFor();
  assert.deepEqual(
    await forwardInto(page, "/app/settings/runtime#add-claude"),
    [],
  );
  assert.equal(await focusedHeading(page), "Add Claude");
  assert.deepEqual(await forwardInto(page, "/app/settings/runtime#unknown"), [
    [0, 0],
  ]);
});

/** Records every heading that takes focus, so a stale or double landing shows. */
const trackFocus = (page: Page) =>
  page.evaluate(() => {
    const log: string[] = [];
    Object.assign(window, { focusLog: log });
    document.addEventListener("focusin", (e) => {
      const t = e.target as HTMLElement;
      if (/^H[23]$/.test(t.tagName)) log.push(t.textContent ?? "");
    });
  });
const focusLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { focusLog: string[] }).focusLog);
const setHash = (page: Page, hash: string) =>
  page.evaluate((h) => {
    location.hash = h;
  }, hash);

test("native hash-only navigation lands, switches targets and leaves unsupported fragments alone", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  await trackFocus(page);
  // A script assigning the hash, then another while the first landing is still settling.
  await setHash(page, "profiles");
  onScreen(await landed(page, "H2", "Profiles"));
  await setHash(page, "routing");
  onScreen(await landed(page, "H2", "Routing"));
  assert.deepEqual(await focusLog(page), ["Profiles", "Routing"]);
  // Supported to unsupported: nothing scrolls and nothing takes focus.
  await page.evaluate(() => {
    const calls: unknown[] = [];
    const into = Element.prototype.scrollIntoView;
    Object.assign(window, { intoCalls: calls });
    Element.prototype.scrollIntoView = function (...a: []) {
      calls.push(this.id);
      return into.apply(this, a);
    };
  });
  await setHash(page, "bogus");
  await nextFrames(page);
  await nextFrames(page);
  assert.deepEqual(
    await page.evaluate(
      () => (window as unknown as { intoCalls: unknown[] }).intoCalls,
    ),
    [],
  );
  assert.deepEqual(await focusLog(page), ["Profiles", "Routing"]);
  // Unsupported to supported lands.
  await setHash(page, "profiles");
  onScreen(await landed(page, "H2", "Profiles"));
  // A link the shell does not intercept (a bare fragment) is the same navigation.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "bare";
    a.href = "#cli-credentials";
    a.textContent = "bare fragment";
    a.style.cssText = "position:fixed;top:0;left:0;z-index:99";
    document.querySelector("main")?.prepend(a);
  });
  await page.locator("#bare").click();
  onScreen(await landed(page, "H2", "CLI credentials"));
  // Back and Forward between these hash-only entries land each one again.
  await page.goBack();
  onScreen(await landed(page, "H2", "Profiles"));
  await page.goForward();
  onScreen(await landed(page, "H2", "CLI credentials"));
});

test("traversal between entries that share one entry key lands each fragment", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  // pushState copies the state, as a browser that copies it for a fragment navigation would.
  await page.evaluate(() => {
    const { scrollY, ...state } = history.state ?? {};
    history.pushState(state, "", "#profiles");
    history.pushState(state, "", "#routing");
  });
  await page.goBack();
  onScreen(await landed(page, "H2", "Profiles"));
  await page.goBack();
  await page.waitForURL(/\/app\/settings$/);
  await page.goForward();
  onScreen(await landed(page, "H2", "Profiles"));
  await page.goForward();
  onScreen(await landed(page, "H2", "Routing"));
});

test("leaving Settings and coming back to the same entry lands again, and a re-render does not", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/tasks");
  await page.locator("main.page h1").waitFor();
  await page.evaluate(() => {
    const { scrollY, ...state } = history.state;
    history.pushState(
      { ...state, navKey: crypto.randomUUID() },
      "",
      "/app/settings#profiles",
    );
    history.back();
  });
  await page.waitForURL(/\/app\/tasks$/);
  await page.goForward();
  onScreen(await landed(page, "H2", "Profiles"));
  await page.goBack();
  await page.waitForURL(/\/app\/tasks$/);
  await page.goForward();
  onScreen(await landed(page, "H2", "Profiles"));
  // A re-render of the same landing leaves the reader's focus where they put it.
  await page.getByRole("link", { name: "Create profile" }).focus();
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Refresh")
      ?.click(),
  );
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Create profile",
  );
});

test("a second hook becoming ready later does not land again or take focus from the reader", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  // The checks arrive well after the sections land, which readies the Readiness hook too.
  await page.route("**/api/operator/readiness", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await coldGoto(page, `${web.origin}/app/settings#profiles`);
  onScreen(await landed(page, "H2", "Profiles"));
  await page.getByRole("link", { name: "Create profile" }).focus();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  await nextFrames(page);
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Create profile",
  );
});

/**
 * Leaves the page on an entry that has a saved position of its own: land on Profiles, move
 * a little, follow the Readiness link, and come Back. Returns the saved scroll position.
 */
async function backToSavedEntry(page: Page) {
  const link = (name: string) =>
    nav(page).getByRole("link", { name, exact: true });
  await link("Profiles").click();
  await landed(page, "H2", "Profiles");
  await page.evaluate(() => scrollTo(0, 60));
  await link("Readiness").click();
  await landed(page, "H2", "Readiness");
  await page.goBack();
  await page.waitForURL(/#profiles$/);
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await page.evaluate(() => scrollY), 60);
  return 60;
}

/** Ways to change the fragment that start a new entry, from the entry the page is on. */
const forwardMethods: [
  string,
  (page: Page, origin: string, hash: string) => Promise<void>,
][] = [
  [
    "an address-bar edit",
    async (page, origin, hash) => {
      await page.goto(`${origin}/app/settings#${hash}`);
    },
  ],
  ["a script hash assignment", (page, _origin, hash) => setHash(page, hash)],
  [
    "a bare fragment link",
    async (page, _origin, hash) => {
      await page.evaluate((h) => {
        const a = document.createElement("a");
        a.id = "bare";
        a.href = `#${h}`;
        a.textContent = "bare fragment";
        document.querySelector("main")?.prepend(a);
      }, hash);
      // Clicked in script so the page keeps the position it was left at.
      await page.locator("#bare").evaluate((a) => (a as HTMLElement).click());
    },
  ],
  [
    "an app link",
    async (page, _origin, hash) => {
      await page.evaluate((h) => {
        const a = document.createElement("a");
        a.id = "applink";
        a.href = `/app/settings#${h}`;
        a.textContent = "app link";
        a.style.cssText = "position:fixed;top:0;left:0;z-index:99";
        document.querySelector("main")?.prepend(a);
      }, hash);
      await page
        .locator("#applink")
        .evaluate((a) => (a as HTMLElement).click());
    },
  ],
];
for (const [method, go] of forwardMethods)
  for (const [hash, supported] of [
    ["cli-credentials", true],
    ["bogus", false],
  ] as const)
    test(`a new entry from ${method} to #${hash} after Back to a saved position ${supported ? "lands" : "does not land"}`, async (_t, journey) => {
      const { page, web } = await startSettings(journey, "/app/settings");
      await nav(page).waitFor();
      await page.getByRole("article", { name: "Codex login" }).waitFor();
      const saved = await backToSavedEntry(page);
      await trackFocus(page);
      await go(page, web.origin, hash);
      if (supported) onScreen(await landed(page, "H2", "CLI credentials"));
      else {
        await nextFrames(page);
        await nextFrames(page);
        assert.deepEqual(await focusLog(page), []);
        if (method !== "an app link")
          assert.equal(await page.evaluate(() => scrollY), 0);
      }
      // Going Back to the saved entry restores its own position and lands nothing.
      const focused = (await focusLog(page)).length;
      await page.goBack();
      await page.waitForURL(/#profiles$/);
      await nextFrames(page);
      await nextFrames(page);
      assert.equal(await page.evaluate(() => scrollY), saved);
      assert.equal((await focusLog(page)).length, focused);
    });

test("an entry that copies a saved position is a new entry, and its source still restores", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  const saved = await backToSavedEntry(page);
  // pushState copies the whole state, saved position included, into an entry at another fragment.
  await page.evaluate(() => {
    history.pushState({ ...history.state }, "", "#cli-credentials");
    history.back();
  });
  await page.waitForURL(/#profiles$/);
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await page.evaluate(() => scrollY), saved);
  await trackFocus(page);
  await page.goForward();
  onScreen(await landed(page, "H2", "CLI credentials"));
  assert.deepEqual(await focusLog(page), ["CLI credentials"]);
});

test("Forward to an entry the page landed on lands again after passing an entry with no target", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  await setHash(page, "profiles");
  onScreen(await landed(page, "H2", "Profiles"));
  await page.goBack();
  await page.waitForURL(/\/app\/settings$/);
  await nextFrames(page);
  // The reader moves on before coming forward again.
  await page.getByRole("link", { name: "Create project" }).focus();
  await trackFocus(page);
  await page.goForward();
  onScreen(await landed(page, "H2", "Profiles"));
  assert.deepEqual(await focusLog(page), ["Profiles"]);
});

test("the first entry and a natively made entry restore their own saved positions", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  const click = (name: string) =>
    nav(page)
      .getByRole("link", { name, exact: true })
      .evaluate((a) => (a as HTMLElement).click());
  // The entry the page was opened on: leave it through a link from 300px down.
  await page.evaluate(() => scrollTo(0, 300));
  await click("Profiles");
  await landed(page, "H2", "Profiles");
  await page.goBack();
  await page.waitForURL(/\/app\/settings$/);
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await page.evaluate(() => scrollY), 300);
  // An entry made by a native fragment change, left through a link from 200px down.
  await setHash(page, "routing");
  await landed(page, "H2", "Routing");
  await page.evaluate(() => scrollTo(0, 200));
  await click("CLI credentials");
  await landed(page, "H2", "CLI credentials");
  await trackFocus(page);
  await page.goBack();
  await page.waitForURL(/#routing$/);
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await page.evaluate(() => scrollY), 200);
  assert.deepEqual(await focusLog(page), []);
});

test("entries made before a reload start clean in the new document and land their fragment", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  const click = (name: string) =>
    nav(page)
      .getByRole("link", { name, exact: true })
      .evaluate((a) => (a as HTMLElement).click());
  await page.evaluate(() => scrollTo(0, 300));
  await click("Profiles");
  await landed(page, "H2", "Profiles");
  await page.evaluate(() => scrollTo(0, 120));
  await click("Readiness");
  await landed(page, "H2", "Readiness");
  await page.reload();
  await nav(page).waitFor();
  // Each load has its own navigation scope, so an entry from the earlier document keeps
  // no saved state (the privacy guard); it lands its fragment like a new entry.
  await page.goBack();
  await page.waitForURL(/#profiles$/);
  onScreen(await landed(page, "H2", "Profiles"));
  assert.equal(
    await page.evaluate(() => (history.state as { scrollY?: number }).scrollY),
    undefined,
  );
  // Entries made in this document own their state again: leave through a link, come Back.
  await page.evaluate(() => scrollTo(0, 90));
  await click("Routing");
  await landed(page, "H2", "Routing");
  await page.goBack();
  await page.waitForURL(/#profiles$/);
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await page.evaluate(() => scrollY), 90);
});

test("leaving through the sidebar keeps the position Back restores", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  await page.getByRole("article", { name: "Codex login" }).waitFor();
  await page.evaluate(() => scrollTo(0, 150));
  // Clicked in script so the page keeps the position it was left at.
  await page
    .getByRole("link", { name: "Tasks", exact: true })
    .first()
    .evaluate((a) => (a as HTMLElement).click());
  await page.waitForURL("**/app/tasks");
  await page.goBack();
  await page.waitForURL(/\/app\/settings$/);
  await nextFrames(page);
  await nextFrames(page);
  assert.equal(await page.evaluate(() => scrollY), 150);
});

test("a state without this load's scope is not adopted as an owned entry", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings");
  await nav(page).waitFor();
  // A foreign state with a saved position, as an old build or another script could leave.
  await page.evaluate(() => {
    history.replaceState({ scrollY: 500 }, "", "/app/settings#profiles");
  });
  await page.reload();
  onScreen(await landed(page, "H2", "Profiles"));
  assert.equal(
    await page.evaluate(() => (history.state as { scrollY?: number }).scrollY),
    undefined,
  );
});

for (const fragment of ["bogus", "readiness-unknown"])
  test(`an unknown Settings fragment #${fragment} leaves the page at the top`, async (_t, journey) => {
    const { page, web } = await startSettings(journey, "/app/settings");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await coldGoto(page, `${web.origin}/app/settings#${fragment}`);
    // Every read has finished once the last check row is drawn.
    await page.getByRole("article", { name: "GitHub discovery" }).waitFor();
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "BODY",
    );
    assert.deepEqual(await current(page), ["Projects"]);
    assert.ok(page.url().endsWith(`/app/settings#${fragment}`), page.url());
    assert.deepEqual(errors, []);
  });

test("Settings section select chooses and Go lands on a phone", async (_t, journey) => {
  const { page } = await startSettings(journey, "/app/settings", phone);
  await page.getByRole("combobox", { name: "Settings section" }).waitFor();
  // The select replaces the section links; Go is the one link in the navigation.
  assert.deepEqual(await nav(page).getByRole("link").allInnerTexts(), ["Go"]);
  const select = nav(page).getByRole("combobox", { name: "Settings section" });
  const go = nav(page).getByRole("link", { name: "Go", exact: true });
  assert.deepEqual(
    await select.locator("option").allInnerTexts(),
    sections.map(([l]) => l),
  );
  // Choosing only chooses: arrow keys on a closed select fire change on some platforms.
  const before = page.url();
  await select.selectOption({ label: "GitHub discovery" });
  await nextFrames(page);
  assert.equal(page.url(), before);
  assert.equal(await page.evaluate(() => scrollY), 0);
  assert.equal(await select.inputValue(), "github-discovery");
  await go.click();
  onScreen(await landed(page, "H2", "GitHub discovery"));
  assert.ok(page.url().endsWith("/app/settings#github-discovery"), page.url());
  assert.equal(await select.inputValue(), "github-discovery");
  await noPageOverflow(page);
  // From the keyboard: the select, then Go, then Enter; the same section again lands again.
  await page.evaluate(() => scrollTo(0, 0));
  await select.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Go",
  );
  await page.keyboard.press("Enter");
  onScreen(await landed(page, "H2", "GitHub discovery"));
  // A choice not followed by Go is dropped when the section changes another way.
  await select.selectOption({ label: "Routing" });
  await page.goBack();
  await page.goBack();
  await page.waitForURL(/\/app\/settings$/);
  await nextFrames(page);
  assert.equal(await select.inputValue(), "projects");
});

test("Home checklist Settings actions land on their sections", async (_t, journey) => {
  const { page, web } = await startSettings(
    journey,
    "/app",
    desktop,
    undefined,
    {
      turnStarted: false,
    },
  );
  const card = page.getByRole("region", { name: "Get Ensemble running" });
  const action = (row: string, name: string) =>
    card
      .getByRole("listitem", { name: row, exact: true })
      .getByRole("link", { name });
  await card.waitFor();

  await action("Runtime", "Open readiness check").click();
  onScreen(await landed(page, "H2", "Readiness"));
  assert.ok(page.url().endsWith("/app/settings#readiness"), page.url());
  await page.goBack();

  await action("GitHub", "Set discovery credential").click();
  onScreen(await landed(page, "H2", "GitHub discovery"));
  assert.ok(page.url().endsWith("/app/settings#github-discovery"), page.url());
  await page.goBack();

  await action("Claude (optional)", "Add Claude").click();
  onScreen(await landed(page, "H2", "Add Claude"));
  assert.ok(
    page.url().endsWith("/app/settings/runtime#add-claude"),
    page.url(),
  );

  // A Claude that cannot run opens its own check, not the whole section.
  await page.route("**/api/operator/readiness", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    for (const check of body.data.checks)
      if (check.id === "claude-executable")
        Object.assign(check, {
          status: "fail",
          reason: "Claude Code did not run.",
          fix: "Install Claude Code.",
        });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${web.origin}/app`);
  await card.waitFor();
  await action("Claude (optional)", "Open readiness check").click();
  onScreen(await landed(page, "H3", "Claude executable"));
  assert.ok(
    page.url().endsWith("/app/settings#readiness-claude-executable"),
    page.url(),
  );
});
