import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { SqliteLiveCallBudget } from "./s05/live-call-budget.js";
import { tmpdir } from "./temp.js";

test("live journey refuses missing authorization and invalid mode before execution", () => {
  for (const [args, expected] of [
    [["--mode", "repository"], /without --live/],
    [["--mode", "local-dependency"], /without --live/],
    [["--live"], /--mode must be/],
    [["--live", "--mode", "invalid"], /--mode must be/],
  ] as const) {
    let refused = false;
    try {
      execFileSync(
        process.execPath,
        [join(process.cwd(), "test/s05/live-journey.mjs"), ...args],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            TYPESAFE_API_KEY: "S05_TEST_ONLY_SECRET_SENTINEL",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const result = error as NodeJS.ErrnoException & {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      assert.equal(result.status, 2);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.match(output, expected);
      assert.doesNotMatch(output, /S05_TEST_ONLY_SECRET_SENTINEL/);
      refused = true;
    }
    assert.equal(
      refused,
      true,
      "journey unexpectedly accepted unsafe invocation",
    );
  }
});

function assertRefusesLiveHarness(args: string[], expected: RegExp): void {
  try {
    execFileSync(
      process.execPath,
      [join(process.cwd(), "test/s05/live-routing.mjs"), ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TYPESAFE_API_KEY: "S05_TEST_ONLY_SECRET_SENTINEL",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const result = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    assert.equal(result.status, 2);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, expected);
    assert.doesNotMatch(output, /S05_TEST_ONLY_SECRET_SENTINEL/);
    return;
  }
  assert.fail("live harness unexpectedly accepted an unsafe invocation");
}

test("live routing harness requires explicit live authorization before reading credentials", () => {
  assertRefusesLiveHarness(["--max-calls", "4"], /without --live/);
  assertRefusesLiveHarness(
    ["--provider-free", "--max-calls", "4"],
    /without --live/,
  );
});

test("live routing harness refuses a provider-call budget above four", () => {
  assertRefusesLiveHarness(
    ["--live", "--max-calls", "5"],
    /--max-calls must be from 1 through 4/,
  );
});

test("live routing harness requires a controller-owned absolute ledger path", () => {
  assertRefusesLiveHarness(
    ["--live", "--max-calls", "4"],
    /absolute controller-owned --ledger path/,
  );
});

function invokeWithoutCredential(ledgerPath: string) {
  try {
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), "test/s05/live-routing.mjs"),
        "--live",
        "--max-calls",
        "4",
        "--ledger",
        ledgerPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TYPESAFE_API_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const result = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
    };
    assert.equal(result.status, 1);
    const report = JSON.parse(String(result.stdout ?? ""));
    assert.equal(report.failure.kind, "provider-access-rejected");
    assert.equal(report.provider.ledgerRetained, true);
    assert.equal(report.cleanup.appServerExited, false);
    return report;
  }
  assert.fail(
    "harness should stop before provider use when credentials are absent",
  );
}

test("separate live harness invocations preserve one controller-owned ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-ledger-invocations-"));
  const ledgerPath = join(root, "controller-owned.sqlite");
  let budget: SqliteLiveCallBudget | undefined;
  try {
    const first = invokeWithoutCredential(ledgerPath);
    assert.equal(first.provider.reservedCalls, 0);

    budget = new SqliteLiveCallBudget(ledgerPath, 4);
    budget.reserve();
    budget.close();
    budget = undefined;

    const second = invokeWithoutCredential(ledgerPath);
    assert.equal(second.provider.reservedCalls, 1);
    budget = new SqliteLiveCallBudget(ledgerPath, 4);
    assert.equal(budget.reservedCalls(), 1);
  } finally {
    budget?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture file action honors a denied production approval decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-denied-action-"));
  const workspacePath = join(root, "workspace");
  const databasePath = join(root, "service.sqlite");
  mkdirSync(workspacePath, { mode: 0o700 });
  const assignmentId = "10000000-0000-4000-8000-000000000001";
  const interactionId = "20000000-0000-4000-8000-000000000001";
  const profileId = "30000000-0000-4000-8000-000000000001";
  const materialJson =
    '{"content":"S05_ALPHA_TASK_MARKER_DENIED_ACTION_MUST_NOT_EXIST","relativePath":"s05-denied.txt"}';
  const materialHash = createHash("sha256").update(materialJson).digest("hex");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE coordination_interactions (
        interactionId TEXT NOT NULL,
        requestingAssignmentId TEXT NOT NULL,
        requestingAssignmentVersion INTEGER NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        materialHash TEXT NOT NULL,
        materialJson TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE domain_assignments (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        profileId TEXT NOT NULL
      );
      CREATE TABLE profiles (id TEXT NOT NULL, revoked INTEGER NOT NULL);
    `);
    database
      .prepare("INSERT INTO profiles (id, revoked) VALUES (?, 0)")
      .run(profileId);
    database
      .prepare(
        "INSERT INTO domain_assignments (id, version, profileId) VALUES (?, 1, ?)",
      )
      .run(assignmentId, profileId);
    database
      .prepare(
        `INSERT INTO coordination_interactions
          (interactionId, requestingAssignmentId,
           requestingAssignmentVersion, status, revision, action, target,
           materialHash, materialJson, kind)
         VALUES (?, ?, 1, 'denied', 2, ?, ?, ?, ?, 'approval')`,
      )
      .run(
        interactionId,
        assignmentId,
        "Write fixture-only relative file",
        "s05-denied.txt",
        materialHash,
        materialJson,
      );
  } finally {
    database.close();
  }

  try {
    const journeyUi = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-journey-ui.mjs")).href
    );
    const decision = journeyUi.runFixtureRelativeFileApprovalAdapter({
      databasePath,
      workspacePath,
      approval: {
        interactionId,
        requestingAssignmentId: assignmentId,
        revision: 2,
        status: "denied",
        action: "Write fixture-only relative file",
        target: "s05-denied.txt",
        materialJson,
      },
    });
    assert.equal(decision.authorizationChecked, true);
    assert.equal(decision.authorizationGranted, false);
    assert.equal(decision.targetWithinWorkspace, true);
    assert.equal(decision.fileCreated, false);
    assert.equal(decision.fileAbsent, true);
    assert.equal(existsSync(join(workspacePath, "s05-denied.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: false });
  }
});

test("mid-stage cleanup closes registered owners and retains an unverified root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-repository-free-"));
  const previousExitCode = process.exitCode;
  const calls: string[] = [];
  const evidence = {
    fixture: {
      created: true,
      removed: false,
      retained: false,
      recoveryToken: basename(root),
    },
    cleanup: {
      appServerProcessesVerifiedExited: [] as unknown[],
      errors: [] as Array<Record<string, unknown>>,
      allServicesExited: false,
      allOperatorServersStopped: false,
      allOperatorAuthClosed: false,
      browserClosed: false,
    },
    failure: {
      stage: "authenticated-operator-ui",
      kind: "journey-or-operator-assertion",
      errorType: "Error",
    },
  };
  const serviceOwners = [
    {
      startAttempted: true,
      stopped: false,
      exitVerified: false,
      processIdentity: undefined,
      service: {
        async stop() {
          calls.push("service-stop");
          throw new Error(`${root} S05_CLEANUP_PRIVATE_SENTINEL`);
        },
      },
    },
  ];
  const operatorOwners = [
    {
      startAttempted: true,
      httpStopped: false,
      authClosed: false,
      http: {
        async stop() {
          calls.push("operator-http-stop");
        },
      },
      auth: {
        close() {
          calls.push("operator-auth-close");
        },
      },
    },
  ];
  process.exitCode = undefined;
  try {
    const journeyUi = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-journey-ui.mjs")).href
    );
    await journeyUi.cleanupJourneyResources({
      root,
      mode: "repository-free",
      evidence,
      browserLaunchAttempted: true,
      browserContext: {
        async close() {
          calls.push("browser-context-close");
        },
      },
      browser: {
        async close() {
          calls.push("browser-close");
        },
      },
      operatorOwners,
      serviceOwners,
    });
    assert.deepEqual(calls, [
      "browser-context-close",
      "browser-close",
      "operator-http-stop",
      "operator-auth-close",
      "service-stop",
    ]);
    assert.equal(evidence.cleanup.appServerProcessesVerifiedExited.length, 0);
    assert.equal(evidence.cleanup.allServicesExited, false);
    assert.equal(evidence.cleanup.allOperatorServersStopped, true);
    assert.equal(evidence.cleanup.allOperatorAuthClosed, true);
    assert.equal(evidence.cleanup.browserClosed, true);
    assert.equal(evidence.fixture.removed, false);
    assert.equal(evidence.fixture.retained, true);
    assert.equal(evidence.fixture.recoveryToken, basename(root));
    const report = JSON.stringify(evidence);
    assert.equal(report.includes(root), false);
    assert.equal(report.includes("S05_CLEANUP_PRIVATE_SENTINEL"), false);
    assert.equal(
      evidence.cleanup.errors.some(
        (error) =>
          error.stage === "service-stop" && error.errorType === "Error",
      ),
      true,
    );
  } finally {
    process.exitCode = previousExitCode;
    if (existsSync(root)) rmSync(root, { recursive: true, force: false });
  }
});

test("journey cleanup removes an exact created canonical fixture root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-repository-"));
  const evidence = {
    fixture: {
      created: true,
      removed: false,
      retained: false,
      recoveryToken: basename(root),
    },
    cleanup: {
      appServerProcessesVerifiedExited: [],
      errors: [],
      allServicesExited: false,
      allOperatorServersStopped: false,
      allOperatorAuthClosed: false,
      browserClosed: false,
      startupOwnersPending: [],
      startupTimeouts: [],
    },
    failure: null,
  };
  try {
    const journeyUi = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-journey-ui.mjs")).href
    );
    const result = await journeyUi.cleanupJourneyResources({
      root,
      mode: "repository",
      evidence,
      browserLaunchAttempted: false,
      browserContext: undefined,
      browser: undefined,
      operatorOwners: [],
      serviceOwners: [],
    });
    assert.equal(result.fixtureRemoved, true);
    assert.equal(evidence.fixture.removed, true);
    assert.equal(evidence.fixture.retained, false);
    assert.equal(evidence.fixture.recoveryToken, null);
    assert.equal(existsSync(root), false);
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: false });
  }
});

test("journey cleanup retains foreign, wrong-parent, and symlink roots", async () => {
  const foreignRoot = mkdtempSync(join(tmpdir(), "s05-foreign-root-"));
  const parent = mkdtempSync(join(tmpdir(), "ensemble-s05-parent-"));
  const wrongParentRoot = join(
    parent,
    `ensemble-s05-repository-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  );
  mkdirSync(wrongParentRoot);
  const symlinkTarget = mkdtempSync(join(tmpdir(), "ensemble-s05-repository-"));
  const unclaimedRoot = mkdtempSync(join(tmpdir(), "ensemble-s05-repository-"));
  const symlinkRoot = join(
    tmpdir(),
    `ensemble-s05-repository-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
  );
  symlinkSync(symlinkTarget, symlinkRoot, "dir");
  const cases = [
    { root: foreignRoot, created: true },
    { root: wrongParentRoot, created: true },
    { root: symlinkRoot, created: true },
    { root: unclaimedRoot, created: false },
  ];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const journeyUi = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-journey-ui.mjs")).href
    );
    for (const { root, created } of cases) {
      const evidence = {
        fixture: {
          created,
          removed: false,
          retained: false,
          recoveryToken: basename(root),
        },
        cleanup: {
          appServerProcessesVerifiedExited: [],
          errors: [],
          allServicesExited: false,
          allOperatorServersStopped: false,
          allOperatorAuthClosed: false,
          browserClosed: false,
          startupOwnersPending: [],
          startupTimeouts: [],
        },
        failure: null,
      };
      const result = await journeyUi.cleanupJourneyResources({
        root,
        mode: "repository",
        evidence,
        browserLaunchAttempted: false,
        browserContext: undefined,
        browser: undefined,
        operatorOwners: [],
        serviceOwners: [],
      });
      assert.equal(result.fixtureRemoved, false);
      assert.equal(evidence.fixture.retained, true);
      assert.equal(existsSync(root), true);
    }
    assert.equal(existsSync(symlinkTarget), true);
  } finally {
    process.exitCode = previousExitCode;
    if (existsSync(symlinkRoot)) unlinkSync(symlinkRoot);
    for (const root of [
      foreignRoot,
      wrongParentRoot,
      symlinkTarget,
      unclaimedRoot,
    ]) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: false });
    }
    if (existsSync(parent)) rmSync(parent, { recursive: true, force: false });
  }
});

test("timed-out startup retains ownership through late resolution or rejection", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const journeyUi = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-journey-ui.mjs")).href
    );
    for (const disposition of [
      "resolve",
      "reject",
      "disposer-failure",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "ensemble-s05-repository-free-"));
      let settleStartup!: (error?: Error) => void;
      const calls: string[] = [];
      const owner = {
        startupKind: "service",
        startupPending: false,
        startupTimedOut: false,
        startupPromise: undefined as Promise<void> | undefined,
        lateCleanupPromise: undefined as Promise<void> | undefined,
        lateCleanupFailed: false,
        startAttempted: true,
        stopped: false,
        exitVerified: false,
        processIdentity: undefined,
        service: {
          async stop() {
            calls.push("service-stop");
            if (disposition === "disposer-failure")
              throw new Error(`${root} S05_LATE_DISPOSER_PRIVATE_SENTINEL`);
          },
        },
      };
      const evidence = {
        fixture: {
          created: true,
          removed: false,
          retained: false,
          recoveryToken: basename(root),
        },
        cleanup: {
          appServerProcessesVerifiedExited: [] as unknown[],
          errors: [] as Array<Record<string, unknown>>,
          allServicesExited: false,
          allOperatorServersStopped: false,
          allOperatorAuthClosed: false,
          browserClosed: false,
          startupOwnersPending: [] as Array<Record<string, unknown>>,
          startupTimeouts: [] as Array<Record<string, unknown>>,
        },
        failure: null as Record<string, unknown> | null,
      };
      try {
        await assert.rejects(
          journeyUi.awaitJourneyStartup(
            owner,
            "service-startup",
            () =>
              new Promise<void>((resolve, reject) => {
                settleStartup = (error) => (error ? reject(error) : resolve());
              }),
            5,
          ),
          /journey timeout: service-startup/,
        );
        assert.equal(owner.startupPending, true);
        assert.equal(owner.startupTimedOut, true);
        await journeyUi.cleanupJourneyResources({
          root,
          mode: "repository-free",
          evidence,
          browserLaunchAttempted: false,
          browserContext: undefined,
          browser: undefined,
          operatorOwners: [],
          serviceOwners: [owner],
        });
        assert.deepEqual(calls, []);
        assert.equal(evidence.cleanup.allServicesExited, false);
        assert.deepEqual(evidence.cleanup.appServerProcessesVerifiedExited, []);
        assert.equal(evidence.fixture.retained, true);
        assert.equal(evidence.fixture.removed, false);
        assert.equal(existsSync(root), true);
        assert.deepEqual(evidence.cleanup.startupOwnersPending, [
          {
            owner: "service-1",
            stage: "service-startup",
            state: "pending",
          },
        ]);
        assert.deepEqual(evidence.cleanup.startupTimeouts, [
          { owner: "service-1", stage: "service-startup" },
        ]);

        settleStartup(
          disposition === "reject"
            ? new Error(`${root} S05_LATE_START_PRIVATE_SENTINEL`)
            : undefined,
        );
        await owner.lateCleanupPromise;
        const lateStart = owner.startupPromise;
        assert.ok(lateStart);
        if (disposition === "reject") await assert.rejects(lateStart);
        else await lateStart;
        assert.deepEqual(calls, ["service-stop"]);
        assert.equal(
          owner.lateCleanupFailed === true,
          disposition === "disposer-failure",
        );
        assert.equal(evidence.cleanup.allServicesExited, false);
        assert.equal(evidence.fixture.retained, true);
        assert.equal(existsSync(root), true);
        assert.equal(JSON.stringify(evidence).includes(root), false);
        assert.equal(
          JSON.stringify(evidence).includes("S05_LATE_START_PRIVATE_SENTINEL"),
          false,
        );
        assert.equal(
          JSON.stringify(evidence).includes(
            "S05_LATE_DISPOSER_PRIVATE_SENTINEL",
          ),
          false,
        );
      } finally {
        if (existsSync(root)) rmSync(root, { recursive: true, force: false });
      }
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("operator startup timeout disposes late handles despite listener-stop failure", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const journeyUi = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-journey-ui.mjs")).href
    );
    for (const failHttpStop of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "ensemble-s05-repository-"));
      const calls: string[] = [];
      let resolveAuth!: (auth: { close(): void }) => void;
      const owner = {
        startupKind: "operator",
        startupPending: false,
        startupTimedOut: false,
        startupPromise: undefined as Promise<number> | undefined,
        lateCleanupPromise: undefined as Promise<void> | undefined,
        lateCleanupFailed: false,
        startAttempted: false,
        httpStopped: true,
        authClosed: true,
        auth: undefined as { close(): void } | undefined,
        http: undefined as { stop(): Promise<void> } | undefined,
      };
      const evidence = {
        fixture: {
          created: true,
          removed: false,
          retained: false,
          recoveryToken: basename(root),
        },
        cleanup: {
          appServerProcessesVerifiedExited: [] as unknown[],
          errors: [] as Array<Record<string, unknown>>,
          allServicesExited: false,
          allOperatorServersStopped: false,
          allOperatorAuthClosed: false,
          browserClosed: false,
          startupOwnersPending: [] as Array<Record<string, unknown>>,
          startupTimeouts: [] as Array<Record<string, unknown>>,
        },
        failure: null as Record<string, unknown> | null,
      };
      try {
        await assert.rejects(
          journeyUi.awaitJourneyStartup(
            owner,
            "operator-startup",
            async () => {
              owner.auth = await new Promise((resolve) => {
                resolveAuth = resolve;
              });
              owner.authClosed = false;
              owner.http = {
                async stop() {
                  calls.push("http-stop");
                  if (failHttpStop)
                    throw new Error(
                      `${root} S05_LATE_HTTP_STOP_PRIVATE_SENTINEL`,
                    );
                },
              };
              owner.startAttempted = true;
              owner.httpStopped = false;
              return 0;
            },
            5,
          ),
          /journey timeout: operator-startup/,
        );
        await journeyUi.cleanupJourneyResources({
          root,
          mode: "repository",
          evidence,
          browserLaunchAttempted: false,
          browserContext: undefined,
          browser: undefined,
          operatorOwners: [owner],
          serviceOwners: [],
        });
        assert.equal(calls.length, 0);
        assert.equal(evidence.cleanup.allOperatorServersStopped, false);
        assert.equal(evidence.cleanup.allOperatorAuthClosed, false);
        assert.deepEqual(evidence.cleanup.startupOwnersPending, [
          {
            owner: "operator-1",
            stage: "operator-startup",
            state: "pending",
          },
        ]);
        assert.equal(evidence.fixture.retained, true);
        assert.equal(existsSync(root), true);

        resolveAuth({
          close() {
            calls.push("auth-close");
          },
        });
        await owner.lateCleanupPromise;
        assert.deepEqual(calls, ["http-stop", "auth-close"]);
        assert.equal(owner.httpStopped, !failHttpStop);
        assert.equal(owner.authClosed, true);
        assert.equal(owner.lateCleanupFailed, failHttpStop);
        assert.equal(evidence.cleanup.allOperatorServersStopped, false);
        assert.equal(evidence.cleanup.allOperatorAuthClosed, false);
        assert.equal(evidence.fixture.retained, true);
        assert.equal(JSON.stringify(evidence).includes(root), false);
        assert.equal(
          JSON.stringify(evidence).includes(
            "S05_LATE_HTTP_STOP_PRIVATE_SENTINEL",
          ),
          false,
        );
      } finally {
        if (existsSync(root)) rmSync(root, { recursive: true, force: false });
      }
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("routing cleanup attempts every owned closer after failures", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const calls: string[] = [];
  const privateSentinel = "/private/tmp/S05_ROUTING_CLEANUP_PRIVATE_SENTINEL";
  try {
    const cleanup = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-routing-cleanup.mjs"))
        .href
    );
    const result = await cleanup.cleanupRoutingResources({
      context: {
        async close() {
          calls.push("context-close");
          throw Object.assign(new Error(privateSentinel), {
            name: "S05PrivateSecretCanary",
          });
        },
      },
      browser: {
        async close() {
          calls.push("browser-close");
        },
      },
      http: {
        async stop() {
          calls.push("http-stop");
          throw new Error(privateSentinel);
        },
      },
      auth: {
        close() {
          calls.push("auth-close");
          throw new Error(privateSentinel);
        },
      },
      serviceStartAttempted: true,
      service: {
        async stop() {
          calls.push("service-stop");
          throw new Error(privateSentinel);
        },
      },
      processIdentity: { processId: 12345 },
      async verifyExited() {
        calls.push("process-exit-verification");
        throw new Error(privateSentinel);
      },
      budget: {
        reservedCalls() {
          calls.push("ledger-reservation-read");
          throw new Error(privateSentinel);
        },
        close() {
          calls.push("ledger-close");
        },
      },
      privateValues: {
        clear() {
          calls.push("private-value-clear");
        },
      },
    });

    assert.deepEqual(calls, [
      "context-close",
      "browser-close",
      "http-stop",
      "auth-close",
      "service-stop",
      "process-exit-verification",
      "ledger-reservation-read",
      "ledger-close",
      "private-value-clear",
    ]);
    assert.deepEqual(
      {
        contextClosed: result.contextClosed,
        browserClosed: result.browserClosed,
        httpStopped: result.httpStopped,
        authClosed: result.authClosed,
        serviceStopped: result.serviceStopped,
        appServerExited: result.appServerExited,
        appServerExitStatus: result.appServerExitStatus,
        ledgerReservationsRead: result.ledgerReservationsRead,
        ledgerClosed: result.ledgerClosed,
        privateValuesCleared: result.privateValuesCleared,
        safeToRemoveFixture: result.safeToRemoveFixture,
      },
      {
        contextClosed: false,
        browserClosed: true,
        httpStopped: false,
        authClosed: false,
        serviceStopped: false,
        appServerExited: false,
        appServerExitStatus: "unverified",
        ledgerReservationsRead: false,
        ledgerClosed: true,
        privateValuesCleared: true,
        safeToRemoveFixture: false,
      },
    );
    assert.deepEqual(
      result.errors.map((error: { stage: string; errorType: string }) => ({
        stage: error.stage,
        errorType: error.errorType,
      })),
      [
        { stage: "context-close", errorType: "Error" },
        { stage: "operator-http-stop", errorType: "Error" },
        { stage: "operator-auth-close", errorType: "Error" },
        { stage: "service-stop", errorType: "Error" },
        { stage: "app-server-exit-verification", errorType: "Error" },
        { stage: "ledger-reservation-read", errorType: "Error" },
      ],
    );
    assert.equal(result.reservedCalls, null);
    assert.equal(JSON.stringify(result).includes(privateSentinel), false);
    assert.equal(
      JSON.stringify(result).includes("S05PrivateSecretCanary"),
      false,
    );
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("routing cleanup retains started service without exact process identity", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const calls: string[] = [];
  try {
    const cleanup = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-routing-cleanup.mjs"))
        .href
    );
    const result = await cleanup.cleanupRoutingResources({
      serviceStartAttempted: true,
      service: {
        async stop() {
          calls.push("service-stop");
        },
      },
      processIdentity: null,
      async verifyExited() {
        calls.push("unexpected-process-verification");
        return { kind: "verified" };
      },
      budget: {
        reservedCalls() {
          calls.push("ledger-reservation-read");
          return 4;
        },
        close() {
          calls.push("ledger-close");
        },
      },
    });

    assert.deepEqual(calls, [
      "service-stop",
      "ledger-reservation-read",
      "ledger-close",
    ]);
    assert.equal(result.serviceStopped, true);
    assert.equal(result.appServerExited, false);
    assert.equal(result.appServerExitStatus, "unverified");
    assert.equal(result.ledgerClosed, true);
    assert.equal(result.reservedCalls, 4);
    assert.equal(result.safeToRemoveFixture, false);
    assert.deepEqual(result.errors, [
      {
        stage: "app-server-exit-verification",
        errorType: "MissingProcessIdentity",
      },
    ]);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("routing cleanup accepts safely absent resources before service startup", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const cleanup = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-routing-cleanup.mjs"))
        .href
    );
    const result = await cleanup.cleanupRoutingResources({
      serviceStartAttempted: false,
      budget: {
        reservedCalls() {
          return 4;
        },
        close() {},
      },
    });

    assert.equal(result.contextClosed, true);
    assert.equal(result.browserClosed, true);
    assert.equal(result.httpStopped, true);
    assert.equal(result.authClosed, true);
    assert.equal(result.serviceStopped, true);
    assert.equal(result.appServerExited, false);
    assert.equal(result.appServerExitStatus, "not-started");
    assert.equal(result.ledgerReservationsRead, true);
    assert.equal(result.ledgerClosed, true);
    assert.equal(result.privateValuesCleared, true);
    assert.equal(result.safeToRemoveFixture, true);
    assert.equal(result.reservedCalls, 4);
    assert.deepEqual(result.errors, []);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("routing cleanup verifies owned handles and ledger on the safe path", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const calls: string[] = [];
  try {
    const cleanup = await import(
      pathToFileURL(join(process.cwd(), "test/s05/live-routing-cleanup.mjs"))
        .href
    );
    const result = await cleanup.cleanupRoutingResources({
      context: {
        async close() {
          calls.push("context-close");
        },
      },
      browser: {
        async close() {
          calls.push("browser-close");
        },
      },
      http: {
        async stop() {
          calls.push("http-stop");
        },
      },
      auth: {
        close() {
          calls.push("auth-close");
        },
      },
      serviceStartAttempted: true,
      service: {
        async stop() {
          calls.push("service-stop");
        },
      },
      processIdentity: { processId: 12345 },
      async verifyExited() {
        calls.push("process-exit-verification");
        return { kind: "verified" };
      },
      budget: {
        reservedCalls() {
          calls.push("ledger-reservation-read");
          return 4;
        },
        close() {
          calls.push("ledger-close");
        },
      },
      privateValues: {
        clear() {
          calls.push("private-value-clear");
        },
      },
    });

    assert.deepEqual(calls, [
      "context-close",
      "browser-close",
      "http-stop",
      "auth-close",
      "service-stop",
      "process-exit-verification",
      "ledger-reservation-read",
      "ledger-close",
      "private-value-clear",
    ]);
    assert.equal(result.contextClosed, true);
    assert.equal(result.browserClosed, true);
    assert.equal(result.httpStopped, true);
    assert.equal(result.authClosed, true);
    assert.equal(result.serviceStopped, true);
    assert.equal(result.appServerExited, true);
    assert.equal(result.appServerExitStatus, "verified");
    assert.equal(result.ledgerReservationsRead, true);
    assert.equal(result.ledgerClosed, true);
    assert.equal(result.privateValuesCleared, true);
    assert.equal(result.reservedCalls, 4);
    assert.equal(result.safeToRemoveFixture, true);
    assert.deepEqual(result.errors, []);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});
