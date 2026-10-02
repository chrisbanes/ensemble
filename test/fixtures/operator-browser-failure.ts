import { strict as assert } from "node:assert";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createOperatorFixture } from "./operator-web.js";

test("injected browser assertion remains observable during fixture teardown", async (t) => {
  const f = await createOperatorFixture();
  let browser: Browser | undefined;
  let peer: Socket | undefined;
  let rescue: ReturnType<typeof setTimeout> | undefined;
  let rescueClose: Promise<void> | undefined;
  t.after(async () => {
    await f.close(browser);
    await rescueClose;
    clearTimeout(rescue);
    console.log(`failure fixture removed: ${f.directory}`);
  });
  const web = await f.startWeb();
  browser = await chromium.launch();
  peer = connect(Number(new URL(web.origin).port), "127.0.0.1");
  peer.on("error", () => {});
  await once(peer, "connect");
  peer.write(`GET /app HTTP/1.1\r\nHost: ${new URL(web.origin).host}\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  browser.once("disconnected", () => peer?.destroy());
  // Rescue only this test's owned resources if the old cleanup order deadlocks.
  // The parent rejects any run requiring rescue; this is not a larger timeout.
  rescue = setTimeout(() => {
    console.log("owned client watchdog rescue");
    peer?.destroy();
    rescueClose = browser?.close();
  }, 5000);
  assert.fail("Injected browser assertion must surface before cleanup rescue");
});
