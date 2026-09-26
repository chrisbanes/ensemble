// Run against a disposable BB instance, never the user's configured server.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [bbPackage, bbSource] = process.argv.slice(2);
assert(
  bbPackage && bbSource,
  "Usage: node scripts/check-bb-startup-guard.mjs <bb-app package> <pinned BB source checkout>",
);
const version = JSON.parse(
  await readFile(path.join(bbPackage, "package.json")),
).version;
assert.equal(
  version,
  "0.43.4",
  "Review the probe before testing a different BB version",
);
const sourceRevision = (
  await exec("git", ["-C", bbSource, "rev-parse", "HEAD"])
).stdout.trim();
assert.equal(sourceRevision, "fdd3de3b19b97e6cd1ef7300cbb54711431249d3");
const root = await mkdtemp(path.join(tmpdir(), "ensemble-bb-startup-probe-"));
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const port = await freePort();
let daemonPort = await freePort();
while (daemonPort === port) daemonPort = await freePort();
const data = path.join(root, "data");
const env = {
  ...process.env,
  BB_DATA_DIR: data,
  BB_SERVER_URL: `http://127.0.0.1:${port}`,
  BB_SERVER_PORT: String(port),
  BB_HOST_DAEMON_PORT: String(daemonPort),
  BB_SERVER_BIND_HOST: "127.0.0.1",
  BB_TELEMETRY: "false",
};
const launcher = path.join(bbPackage, "dist/bb-app.js");
const cli = path.join(bbPackage, "dist/bb.js");
let processHandle;
let launcherOutput = "";
const observations = [];
async function bb(...args) {
  const result = await exec(process.execPath, [cli, ...args, "--json"], {
    env,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
async function until(fn, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function start() {
  processHandle = spawn(process.execPath, [launcher, "start"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processHandle.stdout.on("data", (chunk) => {
    launcherOutput += chunk;
  });
  processHandle.stderr.on("data", (chunk) => {
    launcherOutput += chunk;
  });
  await until(async () => {
    assert.equal(
      processHandle.exitCode,
      null,
      `Launcher exited: ${launcherOutput.slice(-1500)}`,
    );
    try {
      return (await bb("machine", "list")).find(
        (machine) => machine.status === "connected",
      );
    } catch {
      return false;
    }
  }, "isolated machine connection");
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = once(processHandle, "exit");
  await exec(process.execPath, [launcher, "stop"], { env, timeout: 30000 });
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Launcher did not stop")),
        10000,
      );
      timer.unref();
    }),
  ]);
}
async function manifest(dir, name, extra = {}) {
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${name}`,
      version: "0.0.1",
      type: "module",
      dependencies: { "@get-bb/plugin-sdk": "0.5.27", zod: "4.6.5" },
      engines: { bb: ">=0.43.4", bbPluginSdk: ">=0.5.9" },
      bb: {
        name,
        description: "Disposable Ensemble capability fixture",
        branding: { icon: "FlaskConical" },
        server: "./server.ts",
        ...extra,
      },
    }),
  );
}
try {
  const fixture = path.join(root, "provider");
  const guard = path.join(root, "guard");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await mkdir(guard);
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    path.join(fixture, "node_modules"),
    "dir",
  );
  await manifest(fixture, "ensemble-capability", { host: "./host.ts" });
  await copyFile(
    new URL("./fixtures/bb-capability/server.ts", import.meta.url),
    path.join(fixture, "server.ts"),
  );
  // Upstream MIT-licensed bridge is copied only into this disposable test directory.
  await copyFile(
    path.join(bbSource, "tests/scripted-echo-provider/src/provider-bridge.ts"),
    path.join(fixture, "src/provider-bridge.ts"),
  );
  await copyFile(
    path.join(bbSource, "LICENSE"),
    path.join(fixture, "UPSTREAM-LICENSE"),
  );
  await writeFile(
    path.join(fixture, "host.ts"),
    'export { experimental_providerBridge } from "./src/provider-bridge.js";\n',
  );
  await manifest(guard, "ensemble-startup-guard");
  const failureFile = path.join(root, "fail-guard");
  await writeFile(
    path.join(guard, "server.ts"),
    `import { existsSync } from "node:fs";
export default function guard(bb) {
 if (existsSync(${JSON.stringify(failureFile)})) throw new Error("Intentional isolated startup failure");
 bb.experimental_hooks.on("message.dispatch", ctx => ctx.thread.providerId === "ensemble-probe" || ctx.thread.provider === "ensemble-probe" ? {action:"wait",reason:"Startup safety probe"} : {action:"proceed"});
}\n`,
  );
  const empty = path.join(root, "empty.json");
  await writeFile(empty, "{}");
  const count = async () =>
    (
      await bb(
        "plugin",
        "rpc",
        "call",
        "ensemble-capability",
        "ping",
        "--input-file",
        empty,
      )
    ).count;
  await start();
  const installed = await bb("plugin", "install", `path:${fixture}`, "--yes");
  assert.equal(
    installed.plugin.status,
    "running",
    installed.plugin.statusDetail,
  );
  const machine = (await bb("machine", "list")).find(
    (item) => item.status === "connected",
  );
  const repo = path.join(root, "repo");
  await exec("git", ["init", "-b", "main", repo]);
  await exec("git", [
    "-C",
    repo,
    "-c",
    "user.name=Capability Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  ]);
  const project = await bb(
    "project",
    "create",
    "--name",
    "Startup guard probe",
    "--root",
    repo,
    "--machine",
    machine.id,
  );
  const thread = await bb(
    "thread",
    "spawn",
    "--project",
    project.id,
    "--provider",
    "ensemble-probe",
    "--model",
    "fake-model",
    "--permission-mode",
    "accept-edits",
    "--new-environment",
    "worktree",
    "--machine",
    machine.id,
    "--prompt",
    "call_tool:capability_ping",
  );
  await until(async () => (await count()) === 1, "initial tool call");
  await until(
    async () =>
      (await bb("thread", "show", thread.id)).thread.status === "idle",
    "initial turn completion",
  );
  assert.equal(
    (await bb("plugin", "install", `path:${guard}`, "--yes")).plugin.status,
    "running",
  );
  const queued = await bb(
    "thread",
    "tell",
    thread.id,
    "call_tool:capability_ping",
    "--mode",
    "queue",
  );
  assert.equal(queued.delivery, "queued");
  assert.equal(await count(), 1);
  observations.push({
    stage: "before-restart",
    count: 1,
    queueId: queued.queuedMessage.id,
  });
  await writeFile(failureFile, "intentional test failure");
  await stop();
  await start();
  const list = await bb("plugin", "list");
  const guardState = list.plugins.find(
    (plugin) => plugin.id === "ensemble-startup-guard",
  );
  assert.equal(guardState.status, "error");
  // Observe beyond the queue recheck interval; absence of execution is not full proof.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && (await count()) === 1)
    await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await count();
  observations.push({
    stage: "after-restart",
    count: after,
    guardStatus: guardState.status,
    queue: await bb("thread", "queue", "list", thread.id),
  });
  const outcome =
    after > 1 ? "FAIL_OPEN_REPRODUCED" : "NOT_REPRODUCED_IN_OBSERVATION_WINDOW";
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify({ version, sourceRevision, outcome, observations }, null, 2),
  );
  console.log(JSON.stringify({ root, outcome }, null, 2));
  // A reproduced failure is useful evidence, but must never appear as a passing gate.
  process.exitCode = after > 1 ? 2 : 3;
} finally {
  await stop();
  await writeFile(path.join(root, "launcher.log"), launcherOutput);
  console.log(`Stopped isolated BB; evidence retained at ${root}`);
}
