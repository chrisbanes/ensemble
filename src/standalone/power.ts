import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import type { PowerEventCursor } from "./state.js";
import type { ExecutionState } from "./state.js";

export interface PowerEvent {
  cursor: PowerEventCursor;
  previousCursor: PowerEventCursor | null;
  transition: "sleep" | "wake";
}

export interface PowerEventBatch {
  complete: boolean;
  fromCursor: PowerEventCursor | null;
  cursor: PowerEventCursor | null;
  events: PowerEvent[];
}

export interface PowerEventSource {
  readSince(cursor: PowerEventCursor | null): Promise<PowerEventBatch>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export type PowerLogReader = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBufferBytes: number },
) => Promise<string>;

const pmsetTimeCursor = /^pmset-time:(\d+)$/;
const pmsetEventCursorPattern = /^pmset-event:(\d+):(\d+):([a-f0-9]{16})$/;
const timestampPrefix =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(.+)$/;
const sleepWakeType = /^(Sleep|Wake|DarkWake)\b\s*(.*)$/i;

function createPmsetEventCursor(value: string): PowerEventCursor {
  return { version: 1, value };
}

function parseTimestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function knownPmsetSummary(line: string): boolean {
  const value = line.trim();
  return (
    value === "" ||
    value.startsWith("PM ASL data store:") ||
    value.startsWith("Assertion status system-wide:") ||
    value.startsWith("Listed by owning process:") ||
    value.startsWith("Kernel Assertions:") ||
    /^(pid |id=|Details:|Localized=)/.test(value)
  );
}

/** Parses only the documented, timestamped Sleep/Wake rows from `pmset -g log`. */
export function parsePmsetPowerLog(
  output: string,
  requested: PowerEventCursor | null,
): PowerEventBatch {
  const requestedTime = requested?.value.match(pmsetTimeCursor);
  const requestedEvent = requested?.value.match(pmsetEventCursorPattern);
  if (requested && requested.version !== 1) {
    return {
      complete: false,
      fromCursor: requested,
      cursor: requested,
      events: [],
    };
  }
  if (requested && !requestedTime && !requestedEvent) {
    return {
      complete: false,
      fromCursor: requested,
      cursor: requested,
      events: [],
    };
  }

  const events: Array<{
    cursor: PowerEventCursor;
    timestamp: number;
    lineIndex: number;
    transition: "sleep" | "wake";
  }> = [];
  let earliestTimestamp: number | undefined;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let malformed = false;
  let inSummary = false;
  const lines = output.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]?.trimEnd() ?? "";
    if (line.trim().startsWith("Assertion status system-wide:")) {
      inSummary = true;
      continue;
    }
    if (inSummary || knownPmsetSummary(line)) continue;
    const normalized = line.trim();
    const match = timestampPrefix.exec(normalized);
    if (!match) {
      malformed = true;
      continue;
    }
    const timestamp = parseTimestamp(match[1] ?? "");
    if (timestamp === undefined || timestamp < previousTimestamp) {
      malformed = true;
      continue;
    }
    earliestTimestamp ??= timestamp;
    previousTimestamp = timestamp;
    const body = match[2] ?? "";
    const [, kind, detail] = sleepWakeType.exec(body) ?? [];
    if (kind) {
      const hash = createHash("sha256")
        .update(normalized)
        .digest("hex")
        .slice(0, 16);
      const cursor = createPmsetEventCursor(
        `pmset-event:${timestamp}:${lineIndex}:${hash}`,
      );
      events.push({
        cursor,
        timestamp,
        lineIndex,
        transition: kind.toLowerCase() === "sleep" ? "sleep" : "wake",
      });
      continue;
    }
    const category = body.split(/\s+/, 1)[0] ?? "";
    if (
      category.toLowerCase() !== "assertions" &&
      /sleep|wake/i.test(`${category} ${detail ?? body}`)
    )
      malformed = true;
  }

  if (malformed || earliestTimestamp === undefined)
    return {
      complete: false,
      fromCursor: requested,
      cursor: requested,
      events: [],
    };

  let afterLine = Number.NEGATIVE_INFINITY;
  if (requestedEvent) {
    const timestamp = Number(requestedEvent[1]);
    const lineIndex = Number(requestedEvent[2]);
    const found = events.find(
      (event) => event.cursor.value === requested?.value,
    );
    if (
      !found ||
      found.timestamp !== timestamp ||
      found.lineIndex !== lineIndex
    )
      return {
        complete: false,
        fromCursor: requested,
        cursor: requested,
        events: [],
      };
    afterLine = lineIndex;
  } else if (requestedTime) {
    const timestamp = Number(requestedTime[1]);
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      earliestTimestamp > timestamp
    )
      return {
        complete: false,
        fromCursor: requested,
        cursor: requested,
        events: [],
      };
  }

  const selected = events.filter((event) =>
    requestedEvent
      ? event.lineIndex > afterLine
      : requestedTime
        ? event.timestamp >= Number(requestedTime[1])
        : false,
  );
  let previous = requested;
  const chained: PowerEvent[] = selected.map((event) => {
    const item = {
      cursor: event.cursor,
      previousCursor: previous,
      transition: event.transition,
    };
    previous = event.cursor;
    return item;
  });
  return {
    complete: true,
    fromCursor: requested,
    cursor: chained.at(-1)?.cursor ?? requested,
    events: chained,
  };
}

/** Reads a bounded macOS power history; missing or unfamiliar history is incomplete. */
export class MacPowerEventSource implements PowerEventSource {
  constructor(
    private readonly readLog: PowerLogReader = (command, args, options) =>
      new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          {
            encoding: "utf8",
            timeout: options.timeoutMs,
            maxBuffer: options.maxBufferBytes,
          },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      }),
    private readonly timeoutMs = 2500,
    private readonly maxBufferBytes = 4 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isSafeInteger(maxBufferBytes) ||
      maxBufferBytes <= 0
    )
      throw new Error("Power-event read bounds must be positive integers");
  }

  async readSince(cursor: PowerEventCursor | null): Promise<PowerEventBatch> {
    try {
      const output = await this.readLog("/usr/bin/pmset", ["-g", "log"], {
        timeoutMs: this.timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
      });
      if (cursor === null) {
        const parsed = parsePmsetPowerLog(output, null);
        const now = this.now();
        return parsed.complete && Number.isSafeInteger(now) && now >= 0
          ? {
              complete: true,
              fromCursor: null,
              cursor: createPmsetEventCursor(`pmset-time:${now}`),
              events: [],
            }
          : parsed;
      }
      return parsePmsetPowerLog(output, cursor);
    } catch {
      return { complete: false, fromCursor: cursor, cursor, events: [] };
    }
  }
}

export type CaffeinateSpawn = (command: string, args: string[]) => ChildProcess;

/** Owns one macOS idle-sleep assertion and reports unexpected child failure. */
export class CaffeinateAssertion extends EventEmitter {
  private child: ChildProcess | undefined;
  private stopping = false;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly spawnProcess: CaffeinateSpawn = (command, args) =>
      spawn(command, args, { stdio: "ignore" }),
    private readonly stopTimeoutMs = 1000,
  ) {
    super();
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0)
      throw new Error("Caffeinate stop timeout must be a positive integer");
  }

  start(): Promise<void> {
    return this.runTransition(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    let child: ChildProcess;
    try {
      child = this.spawnProcess("/usr/bin/caffeinate", ["-i"]);
    } catch {
      this.emit("failure", "caffeinate process failed to start");
      return;
    }
    this.child = child;
    child.once("error", () => {
      if (this.child === child && !this.stopping)
        this.emit("failure", "caffeinate process failed");
    });
    child.once(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.child !== child) return;
        this.child = undefined;
        if (!this.stopping)
          this.emit(
            "failure",
            `caffeinate process exited (${code === null ? (signal ?? "unknown") : code})`,
          );
      },
    );
  }

  stop(): Promise<void> {
    return this.runTransition(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.stopTimeoutMs);
      timer.unref();
      child.once("close", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
    if (this.child === child) this.child = undefined;
    this.stopping = false;
  }

  private runTransition(action: () => Promise<void>): Promise<void> {
    const current = this.transition.then(action, action);
    this.transition = current.catch(() => {});
    return current;
  }
}

function validCursor(value: unknown): value is PowerEventCursor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.value === "string" &&
    candidate.value.length > 0 &&
    candidate.value.length <= 512
  );
}

function sameCursor(
  left: PowerEventCursor | null,
  right: PowerEventCursor | null,
): boolean {
  return isDeepStrictEqual(left, right);
}

function validBatch(
  value: unknown,
  requested: PowerEventCursor | null,
): value is PowerEventBatch {
  if (typeof value !== "object" || value === null) return false;
  const batch = value as Record<string, unknown>;
  if (
    typeof batch.complete !== "boolean" ||
    !sameCursor(batch.fromCursor as PowerEventCursor | null, requested) ||
    (batch.cursor !== null && !validCursor(batch.cursor)) ||
    !Array.isArray(batch.events)
  )
    return false;

  let previous = requested;
  const seen = new Set<string>();
  for (const item of batch.events) {
    if (typeof item !== "object" || item === null) return false;
    const event = item as Record<string, unknown>;
    if (
      !validCursor(event.cursor) ||
      (event.previousCursor !== null && !validCursor(event.previousCursor)) ||
      !sameCursor(event.previousCursor as PowerEventCursor | null, previous) ||
      (event.transition !== "sleep" && event.transition !== "wake")
    )
      return false;
    const key = `${event.cursor.version}:${event.cursor.value}`;
    if (seen.has(key) || sameCursor(event.cursor, previous)) return false;
    seen.add(key);
    previous = event.cursor;
  }
  if (
    batch.events.length === 0 &&
    requested !== null &&
    !sameCursor(batch.cursor as PowerEventCursor | null, requested)
  )
    return false;
  if (
    batch.events.length > 0 &&
    !sameCursor(batch.cursor as PowerEventCursor | null, previous)
  )
    return false;
  return true;
}

/** Owns active-only sleep assertion and durable sleep/wake admission quarantine. */
export class ExecutionPower {
  private readonly activeWork = new Set<string>();
  private assertionFailure: string | null = null;
  private started = false;
  private polling: Promise<void> | undefined;

  constructor(
    private readonly state: ExecutionState,
    private readonly events: PowerEventSource,
    private readonly assertion: CaffeinateAssertion,
    private readonly reconcile: () => Promise<void>,
    private readonly admissionResumed: () => Promise<void> = async () => {},
  ) {
    this.assertion.on("failure", (reason: unknown) => {
      this.assertionFailure =
        typeof reason === "string"
          ? reason.slice(0, 500)
          : "caffeinate process failed";
    });
  }

  async start(): Promise<void> {
    await this.events.start?.();
    this.started = true;
  }

  async executionStarted(workId: string): Promise<void> {
    if (!this.started)
      throw new Error("Execution power supervision is not started");
    if (this.activeWork.has(workId)) return;
    this.activeWork.add(workId);
    if (this.activeWork.size === 1) {
      try {
        await this.assertion.start();
      } catch {
        this.assertionFailure = "caffeinate process failed to start";
      }
    }
  }

  async executionEnded(workId: string): Promise<void> {
    this.activeWork.delete(workId);
    if (this.activeWork.size === 0) await this.assertion.stop();
  }

  async poll(): Promise<void> {
    if (!this.started)
      throw new Error("Execution power supervision is not started");
    if (this.polling) return this.polling;
    const current = this.pollUnlocked();
    this.polling = current;
    try {
      await current;
    } finally {
      if (this.polling === current) this.polling = undefined;
    }
  }

  private async pollUnlocked(): Promise<void> {
    const persisted = this.state.powerAdmissionState();
    let batch: unknown;
    try {
      batch = await this.events.readSince(persisted.cursor);
    } catch {
      await this.holdAndReconcile("Power-event history is unavailable");
      return;
    }

    if (!validBatch(batch, persisted.cursor) || !batch.complete) {
      await this.holdAndReconcile(
        "Power-event history is incomplete or ambiguous",
      );
      return;
    }

    const active = this.state.admittedWorkIds().length > 0;
    if (
      persisted.cursor === null &&
      batch.events.length === 0 &&
      !persisted.held
    ) {
      if (batch.cursor && this.state.setPowerCursorBaseline(batch.cursor))
        return;
      await this.holdAndReconcile(
        "Power-event baseline is missing for admitted work",
      );
      return;
    }

    if (persisted.cursor === null && batch.events.length === 0 && active) {
      await this.holdAndReconcile(
        "Power-event history is missing for admitted work",
      );
      return;
    }

    if (batch.events.length === 0 && !persisted.held) return;

    let cursor = batch.cursor;
    let revision = this.state.holdPowerAdmission(
      batch.events.length > 0
        ? "Power transition requires execution reconciliation"
        : "Power-event admission is awaiting reconciliation",
    );
    await this.reconcileSafely();
    if (this.state.powerReconciliationPending() > 0) return;

    // Re-read from the source's high-water cursor after T4 reconciliation. Any
    // newly observed transition refreshes the durable pending set before the
    // next asynchronous pass; only an empty complete advancement can clear it.
    for (let pass = 0; pass < 4; pass++) {
      if (!cursor) return;
      let next: unknown;
      try {
        next = await this.events.readSince(cursor);
      } catch {
        this.state.holdPowerAdmission("Power-event advancement is unavailable");
        return;
      }
      if (!validBatch(next, cursor) || !next.complete) {
        this.state.holdPowerAdmission(
          "Power-event advancement is incomplete or ambiguous",
        );
        return;
      }
      if (next.events.length === 0) {
        if (this.state.powerReconciliationPending() > 0) return;
        const resumed = this.state.completePowerReconciliation(
          next.cursor ?? cursor,
          revision,
        );
        if (resumed) {
          try {
            await this.admissionResumed();
          } catch {
            // Admission is durable; the service scheduler can be woken again.
          }
        }
        return;
      }
      cursor = next.cursor;
      revision = this.state.holdPowerAdmission(
        "Power transition arrived during execution reconciliation",
      );
      await this.reconcileSafely();
      if (this.state.powerReconciliationPending() > 0) return;
    }
  }

  private async holdAndReconcile(reason: string): Promise<void> {
    this.state.holdPowerAdmission(reason);
    await this.reconcileSafely();
  }

  private async reconcileSafely(): Promise<void> {
    try {
      await this.reconcile();
    } catch {
      // Keep the durable gate and pending-generation ledger for a later pass.
    }
  }

  admissionHeld(): boolean {
    return this.state.powerAdmissionState().held;
  }

  status(): {
    assertionFailure: string | null;
    admissionHeld: boolean;
    admissionReason: string | null;
  } {
    const gate = this.state.powerAdmissionState();
    return {
      assertionFailure: this.assertionFailure,
      admissionHeld: gate.held,
      admissionReason: gate.reason,
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.activeWork.clear();
    await this.polling?.catch(() => {});
    const failures: Array<{ stage: string; error: unknown }> = [];
    try {
      await this.assertion.stop();
    } catch (error) {
      failures.push({ stage: "assertion stop", error });
    }
    try {
      await this.events.stop?.();
    } catch (error) {
      failures.push({ stage: "power event source stop", error });
    }
    if (failures.length === 1) {
      const [failure] = failures;
      if (failure) throw failure.error;
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Execution power shutdown failed during ${failures.map(({ stage }) => stage).join(", ")}`,
      );
  }
}
