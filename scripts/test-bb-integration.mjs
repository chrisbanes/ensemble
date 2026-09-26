import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExpectedT4Failure,
  assertIntegrationReport,
  assertT5Reports,
  buildIntegrationReport,
  readIntegrationReport,
  sanitizeIntegrationData,
  writeIntegrationReport,
} from "../test/bb-integration/report.mjs";
import { terminateOwnedProcessGroup } from "../test/bb-integration/owned-process-group.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nodePin = "24.21.0";
const bbPin = "0.44.0";
const pluginSdkPin = "0.5.30";
const playwrightPin = "1.63.0";
const hostSdkPin = "0.5.29";
const sourceBridgeProvenance = JSON.parse(
  await readFile(
    path.join(
      repositoryRoot,
      "test/bb-integration/fixture/provider-bridge.provenance.json",
    ),
    "utf8",
  ),
);
const packageTreePins = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "test/bb-integration/package-tree-digests.json"),
    "utf8",
  ),
);
const lockfile = JSON.parse(
  await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
);
const manifestPath = path.join(
  repositoryRoot,
  "node_modules/.cache/ensemble-bb-integration/suite-report.json",
);
const suiteRunDirectory = path.join(
  repositoryRoot,
  "node_modules/.cache/ensemble-bb-integration/suite-run",
);
const t5ReportDirectory = path.join(suiteRunDirectory, "t5-gates");
const scenarioTimeoutMs = 300_000;
const maxOutputBytes = 16 * 1024 * 1024;

const scenarios = [
  {
    id: "T1",
    file: "test/bb-integration/runtime.test.mjs",
    expectedExitCode: 0,
  },
  {
    id: "T2",
    file: "test/bb-integration/execution.test.mjs",
    expectedExitCode: 0,
  },
  {
    id: "T3",
    file: "test/bb-integration/lost-response.test.mjs",
    expectedExitCode: 0,
  },
  {
    id: "T4",
    file: "test/bb-integration/dispatch.test.mjs",
    expectedExitCode: 1,
  },
  {
    id: "T5",
    file: "test/bb-integration/recovery-gates.test.mjs",
    expectedExitCode: 0,
  },
];

const sourceFiles = new Set([
  ".github/workflows/ci.yml",
  ".node-version",
  "docs/acceptance.md",
  "docs/bb-capabilities.md",
  "docs/design/bb-plugin.md",
  "package-lock.json",
  "package.json",
  "scripts/check-bb-integration.mjs",
  "scripts/test-bb-integration.mjs",
]);

async function integrationSourceDigest() {
  const result = spawnSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `Unable to enumerate integration sources: ${result.stderr.toString("utf8")}`,
  );
  const files = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(
      (file) =>
        file.startsWith("test/bb-integration/") || sourceFiles.has(file),
    )
    .sort();
  assert(files.length > 0, "No integration source files were found");
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file);
    digest.update("\0");
    digest.update(await readFile(path.join(repositoryRoot, file)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function runScenario(scenario, manifestFile) {
  const command = `${process.execPath} --test --test-reporter=tap ${scenario.file}`;
  const child = spawn(
    process.execPath,
    ["--test", "--test-reporter=tap", scenario.file],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ENSEMBLE_T1_RUN_MANIFEST_PATH: manifestFile,
        ENSEMBLE_T5_GATE_REPORT_DIRECTORY: t5ReportDirectory,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const processGroupId = child.pid;
  let output = "";
  let outputBytes = 0;
  let outputExceeded = false;
  const collect = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      outputExceeded = true;
      return;
    }
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const closeResult = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  let timedOut = false;
  let closed;
  let timeoutCleanupError;
  let timeoutHandle;
  const timeoutResult = new Promise((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ timedOut: true }),
      scenarioTimeoutMs,
    );
  });
  try {
    const first = await Promise.race([
      closeResult.then((result) => ({ result })),
      timeoutResult,
    ]);
    if (first.timedOut) {
      timedOut = true;
      try {
        closed = await terminateOwnedProcessGroup({
          child,
          processGroupId,
          closePromise: closeResult,
        });
      } catch (error) {
        timeoutCleanupError = String(error);
      }
    } else {
      closed = first.result;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return {
    id: scenario.id,
    file: scenario.file,
    command,
    exitCode: closed?.exitCode ?? null,
    signal: closed?.signal ?? null,
    expectedExitCode: scenario.expectedExitCode,
    timedOut,
    outputExceeded,
    timeoutCleanupError,
    testOutcome: timedOut
      ? "timeout"
      : closed.exitCode === scenario.expectedExitCode
        ? scenario.id === "T4"
          ? "expected-diagnostic"
          : "passed"
        : "failed",
    output,
    manifest,
  };
}

function assertPinnedManifest(id, manifest) {
  assert(manifest, `${id} did not persist a run manifest`);
  assert.equal(manifest.bb, bbPin, `${id} BB package changed`);
  assert.equal(
    manifest.pluginSdk,
    pluginSdkPin,
    `${id} plugin SDK package changed`,
  );
  assert.equal(manifest.node, nodePin, `${id} Node.js version changed`);
  assert.equal(
    manifest.playwright,
    playwrightPin,
    `${id} Playwright version changed`,
  );
  assert.equal(
    manifest.bbLockfileTarballIntegrity,
    lockfile.packages["node_modules/bb-app"].integrity,
    `${id} BB artifact integrity changed`,
  );
  assert.equal(
    manifest.pluginSdkLockfileTarballIntegrity,
    lockfile.packages["node_modules/@get-bb/plugin-sdk"].integrity,
    `${id} plugin SDK integrity changed`,
  );
  assert.equal(
    manifest.bbInstalledTreeSha256,
    packageTreePins.packages["bb-app"].treeSha256,
    `${id} installed BB package tree changed`,
  );
  assert.equal(
    manifest.pluginSdkInstalledTreeSha256,
    packageTreePins.packages["@get-bb/plugin-sdk"].treeSha256,
    `${id} installed plugin SDK package tree changed`,
  );
  assert.equal(
    manifest.providerBridgeRevision,
    sourceBridgeProvenance.revision,
    `${id} scripted provider source revision changed`,
  );
  assert.equal(
    manifest.providerBridgeUpstreamSha256,
    sourceBridgeProvenance.upstreamSourceSha256,
    `${id} scripted provider source digest changed`,
  );
  if (id === "T4") {
    assert.equal(
      manifest.checks?.t4PluginSdkCompatibility?.bbHostPluginSdk,
      hostSdkPin,
      "T4 BB host plugin SDK compatibility observation changed",
    );
  }
  const cleanup = manifest.checks?.ownedProcessCleanup;
  assert(cleanup, `${id} has no owned-process cleanup record`);
  assert.equal(cleanup.allExited, true, `${id} leaked an owned process`);
  assert.equal(cleanup.serverPortClosed, true, `${id} server port stayed open`);
  assert.equal(cleanup.daemonPortClosed, true, `${id} daemon port stayed open`);
  assert.equal(cleanup.forced, false, `${id} required forced process cleanup`);
}

function assertTapSummary(
  id,
  output,
  expectedTests,
  expectedPass,
  expectedFail,
) {
  for (const [field, expected] of [
    ["tests", expectedTests],
    ["pass", expectedPass],
    ["fail", expectedFail],
  ]) {
    const match = output.match(new RegExp(`^# ${field} (\\d+)$`, "mu"));
    assert(match, `${id} TAP output is missing # ${field}`);
    assert.equal(
      Number(match[1]),
      expected,
      `${id} TAP ${field} count changed`,
    );
  }
}

function assertT1Evidence(manifest) {
  const checks = manifest.checks;
  for (const key of [
    "publicPluginLoader",
    "pluginSettings",
    "browserPanel",
    "temporaryGitProject",
    "ownedProcessRoles",
    "scriptedToolResult",
    "pluginReloadPersistence",
    "bbRestartPersistence",
    "browserPanelAfterRestart",
  ]) {
    assert(
      Object.hasOwn(checks, key),
      `T1 required evidence ${key} is missing`,
    );
  }
  assert.equal(
    checks.scriptedToolResult.toolCalls,
    1,
    "T1 expected exactly one tool effect",
  );
  assert.equal(
    checks.pluginReloadPersistence.toolCalls,
    1,
    "T1 reload duplicated the tool effect",
  );
  assert.equal(
    checks.bbRestartPersistence.toolCalls,
    1,
    "T1 restart duplicated the tool effect",
  );
  assert(
    checks.ownedProcessRoles.includes("chromium"),
    "T1 browser process was not observed",
  );
}

function assertT2Evidence(manifest) {
  const checks = manifest.checks;
  for (const key of [
    "executionSpawn",
    "executionUnsupportedChoice",
    "executionRetry",
    "executionLifecycle",
    "executionInteraction",
    "sharedEnvironmentAfterRestart",
  ]) {
    assert(
      Object.hasOwn(checks, key),
      `T2 required evidence ${key} is missing`,
    );
  }
  assert.equal(
    checks.executionRetry.providerTrace.length,
    2,
    "T2 retry duplicated or lost a provider attempt",
  );
  assert.equal(
    checks.executionRetry.retry.attempt,
    2,
    "T2 explicit retry attempt identity changed",
  );
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "message.queued",
    "message.dispatched",
    "message.cancelled",
  ]) {
    assert(
      checks.executionLifecycle.some((entry) => entry.name === event),
      `T2 required public event ${event} is missing`,
    );
  }
}

function assertT3Evidence(manifest) {
  const evidence = manifest.checks?.lostResponse;
  assert(evidence, "T3 lost-response evidence is missing");
  for (const key of [
    "acceptedSpawnRecovered",
    "zeroSpawnMatchesHeld",
    "multipleSpawnMatchesHeld",
    "directSendRecovered",
    "delayedSendResponse",
    "queuedSendRecovered",
    "ambiguousQueueHeld",
    "staleGenerationInvalidated",
  ]) {
    assert(
      Object.hasOwn(evidence, key),
      `T3 required evidence ${key} is missing`,
    );
  }
  const spawnEffects = evidence.acceptedSpawnRecovered.providerToolEffects;
  const direct = evidence.directSendRecovered;
  const delayed = evidence.delayedSendResponse;
  const queued = evidence.queuedSendRecovered;
  assert.equal(spawnEffects, 1, "T3 accepted spawn produced one tool effect");
  assert.equal(
    direct.providerToolEffectDelta,
    1,
    "T3 direct send produced one additional effect",
  );
  assert.equal(
    delayed.providerToolEffectDelta,
    1,
    "T3 delayed send produced one additional effect",
  );
  assert.equal(
    queued.providerToolEffectDelta,
    1,
    "T3 queued send produced one additional effect",
  );
  assert.equal(direct.providerToolEffectCount, spawnEffects + 1);
  assert.equal(
    delayed.providerToolEffectCount,
    direct.providerToolEffectCount + 1,
  );
  assert.equal(
    queued.providerToolEffectCount,
    delayed.providerToolEffectCount + 1,
  );
  assert.equal(direct.sendCallsAfterReplay, 1);
  assert.equal(queued.sendCallsAfterReplay, 1);
  assert.equal(evidence.delayedSendResponse.lateResponseIgnored, true);
  assert.equal(
    evidence.staleGenerationInvalidated.providerToolEffectsAfterInvalidation,
    queued.providerToolEffectCount,
    "T3 stale-generation invalidation added no tool effect",
  );
  assert.equal(evidence.staleGenerationInvalidated.state, "invalidated");
  assert.equal(evidence.staleGenerationInvalidated.publicQueueRowDeleted, true);
  assert.match(
    evidence.idempotencyBoundary,
    /not establish general idempotency/u,
  );
}

async function readT5Reports() {
  const jsonlPath = path.join(t5ReportDirectory, "reports.jsonl");
  const lines = (await readFile(jsonlPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const rows = lines.map((line) => JSON.parse(line));
  assertT5Reports(rows);
  for (const report of rows) {
    const individualPath = path.join(t5ReportDirectory, `${report.name}.json`);
    const individual = JSON.parse(await readFile(individualPath, "utf8"));
    assert.deepEqual(
      individual,
      report,
      `T5 ${report.name} JSON and JSONL rows differ`,
    );
    assert.notEqual(
      report.verdict,
      "fail",
      `T5 ${report.name} scenario reports a failure`,
    );
  }
  return rows;
}

function gitHead() {
  const result = spawnSyncGitHead();
  assert.equal(
    result.status,
    0,
    `Unable to read repository HEAD: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function spawnSyncGitHead() {
  return spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function manifestMap(slices) {
  return Object.fromEntries(
    Object.entries(slices).map(([id, result]) => [
      id,
      { ...result, manifest: result.manifest },
    ]),
  );
}

async function main() {
  assert.equal(
    process.versions.node,
    nodePin,
    `Use Node ${nodePin} for BB integration`,
  );
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.packageManager, "npm@12.1.0", "npm pin changed");
  const npmVersion =
    process.env.npm_config_user_agent?.match(/npm\/(\d+\.\d+\.\d+)/u)?.[1];
  assert.equal(npmVersion, "12.1.0", "Run through pinned npm@12.1.0");
  assert.equal(packageTreePins.measuredWith.node, nodePin);
  assert.equal(packageTreePins.measuredWith.npm, npmVersion);
  await rm(suiteRunDirectory, { recursive: true, force: true });
  await mkdir(t5ReportDirectory, { recursive: true });
  const sourceDigest = await integrationSourceDigest();

  const slices = {};
  const failures = [];
  for (const scenario of scenarios) {
    process.stdout.write(
      `BB_INTEGRATION_START ${scenario.id} ${scenario.file}\n`,
    );
    const runManifestPath = path.join(
      suiteRunDirectory,
      `${scenario.id}.run-manifest.json`,
    );
    let result;
    try {
      result = await runScenario(scenario, runManifestPath);
      slices[scenario.id] = result;
      assert.equal(
        result.outputExceeded,
        false,
        `${scenario.id} child output exceeded ${maxOutputBytes} bytes`,
      );
      if (scenario.id === "T4") {
        const observed = assertExpectedT4Failure({
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output: result.output,
          manifest: result.manifest,
        });
        result.t4Diagnostic = observed;
      } else {
        assert.equal(
          result.timedOut,
          false,
          `${scenario.id} timed out after ${scenarioTimeoutMs} ms${result.timeoutCleanupError ? `; ${result.timeoutCleanupError}` : ""}`,
        );
        assert.equal(
          result.exitCode,
          0,
          `${scenario.id} test child failed\n${result.output}`,
        );
        assertTapSummary(
          scenario.id,
          result.output,
          scenario.id === "T5" ? 6 : 1,
          scenario.id === "T5" ? 6 : 1,
          0,
        );
        assert.equal(
          result.manifest?.outcome,
          "passed",
          `${scenario.id} runtime manifest is not passed`,
        );
        assertPinnedManifest(scenario.id, result.manifest);
        if (scenario.id === "T1") assertT1Evidence(result.manifest);
        if (scenario.id === "T2") assertT2Evidence(result.manifest);
        if (scenario.id === "T3") assertT3Evidence(result.manifest);
      }
      if (scenario.id === "T4")
        assertPinnedManifest(scenario.id, result.manifest);
      if (scenario.id === "T4")
        assertTapSummary(scenario.id, result.output, 1, 0, 1);
      process.stdout.write(
        `BB_INTEGRATION_DONE ${scenario.id} ${result.testOutcome}\n`,
      );
    } catch (error) {
      failures.push({ scenario: scenario.id, message: String(error) });
      if (result) {
        slices[scenario.id] = result;
      } else {
        slices[scenario.id] = {
          id: scenario.id,
          file: scenario.file,
          command: `${process.execPath} --test --test-reporter=tap ${scenario.file}`,
          exitCode: null,
          expectedExitCode: scenario.expectedExitCode,
          timedOut: false,
          testOutcome: "failed",
          output: "",
        };
        try {
          slices[scenario.id].manifest = JSON.parse(
            await readFile(runManifestPath, "utf8"),
          );
        } catch {
          // Missing manifest remains explicit in the failure report.
        }
      }
      process.stderr.write(
        `BB_INTEGRATION_FAIL ${scenario.id} ${String(error)}${result?.output ? `\n${result.output.slice(-8_000)}` : ""}\n`,
      );
      if (result?.timedOut) break;
    }
  }

  let t5Reports = [];
  if (slices.T5?.exitCode === 0) {
    try {
      t5Reports = await readT5Reports();
    } catch (error) {
      failures.push({ scenario: "T5 reports", message: String(error) });
    }
  }

  const head = gitHead();
  const report = buildIntegrationReport({
    ensembleHead: head,
    sourceDigest,
    slices: manifestMap(slices),
    t5Reports,
    replacements: [
      [repositoryRoot, "<repository>"],
      [os.homedir(), "<home>"],
      [os.tmpdir(), "<temporary-directory>"],
    ],
  });
  report.toolchain = { node: process.versions.node, npm: npmVersion };
  if (failures.length > 0) {
    report.outcome = "failed-harness";
    report.failures = sanitizeIntegrationData(failures, [
      [repositoryRoot, "<repository>"],
      [os.homedir(), "<home>"],
      [os.tmpdir(), "<temporary-directory>"],
    ]);
  }

  try {
    assertIntegrationReport(report);
  } catch (error) {
    failures.push({ scenario: "report validation", message: String(error) });
    report.outcome = "failed-harness";
    report.failures = sanitizeIntegrationData(failures, [
      [repositoryRoot, "<repository>"],
      [os.homedir(), "<home>"],
      [os.tmpdir(), "<temporary-directory>"],
    ]);
  }
  await writeIntegrationReport(manifestPath, report);
  try {
    assert.deepEqual(await readIntegrationReport(manifestPath), report);
  } catch (error) {
    failures.push({ scenario: "report readback", message: String(error) });
    report.outcome = "failed-harness";
    report.failures = sanitizeIntegrationData(failures, [
      [repositoryRoot, "<repository>"],
      [os.homedir(), "<home>"],
      [os.tmpdir(), "<temporary-directory>"],
    ]);
    await writeIntegrationReport(manifestPath, report);
  }
  process.stdout.write(`BB_INTEGRATION_REPORT_PATH ${manifestPath}\n`);
  process.stdout.write(
    `BB_INTEGRATION_REPORT_SUMMARY ${JSON.stringify({
      outcome: report.outcome,
      apiRows: report.rows.filter((entry) => entry.type === "public-api")
        .length,
      proofGates: report.rows.filter((entry) => entry.type === "proof-gate")
        .length,
      t5Rows: t5Reports.length,
      failedGateIds: report.rows
        .filter(
          (entry) =>
            entry.type === "proof-gate" &&
            entry.verdict === "failed-capability",
        )
        .map((entry) => entry.id),
      dependentExecutionBlocked: report.dependentExecutionBlocked,
    })}\n`,
  );
  if (failures.length > 0) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
