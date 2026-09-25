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
};
const fixturePluginId = "ensemble-t1-fixture";

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

async function writeFailureEvidence(instance, error) {
  const root = instance.root;
  const trace = sanitize(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n${instance.output()}`,
    root,
  );
  await writeFile(path.join(root, "failure-trace.txt"), trace);
  await writeFile(
    path.join(root, "run-manifest.json"),
    JSON.stringify(
      {
        ...instance.runtimeManifest,
        outcome: "failed",
        checks: instance.runtimeManifest.checks ?? {},
        trace: "failure-trace.txt",
      },
      null,
      2,
    ),
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

export async function startBb(root) {
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
  });
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
    checks: {},
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
    env,
    output: () => output,
    processHandle,
    browserServers: [],
    browsers: [],
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
  } catch (error) {
    await stopBb(instance).catch((cleanupError) => {
      output += `\nCleanup failure: ${String(cleanupError)}`;
    });
    await writeFailureEvidence(instance, error);
    throw error;
  }
  return instance;
}

export async function stopBb(instance) {
  for (const browser of instance.browsers.reverse()) {
    await browser.close();
  }
  for (const server of instance.browserServers.reverse()) {
    await server.close();
    const child = server.process();
    await waitFor(
      () => hasExited(child),
      "owned Chromium process shutdown",
      5_000,
    );
  }
  if (hasExited(instance.processHandle)) {
    await waitFor(
      async () =>
        (await portIsClosed(instance.ports.serverPort)) &&
        (await portIsClosed(instance.ports.daemonPort)),
      "owned BB service ports to close",
      5_000,
    );
    return;
  }

  const cli = path.join(repositoryRoot, "node_modules/bb-app/dist/bb-app.js");
  try {
    await exec(process.execPath, [cli, "stop"], {
      env: instance.env,
      timeout: 20_000,
    });
  } catch (error) {
    instance.processHandle.kill("SIGTERM");
    await waitFor(
      () => hasExited(instance.processHandle),
      "BB launcher after SIGTERM",
      5_000,
    ).catch(() => {});
    if (!hasExited(instance.processHandle)) {
      instance.processHandle.kill("SIGKILL");
      await waitFor(
        () => hasExited(instance.processHandle),
        "BB launcher after SIGKILL",
        5_000,
      );
    }
    throw new Error("BB required forced cleanup", { cause: error });
  }

  await waitFor(
    () => hasExited(instance.processHandle),
    "BB launcher shutdown",
    10_000,
  );
  assert(hasExited(instance.processHandle), "Owned BB launcher did not exit");
  await waitFor(
    async () =>
      (await portIsClosed(instance.ports.serverPort)) &&
      (await portIsClosed(instance.ports.daemonPort)),
    "owned BB service ports to close",
    5_000,
  );
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
  const replacement = await startBb(root);
  replacement.runtimeManifest.checks = { ...previousManifest.checks };
  replacement.runtimeManifest.restartCount =
    (previousManifest.restartCount ?? 0) + 1;
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
    passed = true;
    instance.runtimeManifest.outcome = "passed";
    instance.runtimeManifest.checks.ownedProcessCleanup = "passed";
    process.stdout.write(
      `T1_RUN_MANIFEST ${JSON.stringify(instance.runtimeManifest)}\n`,
    );
    await rm(root, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (instance) {
      let cleanupError;
      await stopBb(instance).catch((failure) => {
        cleanupError = failure;
      });
      await writeFailureEvidence(
        instance,
        cleanupError
          ? new Error(
              `${String(error)}\nCleanup failure: ${String(cleanupError)}`,
              {
                cause: error,
              },
            )
          : error,
      );
    } else {
      await writeFile(
        path.join(root, "failure-trace.txt"),
        sanitize(
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
          root,
        ),
      );
      await writeFile(
        path.join(root, "run-manifest.json"),
        JSON.stringify(
          {
            node: process.versions.node,
            bb: expected.bb,
            pluginSdk: expected.sdk,
            playwright: expected.playwright,
            platform: `${process.platform}-${process.arch}`,
            outcome: "failed-before-start",
            checks: {},
            trace: "failure-trace.txt",
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    if (passed && instance) assert(hasExited(instance.processHandle));
  }
}
