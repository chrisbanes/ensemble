import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { CodexRuntime } from "../../dist/src/standalone/index.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import { CaptureObserver } from "../../dist/test/s05/capture-observer.js";
import { tmpdir } from "../../dist/test/temp.js";

const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
if (!args.includes("--live")) {
  process.stderr.write("Refusing live Codex execution without --live.\n");
  process.exit(2);
}
if (
  !new Set([
    "capture",
    "repository",
    "repository-free",
    "local-dependency",
  ]).has(mode)
) {
  process.stderr.write(
    "Refusing live journey: --mode must be capture, repository, repository-free, or local-dependency.\n",
  );
  process.exit(2);
}

if (mode !== "capture") {
  const { runLiveJourney } = await import("./live-journey-ui.mjs");
  await runLiveJourney(mode);
} else {
  const marker = "S05_CAPTURE_OK";
  const evidence = {
    mode,
    source: {},
    runtime: { threadId: null, turnId: null, processIdentity: null },
    projection: {
      started: 0,
      deltas: 0,
      deltaBytes: 0,
      completed: 0,
      omitted: 0,
      identities: [],
      markerMatched: false,
      oneTurnIdentity: true,
      otherObservedTurns: 0,
      otherTurns: [],
      droppedTurnEvents: 0,
    },
    terminal: null,
    cleanup: { appServerExitVerified: false, fixtureRemoved: false },
    limitations: {
      typeSafe: "not invoked",
      workspace: "empty disposable capture root; no task files requested",
      history: "only counts, item identities and marker match are reported",
      providerThread: "not deleted by this harness",
    },
    failure: null,
  };

  let runtime;
  let root;
  let stage = "source-identity";

  function command(file, argv) {
    return execFileSync(file, argv, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  function processEvidence(identity) {
    return identity
      ? {
          processId: identity.processId,
          processStartedAt: identity.processStartedAt,
          bootId: identity.bootId,
        }
      : null;
  }

  function bounded(action, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("capture timed out")),
        milliseconds,
      );
      action.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          reject(new Error("capture failed"));
        },
      );
    });
  }

  async function verifyExited(identity) {
    if (!identity) return { kind: "unproved" };
    const verifier = new MacProcessTerminationVerifier();
    const deadline = Date.now() + 10_000;
    let latest;
    do {
      latest = await verifier.verify(identity);
      if (latest.kind === "verified") return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return latest;
  }

  async function run() {
    evidence.source = {
      revision: command("git", ["rev-parse", "HEAD"]),
      codexRuntimeSha256: createHash("sha256")
        .update(readFileSync("src/standalone/codex.ts"))
        .digest("hex"),
      compiledCodexRuntimeSha256: createHash("sha256")
        .update(readFileSync("dist/src/standalone/codex.js"))
        .digest("hex"),
      node: process.version,
      packageManager: "npm@12.1.0 (package.json pin)",
      codex: command("codex", ["--version"]),
    };

    stage = "disposable-root";
    root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s05-capture-")));
    chmodSync(root, 0o700);

    stage = "existing-login-runtime";
    runtime = new CodexRuntime();
    const capture = new CaptureObserver(marker);
    runtime.onConversationEvent((event) => capture.observe(event));
    await bounded(runtime.start(), 30_000);
    const processIdentity = await runtime.processIdentity();
    evidence.runtime.processIdentity = processEvidence(processIdentity);
    if (!processIdentity) throw new Error("process identity unavailable");

    stage = "capture-thread-and-turn";
    const expectedThreadId = await runtime.startThread(root);
    capture.bindThread(expectedThreadId);
    evidence.runtime.threadId = expectedThreadId;
    const turnId = await runtime.startTurn(
      expectedThreadId,
      root,
      `Reply with the exact marker ${marker} and no other text. Do not use tools or modify files.`,
    );
    evidence.runtime.turnId = turnId;
    capture.bindTurn(turnId);
    evidence.terminal = await bounded(
      runtime.waitForTurn(expectedThreadId, turnId),
      240_000,
    );
    const observed = capture.snapshot();
    const targetTurn = observed.targetTurn;
    if (targetTurn) {
      Object.assign(evidence.projection, targetTurn);
      evidence.projection.otherTurns = observed.otherTurns;
      evidence.projection.otherObservedTurns = observed.otherTurns.length;
    }
    evidence.projection.oneTurnIdentity = targetTurn !== null;
    evidence.projection.droppedTurnEvents = observed.droppedTurnEvents;
    if (evidence.terminal !== "completed")
      throw new Error("turn did not complete");
    if (!evidence.projection.markerMatched)
      throw new Error("capture marker not observed");
    if (
      evidence.projection.started < 1 ||
      evidence.projection.deltas < 1 ||
      evidence.projection.completed < 1 ||
      evidence.projection.deltaBytes < 1 ||
      !evidence.projection.oneTurnIdentity
    )
      throw new Error("required stream lifecycle was not observed");
  }

  try {
    await run();
  } catch {
    evidence.failure = stage;
  } finally {
    if (runtime) {
      try {
        await runtime.stop();
      } catch {
        evidence.failure ??= "runtime-cleanup";
      }
    }
    if (evidence.runtime.processIdentity) {
      const exited = await verifyExited({
        processId: evidence.runtime.processIdentity.processId,
        processStartedAt: evidence.runtime.processIdentity.processStartedAt,
        bootId: evidence.runtime.processIdentity.bootId,
      });
      evidence.cleanup.appServerExitVerified = exited.kind === "verified";
    }
    if (evidence.cleanup.appServerExitVerified && root && existsSync(root)) {
      rmSync(root, { recursive: true, force: false });
      evidence.cleanup.fixtureRemoved = !existsSync(root);
    }
  }

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.failure || !evidence.cleanup.fixtureRemoved)
    process.exitCode = 1;
}
