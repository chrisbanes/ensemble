import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { readHiddenPassword } from "../../dist/src/standalone/operator-hidden-password.js";

function readConfiguration() {
  const origin = process.env.ENSEMBLE_TEST_HTTPS_ORIGIN ?? "";
  const projectId = process.env.ENSEMBLE_TEST_PROJECT_ID ?? "";
  const privateMarker = process.env.ENSEMBLE_TEST_PRIVATE_MARKER ?? "";
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("invalid origin");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(projectId) ||
    !privateMarker ||
    privateMarker.length > 256
  ) {
    throw new Error("invalid configuration");
  }
  return { origin, projectId, privateMarker };
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--live") {
  process.stderr.write(
    "Usage: node test/s04c/private-access.mjs --live (requires explicit HTTPS fixture environment)\n",
  );
  process.exitCode = 2;
} else {
  let config;
  try {
    config = readConfiguration();
  } catch {
    process.stderr.write(
      "Private-access proof needs an explicit HTTPS fixture\n",
    );
    process.exitCode = 2;
  }

  if (config) {
    let phase = "fixture password prompt";
    let password = "";
    let browser;
    let context;
    let page;
    let signedIn = false;
    let failed = false;
    let capacityRestore;
    let capacityChangeAttempted = false;
    let capacityRestored = false;
    try {
      password = await readHiddenPassword(
        process.stdin,
        process.stdout,
        "Ensemble fixture password: ",
      );
      assert.ok(password.length > 0);
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
      page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(15_000);

      phase = "unauthenticated private read";
      const privatePath = `/project/${encodeURIComponent(config.projectId)}`;
      const preLogin = await page.goto(`${config.origin}${privatePath}`);
      assert.equal(new URL(page.url()).origin, config.origin);
      assert.equal(preLogin?.status(), 200);
      const preLoginBody = await page.locator("body").innerText();
      assert.match(preLoginBody, /Sign in/);
      assert.equal(preLoginBody.includes(config.privateMarker), false);
      assert.equal(
        await page.locator('form[method="post"]').getAttribute("action"),
        "/login",
      );
      const anonymousCookie = (await context.cookies()).find(
        (cookie) => cookie.name === "ensemble_operator_session",
      );
      assert.ok(anonymousCookie);

      phase = "unauthenticated runtime and coordination reads";
      for (const path of ["/runtime", "/coordination"]) {
        const response = await page.goto(`${config.origin}${path}`);
        assert.equal(response?.status(), 200);
        const body = await page.locator("body").innerText();
        assert.match(body, /Sign in/);
        assert.equal(body.includes(config.privateMarker), false);
      }

      phase = "unauthenticated private write";
      const unauthenticatedName = `Unauthenticated proof ${randomUUID()}`;
      const anonymousContext = await browser.newContext();
      try {
        const response = await anonymousContext.request.post(
          `${config.origin}/command`,
          {
            headers: { origin: config.origin },
            form: {
              type: "project.create",
              key: randomUUID(),
              projectId: randomUUID(),
              name: unauthenticatedName,
            },
          },
        );
        assert.equal(response.status(), 401);
        const runtimeWrite = await anonymousContext.request.post(
          `${config.origin}/runtime/control/capacity`,
          {
            headers: { origin: config.origin },
            form: {
              key: randomUUID(),
              globalLimit: "2",
              projectId: config.projectId,
              projectLimit: "2",
            },
          },
        );
        assert.equal(runtimeWrite.status(), 401);
      } finally {
        await anonymousContext.close();
      }

      phase = "independent login";
      await page.locator('input[name="password"]').fill(password);
      const loginResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/login" &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in" }).click();
      const login = await loginResponse;
      assert.equal(login.status(), 303);
      signedIn = true;
      assert.equal(login.headers().location, "/");
      await page.waitForURL(`${config.origin}/`);
      assert.equal(new URL(page.url()).origin, config.origin);
      const authenticatedCookie = (await context.cookies()).find(
        (cookie) => cookie.name === "ensemble_operator_session",
      );
      assert.ok(authenticatedCookie);
      assert.notEqual(authenticatedCookie.value, anonymousCookie.value);
      assert.equal(authenticatedCookie.httpOnly, true);
      assert.equal(authenticatedCookie.sameSite, "Strict");
      assert.equal(authenticatedCookie.secure, true);
      password = "";

      phase = "authenticated private read";
      await page.goto(`${config.origin}${privatePath}`);
      assert.equal(new URL(page.url()).origin, config.origin);
      const privateBody = await page.locator("body").innerText();
      assert.equal(privateBody.includes(config.privateMarker), true);
      await page.goto(`${config.origin}/runtime`);
      assert.equal(new URL(page.url()).origin, config.origin);
      const runtimeBody = await page.locator("body").innerText();
      assert.equal(runtimeBody.includes(config.privateMarker), true);
      const globalLimit = Number(
        /Global active turns:\s*(\d+)/.exec(runtimeBody)?.[1],
      );
      const projectLine = runtimeBody
        .split("\n")
        .find((line) => line.includes(config.privateMarker));
      const projectLimit = Number(
        /:\s*(\d+) active turns/.exec(projectLine ?? "")?.[1],
      );
      assert.ok(Number.isSafeInteger(globalLimit) && globalLimit > 0);
      assert.ok(Number.isSafeInteger(projectLimit) && projectLimit > 0);
      await page.goto(`${config.origin}/coordination`);
      assert.equal(new URL(page.url()).origin, config.origin);
      assert.equal(
        (await page.locator("body").innerText()).includes(config.privateMarker),
        true,
      );
      await page.goto(`${config.origin}/`);
      assert.equal(new URL(page.url()).origin, config.origin);
      assert.equal(
        (await page.locator("body").innerText()).includes(unauthenticatedName),
        false,
      );

      phase = "origin and CSRF refusals";
      const csrfToken = await page
        .locator('input[name="csrfToken"]')
        .first()
        .inputValue();
      const deniedName = `Rejected proof ${randomUUID()}`;
      for (const attempt of [
        { headers: { origin: config.origin }, csrfToken: "" },
        { headers: {}, csrfToken },
        { headers: { origin: "null" }, csrfToken },
        {
          headers: { origin: "https://elsewhere.example" },
          csrfToken,
        },
      ]) {
        const response = await context.request.post(
          `${config.origin}/command`,
          {
            headers: attempt.headers,
            form: {
              type: "project.create",
              key: randomUUID(),
              projectId: randomUUID(),
              name: deniedName,
              csrfToken: attempt.csrfToken,
            },
          },
        );
        assert.equal(response.status(), 403);
        const runtimeResponse = await context.request.post(
          `${config.origin}/runtime/control/capacity`,
          {
            headers: attempt.headers,
            form: {
              key: randomUUID(),
              globalLimit: String(globalLimit),
              projectId: config.projectId,
              projectLimit: String(projectLimit),
              csrfToken: attempt.csrfToken,
            },
          },
        );
        assert.equal(runtimeResponse.status(), 403);
      }
      await page.goto(`${config.origin}/`);
      assert.equal(new URL(page.url()).origin, config.origin);
      const deniedBody = await page.locator("body").innerText();
      assert.equal(deniedBody.includes(deniedName), false);
      assert.equal(deniedBody.includes(unauthenticatedName), false);

      phase = "same-origin runtime capacity write and replay";
      const changedProjectLimit = projectLimit === 1 ? 2 : projectLimit - 1;
      const capacityKey = randomUUID();
      capacityRestore = {
        globalLimit,
        projectId: config.projectId,
        projectLimit,
        csrfToken,
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        capacityChangeAttempted = true;
        const response = await context.request.post(
          `${config.origin}/runtime/control/capacity`,
          {
            headers: { origin: config.origin },
            form: {
              key: capacityKey,
              globalLimit: String(globalLimit),
              projectId: config.projectId,
              projectLimit: String(changedProjectLimit),
              csrfToken,
            },
          },
        );
        assert.equal(response.status(), 303);
        assert.equal(response.headers().location, "/runtime");
      }
      await page.goto(`${config.origin}/runtime`);
      const updatedRuntimeBody = await page.locator("body").innerText();
      assert.equal(updatedRuntimeBody.includes(config.privateMarker), true);
      const updatedProjectLine = updatedRuntimeBody
        .split("\n")
        .find((line) => line.includes(config.privateMarker));
      assert.match(
        updatedProjectLine ?? "",
        new RegExp(`:\\s*${changedProjectLimit} active turns`),
      );
      const restoreKey = randomUUID();
      const restored = await context.request.post(
        `${config.origin}/runtime/control/capacity`,
        {
          headers: { origin: config.origin },
          form: {
            key: restoreKey,
            globalLimit: String(globalLimit),
            projectId: config.projectId,
            projectLimit: String(projectLimit),
            csrfToken,
          },
        },
      );
      assert.equal(restored.status(), 303);
      await page.goto(`${config.origin}/runtime`);
      const restoredRuntimeBody = await page.locator("body").innerText();
      const restoredProjectLine = restoredRuntimeBody
        .split("\n")
        .find((line) => line.includes(config.privateMarker));
      assert.match(
        restoredProjectLine ?? "",
        new RegExp(`:\\s*${projectLimit} active turns`),
      );
      capacityRestored = true;

      phase = "same-origin configuration write";
      const createdName = `S04c private proof ${randomUUID()}`;
      const projectForm = page.locator('form[data-command="project.create"]');
      await projectForm.locator('input[name="name"]').fill(createdName);
      const createResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/command" &&
          response.request().method() === "POST",
      );
      await projectForm.getByRole("button", { name: "Save" }).click();
      const created = await createResponse;
      assert.equal(created.status(), 303);
      assert.equal(created.headers().location, "/");
      assert.equal(
        (await page.locator("body").innerText()).includes(createdName),
        true,
      );
    } catch {
      failed = true;
      process.stderr.write(
        `Private-access proof failed during ${phase}; response data and credentials were suppressed\n`,
      );
    } finally {
      password = "";
      if (
        capacityRestore &&
        capacityChangeAttempted &&
        !capacityRestored &&
        context
      ) {
        try {
          const response = await context.request.post(
            `${config.origin}/runtime/control/capacity`,
            {
              headers: { origin: config.origin },
              form: {
                key: randomUUID(),
                globalLimit: String(capacityRestore.globalLimit),
                projectId: capacityRestore.projectId,
                projectLimit: String(capacityRestore.projectLimit),
                csrfToken: capacityRestore.csrfToken,
              },
            },
          );
          assert.equal(response.status(), 303);
          capacityRestored = true;
        } catch {
          failed = true;
          process.stderr.write(
            "Private-access capacity restoration was not confirmed; restore the disposable fixture before release\n",
          );
        }
      }
      if (signedIn && page) {
        try {
          phase = "browser logout cleanup";
          await page.goto(`${config.origin}/`);
          assert.equal(new URL(page.url()).origin, config.origin);
          const logoutResponse = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/logout" &&
              response.request().method() === "POST",
          );
          await page.getByRole("button", { name: "Log out" }).click();
          assert.equal((await logoutResponse).status(), 303);
        } catch {
          failed = true;
          process.stderr.write(
            "Private-access browser logout was not confirmed; stop the disposable fixture before release\n",
          );
        }
      }
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }

    if (failed) process.exitCode = 1;
    else
      process.stdout.write(
        "Private-access assertions and browser logout passed\n",
      );
  }
}
