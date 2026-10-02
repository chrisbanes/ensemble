import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  test as nodeTest,
  type TestContext,
  type TestOptions,
} from "node:test";
import type { Page } from "playwright";
import { tmpdir } from "../temp.js";
import {
  FixtureLifecycle,
  FixtureStartupError,
  fixtureStepCompleted,
  fixtureStepPending,
  throwFixtureCleanup,
  type FixtureStep,
  type FixtureLifecycleOptions,
} from "./fixture-lifecycle.js";

export const browserEvidenceLimits = {
  files: 24,
  screenshotBytes: 2 * 1024 * 1024,
  bytes: 8 * 1024 * 1024,
  diagnostics: 40,
  metadataBytes: 65536,
};
export interface BrowserJourneyOptions {
  executionMs?: number;
  overallMs?: number;
  cleanupStepMs?: number;
  startupMs?: number;
  evidenceRoot?: string;
  writeEvidence?: (
    filename: string,
    data: string | Uint8Array,
  ) => Promise<void>;
}
type Cleanup = {
  name: string;
  operation: (primary?: unknown) => Promise<void>;
  steps?: () => FixtureStep[];
};
interface LocalFixture {
  browser: () => Promise<void>;
  listeners: Array<{ name: string; close: () => Promise<void> }>;
  auth?: () => void;
  state?: () => Promise<void>;
  directory?: () => void;
}
export class BrowserJourney {
  readonly cleanups: Cleanup[] = [];
  readonly diagnostics: string[] = [];
  readonly evidenceFailures: Error[] = [];
  readonly lifecycle = new FixtureLifecycle();
  omittedDiagnostics = 0;
  omittedScreenshots = 0;
  omittedEvidenceFailures = 0;
  active = true;
  uncertainStartup = false;
  partialLifecycle: FixtureLifecycle | undefined;
  private screenshotBytes = 0;
  private readonly screenshots = new Set<string>();
  private startupDeadline: number | undefined;
  private evidenceFailure(failure: Error) {
    if (this.evidenceFailures.length < browserEvidenceLimits.diagnostics)
      this.evidenceFailures.push(failure);
    else this.omittedEvidenceFailures++;
  }
  constructor(
    readonly directory: string,
    private readonly write: (
      filename: string,
      data: string | Uint8Array,
    ) => Promise<void>,
    private readonly startupMs: number,
    private readonly cleanupStepMs: number,
    private readonly cleanupDeadline: number,
  ) {}
  get fixtureOptions(): FixtureLifecycleOptions {
    const journey = this;
    return {
      startupTimeoutMs: this.startupMs,
      get cleanupTimeoutMs() {
        return Math.max(
          1,
          Math.min(
            journey.cleanupStepMs,
            journey.cleanupDeadline - performance.now(),
          ),
        );
      },
      async operation(_name, operation) {
        if (performance.now() >= journey.cleanupDeadline)
          throw Error("overall: cleanup deadline expired");
        await operation();
      },
    };
  }
  async start<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.startupDeadline ??= performance.now() + this.startupMs;
    const remaining = this.startupDeadline - performance.now();
    if (remaining <= 0)
      throw new FixtureStartupError(this.lifecycle.skip(name, "startup"));
    let value!: T;
    const step = await this.lifecycle.attempt(
      name,
      "startup",
      async () => {
        value = await operation();
      },
      remaining,
    );
    if (!fixtureStepCompleted(step)) {
      if (step.status === "timed-out") this.uncertainStartup = true;
      if (step.error instanceof Error) {
        const error = step.error;
        if (
          "fixture" in error &&
          error.fixture &&
          typeof error.fixture === "object" &&
          "lifecycle" in error.fixture &&
          error.fixture.lifecycle instanceof FixtureLifecycle
        ) {
          this.partialLifecycle = error.fixture.lifecycle;
          this.uncertainStartup ||=
            this.partialLifecycle.steps.some(fixtureStepPending);
        }
        throw error;
      }
      throw new FixtureStartupError(step);
    }
    return value;
  }
  /** Tests deliberately restarting an owner begin another bounded startup sequence. */
  restart() {
    this.startupDeadline = undefined;
  }
  async closeStep(
    name: string,
    operation: () => Promise<void> | void,
    lifecycle = this.lifecycle,
  ): Promise<void> {
    const remaining = this.cleanupDeadline - performance.now();
    const step =
      remaining > 0
        ? await lifecycle.attempt(
            name,
            "cleanup",
            async () => operation(),
            Math.min(this.cleanupStepMs, remaining),
          )
        : lifecycle.skip(name);
    throwFixtureCleanup([step]);
  }
  cleanup(
    operation: Cleanup["operation"],
    name = "fixture.close",
    steps?: () => FixtureStep[],
  ) {
    this.cleanups.push({ name, operation, ...(steps ? { steps } : {}) });
  }
  ownLocal(fixture: LocalFixture) {
    this.cleanup(
      async (primary) => {
        const steps: FixtureStep[] = [];
        const attempt = async (
          name: string,
          operation: () => Promise<void>,
        ) => {
          const remaining = this.cleanupDeadline - performance.now();
          const step =
            remaining > 0
              ? await this.lifecycle.attempt(
                  name,
                  "cleanup",
                  operation,
                  Math.min(this.cleanupStepMs, remaining),
                )
              : this.lifecycle.skip(name);
          steps.push(step);
          return fixtureStepCompleted(step);
        };
        const skip = (name: string) => steps.push(this.lifecycle.skip(name));
        const clientClosed = await attempt("browser.close", fixture.browser);
        let listenersClosed = clientClosed;
        for (const listener of fixture.listeners) {
          if (clientClosed)
            listenersClosed =
              (await attempt(listener.name, listener.close)) && listenersClosed;
          else skip(listener.name);
        }
        let authClosed = listenersClosed;
        if (fixture.auth) {
          if (listenersClosed)
            authClosed = await attempt("auth.close", async () =>
              fixture.auth?.(),
            );
          else skip("auth.close");
        }
        let stateClosed = listenersClosed && authClosed;
        if (fixture.state) {
          if (stateClosed)
            stateClosed = await attempt("state.close", fixture.state);
          else skip("state.close");
        }
        if (fixture.directory) {
          if (stateClosed)
            await attempt("directory.remove", async () =>
              fixture.directory?.(),
            );
          else skip("directory.remove");
        }
        throwFixtureCleanup(steps, primary);
      },
      "local-fixture.close",
      () => this.lifecycle.steps,
    );
  }
  observe(page: Page) {
    const record = (diagnostic: string) => {
      if (!this.active) return;
      if (this.diagnostics.length < browserEvidenceLimits.diagnostics)
        this.diagnostics.push(diagnostic);
      else this.omittedDiagnostics++;
    };
    page.on("console", (message) => {
      if (["error", "warning", "assert"].includes(message.type()))
        record(`console-${message.type()}`);
      else if (this.active) this.omittedDiagnostics++;
    });
    page.on("pageerror", (error) => {
      const name = [
        "Error",
        "TypeError",
        "ReferenceError",
        "SyntaxError",
        "RangeError",
      ].includes(error.name)
        ? error.name
        : "Error";
      record(`pageerror-${name}`);
    });
  }
  async capture(page: Page, name: string): Promise<string | undefined> {
    if (!this.active) return undefined;
    if (!/^[a-z0-9-]{1,100}$/.test(name)) {
      this.evidenceFailure(Error("evidence.screenshot: invalid name"));
      return undefined;
    }
    if (this.screenshots.size >= browserEvidenceLimits.files - 3) {
      this.omittedScreenshots++;
      return undefined;
    }
    try {
      const image = await page.screenshot({ fullPage: true, timeout: 5000 });
      if (!this.active) return undefined;
      if (
        image.length > browserEvidenceLimits.screenshotBytes ||
        this.screenshotBytes + image.length >
          browserEvidenceLimits.bytes - 3 * browserEvidenceLimits.metadataBytes
      ) {
        this.omittedScreenshots++;
        return undefined;
      }
      const filename = join(this.directory, `${name}.png`);
      this.screenshots.add(name);
      this.screenshotBytes += image.length;
      await this.write(filename, image);
      return filename;
    } catch (error) {
      if (this.active)
        this.evidenceFailure(
          Error("evidence.screenshot: failed", { cause: error }),
        );
      return undefined;
    }
  }
}
interface Phase {
  status: "completed" | "failed" | "timed-out" | "dependency-skipped";
  elapsedMs: number;
  error?: unknown;
  eventual?: { status: "completed" | "failed"; elapsedMs: number };
}
async function waitFor(
  operation: () => Promise<void>,
  milliseconds: number,
): Promise<Phase> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const phase: Phase = { status: "timed-out", elapsedMs: 0 };
  const outcome = Promise.resolve()
    .then(operation)
    .then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
  void outcome.then((result) => {
    if (phase.status === "timed-out" && phase.elapsedMs > 0)
      phase.eventual = {
        status: result.status,
        elapsedMs: Math.round(performance.now() - started),
      };
  });
  try {
    Object.assign(
      phase,
      await Promise.race([
        outcome,
        new Promise<{ status: "timed-out" }>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "timed-out" }),
            milliseconds,
          );
        }),
      ]),
      { elapsedMs: Math.round(performance.now() - started) },
    );
    return phase;
  } finally {
    clearTimeout(timer);
  }
}
let defaultRoot: Promise<string> | undefined;
async function ownedDirectory(path: string) {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory())
    throw Error("Browser evidence directory must not be a symlink");
}
async function evidenceDirectory(
  suite: string,
  name: string,
  configured?: string,
) {
  if (!/^[a-z0-9-]{1,40}$/.test(suite))
    throw Error("Invalid browser evidence suite");
  let root = configured ?? process.env.ENSEMBLE_TEST_EVIDENCE_DIR;
  if (!root) {
    defaultRoot ??= mkdtemp(join(tmpdir(), "ensemble-test-evidence-"));
    root = await defaultRoot;
  }
  if (!isAbsolute(root)) throw Error("Browser evidence root must be absolute");
  await ownedDirectory(root);
  const marker = ".ensemble-test-evidence-v1";
  const existing = await readdir(root);
  if (
    existing.length &&
    (!existing.includes(marker) ||
      existing.some(
        (entry) => entry !== marker && !/^[a-z0-9-]{1,40}-\d+$/.test(entry),
      ))
  )
    throw Error("Browser evidence root must be dedicated to test diagnostics");
  await ownedDirectory(join(root, marker));
  const physicalRoot = await realpath(root);
  const parent = join(physicalRoot, `${suite}-${process.pid}`);
  await ownedDirectory(parent);
  const id = createHash("sha256").update(name).digest("hex").slice(0, 16);
  const directory = join(parent, id);
  await ownedDirectory(directory);
  for (const entry of await readdir(directory)) {
    if (
      !/^(manifest\.json|std(out|err)\.sanitized\.log|[a-z0-9-]{1,100}\.png)$/.test(
        entry,
      ) ||
      !(await lstat(join(directory, entry))).isFile()
    )
      throw Error("Browser evidence directory contains unowned files");
  }
  return directory;
}
function safeStep(step: FixtureStep) {
  return {
    name: /^[a-z0-9.-]{1,100}$/.test(step.name) ? step.name : "unknown-step",
    phase: step.phase,
    status: step.status,
    elapsedMs: step.elapsedMs,
    ...(step.eventual
      ? {
          eventual: {
            status: step.eventual.status,
            elapsedMs: step.eventual.elapsedMs,
          },
        }
      : {}),
  };
}
function secondary(primary: unknown, failure: Error): unknown {
  if (primary instanceof Error) {
    primary.cause = new AggregateError(
      [primary.cause, failure],
      "Browser diagnostics incomplete",
    );
    return primary;
  }
  return primary ?? failure;
}
export async function runBrowserJourney(
  suite: string,
  name: string,
  action: (journey: BrowserJourney) => Promise<void>,
  options: BrowserJourneyOptions = {},
) {
  const executionMs = options.executionMs ?? 45000;
  const overallMs = options.overallMs ?? 90000;
  const cleanupStepMs = options.cleanupStepMs ?? 10000;
  const startupMs = options.startupMs ?? 15000;
  for (const limit of [executionMs, overallMs, cleanupStepMs, startupMs])
    if (!Number.isFinite(limit) || limit <= 0)
      throw Error(
        "Browser journey deadlines must be finite positive milliseconds",
      );
  const started = performance.now();
  const overallDeadline = started + overallMs;
  const evidenceReserve = Math.min(5000, overallMs / 10);
  let directory = "";
  const initialization = await waitFor(
    async () => {
      directory = await evidenceDirectory(suite, name, options.evidenceRoot);
    },
    Math.min(5000, overallMs),
  );
  if (initialization.status !== "completed")
    throw (
      initialization.error ??
      Error(`evidence.start: timed-out after ${initialization.elapsedMs} ms`)
    );
  const writer =
    options.writeEvidence ??
    ((filename: string, data: string | Uint8Array) =>
      writeFile(filename, data, { mode: 0o600, flag: "w" }));
  const write = async (filename: string, data: string | Uint8Array) => {
    const limit = filename.endsWith(".png")
      ? browserEvidenceLimits.screenshotBytes
      : browserEvidenceLimits.metadataBytes;
    if (Buffer.byteLength(data) > limit)
      throw Error("evidence.write: file byte limit exceeded");
    await writer(filename, data);
  };
  const journey = new BrowserJourney(
    directory,
    write,
    startupMs,
    cleanupStepMs,
    overallDeadline - evidenceReserve,
  );
  const execution = await waitFor(
    () => action(journey),
    Math.min(
      executionMs,
      Math.max(
        1,
        overallDeadline -
          performance.now() -
          Math.min(30000, overallMs / 3) -
          evidenceReserve,
      ),
    ),
  );
  journey.active = false;
  let primary = execution.error;
  if (execution.status === "timed-out")
    primary = Error(`execution: timed-out after ${execution.elapsedMs} ms`);
  const cleanup: Array<{ owned: Cleanup; outcome: Phase }> = [];
  let overallExpired = false;
  if (execution.status === "timed-out" || journey.uncertainStartup) {
    for (const owned of journey.cleanups)
      cleanup.push({
        owned,
        outcome: { status: "dependency-skipped", elapsedMs: 0 },
      });
  } else {
    for (const owned of journey.cleanups.toReversed()) {
      const remaining = overallDeadline - performance.now() - evidenceReserve;
      const budget = owned.steps
        ? remaining
        : Math.min(cleanupStepMs, remaining);
      const outcome =
        remaining <= 0
          ? { status: "dependency-skipped" as const, elapsedMs: 0 }
          : await waitFor(() => owned.operation(), budget);
      cleanup.push({ owned, outcome });
      if (
        remaining <= 0 ||
        (budget === remaining && outcome.status === "timed-out")
      )
        overallExpired = true;
      if (outcome.error && outcome.error !== primary)
        primary = secondary(
          primary,
          Error(`${owned.name}: failed after ${outcome.elapsedMs} ms`, {
            cause: outcome.error,
          }),
        );
      if (outcome.status === "timed-out")
        primary = secondary(
          primary,
          Error(
            overallExpired
              ? `overall: timed-out after ${Math.round(performance.now() - started)} ms (${Math.round(evidenceReserve)} ms evidence reserve)`
              : `${owned.name}: timed-out after ${outcome.elapsedMs} ms`,
          ),
        );
    }
  }
  for (const failure of journey.evidenceFailures)
    primary = secondary(primary, failure);
  const partialSteps = journey.partialLifecycle?.steps ?? [];
  const steps = [
    ...partialSteps.filter((step) => step.phase === "cleanup").map(safeStep),
    ...cleanup.flatMap(({ owned, outcome }) => {
      const ledger = owned.steps?.() ?? [];
      const summary = {
        name: /^[a-z0-9.-]{1,100}$/.test(owned.name)
          ? owned.name
          : "unknown-step",
        phase: "cleanup" as const,
        status: outcome.status,
        elapsedMs: outcome.elapsedMs,
      };
      return [...ledger.map(safeStep), summary];
    }),
  ];
  const incomplete =
    execution.status === "timed-out" ||
    journey.uncertainStartup ||
    partialSteps.some(
      (step) => step.phase === "cleanup" && !fixtureStepCompleted(step),
    ) ||
    cleanup.some(({ outcome }) => outcome.status !== "completed");
  const startup = [...partialSteps, ...journey.lifecycle.steps].filter(
    (step) => step.phase === "startup",
  );
  const manifest = {
    suite,
    test: name.slice(0, 240),
    limits: { startupMs, executionMs, overallMs, cleanupStepMs },
    phases: {
      startup: startup.slice(0, 80).map(safeStep),
      omittedStartupSteps: Math.max(0, startup.length - 80),
      execution: { status: execution.status, elapsedMs: execution.elapsedMs },
      overall: {
        status: overallExpired
          ? "timed-out"
          : primary === undefined
            ? "completed"
            : "failed",
        elapsedMs: Math.round(performance.now() - started),
      },
    },
    cleanup: {
      incomplete,
      steps: steps.slice(0, 80),
      omittedSteps: Math.max(0, steps.length - 80),
    },
    diagnostics: journey.diagnostics,
    omittedDiagnostics: journey.omittedDiagnostics,
    omittedScreenshots: journey.omittedScreenshots,
    omittedEvidenceFailures: journey.omittedEvidenceFailures,
    evidenceFailures: journey.evidenceFailures.map(
      (failure) => failure.message,
    ),
  };
  const report = await waitFor(
    async () => {
      const serialized = JSON.stringify(manifest, null, 2);
      if (Buffer.byteLength(serialized) > browserEvidenceLimits.metadataBytes)
        throw Error("evidence.write: metadata byte limit exceeded");
      await write(join(directory, "manifest.json"), serialized);
      await write(
        join(directory, "stdout.sanitized.log"),
        `browser-diagnostics suite=${suite} execution=${execution.status} elapsedMs=${execution.elapsedMs} cleanupIncomplete=${incomplete}\n`,
      );
      await write(
        join(directory, "stderr.sanitized.log"),
        `${journey.diagnostics.join("\n")}\nomitted=${journey.omittedDiagnostics} screenshotsOmitted=${journey.omittedScreenshots} evidenceFailures=${journey.evidenceFailures.length}\n`,
      );
    },
    Math.max(1, Math.min(5000, overallDeadline - performance.now())),
  );
  if (report.status !== "completed")
    primary = secondary(
      primary,
      Error(`evidence.write: ${report.status} after ${report.elapsedMs} ms`, {
        cause: report.error,
      }),
    );
  if (primary !== undefined)
    throw Object.assign(
      primary instanceof Error ? primary : Error(String(primary)),
      {
        evidenceDirectory: directory,
        phases: {
          execution,
          cleanup: cleanup.map(({ owned, outcome }) => ({
            name: owned.name,
            outcome,
          })),
        },
      },
    );
  return { evidenceDirectory: directory, phases: { execution } };
}
// Only existing nested screenshot helpers need ambient context. Ownership stays explicit.
const screenshotJourney = new AsyncLocalStorage<BrowserJourney>();
export function captureBrowserEvidence(page: Page, name: string) {
  const journey = screenshotJourney.getStore();
  if (!journey) throw Error("Screenshot must belong to a browser journey");
  return journey.capture(page, name);
}
export function browserSuite(suite: string) {
  return (
    name: string,
    optionsOrAction:
      | TestOptions
      | ((t: TestContext, journey: BrowserJourney) => Promise<void>),
    action?: (t: TestContext, journey: BrowserJourney) => Promise<void>,
  ) => {
    const options =
      typeof optionsOrAction === "function" ? {} : optionsOrAction;
    const run =
      typeof optionsOrAction === "function" ? optionsOrAction : action;
    if (!run) throw Error("Browser journey callback is required");
    return nodeTest(name, { timeout: 95000, ...options }, async (t) => {
      await runBrowserJourney(suite, name, (journey) =>
        screenshotJourney.run(journey, () => run(t, journey)),
      );
    });
  };
}
