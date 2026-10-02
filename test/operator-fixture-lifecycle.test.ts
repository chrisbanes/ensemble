import { strict as assert } from "node:assert";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { Browser } from "playwright";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { FixtureCleanupError } from "./fixtures/fixture-lifecycle.js";
import type { FixtureLifecycle } from "./fixtures/fixture-lifecycle.js";
import { tmpdir } from "./temp.js";

// These synthetic failures never called the real stop operation. Release only
// their known test-owned resources; this is not recovery of an uncertain client.
async function disposeInjectedFailure(
  fixture: Awaited<ReturnType<typeof createOperatorFixture>>,
  webs: Awaited<ReturnType<typeof fixture.startWeb>>[] = [],
) {
  for (const web of webs) {
    await web.http.stop();
    web.auth.close();
  }
  await fixture.service.stop();
  await rm(fixture.directory, { recursive: true, force: true });
}

test("rejected disconnected browser close retains dependent fixture resources", async () => {
  const fixture = await createOperatorFixture();
  const web = await fixture.startWeb();
  const peer = connect(Number(new URL(web.origin).port), "127.0.0.1");
  peer.on("error", () => {});
  await once(peer, "connect");
  peer.write(`GET /app HTTP/1.1\r\nHost: ${new URL(web.origin).host}\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const browser = {
    isConnected: () => false,
    close: async () => {
      throw Error("Injected browser close rejection");
    },
  } as unknown as Browser;
  try {
    await assert.rejects(fixture.close(browser), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /browser.close.*failed.*\d.*ms/);
      return true;
    });
    await access(fixture.directory);
    assert.equal(
      peer.destroyed,
      false,
      "Disconnected Playwright mock leaves the real HTTP client live",
    );
    assert.equal((await fetch(web.origin)).status, 200);
    assert.ok(fixture.service.domain());
  } finally {
    peer.destroy();
    await disposeInjectedFailure(fixture, [web]);
  }
});

test("initial service and web startup share one fixture deadline", async () => {
  let finishProbe!: () => void;
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    startupTimeoutMs: 1200,
    cleanupTimeoutMs: 25,
    operation: async (name, operation) => {
      await operation();
      if (name === "service.start")
        await new Promise((resolve) => setTimeout(resolve, 750));
      if (name === "probe-1.start")
        await new Promise<void>((resolve) => {
          finishProbe = resolve;
        });
    },
  });
  try {
    await assert.rejects(fixture.startWeb(), /probe-1.start: timed-out/);
    const step = fixture.lifecycle.steps.find(
      (step) => step.name === "probe-1.start",
    );
    assert.ok(step);
    assert.ok(
      step.elapsedMs < 750,
      `Initial startup budget was reset: ${step.elapsedMs} ms`,
    );
    await assert.rejects(fixture.close(), /probe-1.close: dependency-skipped/);
  } finally {
    finishProbe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
  }
});

test("a stalled service startup preserves backing state until startup settles", async () => {
  let finish!: () => void;
  let failure: unknown;
  try {
    await createOperatorFixture(null, undefined, undefined, {
      startupTimeoutMs: 150,
      cleanupTimeoutMs: 25,
      operation: async (name, operation) => {
        await operation();
        if (name === "service.start")
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /service.start: timed-out after \d+ ms/);
  const fixture = (
    failure as Error & {
      fixture: Awaited<ReturnType<typeof createOperatorFixture>>;
    }
  ).fixture;
  assert.ok(fixture);
  try {
    await access(fixture.directory);
    assert.ok(fixture.service.domain());
    assert.equal(
      fixture.lifecycle.steps.find((step) => step.name === "service.stop")
        ?.status,
      "dependency-skipped",
    );
    await assert.rejects(fixture.close(), /service.stop: dependency-skipped/);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
    await assert.rejects(access(fixture.directory));
  } finally {
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
  }
});

test("a stalled web startup retains its resources while an independent listener closes", async () => {
  let finish!: () => void;
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    startupTimeoutMs: 1000,
    cleanupTimeoutMs: 25,
    operation: async (name, operation) => {
      await operation();
      if (name === "listener-2.start")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    },
  });
  const first = await fixture.startWeb();
  try {
    await assert.rejects(fixture.startWeb(), /listener-2.start: timed-out/);
    await assert.rejects(fixture.close(), /web-2.cleanup: dependency-skipped/);
    await assert.rejects(fetch(first.origin));
    await access(fixture.directory);
    assert.ok(fixture.service.domain());
    for (const name of [
      "listener-2.close",
      "auth-2.close",
      "service.stop",
      "directory.remove",
    ])
      assert.equal(
        fixture.lifecycle.steps.find((step) => step.name === name)?.status,
        "dependency-skipped",
        name,
      );
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
    await assert.rejects(access(fixture.directory));
  } finally {
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
  }
});

test("clean fixture teardown is idempotent and closes clients before listeners and state", async () => {
  const attempts: string[] = [];
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    operation: async (name, operation) => {
      attempts.push(name);
      await operation();
    },
  });
  const web = await fixture.startWeb();
  const browser = { close: async () => {} } as unknown as Browser;
  await fixture.close(browser);
  await web.close();
  await fixture.close(browser);
  await assert.rejects(access(fixture.directory));
  assert.deepEqual(
    attempts.filter(
      (name) =>
        name === "browser.close" ||
        name === "listener-1.close" ||
        name === "auth-1.close" ||
        name === "service.stop" ||
        name === "directory.remove",
    ),
    [
      "browser.close",
      "listener-1.close",
      "auth-1.close",
      "service.stop",
      "directory.remove",
    ],
  );
});

test("a rejected service stop leaves its backing directory intact", async () => {
  let rejectStop = true;
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    operation: async (name, operation) => {
      if (name === "service.stop" && rejectStop)
        throw Error("Injected service stop rejection");
      await operation();
    },
  });
  try {
    await assert.rejects(fixture.close(), /service.stop: failed after \d+ ms/);
    await access(fixture.directory);
    assert.equal(
      fixture.lifecycle.steps.find((step) => step.name === "directory.remove")
        ?.status,
      "dependency-skipped",
    );
  } finally {
    rejectStop = false;
    await disposeInjectedFailure(fixture);
  }
});

test("a rejected partial service startup reports its completed cleanup", async () => {
  let failure: unknown;
  try {
    await createOperatorFixture(null, undefined, undefined, {
      operation: async (name, operation) => {
        await operation();
        if (name === "service.start")
          throw Error("Injected partial service startup rejection");
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /Injected partial service startup rejection/);
  const fixture = (
    failure as Error & {
      fixture: Awaited<ReturnType<typeof createOperatorFixture>>;
    }
  ).fixture;
  assert.ok(fixture, "Startup failure must retain cleanup diagnostics");
  await assert.rejects(access(fixture.directory));
  assert.equal(
    fixture.lifecycle.steps.find((step) => step.name === "service.stop")
      ?.status,
    "completed",
  );
  assert.equal(
    fixture.lifecycle.steps.find((step) => step.name === "directory.remove")
      ?.status,
    "completed",
  );
});

test("a timed-out directory allocation retains ownership for eventual cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-lifecycle-startup-"));
  const oldTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  let finish: (() => void) | undefined;
  try {
    let failure: unknown;
    try {
      await createOperatorFixture(null, undefined, undefined, {
        startupTimeoutMs: 25,
        operation: async (name, operation) => {
          await operation();
          if (name === "directory.create")
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /directory.create: timed-out/);
    const fixture = (
      failure as Error & {
        fixture: {
          directory: string;
          lifecycle: FixtureLifecycle;
          close: () => Promise<void>;
        };
      }
    ).fixture;
    assert.ok(fixture, "Timed-out allocation must retain a cleanup owner");
    await access(fixture.directory);
    await assert.rejects(
      fixture.close(),
      /directory.remove: dependency-skipped/,
    );
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
    await assert.rejects(access(fixture.directory));
  } finally {
    finish?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected partial web startup still owns its listener and auth", async () => {
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    operation: async (name, operation) => {
      await operation();
      if (name === "listener-1.start")
        throw Error("Injected partial web startup rejection");
    },
  });
  try {
    await assert.rejects(
      fixture.startWeb(),
      /Injected partial web startup rejection/,
    );
  } finally {
    await fixture.close();
  }
  await assert.rejects(access(fixture.directory));
  for (const name of [
    "listener-1.close",
    "auth-1.close",
    "service.stop",
    "directory.remove",
  ])
    assert.equal(
      fixture.lifecycle.steps.find((step) => step.name === name)?.status,
      "completed",
      name,
    );
});

test("stalled listener close bounds both entry points and retains a late rejection", async () => {
  let reject!: (error: Error) => void;
  const attempts: string[] = [];
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    cleanupTimeoutMs: 25,
    operation: async (name, operation) => {
      attempts.push(name);
      if (name === "listener-1.close")
        await new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      else await operation();
    },
  });
  const first = await fixture.startWeb();
  const second = await fixture.startWeb();
  try {
    await assert.rejects(first.close(), /listener-1.close: timed-out/);
    await assert.rejects(fixture.close(), /listener-1.close: timed-out/);
    assert.equal(
      attempts.filter((name) => name === "listener-1.close").length,
      1,
    );
    assert.equal(
      attempts.filter((name) => name === "listener-2.close").length,
      1,
    );
    assert.equal((await fetch(first.origin)).status, 200);
    await assert.rejects(fetch(second.origin));
    await access(fixture.directory);
    reject(Error("Injected late listener rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const step = fixture.lifecycle.steps.find(
      (step) => step.name === "listener-1.close",
    );
    assert.equal(step?.status, "timed-out");
    assert.equal(step.eventual?.status, "failed");
    assert.match(
      String(step.eventual.error),
      /Injected late listener rejection/,
    );
  } finally {
    reject?.(Error("Release test-owned deferred close"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await disposeInjectedFailure(fixture, [first, second]);
  }
});

test("a stalled browser close remains uncertain until its eventual completion", async () => {
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    cleanupTimeoutMs: 25,
  });
  const web = await fixture.startWeb();
  let finish!: () => void;
  let attempts = 0;
  const browser = {
    isConnected: () => false,
    close: () => {
      attempts++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  } as unknown as Browser;
  try {
    const started = performance.now();
    await assert.rejects(
      fixture.close(browser),
      /browser.close: timed-out after \d+ ms/,
    );
    assert.ok(performance.now() - started < 500);
    await assert.rejects(fixture.close(), /browser.close: timed-out/);
    assert.equal(attempts, 1);
    await access(fixture.directory);
    assert.equal((await fetch(web.origin)).status, 200);
    const step = fixture.lifecycle.steps.find(
      (step) => step.name === "browser.close",
    );
    assert.equal(step?.status, "timed-out");
    assert.equal(step.eventual, undefined);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      fixture.lifecycle.steps.find((step) => step.name === "browser.close")
        ?.eventual?.status,
      "completed",
    );
    await fixture.close();
    await assert.rejects(access(fixture.directory));
  } finally {
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.close();
  }
});

test("one rejected listener preserves the primary assertion and closes an independent listener", async () => {
  const attempts: string[] = [];
  let rejectClose = true;
  const fixture = await createOperatorFixture(null, undefined, undefined, {
    operation: async (name: string, operation: () => Promise<void>) => {
      attempts.push(name);
      if (name === "listener-1.close" && rejectClose)
        throw Error("Injected listener close rejection");
      await operation();
    },
  });
  const first = await fixture.startWeb();
  const second = await fixture.startWeb();
  const primary = Error("Injected primary browser assertion");
  try {
    await assert.rejects(
      fixture.close(undefined, primary),
      (error: unknown) => {
        assert.equal(error, primary);
        assert.ok(primary.cause instanceof FixtureCleanupError);
        assert.match(
          primary.cause.message,
          /listener-1.close: failed after \d+ ms/,
        );
        assert.match(primary.cause.message, /service.stop: dependency-skipped/);
        assert.match(
          primary.cause.message,
          /directory.remove: dependency-skipped/,
        );
        return true;
      },
    );
    assert.equal(
      attempts.filter((name) => name === "listener-1.close").length,
      1,
    );
    assert.equal(
      attempts.filter((name) => name === "listener-2.close").length,
      1,
    );
    assert.equal((await fetch(first.origin)).status, 200);
    await assert.rejects(fetch(second.origin));
    await access(fixture.directory);
    assert.ok(fixture.service.domain());
    rejectClose = false;
    await assert.rejects(fixture.close(), /listener-1.close: failed/);
    assert.equal(
      attempts.filter((name) => name === "listener-1.close").length,
      1,
    );
    await access(fixture.directory);
  } finally {
    await disposeInjectedFailure(fixture, [first, second]);
  }
});
