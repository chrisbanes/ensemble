export type FixtureStepStatus =
  | "attempted"
  | "completed"
  | "failed"
  | "timed-out"
  | "dependency-skipped";

export interface FixtureStep {
  name: string;
  phase: "startup" | "cleanup";
  status: FixtureStepStatus;
  elapsedMs: number;
  error?: unknown;
  eventual?: {
    status: "completed" | "failed";
    elapsedMs: number;
    error?: unknown;
  };
}

export interface FixtureLifecycleOptions {
  cleanupTimeoutMs?: number;
  startupTimeoutMs?: number;
  operation?: (name: string, operation: () => Promise<void>) => Promise<void>;
}

export function fixtureStepCompleted(step: FixtureStep | undefined): boolean {
  return step?.status === "completed" || step?.eventual?.status === "completed";
}

export function fixtureStepPending(step: FixtureStep): boolean {
  return (
    step.status === "attempted" ||
    (step.status === "timed-out" && !step.eventual)
  );
}

export class FixtureStartupError extends Error {
  constructor(readonly step: FixtureStep) {
    super(
      `${step.name}: ${step.status} after ${step.elapsedMs} ms${step.error instanceof Error ? `: ${step.error.message}` : ""}`,
      { cause: step.error },
    );
  }
}

export function throwFixtureCleanup(
  steps: FixtureStep[],
  primaryFailure?: unknown,
): void {
  if (steps.every(fixtureStepCompleted)) return;
  const cleanupFailure = new FixtureCleanupError(steps);
  if (primaryFailure instanceof Error) {
    const cause = primaryFailure.cause;
    primaryFailure.cause =
      cause === undefined
        ? cleanupFailure
        : new AggregateError(
            [cause, cleanupFailure],
            "Fixture cleanup incomplete",
          );
    throw primaryFailure;
  }
  throw cleanupFailure;
}

export class FixtureCleanupError extends AggregateError {
  constructor(readonly steps: FixtureStep[]) {
    const incomplete = steps.filter((step) => !fixtureStepCompleted(step));
    super(
      incomplete.map(
        (step) =>
          new Error(`${step.name}: ${step.status} after ${step.elapsedMs} ms`, {
            cause: step.error,
          }),
      ),
      incomplete
        .map(
          (step) => `${step.name}: ${step.status} after ${step.elapsedMs} ms`,
        )
        .join("; "),
    );
  }
}

/** Test-owned operation deadlines report uncertainty; they never cancel work. */
export class FixtureLifecycle {
  readonly steps: FixtureStep[] = [];
  private readonly operations = new Map<string, FixtureStep>();

  constructor(private readonly options: FixtureLifecycleOptions = {}) {
    for (const timeout of [this.cleanupTimeoutMs, this.startupTimeoutMs])
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw Error("Fixture deadlines must be finite positive milliseconds");
  }

  get cleanupTimeoutMs() {
    return this.options.cleanupTimeoutMs ?? 10000;
  }

  get startupTimeoutMs() {
    return this.options.startupTimeoutMs ?? 15000;
  }

  async start(
    name: string,
    operation: () => Promise<void>,
    deadline: number,
    steps: FixtureStep[],
  ): Promise<void> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const step = this.skip(name, "startup");
      steps.push(step);
      throw new FixtureStartupError(step);
    }
    const step = await this.attempt(name, "startup", operation, remaining);
    steps.push(step);
    if (!fixtureStepCompleted(step)) throw new FixtureStartupError(step);
  }

  async attempt(
    name: string,
    phase: FixtureStep["phase"],
    operation: () => Promise<void>,
    timeoutMs: number,
  ): Promise<FixtureStep> {
    const previous = this.operations.get(name);
    // A second public stop may be a no-op after the first discarded its handle.
    // Only the first operation's successful outcome can establish completion.
    if (
      previous &&
      (fixtureStepPending(previous) ||
        (phase === "cleanup" && !fixtureStepCompleted(previous)))
    )
      return previous;
    const started = performance.now();
    const step: FixtureStep = {
      name,
      phase,
      status: "attempted",
      elapsedMs: 0,
    };
    this.steps.push(step);
    this.operations.set(name, step);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = Promise.resolve()
      .then(() => this.options.operation?.(name, operation) ?? operation())
      .then(
        () => ({ status: "completed" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      );
    void outcome.then((result) => {
      if (step.status === "timed-out")
        step.eventual = {
          ...result,
          elapsedMs: Math.round(performance.now() - started),
        };
    });
    try {
      const result = await Promise.race([
        outcome,
        new Promise<{ status: "timed-out" }>((resolve) => {
          timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
        }),
      ]);
      Object.assign(step, result, {
        elapsedMs: Math.round(performance.now() - started),
      });
      return step;
    } finally {
      clearTimeout(timer);
    }
  }

  skip(name: string, phase: FixtureStep["phase"] = "cleanup"): FixtureStep {
    const step: FixtureStep = {
      name,
      phase,
      status: "dependency-skipped",
      elapsedMs: 0,
    };
    this.steps.push(step);
    return step;
  }
}
