import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { availableParallelism, constants } from "node:os";
import {
  createTestEvidenceDirectory,
  writeTestEvidence,
} from "../dist/test/fixtures/browser-diagnostics.js";

function diagnosticStream() {
  const result = { lines: [], omitted: 0, truncated: 0 };
  let pending = "",
    dropping = false,
    ended = false;
  const line = () => {
    const value = pending.replace(/^# /, "").trim();
    pending = "";
    const allowed =
      /^(ensemble-test-evidence (stdout|stderr) synthetic-ci-probe|AssertionError \[ERR_ASSERTION\]: Injected CI browser assertion remains primary|[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo) \d+)$/.test(
        value,
      );
    if (allowed && result.lines.length < 40) result.lines.push(value);
    else result.omitted++;
  };
  return {
    add(chunk) {
      if (ended) return;
      for (const character of chunk.toString("utf8")) {
        if (character === "\n") {
          if (!dropping) line();
          pending = "";
          dropping = false;
        } else if (!dropping) {
          if (pending.length === 4096) {
            pending = "";
            dropping = true;
            result.truncated++;
          } else pending += character;
        }
      }
    },
    finish() {
      if (!ended && pending && !dropping) line();
      ended = true;
      return result;
    },
  };
}

export async function runTestProcess(args, options = {}) {
  const started = performance.now();
  const deadlineMs = options.deadlineMs ?? 600000;
  const graceMs = options.graceMs ?? 5000;
  const forceWaitMs = options.forceWaitMs ?? 5000;
  for (const limit of [deadlineMs, graceMs, forceWaitMs])
    if (!Number.isFinite(limit) || limit <= 0)
      throw Error("Runner deadlines must be finite positive milliseconds");
  // Only tests transfer a ready child, together with its exact creation grant.
  const group = options.ownedChild
    ? options.ownedChild.ownsGroup
    : process.platform !== "win32";
  if (typeof group !== "boolean")
    throw Error("Transferred test child requires its group ownership grant");
  const child =
    options.ownedChild?.child ??
    spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
    });
  const pid = child.pid;
  if (
    options.ownedChild &&
    (options.ownedChild.pid !== pid ||
      child.exitCode !== null ||
      child.signalCode !== null)
  )
    throw Error(
      "Transferred test child must retain its live creation identity",
    );
  const stdout = diagnosticStream(),
    stderr = diagnosticStream();
  child.stdout.on("data", (chunk) => {
    stdout.add(chunk);
    if (options.forwardOutput) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.add(chunk);
    if (options.forwardOutput) process.stderr.write(chunk);
  });
  const closed = new Promise((resolve) =>
    child.once("close", () => resolve(true)),
  );
  let observed;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      observed = { code, signal };
      resolve(observed);
    });
    child.once("error", () => {
      observed = { code: null, signal: null, spawnFailed: true };
      resolve(observed);
    });
  });
  const wait = async (milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const terminationSignals = [];
  const signalOwned = (signal) => {
    if (
      observed ||
      !pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    try {
      if (group) process.kill(-pid, signal);
      else child.kill(signal);
      terminationSignals.push(signal);
    } catch {
      /* An unsuccessful signal is not proof of exit. */
    }
  };
  let interrupted;
  let interrupt;
  const interruption = new Promise((resolve) => {
    interrupt = resolve;
  });
  const handlers = new Map();
  if (options.forwardSignals)
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const handler = () => {
        interrupted ??= signal;
        interrupt({ interrupted: true });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  let deadlineTimer;
  const first = await Promise.race([
    exited,
    interruption,
    new Promise((resolve) => {
      deadlineTimer = setTimeout(
        resolve,
        Math.max(1, deadlineMs - (performance.now() - started)),
      );
    }),
  ]);
  clearTimeout(deadlineTimer);
  const timedOut = first === undefined;
  if (timedOut || interrupted) {
    signalOwned("SIGTERM");
    if (!(await wait(graceMs))) {
      signalOwned("SIGKILL");
      await wait(forceWaitMs);
    }
  }
  let drainTimer;
  const outputComplete = await Promise.race([
    closed,
    new Promise((resolve) => {
      drainTimer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  clearTimeout(drainTimer);
  child.stdout.destroy();
  child.stderr.destroy();
  if (!observed) child.unref();
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return {
    code: observed?.code ?? null,
    signal: observed?.signal ?? null,
    pid: pid ?? null,
    signalTarget: group ? "owned-process-group" : "owned-root-child",
    exitObserved: Boolean(observed && !observed.spawnFailed),
    spawnFailed: Boolean(observed?.spawnFailed),
    timedOut,
    interrupted: interrupted ?? null,
    ownershipHeld: !observed,
    elapsedMs: Math.round(performance.now() - started),
    limits: {
      deadlineMs,
      gracefulFollowupMs: graceMs,
      forcedFollowupMs: forceWaitMs,
    },
    terminationSignals,
    stdout: stdout.finish(),
    stderr: stderr.finish(),
    outputComplete,
    eventualExit: exited,
  };
}

export function runnerStatus(result) {
  if (result.timedOut) return result.exitObserved ? 124 : 125;
  if (result.interrupted)
    return result.exitObserved
      ? result.interrupted === "SIGINT"
        ? 130
        : 143
      : 125;
  return result.exitObserved
    ? (result.code ??
        (result.signal && constants.signals[result.signal]
          ? 128 + constants.signals[result.signal]
          : 1))
    : 125;
}

export async function recordRunnerEvidence(result, name, evidenceRoot) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const directory = await createTestEvidenceDirectory(
          "test-runner",
          name,
          evidenceRoot,
        );
        const { eventualExit: _eventualExit, ...manifest } = result;
        await writeTestEvidence(
          directory,
          "manifest.json",
          JSON.stringify(
            {
              ...manifest,
              wrapperStatus: runnerStatus(result),
              exitProof: "owned root child only",
            },
            null,
            2,
          ),
        );
        for (const stream of ["stdout", "stderr"])
          await writeTestEvidence(
            directory,
            `${stream}.sanitized.log`,
            `${result[stream].lines.join("\n")}\nomitted=${result[stream].omitted} truncated=${result[stream].truncated}\n`,
          );
        return directory;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Runner evidence wait ended after 5000ms")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const mode = process.argv.slice(2);
  if (
    mode.length > 1 ||
    (mode.length === 1 && mode[0] !== "--fixture-preflight")
  )
    throw Error("Only --fixture-preflight is supported");
  const preflight = mode.length === 1;
  const files = preflight
    ? [
        "dist/test/operator-fixture-preflight.test.js",
        "dist/test/operator-web-browser.test.js",
      ]
    : globSync("dist/test/*.test.js").sort();
  if (!files.length) throw Error("No compiled test files found");
  // Bound concurrent Git/browser/capture fixtures while preserving production
  // observation deadlines under aggregate test-runner resource contention.
  const concurrency = Math.max(1, Math.min(4, availableParallelism() - 1));
  const args = [
    "--test",
    `--test-concurrency=${concurrency}`,
    ...(preflight
      ? [
          "--test-name-pattern=fixture preflight|failed browser assertion surfaces",
        ]
      : []),
    ...files,
  ];
  const result = await runTestProcess(args, {
    forwardOutput: true,
    forwardSignals: true,
  });
  try {
    await recordRunnerEvidence(
      result,
      preflight ? "fixture preflight" : "complete test suite",
    );
  } catch {
    process.stderr.write("Runner evidence incomplete\n");
    process.exitCode = runnerStatus(result) || 1;
    return;
  }
  process.exitCode = runnerStatus(result);
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
)
  await main();
