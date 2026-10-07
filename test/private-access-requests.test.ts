import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { browserSuite } from "./fixtures/browser-diagnostics.js";
const test = browserSuite("private-access");
import { chromium, type Browser } from "playwright";
import { postWithoutFollowingRedirects } from "./s04c/private-access-requests.js";

test("private proof observes the capacity redirect without following it", async (_t, journey) => {
  let capacityPosts = 0;
  let runtimeReads = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/capacity") {
      capacityPosts += 1;
      response.writeHead(303, { location: "/runtime" }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/runtime") {
      runtimeReads += 1;
      response.writeHead(200).end("runtime");
      return;
    }
    response.writeHead(404).end();
  });
  let browser: Browser | undefined;
  journey.ownLocal({
    browser: async () => {
      await browser?.close();
    },
    listeners: [
      {
        name: "http.close",
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      },
    ],
  });
  await journey.start(
    "http.listen",
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  const address = server.address() as AddressInfo;
  browser = await journey.start("browser.launch", () =>
    chromium.launch({ headless: true }),
  );
  const context = await browser.newContext();

  const response = await postWithoutFollowingRedirects(
    context.request,
    `http://127.0.0.1:${address.port}/capacity`,
    { form: { projectLimit: 1 } },
  );

  assert.equal(response.status(), 303);
  assert.equal(response.headers().location, "/runtime");
  assert.equal(capacityPosts, 1);
  assert.equal(runtimeReads, 0);
});
