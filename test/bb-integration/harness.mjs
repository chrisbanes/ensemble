import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const expected = {
  node: "24.21.0",
  bb: "0.43.4",
  bbIntegrity:
    "sha512-+Al7eFihHN9350ao8LTVyoPbY4bbiRg8j2ZQNTlNjRLSaYpyTUR87aph6KqkqJR3sskMtPpxhLOaiFqqYO5LBQ==",
  sdk: "0.5.24",
  sdkIntegrity:
    "sha512-NHF2PZosuP0FNO5OZwb3T2TdQEJ7Nyycv1Ytl1AVgIfZT8g5+sz9kFynZp6yLpmx2NJXq7oCivC4B+4WQXFLqQ==",
  playwright: "1.63.0",
  playwrightIntegrity:
    "sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==",
  providerBridgeSha256:
    "049cf0e0a74ce848488e0a0558a5cd7eb30f252b7e5ebaf3f50ce9624832cf4b",
  providerBridgeRevision: "fdd3de3b19b97e6cd1ef7300cbb54711431249d3",
  providerBridgeUpstreamSha256:
    "4af6205519d056007f179cec8e93b112e74a19fb9574c7ab489533e276c6dfe3",
};
const fixturePluginId = "ensemble-t1-fixture";
const runManifestPath = process.env.ENSEMBLE_T1_RUN_MANIFEST_PATH
  ? path.resolve(process.env.ENSEMBLE_T1_RUN_MANIFEST_PATH)
  : path.join(
      repositoryRoot,
      "node_modules/.cache/ensemble-bb-integration/run-manifest.json",
    );
const failureTraceName = `${path.basename(runManifestPath)}.failure-trace.txt`;
const persistedFailureTracePath = path.join(
  path.dirname(runManifestPath),
  failureTraceName,
);

function sanitize(text, root) {
  let sanitized = text
    .replaceAll(root, "<isolated-root>")
    .replaceAll(repositoryRoot, "<repository>")
    .replaceAll(homedir(), "<home>");
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/iu.test(name) &&
      value.length > 4
    ) {
      sanitized = sanitized.replaceAll(value, `<redacted:${name}>`);
    }
  }
  return sanitized.replace(
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu,
    "<redacted-secret>",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function readVersion(packagePath, expectedVersion, label) {
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(manifest.version, expectedVersion, `${label} version`);
  return manifest.version;
}

function failureManifestBaseline() {
  return {
    node: process.versions.node,
    bb: null,
    bbExpected: expected.bb,
    bbTarballIntegrity: expected.bbIntegrity,
    pluginSdk: null,
    pluginSdkExpected: expected.sdk,
    pluginSdkIntegrity: expected.sdkIntegrity,
    playwright: null,
    playwrightExpected: expected.playwright,
    providerBridgeRevision: expected.providerBridgeRevision,
    providerBridgeUpstreamSha256: expected.providerBridgeUpstreamSha256,
    providerBridgeInstrumentedSha256: expected.providerBridgeSha256,
    platform: `${process.platform}-${process.arch}`,
    checks: {},
  };
}

async function writeFailureEvidence(instance, error, root, fallbackManifest) {
  const trace = sanitize(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n${instance?.output() ?? ""}`,
    root,
  );
  const sourceManifest = instance?.runtimeManifest ?? fallbackManifest;
  assert(sourceManifest, "Failure evidence requires a runtime manifest");
  const manifest = {
    ...sourceManifest,
    outcome: "failed",
    checks: sourceManifest.checks ?? {},
    trace: failureTraceName,
  };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "failure-trace.txt"), trace);
  await mkdir(path.dirname(persistedFailureTracePath), { recursive: true });
  await writeFile(persistedFailureTracePath, trace);
  await writeFile(
    path.join(root, "run-manifest.json"),
    `${sanitize(JSON.stringify(manifest, null, 2), root)}\n`,
  );
  await persistRunManifest(manifest, root);
}

async function persistRunManifest(manifest, root) {
  const relative = path.relative(root, runManifestPath);
  const isInsideDisposableRoot =
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  assert.equal(
    isInsideDisposableRoot,
    false,
    "The T1 run manifest path must be outside the disposable BB instance",
  );
  await mkdir(path.dirname(runManifestPath), { recursive: true });
  await writeFile(
    runManifestPath,
    `${sanitize(JSON.stringify(manifest, null, 2), root)}\n`,
  );
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stageFixture(root) {
  const sourceDirectory = path.join(
    repositoryRoot,
    "test/bb-integration/fixture",
  );
  const fixtureDirectory = path.join(root, "fixture");
  await mkdir(fixtureDirectory, { recursive: true });
  for (const name of [
    "UPSTREAM-LICENSE",
    "app.tsx",
    "host.ts",
    "package.json",
    "provider-bridge.provenance.json",
    "provider-bridge.ts",
    "server.ts",
  ]) {
    await copyFile(
      path.join(sourceDirectory, name),
      path.join(fixtureDirectory, name),
    );
  }
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(fixtureDirectory, "node_modules"),
    "dir",
  );
  return fixtureDirectory;
}

async function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => {
      resolve(error.code === "ECONNREFUSED");
    });
  });
}

async function readProcessTable() {
  const { stdout } = await exec(
    "ps",
    ["-ww", "-axo", "pid=,ppid=,lstart=,command="],
    {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const processes = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u,
    );
    if (match) {
      const [, rawPid, rawParentPid, rawStartTime, command] = match;
      processes.set(Number(rawPid), {
        pid: Number(rawPid),
        parentPid: Number(rawParentPid),
        startTime: rawStartTime.replace(/\s+/gu, " ").trim(),
        command,
      });
    }
  }
  return processes;
}

function descendants(processes, rootPid) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes.values()) {
      if (!found.has(processInfo.pid) && found.has(processInfo.parentPid)) {
        found.add(processInfo.pid);
        changed = true;
      }
    }
  }
  return found;
}

function processRole(processInfo, instance, root) {
  if (processInfo.pid === root.pid) return root.role;
  if (
    processInfo.command.includes(
      path.join(instance.bbPackage, "server/dist/index.js"),
    )
  ) {
    return "bb-server";
  }
  if (
    processInfo.command.includes(
      path.join(instance.bbPackage, "host-daemon/dist/daemon-bundle.mjs"),
    )
  ) {
    return "bb-host-daemon";
  }
  return root.role === "chromium" ? "chromium-child" : "bb-child";
}

async function readProviderProcessIds(instance) {
  try {
    const log = await readFile(
      instance.env.SCRIPTED_ECHO_PROCESS_LOG_PATH,
      "utf8",
    );
    return [
      ...new Set(
        [...log.matchAll(/^spawn:(\d+)$/gmu)].map(([, pid]) => Number(pid)),
      ),
    ];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function processIdentity(processInfo) {
  return `${processInfo.startTime}\0${processInfo.command}`;
}

export async function captureOwnedProcesses(instance) {
  let processes = await readProcessTable();
  const providerPids = await readProviderProcessIds(instance);
  if (
    providerPids.some(
      (pid) => !processes.has(pid) && !instance.ownedProcesses.has(pid),
    )
  ) {
    processes = await readProcessTable();
  }
  const roots = [{ pid: instance.processHandle.pid, role: "bb-app" }];
  for (const server of instance.browserServers) {
    roots.push({ pid: server.process().pid, role: "chromium" });
  }

  for (const root of roots) {
    for (const pid of descendants(processes, root.pid)) {
      const processInfo = processes.get(pid);
      if (processInfo) {
        const role = processRole(processInfo, instance, root);
        const previous = instance.ownedProcesses.get(pid);
        const identities = new Set(previous?.identities ?? []);
        identities.add(processIdentity(processInfo));
        instance.ownedProcesses.set(pid, {
          pid,
          role: role === "bb-child" ? (previous?.role ?? role) : role,
          identities,
        });
      }
    }
  }

  for (const pid of providerPids) {
    const processInfo = processes.get(pid);
    const previous = instance.ownedProcesses.get(pid);
    const identities = new Set(previous?.identities ?? []);
    if (processInfo) identities.add(processIdentity(processInfo));
    instance.ownedProcesses.set(pid, {
      pid,
      role: "scripted-provider",
      identities,
    });
  }

  const ownedByPid = new Map(
    (instance.runtimeManifest.ownedProcesses ?? []).map(({ pid, role }) => [
      pid,
      { pid, role },
    ]),
  );
  for (const { pid, role } of instance.ownedProcesses.values()) {
    const previous = ownedByPid.get(pid);
    ownedByPid.set(pid, {
      pid,
      role: role === "bb-child" ? (previous?.role ?? role) : role,
    });
  }
  instance.runtimeManifest.ownedProcesses = [...ownedByPid.values()].sort(
    (left, right) => left.pid - right.pid,
  );
  return instance.runtimeManifest.ownedProcesses;
}

async function liveOwnedProcesses(instance) {
  const processes = await readProcessTable();
  return [...instance.ownedProcesses.values()].filter((owned) => {
    const current = processes.get(owned.pid);
    if (!current) return false;
    if (owned.identities.size === 0) return owned.role === "scripted-provider";
    return owned.identities.has(processIdentity(current));
  });
}

async function terminateLiveOwnedProcesses(instance, signal) {
  const live = await liveOwnedProcesses(instance);
  for (const owned of live.reverse()) {
    if (owned.identities.size === 0) continue;
    try {
      const current = (await readProcessTable()).get(owned.pid);
      if (!current || !owned.identities.has(processIdentity(current))) continue;
      process.kill(owned.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

export async function waitFor(callback, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}

export async function startBb(root, previousManifest) {
  assert.equal(process.versions.node, expected.node, "Use Node 24.21.0");
  const bbPackage = path.join(repositoryRoot, "node_modules/bb-app");
  const sdkPackage = path.join(
    repositoryRoot,
    "node_modules/@get-bb/plugin-sdk",
  );
  await readVersion(path.join(bbPackage, "package.json"), expected.bb, "BB");
  await readVersion(
    path.join(sdkPackage, "package.json"),
    expected.sdk,
    "Plugin SDK",
  );
  await readVersion(
    path.join(repositoryRoot, "node_modules/playwright/package.json"),
    expected.playwright,
    "Playwright",
  );

  const lockfile = JSON.parse(
    await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
  );
  assert.equal(
    lockfile.packages["node_modules/bb-app"].integrity,
    expected.bbIntegrity,
    "Pinned BB npm artifact integrity",
  );
  assert.equal(
    lockfile.packages["node_modules/@get-bb/plugin-sdk"].integrity,
    expected.sdkIntegrity,
    "Pinned plugin SDK npm artifact integrity",
  );
  assert.equal(
    lockfile.packages["node_modules/playwright"].integrity,
    expected.playwrightIntegrity,
    "Pinned Playwright npm artifact integrity",
  );
  const providerProvenance = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "test/bb-integration/fixture/provider-bridge.provenance.json",
      ),
      "utf8",
    ),
  );
  const providerBridgePath = path.join(
    repositoryRoot,
    "test/bb-integration/fixture/provider-bridge.ts",
  );
  const providerBridgeSource = await readFile(providerBridgePath, "utf8");
  assert.equal(
    sha256(providerBridgeSource),
    expected.providerBridgeSha256,
    "Pinned instrumented scripted provider bridge source changed",
  );
  const recorder = `  if (pending.kind === "tool") {
    recordRequest("t1/tool-result", {
      toolName: pending.toolName,
      result,
      error: error ?? null,
    });
  }
`;
  assert.equal(providerBridgeSource.split(recorder).length - 1, 1);
  assert.equal(
    sha256(providerBridgeSource.replace(recorder, "")),
    providerProvenance.upstreamSourceSha256,
    "Scripted bridge does not match the pinned upstream source plus test recorder",
  );

  const serverPort = await freePort();
  let daemonPort = await freePort();
  while (daemonPort === serverPort) daemonPort = await freePort();
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("BB_") ||
      name.startsWith("SCRIPTED_ECHO_") ||
      name === "ENSEMBLE_T1_RUN_MANIFEST_PATH" ||
      /(?:API_KEY|(?:ACCESS|REFRESH)_TOKEN|PASSWORD|SECRET|CREDENTIAL)/iu.test(
        name,
      )
    ) {
      delete env[name];
    }
  }
  const isolatedHome = path.join(root, "home");
  const isolatedConfig = path.join(root, "config");
  const isolatedData = path.join(root, "xdg-data");
  await Promise.all(
    [isolatedHome, isolatedConfig, isolatedData].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: isolatedConfig,
    XDG_DATA_HOME: isolatedData,
    BB_DATA_DIR: path.join(root, "data"),
    BB_SERVER_BIND_HOST: "127.0.0.1",
    BB_SERVER_PORT: String(serverPort),
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_SERVER_URL: `http://127.0.0.1:${serverPort}`,
    BB_TELEMETRY: "false",
    SCRIPTED_ECHO_RECORD_PATH: path.join(root, "provider-record.jsonl"),
    SCRIPTED_ECHO_PROCESS_LOG_PATH: path.join(root, "provider-processes.log"),
  });
  const scriptedEnvironmentNames = Object.keys(env).filter((name) =>
    name.startsWith("SCRIPTED_ECHO_"),
  );
  assert.deepEqual(
    scriptedEnvironmentNames.sort(),
    ["SCRIPTED_ECHO_PROCESS_LOG_PATH", "SCRIPTED_ECHO_RECORD_PATH"].sort(),
    "Only harness-owned scripted provider paths may reach BB",
  );
  assert.equal(path.dirname(env.SCRIPTED_ECHO_RECORD_PATH), root);
  assert.equal(path.dirname(env.SCRIPTED_ECHO_PROCESS_LOG_PATH), root);
  const runtimeManifest = {
    node: process.versions.node,
    bb: expected.bb,
    bbTarballIntegrity: lockfile.packages["node_modules/bb-app"].integrity,
    pluginSdk: expected.sdk,
    pluginSdkIntegrity:
      lockfile.packages["node_modules/@get-bb/plugin-sdk"].integrity,
    playwright: expected.playwright,
    providerBridgeRevision: providerProvenance.revision,
    providerBridgeUpstreamSha256: providerProvenance.upstreamSourceSha256,
    providerBridgeInstrumentedSha256: expected.providerBridgeSha256,
    platform: `${process.platform}-${process.arch}`,
    serverPort,
    daemonPort,
    checks: { ...(previousManifest?.checks ?? {}) },
    ownedProcesses: [...(previousManifest?.ownedProcesses ?? [])],
    ...(previousManifest
      ? { restartCount: (previousManifest.restartCount ?? 0) + 1 }
      : {}),
  };

  const launcher = path.join(bbPackage, "dist/bb-app.js");
  const cli = path.join(bbPackage, "dist/bb.js");
  const processHandle = spawn(process.execPath, [launcher, "start"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  processHandle.stdout.on("data", (chunk) => (output += chunk));
  processHandle.stderr.on("data", (chunk) => (output += chunk));
  processHandle.on("error", (error) => (output += `${error}\n`));

  const instance = {
    root,
    bbPackage,
    env,
    output: () => output,
    processHandle,
    browserServers: [],
    browsers: [],
    ownedProcesses: new Map(),
    baseUrl: env.BB_SERVER_URL,
    runtimeManifest,
    ports: { serverPort, daemonPort },
    async bbCli(...args) {
      try {
        const result = await exec(process.execPath, [cli, ...args, "--json"], {
          env,
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(result.stdout);
      } catch (error) {
        const detail = [error.stdout, error.stderr]
          .filter((part) => typeof part === "string" && part.length > 0)
          .join("\n");
        throw new Error(
          sanitize(
            `bb ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
            root,
          ),
          { cause: error },
        );
      }
    },
  };

  try {
    await waitFor(async () => {
      assert.equal(
        hasExited(processHandle),
        false,
        `Pinned BB launcher exited: ${sanitize(output.slice(-2_000), root)}`,
      );
      try {
        const machines = await instance.bbCli("machine", "list");
        return machines.find((machine) => machine.status === "connected");
      } catch {
        return false;
      }
    }, "pinned BB host connection");
    const processes = await captureOwnedProcesses(instance);
    assert(processes.some((owned) => owned.role === "bb-app"));
    assert(processes.some((owned) => owned.role === "bb-server"));
    assert(processes.some((owned) => owned.role === "bb-host-daemon"));
  } catch (error) {
    const startError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    startError.t1Instance = instance;
    throw startError;
  }
  return instance;
}

export async function stopBb(instance) {
  const failures = [];
  let forcedCleanup =
    instance.runtimeManifest.checks.ownedProcessCleanup?.forced ?? false;
  try {
    await captureOwnedProcesses(instance);
  } catch (error) {
    failures.push(
      new Error("Could not snapshot owned processes", { cause: error }),
    );
  }

  for (const browser of instance.browsers.splice(0).reverse()) {
    try {
      await browser.close();
    } catch (error) {
      failures.push(
        new Error("Could not close owned Chromium client", { cause: error }),
      );
    }
  }
  for (const server of instance.browserServers.splice(0).reverse()) {
    try {
      await server.close();
      await waitFor(
        () => hasExited(server.process()),
        "owned Chromium process shutdown",
        5_000,
      );
    } catch (error) {
      failures.push(
        new Error("Could not stop owned Chromium process", { cause: error }),
      );
    }
  }

  const cli = path.join(repositoryRoot, "node_modules/bb-app/dist/bb-app.js");
  if (!hasExited(instance.processHandle)) {
    try {
      await exec(process.execPath, [cli, "stop"], {
        env: instance.env,
        timeout: 20_000,
      });
    } catch (error) {
      if (!hasExited(instance.processHandle)) {
        forcedCleanup = true;
        try {
          instance.processHandle.kill("SIGTERM");
          await waitFor(
            () => hasExited(instance.processHandle),
            "BB launcher after SIGTERM",
            5_000,
          );
        } catch (signalError) {
          failures.push(
            new Error("BB launcher did not stop after SIGTERM", {
              cause: signalError,
            }),
          );
        }
        if (!hasExited(instance.processHandle)) {
          try {
            instance.processHandle.kill("SIGKILL");
            await waitFor(
              () => hasExited(instance.processHandle),
              "BB launcher after SIGKILL",
              5_000,
            );
          } catch (killError) {
            failures.push(
              new Error("BB launcher did not stop after SIGKILL", {
                cause: killError,
              }),
            );
          }
        }
        failures.push(
          new Error("BB required forced cleanup", { cause: error }),
        );
      }
    }
  }

  if (!hasExited(instance.processHandle)) {
    try {
      instance.processHandle.kill("SIGTERM");
      await waitFor(
        () => hasExited(instance.processHandle),
        "BB launcher shutdown",
        5_000,
      );
    } catch (error) {
      failures.push(new Error("BB launcher did not exit", { cause: error }));
    }
  }

  const awaitOwnedExit = async (timeoutMs) => {
    await waitFor(
      async () => {
        await captureOwnedProcesses(instance);
        return (
          hasExited(instance.processHandle) &&
          (await liveOwnedProcesses(instance)).length === 0
        );
      },
      "all owned BB, provider, and Chromium processes to exit",
      timeoutMs,
    );
  };

  try {
    await awaitOwnedExit(7_000);
  } catch (error) {
    forcedCleanup = true;
    failures.push(
      new Error("Owned child processes remained after graceful shutdown", {
        cause: error,
      }),
    );
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        await captureOwnedProcesses(instance);
        await terminateLiveOwnedProcesses(instance, signal);
        await awaitOwnedExit(signal === "SIGTERM" ? 3_000 : 5_000);
        break;
      } catch (terminationError) {
        failures.push(
          new Error(`Owned process cleanup failed after ${signal}`, {
            cause: terminationError,
          }),
        );
      }
    }
  }

  let serverPortClosed = false;
  let daemonPortClosed = false;
  try {
    await waitFor(
      async () => {
        serverPortClosed = await portIsClosed(instance.ports.serverPort);
        daemonPortClosed = await portIsClosed(instance.ports.daemonPort);
        return serverPortClosed && daemonPortClosed;
      },
      "owned BB service ports to close",
      5_000,
    );
  } catch (error) {
    failures.push(
      new Error("Owned BB service ports remained open", { cause: error }),
    );
  }

  let liveProcesses = [];
  let processExitVerified = false;
  try {
    await captureOwnedProcesses(instance);
    liveProcesses = await liveOwnedProcesses(instance);
    assert.equal(
      hasExited(instance.processHandle),
      true,
      "BB launcher did not exit",
    );
    assert.deepEqual(liveProcesses, [], "Owned process PIDs remained live");
    processExitVerified = true;
  } catch (error) {
    failures.push(
      new Error("Owned process exit verification failed", { cause: error }),
    );
  }

  const previousCleanup =
    instance.runtimeManifest.checks.ownedProcessCleanup ?? {};
  const pids = [
    ...new Set([
      ...(previousCleanup.pids ?? []),
      ...(instance.runtimeManifest.ownedProcesses ?? []).map(({ pid }) => pid),
    ]),
  ].sort((left, right) => left - right);
  instance.runtimeManifest.checks.ownedProcessCleanup = {
    pids,
    allExited:
      previousCleanup.allExited !== false &&
      processExitVerified &&
      hasExited(instance.processHandle) &&
      liveProcesses.length === 0,
    serverPortClosed:
      previousCleanup.serverPortClosed !== false && serverPortClosed,
    daemonPortClosed:
      previousCleanup.daemonPortClosed !== false && daemonPortClosed,
    forced: previousCleanup.forced === true || forcedCleanup,
  };
  if (failures.length > 0) {
    throw new AggregateError(failures, "T1 owned-process cleanup failed");
  }
}

export async function launchChromium(instance) {
  const server = await chromium.launchServer({ headless: true });
  instance.browserServers.push(server);
  const browser = await chromium.connect(server.wsEndpoint());
  instance.browsers.push(browser);
  return browser;
}

export async function restartBb(instance) {
  const root = instance.root;
  const previousManifest = instance.runtimeManifest;
  await stopBb(instance);
  const replacement = await startBb(root, previousManifest);
  Object.assign(instance, replacement);
  return instance;
}

export async function bbCli(instance, ...args) {
  return instance.bbCli(...args);
}

export async function rpc(instance, method, input = {}) {
  const inputPath = path.join(instance.root, `${method}-${randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify(input));
  const response = await bbCli(
    instance,
    "plugin",
    "rpc",
    "call",
    fixturePluginId,
    method,
    "--input-file",
    inputPath,
  );
  return response.result ?? response;
}

export async function withFixture(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-bb-t1-"));
  let instance;
  let passed = false;
  try {
    const fixtureDirectory = await stageFixture(root);
    instance = await startBb(root);
    instance.fixtureDirectory = fixtureDirectory;
    const result = await callback(instance);
    await stopBb(instance);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
    instance.runtimeManifest.outcome = "passed";
    await persistRunManifest(instance.runtimeManifest, root);
    process.stdout.write(`T1_RUN_MANIFEST_PATH ${runManifestPath}\n`);
    process.stdout.write(
      `T1_RUN_MANIFEST ${JSON.stringify(instance.runtimeManifest)}\n`,
    );
    passed = true;
    return result;
  } catch (error) {
    const failedInstance = error?.t1Instance ?? instance;
    let cleanupError;
    if (failedInstance) {
      await stopBb(failedInstance).catch((failure) => {
        cleanupError = failure;
      });
    }
    const failure = cleanupError
      ? new Error(
          `${String(error)}\nCleanup failure: ${String(cleanupError)}`,
          {
            cause: error,
          },
        )
      : error;
    await writeFailureEvidence(
      failedInstance,
      failure,
      root,
      failureManifestBaseline(),
    );
    process.stdout.write(`T1_RUN_MANIFEST_PATH ${runManifestPath}\n`);
    throw error;
  } finally {
    if (passed && instance) assert(hasExited(instance.processHandle));
  }
}
