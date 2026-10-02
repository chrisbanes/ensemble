import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import { chromium } from "playwright";
import { runBrowserJourney } from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { tmpdir } from "./temp.js";

test("timed-out execution preserves a live client and writes sanitized bounded diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-browser-diagnostics-"));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const secret = "SYNTHETIC_SECRET_MUST_NOT_BE_ARTIFACTED";
  let finish!: () => void;
  let cleanups = 0;
  let callbackFinished!: () => void;
  const callbackDone = new Promise<void>((resolve) => {
    callbackFinished = resolve;
  });
  let guardian: ReturnType<typeof setTimeout> | number | undefined;
  const started = performance.now();
  const pending = runBrowserJourney(
    "diagnostics",
    "synthetic stalled action",
    async (journey) => {
      journey.observe(page);
      journey.cleanup(async () => {
        cleanups++;
        await browser.close();
      });
      const pageError = page.waitForEvent("pageerror");
      await page.evaluate((marker) => {
        console.error(`fixture-console-error ${marker}`);
        setTimeout(() => {
          throw new TypeError(`fixture-page-error ${marker}`);
        }, 0);
      }, secret);
      await pageError;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      assert.equal(await journey.capture(page, "late-screenshot"), undefined);
      callbackFinished();
    },
    {
      executionMs: 100,
      overallMs: 350,
      cleanupStepMs: 100,
      evidenceRoot: root,
    },
  );
  try {
    const failure = await Promise.race([
      pending.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<undefined>((resolve) => {
        guardian = setTimeout(resolve, 1000);
      }),
    ]);
    assert.ok(
      failure instanceof Error,
      "Journey must stop waiting at its own deadline",
    );
    assert.match(failure.message, /execution.*timed-out.*\d+ ms/);
    assert.ok(performance.now() - started < 350 + 100);
    assert.equal(cleanups, 0);
    assert.equal(browser.isConnected(), true);
    const directory = (failure as Error & { evidenceDirectory: string })
      .evidenceDirectory;
    const manifest = await readFile(join(directory, "manifest.json"), "utf8");
    assert.doesNotMatch(manifest, new RegExp(secret));
    const evidence = JSON.parse(manifest);
    assert.equal(evidence.phases.execution.status, "timed-out");
    assert.ok(evidence.phases.execution.elapsedMs >= 80);
    assert.equal(evidence.cleanup.incomplete, true);
    assert.equal(evidence.cleanup.steps[0].status, "dependency-skipped");
    assert.match(manifest, /console-error|pageerror-TypeError/);
    finish();
    await callbackDone;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const phases = (
      failure as Error & {
        phases?: {
          execution: { status: string; eventual?: { status: string } };
        };
      }
    ).phases;
    assert.ok(
      phases,
      "The underlying operation outcome must remain observable",
    );
    assert.equal(phases?.execution.status, "timed-out");
    assert.equal(phases.execution.eventual?.status, "completed");
    assert.equal(
      await readFile(join(directory, "manifest.json"), "utf8"),
      manifest,
    );
    assert.equal(
      (await readdir(directory)).includes("late-screenshot.png"),
      false,
    );
    assert.equal(cleanups, 0);
  } finally {
    clearTimeout(guardian);
    finish?.();
    await pending.catch(() => {});
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("screenshot failure remains secondary and a non-diagnostic root is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-screenshot-failure-"));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.close();
  const original = Error("Original assertion after screenshot failure");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "closed synthetic page",
        async (journey) => {
          await journey.capture(page, "closed-page");
          throw original;
        },
        { evidenceRoot: root },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String(original.cause.errors[1]),
          /evidence.screenshot: failed/,
        );
        return true;
      },
    );
    const privateRoot = await mkdtemp(join(root, "fixture-"));
    await writeFile(
      join(privateRoot, "private-fixture.sqlite"),
      "SYNTHETIC_PRIVATE_FIXTURE",
    );
    let ran = false;
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "unowned root",
        async () => {
          ran = true;
        },
        { evidenceRoot: privateRoot },
      ),
      /dedicated to test diagnostics/,
    );
    assert.equal(ran, false);
    assert.deepEqual(await readdir(privateRoot), ["private-fixture.sqlite"]);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local listener rejection preserves the assertion and backing state while other listeners close", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-local-cleanup-"));
  const calls: string[] = [];
  const original = Error("Original local fixture assertion");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "local listener failure",
        async (journey) => {
          journey.ownLocal({
            browser: async () => {
              calls.push("browser");
            },
            listeners: [
              {
                name: "first.close",
                close: async () => {
                  calls.push("first");
                  throw Error("Injected listener rejection");
                },
              },
              {
                name: "second.close",
                close: async () => {
                  calls.push("second");
                },
              },
            ],
            auth: () => {
              calls.push("auth");
            },
            state: async () => {
              calls.push("state");
            },
            directory: () => {
              calls.push("directory");
            },
          });
          throw original;
        },
        { evidenceRoot: root },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String((original.cause.errors[1] as Error).cause),
          /first.close: failed|state.close: dependency-skipped/,
        );
        return true;
      },
    );
    assert.deepEqual(calls, ["browser", "first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence write failure remains secondary to the original assertion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-write-diagnostics-"));
  const original = Error("Original synthetic assertion must remain primary");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "synthetic evidence failure",
        async () => {
          throw original;
        },
        {
          evidenceRoot: root,
          writeEvidence: async () => {
            throw Error("Injected evidence write rejection");
          },
        },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.match(original.message, /Original synthetic assertion/);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String(original.cause.errors[1]),
          /evidence.write: failed/,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled local listener leaves auth and backing state held while its sibling closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-stalled-local-"));
  const calls: string[] = [];
  let finish!: () => void;
  const original = Error("Original local assertion with pending listener");
  try {
    await assert.rejects(
      runBrowserJourney(
        "diagnostics",
        "stalled local listener",
        async (journey) => {
          journey.ownLocal({
            browser: async () => {
              calls.push("browser");
            },
            listeners: [
              {
                name: "first.close",
                close: () =>
                  new Promise<void>((resolve) => {
                    calls.push("first");
                    finish = resolve;
                  }),
              },
              {
                name: "second.close",
                close: async () => {
                  calls.push("second");
                },
              },
            ],
            auth: () => {
              calls.push("auth");
            },
            state: async () => {
              calls.push("state");
            },
            directory: () => {
              calls.push("directory");
            },
          });
          throw original;
        },
        { evidenceRoot: root, cleanupStepMs: 20, overallMs: 250 },
      ),
      (error: unknown) => {
        assert.equal(error, original);
        assert.ok(original.cause instanceof AggregateError);
        assert.match(
          String((original.cause.errors[1] as Error).cause),
          /first.close: timed-out.*auth.close: dependency-skipped/,
        );
        return true;
      },
    );
    assert.deepEqual(calls, ["browser", "first", "second"]);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["browser", "first", "second"]);
  } finally {
    finish?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("UI02 UI03 and UI06 screenshots stay in distinct configured evidence directories", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "ensemble-screenshot-diagnostics-"),
  );
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<h1>Synthetic browser fixture</h1>");
  const paths: string[] = [];
  try {
    for (const suite of ["ui02", "ui03", "ui06"]) {
      const result = await runBrowserJourney(
        suite,
        "same synthetic screenshot",
        async (journey) => {
          const filename = await journey.capture(page, "synthetic-screen");
          assert.ok(filename);
          assert.ok(
            filename?.startsWith(join(root, `${suite}-${process.pid}`)),
          );
          paths.push(filename);
          const image = await readFile(filename);
          assert.equal(
            image.subarray(0, 8).toString("hex"),
            "89504e470d0a1a0a",
          );
        },
        { evidenceRoot: root },
      );
      assert.ok(result.evidenceDirectory.startsWith(root));
    }
    assert.equal(new Set(paths).size, 3);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("overall expiry bounds a stalled cleanup and labels its uncertain outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-overall-diagnostics-"));
  let finish!: () => void;
  const started = performance.now();
  try {
    let failure: unknown;
    try {
      await runBrowserJourney(
        "diagnostics",
        "synthetic stalled cleanup",
        async (journey) => {
          journey.cleanup(
            () =>
              new Promise<void>((resolve) => {
                finish = resolve;
              }),
          );
        },
        {
          executionMs: 50,
          overallMs: 150,
          cleanupStepMs: 1000,
          evidenceRoot: root,
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /overall.*timed-out.*\d+ ms/);
    assert.ok(performance.now() - started < 250);
    const directory = (failure as Error & { evidenceDirectory: string })
      .evidenceDirectory;
    const evidence = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    assert.equal(evidence.phases.execution.status, "completed");
    assert.equal(evidence.phases.overall.status, "timed-out");
    assert.equal(evidence.cleanup.incomplete, true);
    assert.equal(evidence.cleanup.steps[0].status, "timed-out");
  } finally {
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("partial shared startup retains its original owner and reports rejected cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-partial-diagnostics-"));
  let original: (Error & { fixture?: { directory: string } }) | undefined;
  try {
    let failure: unknown;
    try {
      await runBrowserJourney(
        "diagnostics",
        "partial fixture startup",
        async (journey) => {
          await journey.start("fixture.create", async () => {
            try {
              return await createOperatorFixture(null, undefined, undefined, {
                operation: async (name, operation) => {
                  if (name === "service.start" || name === "directory.remove")
                    throw Error(`Injected ${name} rejection`);
                  await operation();
                },
              });
            } catch (error) {
              original = error as Error & { fixture?: { directory: string } };
              throw error;
            }
          });
        },
        { evidenceRoot: root },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(original?.fixture);
    assert.equal(failure, original);
    const directory = (failure as Error & { evidenceDirectory: string })
      .evidenceDirectory;
    const evidence = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    assert.equal(evidence.cleanup.incomplete, true);
    assert.ok(
      evidence.cleanup.steps.some(
        (step: { name: string; status: string }) =>
          step.name === "directory.remove" && step.status === "failed",
      ),
    );
  } finally {
    // The injected removal rejected before touching the known synthetic directory.
    if (original?.fixture)
      await rm(original.fixture.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
