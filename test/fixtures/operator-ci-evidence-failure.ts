import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { runBrowserJourney } from "./browser-diagnostics.js";
import { createOperatorFixture } from "./operator-web.js";

try {
  await runBrowserJourney(
    "ci-failure",
    "synthetic CI assertion failure",
    async (journey) => {
      const fixture = await journey.start("fixture.create", () =>
        createOperatorFixture(
          null,
          undefined,
          undefined,
          journey.fixtureOptions,
        ),
      );
      let browser: Browser | undefined;
      journey.cleanup(
        () => fixture.close(browser),
        "fixture.close",
        () => fixture.lifecycle.steps,
      );
      const web = await journey.start("fixture.web", () => fixture.startWeb());
      browser = await journey.start("browser.launch", () => chromium.launch());
      const page = await browser.newPage();
      journey.observe(page);
      await page.goto(`${web.origin}/login`);
      await page
        .getByRole("heading", { name: "Sign in", exact: true })
        .waitFor();
      await journey.capture(page, "synthetic-failure");
      process.stdout.write(
        "ensemble-test-evidence stdout synthetic-ci-probe\n",
      );
      process.stderr.write(
        "ensemble-test-evidence stderr synthetic-ci-probe\n",
      );
      process.stdout.write(
        "SYNTHETIC_PRIVATE_MARKER bearer=private-fixture-value\n",
      );
      await page.evaluate(() =>
        console.error("SYNTHETIC_PRIVATE_MARKER private page body"),
      );
      assert.fail("Injected CI browser assertion remains primary");
    },
  );
} catch (error) {
  if (
    error instanceof assert.AssertionError &&
    error.message === "Injected CI browser assertion remains primary"
  )
    process.stderr.write(`AssertionError [ERR_ASSERTION]: ${error.message}\n`);
  else process.stderr.write("synthetic-ci-probe unexpected failure\n");
  process.exitCode = 1;
}
