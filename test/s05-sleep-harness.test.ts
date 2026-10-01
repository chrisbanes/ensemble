import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;
type ScheduleEvent = {
  action: string;
  localTime: string;
  instant: number;
  owner: string;
};

type SleepHarnessModule = {
  parseLiveArguments(
    args: string[],
  ): { ok: true; windowPath: string } | { ok: false; reason: string };
  validateWindowRecord(
    value: unknown,
    hostname: string,
    now: number,
  ): {
    version: 1;
    approvedBy: "chrisbanes";
    hostname: string;
    startAt: string;
    sleepAt: string;
    wakeAt: string;
    endAt: string;
  };
  parsePmsetSchedule(output: string): {
    complete: boolean;
    events: ScheduleEvent[];
  };
  prepareWakeSchedule(options: {
    window: ReturnType<SleepHarnessModule["validateWindowRecord"]>;
    fixtureId: string;
    run: CommandRunner;
    now: () => number;
  }): Promise<{
    owner: string;
    localWakeTime: string;
    baseline: ScheduleEvent[];
  }>;
  cancelOwnedWake(options: {
    owner: string;
    localWakeTime: string;
    baseline: ScheduleEvent[];
    run: CommandRunner;
    scheduleOutcomeUncertain?: boolean;
  }): Promise<{ verified: boolean; reconciliation: string }>;
  sleepAtApprovedTime(options: {
    window: ReturnType<SleepHarnessModule["validateWindowRecord"]>;
    owner: string;
    localWakeTime: string;
    baseline: ScheduleEvent[];
    run: CommandRunner;
    now: () => number;
    waitUntil: (timestamp: number) => Promise<void>;
  }): Promise<void>;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<SleepHarnessModule>;
const harness = await dynamicImport(
  pathToFileURL(resolve("test/s05/live-sleep.mjs")).href,
);

function windowRecord(hostname = "fixture-host") {
  return {
    version: 1,
    approvedBy: "chrisbanes",
    hostname,
    startAt: "2026-09-30T10:00:00.000Z",
    sleepAt: "2026-09-30T10:05:00.000Z",
    wakeAt: "2026-09-30T10:06:00.000Z",
    endAt: "2026-09-30T10:10:00.000Z",
  };
}

function scheduleOutput(rows: string[] = []): string {
  return ["Scheduled power events:", ...rows].join("\n");
}

function commandRecorder(
  response: (file: string, args: string[]) => CommandResult | Error,
): { run: CommandRunner; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    async run(file, args) {
      calls.push({ file, args });
      const result = response(file, args);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("live flags and an absolute controller record path are required before commands", () => {
  assert.deepEqual(harness.parseLiveArguments([]), {
    ok: false,
    reason: "live-host-sleep-guards-required",
  });
  assert.deepEqual(
    harness.parseLiveArguments([
      "--live",
      "--allow-host-sleep",
      "--window-record",
      "relative-window.json",
    ]),
    { ok: false, reason: "absolute-window-record-required" },
  );
  assert.deepEqual(
    harness.parseLiveArguments([
      "--live",
      "--allow-host-sleep",
      "--window-record",
      "/tmp/controller-window.json",
    ]),
    { ok: true, windowPath: "/tmp/controller-window.json" },
  );
});

test("the executable refuses before starting the live journey when guards are absent", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("test/s05/live-sleep.mjs")],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Refusing host sleep without live approval guards.\n",
  );
});

test("window records bind operator, exact host, UTC interval and a one-minute wake", () => {
  const valid = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  assert.equal(valid.approvedBy, "chrisbanes");
  assert.throws(
    () =>
      harness.validateWindowRecord(
        windowRecord("other-host"),
        "fixture-host",
        Date.parse("2026-09-30T10:01:00.000Z"),
      ),
    /window-record-invalid/,
  );
  assert.throws(
    () =>
      harness.validateWindowRecord(
        { ...windowRecord(), wakeAt: "2026-09-30T10:06:01.000Z" },
        "fixture-host",
        Date.parse("2026-09-30T10:01:00.000Z"),
      ),
    /window-record-invalid/,
  );
  assert.throws(
    () =>
      harness.validateWindowRecord(
        { ...windowRecord(), sleepAt: "2026-09-30T10:00:00.000Z" },
        "fixture-host",
        Date.parse("2026-09-30T10:01:00.000Z"),
      ),
    /window-record-invalid/,
  );
  assert.throws(
    () =>
      harness.validateWindowRecord(
        {
          ...windowRecord(),
          sleepAt: "2026-09-30T10:05:59.000Z",
        },
        "fixture-host",
        Date.parse("2026-09-30T10:05:58.000Z"),
      ),
    /window-record-invalid/,
    "a one-second sleep interval cannot guarantee the scheduled wake follows sleep",
  );
});

test("pmset schedule parsing accepts a successful empty result and rejects unknown output", () => {
  assert.deepEqual(harness.parsePmsetSchedule(""), {
    complete: true,
    events: [],
  });
  assert.deepEqual(
    harness.parsePmsetSchedule("Scheduled power events:\nunknown schedule row"),
    { complete: false, events: [] },
  );
  const parsed = harness.parsePmsetSchedule(
    scheduleOutput([
      " [0] wake at 09/30/26 11:06:00 by 'ensemble-s05-unrelated'",
    ]),
  );
  assert.equal(parsed.complete, true);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]?.action, "wake");
  assert.equal(parsed.events[0]?.owner, "ensemble-s05-unrelated");
});

test("ambiguous daylight-saving schedule times are refused", () => {
  const moduleUrl = pathToFileURL(resolve("test/s05/live-sleep.mjs")).href;
  const program = [
    `const { parsePmsetSchedule } = await import(${JSON.stringify(moduleUrl)});`,
    `const parsed = parsePmsetSchedule("Scheduled power events:\\n [0] wake at 10/25/26 01:30:00 by 'com.apple.alarm.test'");`,
    "process.stdout.write(String(parsed.complete));",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "", TZ: "Europe/London" },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false");
});

test("an existing event in the approved sleep interval blocks scheduling without touching it", async () => {
  const fixture = Date.parse("2026-09-30T10:05:30.000Z");
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:05:30 by 'com.apple.alarm.existing'",
        ]),
        stderr: "",
      };
    return new Error("unexpected command");
  });
  await assert.rejects(
    harness.prepareWakeSchedule({
      window: record,
      fixtureId: "fixture",
      run: recorder.run,
      now: () => fixture - 4 * 60_000,
    }),
    /schedule-conflict/,
  );
  assert.equal(
    recorder.calls.some((call) => call.args.includes("schedule")),
    false,
  );
});

test("unavailable noninteractive privilege stops before schedule inspection or mutation", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  const recorder = commandRecorder(() => new Error("privilege unavailable"));
  await assert.rejects(
    harness.prepareWakeSchedule({
      window: record,
      fixtureId: "fixture",
      run: recorder.run,
      now: () => Date.parse("2026-09-30T10:01:00.000Z"),
    }),
    /privilege-preflight-failed/,
  );
  assert.deepEqual(recorder.calls, [
    { file: "/usr/bin/sudo", args: ["-n", "true"] },
  ]);
});

test("a verified wake is scheduled once while unrelated events remain present", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let ownWakePresent = false;
  let scheduleArguments: string[] | undefined;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:07:00 by 'com.apple.alarm.existing'",
          ...(ownWakePresent
            ? [" [1] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'"]
            : []),
        ]),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "wake"
    ) {
      scheduleArguments = args;
      ownWakePresent = true;
      return { stdout: "", stderr: "" };
    }
    return new Error("unexpected command");
  });
  const prepared = await harness.prepareWakeSchedule({
    window: record,
    fixtureId: "fixture",
    run: recorder.run,
    now: () => Date.parse("2026-09-30T10:01:00.000Z"),
  });
  assert.equal(prepared.owner, "ensemble-s05-fixture");
  assert.equal(prepared.baseline.length, 1);
  assert.deepEqual(scheduleArguments, [
    "-n",
    "/usr/bin/pmset",
    "schedule",
    "wake",
    "09/30/26 11:06:00",
    "ensemble-s05-fixture",
  ]);
  assert.equal(ownWakePresent, true);
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "wake",
    ).length,
    1,
  );
});

test("a successful empty pmset result is a valid baseline for the owned wake", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let ownWakePresent = false;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: ownWakePresent
          ? scheduleOutput([
              " [0] wake at 09/30/26 11:06:00 by 'ensemble-s05-empty-baseline'",
            ])
          : "",
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "wake"
    ) {
      ownWakePresent = true;
      return { stdout: "", stderr: "" };
    }
    return new Error("unexpected command");
  });
  const prepared = await harness.prepareWakeSchedule({
    window: record,
    fixtureId: "empty-baseline",
    run: recorder.run,
    now: () => Date.parse("2026-09-30T10:01:00.000Z"),
  });
  assert.equal(prepared.baseline.length, 0);
  assert.equal(prepared.owner, "ensemble-s05-empty-baseline");
  assert.equal(ownWakePresent, true);
});

test("a lost schedule response is reconciled once and only the exact owned wake is canceled", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let ownWakePresent = false;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:07:00 by 'com.apple.alarm.existing'",
          ...(ownWakePresent
            ? [" [1] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'"]
            : []),
        ]),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "wake"
    ) {
      ownWakePresent = true;
      return new Error("schedule response lost");
    }
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "cancel"
    ) {
      assert.equal(args[4], "wake");
      assert.equal(args[6], "ensemble-s05-fixture");
      ownWakePresent = false;
      return { stdout: "", stderr: "" };
    }
    return new Error("unexpected command");
  });

  await assert.rejects(
    harness.prepareWakeSchedule({
      window: record,
      fixtureId: "fixture",
      run: recorder.run,
      now: () => Date.parse("2026-09-30T10:01:00.000Z"),
    }),
    /schedule-response-uncertain/,
  );
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "wake",
    ).length,
    1,
  );
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "cancel",
    ).length,
    1,
  );
  assert.equal(ownWakePresent, false);
});

test("unreadable schedule readback never triggers sleep or a duplicate schedule", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let scheduleCount = 0;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched") {
      scheduleCount++;
      return {
        stdout:
          scheduleCount === 1
            ? scheduleOutput()
            : "unrecognized pmset schedule result",
        stderr: "",
      };
    }
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "wake"
    )
      return { stdout: "", stderr: "" };
    return new Error("unexpected command");
  });
  let failure: unknown;
  try {
    await harness.prepareWakeSchedule({
      window: record,
      fixtureId: "fixture",
      run: recorder.run,
      now: () => Date.parse("2026-09-30T10:01:00.000Z"),
    });
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure), /schedule-readback-unverified/);
  assert.deepEqual(
    (
      failure as Error & {
        wakeSchedule: {
          owner: string;
          localWakeTime: string;
          baseline: ScheduleEvent[];
          scheduleOutcomeUncertain: boolean;
          reconciliation: string;
        };
      }
    ).wakeSchedule,
    {
      owner: "ensemble-s05-fixture",
      localWakeTime: "09/30/26 11:06:00",
      baseline: [],
      scheduleOutcomeUncertain: true,
      reconciliation: "schedule-outcome-unreadable",
    },
  );
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "wake",
    ).length,
    1,
  );
  assert.equal(
    recorder.calls.some(
      (call) => call.args[2] === "sleepnow" || call.args.includes("cancelall"),
    ),
    false,
  );
});

test("an uncertain schedule response stays unresolved when the event appears after an absent read", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let scheduleReads = 0;
  let delayedEventPresent = false;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched") {
      scheduleReads++;
      if (scheduleReads === 4) delayedEventPresent = true;
      return {
        stdout: scheduleOutput(
          delayedEventPresent
            ? [" [0] wake at 09/30/26 11:06:00 by 'ensemble-s05-delayed'"]
            : [],
        ),
        stderr: "",
      };
    }
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "wake"
    )
      return new Error("schedule response lost");
    return new Error("unexpected command");
  });

  let failure: Error & {
    wakeSchedule: {
      owner: string;
      localWakeTime: string;
      baseline: ScheduleEvent[];
      scheduleOutcomeUncertain: boolean;
      reconciliation: string;
    };
  };
  try {
    await harness.prepareWakeSchedule({
      window: record,
      fixtureId: "delayed",
      run: recorder.run,
      now: () => Date.parse("2026-09-30T10:01:00.000Z"),
    });
    assert.fail("an uncertain schedule response must stop before sleep");
  } catch (error) {
    failure = error as typeof failure;
  }

  assert.match(failure.message, /schedule-response-uncertain/);
  assert.equal(failure.wakeSchedule.scheduleOutcomeUncertain, true);
  assert.equal(failure.wakeSchedule.owner, "ensemble-s05-delayed");
  assert.equal(failure.wakeSchedule.localWakeTime, "09/30/26 11:06:00");
  assert.equal(failure.wakeSchedule.baseline.length, 0);
  assert.equal(scheduleReads, 2);

  const cleanup = await harness.cancelOwnedWake({
    ...failure.wakeSchedule,
    run: recorder.run,
  });
  assert.deepEqual(cleanup, {
    verified: false,
    reconciliation:
      "schedule-outcome-uncertain-event-currently-absent-baseline-preserved",
  });
  assert.equal(delayedEventPresent, false);
  assert.equal(
    recorder.calls.some((call) => call.args.includes("cancelall")),
    false,
  );

  const delayedRead = await recorder.run(
    "/usr/bin/pmset",
    ["-g", "sched"],
    1000,
  );
  assert.match(delayedRead.stdout, /ensemble-s05-delayed/);
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "wake",
    ).length,
    1,
    "the ambiguous schedule must never be retried",
  );
});

test("a lost cancel response is reconciled from exact absence and preserved baseline", async () => {
  const baseline = [
    {
      action: "wake",
      localTime: "09/30/26 11:07:00",
      instant: Date.parse("2026-09-30T10:07:00.000Z"),
      owner: "com.apple.alarm.existing",
    },
  ];
  let ownWakePresent = true;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:07:00 by 'com.apple.alarm.existing'",
          ...(ownWakePresent
            ? [" [1] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'"]
            : []),
        ]),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args.join(" ") ===
        "-n /usr/bin/pmset schedule cancel wake 09/30/26 11:06:00 ensemble-s05-fixture"
    ) {
      ownWakePresent = false;
      return new Error("cancel response lost");
    }
    return new Error("unexpected command");
  });
  const result = await harness.cancelOwnedWake({
    owner: "ensemble-s05-fixture",
    localWakeTime: "09/30/26 11:06:00",
    baseline,
    run: recorder.run,
  });
  assert.deepEqual(result, {
    verified: true,
    reconciliation: "owned-event-absent-and-baseline-preserved",
  });
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "cancel",
    ).length,
    1,
  );
});

test("baseline preservation compares duplicate schedule rows as a multiset", async () => {
  const duplicate = {
    action: "wake",
    localTime: "09/30/26 11:07:00",
    instant: Date.parse("2026-09-30T10:07:00.000Z"),
    owner: "com.apple.alarm.existing",
  };
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:07:00 by 'com.apple.alarm.existing'",
        ]),
        stderr: "",
      };
    return new Error("unexpected command");
  });
  const result = await harness.cancelOwnedWake({
    owner: "ensemble-s05-fixture",
    localWakeTime: "09/30/26 11:06:00",
    baseline: [duplicate, duplicate],
    run: recorder.run,
  });
  assert.deepEqual(result, {
    verified: false,
    reconciliation: "baseline-not-preserved",
  });
  assert.equal(
    recorder.calls.some((call) => call.args.includes("cancel")),
    false,
  );
});

test("pre-sleep time guard cleans only the exact owned wake and never sleeps after its deadline", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let ownWakePresent = true;
  let sleepCount = 0;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:07:00 by 'com.apple.alarm.existing'",
          ...(ownWakePresent
            ? [" [1] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'"]
            : []),
        ]),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "cancel"
    ) {
      ownWakePresent = false;
      return { stdout: "", stderr: "" };
    }
    if (
      file === "/usr/bin/sudo" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "sleepnow"
    ) {
      sleepCount++;
      return { stdout: "", stderr: "" };
    }
    return new Error("unexpected command");
  });
  const baseline = [
    {
      action: "wake",
      localTime: "09/30/26 11:07:00",
      instant: Date.parse("2026-09-30T10:07:00.000Z"),
      owner: "com.apple.alarm.existing",
    },
  ];
  await assert.rejects(
    harness.sleepAtApprovedTime({
      window: record,
      owner: "ensemble-s05-fixture",
      localWakeTime: "09/30/26 11:06:00",
      baseline,
      run: recorder.run,
      now: () => Date.parse(record.wakeAt),
      waitUntil: async () => {},
    }),
    /sleep-window-expired/,
  );
  assert.equal(sleepCount, 0);
  assert.equal(ownWakePresent, false);
  assert.equal(
    recorder.calls.some((call) => call.args.includes("cancelall")),
    false,
  );
});

test("the physical sleep command is reached only inside the approved scheduled interval", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  let current = Date.parse(record.sleepAt) - 500;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: scheduleOutput([
          " [0] wake at 09/30/26 11:07:00 by 'com.apple.alarm.existing'",
          " [1] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'",
        ]),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args.join(" ") === "-n /usr/bin/pmset sleepnow"
    )
      return { stdout: "", stderr: "" };
    return new Error("unexpected command");
  });
  await harness.sleepAtApprovedTime({
    window: record,
    owner: "ensemble-s05-fixture",
    localWakeTime: "09/30/26 11:06:00",
    baseline: [
      {
        action: "wake",
        localTime: "09/30/26 11:07:00",
        instant: Date.parse("2026-09-30T10:07:00.000Z"),
        owner: "com.apple.alarm.existing",
      },
    ],
    run: recorder.run,
    now: () => current,
    waitUntil: async (timestamp) => {
      current = timestamp + 500;
    },
  });
  assert.deepEqual(
    recorder.calls.filter(
      (call) =>
        call.args[1] === "/usr/bin/pmset" && call.args[2] === "sleepnow",
    ),
    [
      {
        file: "/usr/bin/sudo",
        args: ["-n", "/usr/bin/pmset", "sleepnow"],
      },
    ],
  );
});

test("the physical sleep dispatch is refused and its owned wake canceled near the wake deadline", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  const sleepAt = Date.parse(record.sleepAt);
  let current = sleepAt - 500;
  let ownWakePresent = true;
  let sleepCount = 0;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: ownWakePresent
          ? scheduleOutput([
              " [0] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'",
            ])
          : scheduleOutput(),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "cancel"
    ) {
      ownWakePresent = false;
      return { stdout: "", stderr: "" };
    }
    if (args[1] === "/usr/bin/pmset" && args[2] === "sleepnow") {
      sleepCount++;
      return { stdout: "", stderr: "" };
    }
    return new Error("unexpected command");
  });

  await assert.rejects(
    harness.sleepAtApprovedTime({
      window: record,
      owner: "ensemble-s05-fixture",
      localWakeTime: "09/30/26 11:06:00",
      baseline: [],
      run: recorder.run,
      now: () => current,
      waitUntil: async () => {
        current = sleepAt + 5_500;
      },
    }),
    /pre-sleep-guard-failed/,
  );
  assert.equal(sleepCount, 0);
  assert.equal(ownWakePresent, false);
  assert.equal(
    recorder.calls.some((call) => call.args.includes("cancelall")),
    false,
  );
});

test("a dispatch that crosses five seconds during pre-sleep checks is refused and cleaned up", async () => {
  const record = harness.validateWindowRecord(
    windowRecord(),
    "fixture-host",
    Date.parse("2026-09-30T10:01:00.000Z"),
  );
  const sleepAt = Date.parse(record.sleepAt);
  let nowCalls = 0;
  let ownWakePresent = true;
  let sleepCount = 0;
  const recorder = commandRecorder((file, args) => {
    if (file === "/usr/bin/sudo" && args.join(" ") === "-n true")
      return { stdout: "", stderr: "" };
    if (file === "/usr/bin/pmset" && args.join(" ") === "-g sched")
      return {
        stdout: ownWakePresent
          ? scheduleOutput([
              " [0] wake at 09/30/26 11:06:00 by 'ensemble-s05-fixture'",
            ])
          : scheduleOutput(),
        stderr: "",
      };
    if (
      file === "/usr/bin/sudo" &&
      args[0] === "-n" &&
      args[1] === "/usr/bin/pmset" &&
      args[2] === "schedule" &&
      args[3] === "cancel"
    ) {
      ownWakePresent = false;
      return { stdout: "", stderr: "" };
    }
    if (args[1] === "/usr/bin/pmset" && args[2] === "sleepnow") {
      sleepCount++;
      return { stdout: "", stderr: "" };
    }
    return new Error("unexpected command");
  });
  const times = [sleepAt - 500, sleepAt + 4_999, sleepAt + 5_001];

  await assert.rejects(
    harness.sleepAtApprovedTime({
      window: record,
      owner: "ensemble-s05-fixture",
      localWakeTime: "09/30/26 11:06:00",
      baseline: [],
      run: recorder.run,
      now: () => times[nowCalls++] ?? sleepAt + 5_001,
      waitUntil: async () => {},
    }),
    /pre-sleep-guard-failed/,
  );
  assert.equal(sleepCount, 0);
  assert.equal(ownWakePresent, false);
  assert.equal(
    recorder.calls.filter(
      (call) => call.args[2] === "schedule" && call.args[3] === "cancel",
    ).length,
    1,
  );
});
