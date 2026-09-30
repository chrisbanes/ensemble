import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { OperatorAuth } from "../../dist/src/standalone/operator-auth.js";

const PINNED_NODE =
  "/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node";
const PINNED_NPM =
  "/private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js";
const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const LAUNCHCTL = "/bin/launchctl";
const PS = "/bin/ps";
const EVIDENCE = {
  optIn: false,
  source: {},
  runtime: {},
  launchd: {},
  operations: {},
  restoredPublicState: {},
  cleanup: {
    scope:
      "this harness's exact disposable data, auth, log, snapshot, restore and plist fixtures",
    bootoutConfirmed: false,
    serviceProcessesExited: false,
    labelAbsent: false,
    fixtureRootRemoved: false,
    fixturePathsAbsent: false,
  },
  limitations: {
    hostRestart: "manual fallback is documented; no host reboot was run",
    externalEffects:
      "GitHub/provider effects are not reconciled by this database snapshot",
    workspaces:
      "managed worktree contents and external workspace files are not included",
    futureSchemas:
      "the current supported schema is verified; later schemas need requalification",
    prototypeAndCutover:
      "the installed prototype was not read or changed; no production deployment or cutover was performed",
    modelTurn:
      "Codex App Server initialization/login was exercised; no model turn was requested",
  },
  failure: null,
};

const stageLog = (name) => process.stderr.write(`[s08a-live] ${name}\n`);
let stage = "opt-in";
let root;
let rootCreated = false;
let currentDataDirectory;
let label;
let target;
let origin;
let port;
let authFile;
let password;
let plistPath;
let snapshotPath;
let restoredDataDirectory;
let sourceDataDirectory;
let cliPath;
const observedProcessIds = new Set();

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 15_000,
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function runNpm(args) {
  return runCommand(process.execPath, [PINNED_NPM, ...args], {
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${LAUNCHD_PATH}`,
      npm_config_loglevel: "silent",
      npm_config_color: "false",
    },
  });
}

function runOperations(...args) {
  return runNpm(["run", "operations", "--", ...args]);
}

function operationJson(result) {
  const line = `${result.stdout ?? ""}`
    .trim()
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("{"))
    .at(-1);
  assert.ok(line, "operations command must return bounded JSON");
  return JSON.parse(line);
}

function pathExecutable(name) {
  for (const directory of LAUNCHD_PATH.split(delimiter)) {
    const path = join(directory, name);
    try {
      const info = statSync(path);
      if (info.isFile() && (info.mode & 0o111) !== 0) return path;
    } catch {
      // Continue through the fixed, reviewed launchd search path.
    }
  }
  throw new Error("A required fixed-PATH executable is unavailable");
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function treeSha256(directory) {
  const hash = createHash("sha256");
  function visit(current, prefix = "") {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(path);
      assert.equal(
        info.isSymbolicLink(),
        false,
        "fixture contains no symlinks",
      );
      if (info.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(path, relativePath);
      } else {
        assert.equal(
          info.isFile(),
          true,
          "fixture contains only regular files",
        );
        hash.update(`file\0${relativePath}\0`);
        hash.update(readFileSync(path));
      }
    }
  }
  visit(directory);
  return hash.digest("hex");
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const selectedPort = address.port;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return selectedPort;
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${description} timed out`);
}

function launchctl(args) {
  const result = runCommand(LAUNCHCTL, args, { timeout: 20_000 });
  if (result.status !== 0) throw new Error("launchctl operation failed");
  return result.stdout;
}

function labelIsAbsent() {
  const result = runCommand(LAUNCHCTL, ["print", target], { timeout: 10_000 });
  return result.status !== 0;
}

function processIdsFor(dataDirectory) {
  const listing = execFileSync(PS, ["-axo", "pid=,stat=,command="], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return listing.split("\n").flatMap((line) => {
    if (!line.includes(cliPath) || !line.includes(dataDirectory)) return [];
    if (!/\boperator\b/.test(line)) return [];
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!match) return [];
    return [{ pid: Number(match[1]), state: match[2] }];
  });
}

function processIsExited(pid) {
  const result = runCommand(PS, ["-p", String(pid), "-o", "stat="], {
    timeout: 10_000,
  });
  const state = result.stdout.trim();
  return result.status !== 0 || state.length === 0 || state.startsWith("Z");
}

function currentLaunchdPid() {
  const result = runCommand(LAUNCHCTL, ["print", target], { timeout: 10_000 });
  if (result.status !== 0) return null;
  const match = /\bpid\s*=\s*(\d+)\b/.exec(result.stdout);
  return match ? Number(match[1]) : null;
}

async function waitForOperator() {
  return waitUntil(
    async () => {
      const pid = currentLaunchdPid();
      if (!pid) return null;
      const processes = processIdsFor(currentDataDirectory);
      if (!processes.some((process) => process.pid === pid)) return null;
      try {
        const response = await fetch(`${origin}/login`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status !== 200) return null;
        const body = await response.text();
        if (!body.includes("Sign in")) return null;
        observedProcessIds.add(pid);
        return pid;
      } catch {
        return null;
      }
    },
    60_000,
    "LaunchAgent operator listener",
  );
}

function readCookie(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "operator response sets a session cookie");
  const cookie = header.split(";", 1)[0];
  assert.match(cookie, /^ensemble_operator_session=[A-Za-z0-9_-]{43}$/);
  return cookie;
}

function readCsrf(html) {
  const token = /name="csrfToken" type="hidden" value="([^"]+)"/.exec(
    html,
  )?.[1];
  assert.ok(token, "operator page contains a CSRF token");
  return token;
}

async function authenticateOperator() {
  const loginPage = await fetch(`${origin}/login`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(loginPage.status, 200);
  const anonymousCookie = readCookie(loginPage);
  const csrf = readCsrf(await loginPage.text());
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: {
      cookie: anonymousCookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrfToken: csrf, password }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(login.status, 303);
  const sessionCookie = readCookie(login);
  const home = await fetch(`${origin}/`, {
    headers: { cookie: sessionCookie },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<h1>Ensemble<\/h1>/);
  return { cookie: sessionCookie, csrf: readCsrf(html) };
}

async function postCommand(session, fields) {
  const response = await fetch(`${origin}/command`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      ...fields,
      csrfToken: session.csrf,
      key: randomUUID(),
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 303);
}

async function seedPublicState(session) {
  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await postCommand(session, {
    type: "profile.create",
    profileId,
    name: "S08a disposable profile",
    instructions: "Disposable operations proof only.",
    capabilities: "operations-proof",
  });
  await postCommand(session, {
    type: "project.create",
    projectId,
    name: "S08a disposable project",
    leadProfileId: profileId,
  });
  await postCommand(session, {
    type: "task.create",
    projectId,
    taskId,
    title: "S08a unready fixture task",
    outcome: "Remain unready during the backup/restore proof.",
    ready: "0",
  });
  return { profileId, projectId, taskId };
}

async function readRestoredPublicState(session, records) {
  for (const [kind, id, expected] of [
    ["profile", records.profileId, "S08a disposable profile"],
    ["project", records.projectId, "S08a disposable project"],
    ["task", records.taskId, "S08a unready fixture task"],
  ]) {
    const response = await fetch(`${origin}/${kind}/${id}`, {
      headers: { cookie: session.cookie },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(expected));
  }
  const task = await fetch(`${origin}/task/${records.taskId}`, {
    headers: { cookie: session.cookie },
    signal: AbortSignal.timeout(5_000),
  });
  const taskHtml = await task.text();
  assert.match(taskHtml, /Not ready/);
  const project = await fetch(`${origin}/project/${records.projectId}`, {
    headers: { cookie: session.cookie },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(project.status, 200);
  assert.match(await project.text(), /Paused/);
  return { profiles: 1, projects: 1, pausedProjects: 1, unreadyTasks: 1 };
}

async function writeLaunchAgent(dataDirectory, logDirectory) {
  currentDataDirectory = dataDirectory;
  const stdoutPath = join(logDirectory, "operator.stdout.log");
  const stderrPath = join(logDirectory, "operator.stderr.log");
  const result = runOperations(
    "render-launch-agent",
    label,
    PINNED_NODE,
    cliPath,
    dataDirectory,
    authFile,
    origin,
    String(port),
    stdoutPath,
    stderrPath,
    plistPath,
  );
  assert.equal(result.status, 0);
  const output = operationJson(result);
  assert.deepEqual(output, {
    ok: true,
    operation: "render-launch-agent",
    label,
  });
  const lint = runCommand("/usr/bin/plutil", ["-lint", plistPath]);
  assert.equal(lint.status, 0);
  const parsed = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", plistPath],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  );
  assert.deepEqual(parsed.EnvironmentVariables, {
    ENSEMBLE_OPERATOR_AUTH_FILE: authFile,
    ENSEMBLE_OPERATOR_ORIGIN: origin,
    PATH: LAUNCHD_PATH,
  });
  assert.equal(parsed.ProgramArguments[0], PINNED_NODE);
  assert.equal(parsed.ProgramArguments[1], cliPath);
  assert.equal(parsed.ProgramArguments[2], "operator");
  assert.equal(parsed.ProgramArguments[3], dataDirectory);
  assert.equal(parsed.ProgramArguments[4], String(port));
  assert.equal(parsed.KeepAlive, false);
  assert.equal(parsed.RunAtLoad, true);
  const plistText = readFileSync(plistPath, "utf8");
  assert.equal(plistText.includes(password), false);
  return { stdoutPath, stderrPath };
}

async function bootstrapAndWait(dataDirectory) {
  currentDataDirectory = dataDirectory;
  launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath]);
  const pid = await waitForOperator();
  assert.equal(processIdsFor(dataDirectory).length, 1);
  return pid;
}

async function bootoutAndVerify(dataDirectory) {
  currentDataDirectory = dataDirectory;
  const before = currentLaunchdPid();
  if (before) observedProcessIds.add(before);
  launchctl(["bootout", target]);
  await waitUntil(
    () => {
      const processes = processIdsFor(dataDirectory).filter(
        (process) => !process.state.startsWith("Z"),
      );
      return (
        processes.length === 0 && (before === null || processIsExited(before))
      );
    },
    30_000,
    "LaunchAgent process exit",
  );
  assert.equal(labelIsAbsent(), true);
  EVIDENCE.cleanup.bootoutConfirmed = true;
  return before;
}

async function run() {
  EVIDENCE.optIn = true;
  stageLog("preflight");
  assert.equal(
    process.platform,
    "darwin",
    "the disposable proof requires macOS",
  );
  assert.equal(process.version, "v24.21.0");
  assert.equal(realpathSync(process.execPath), PINNED_NODE);
  assert.equal(realpathSync(PINNED_NPM), PINNED_NPM);
  assert.equal(realpathSync(process.env.npm_execpath ?? ""), PINNED_NPM);
  assert.match(process.env.npm_config_user_agent ?? "", /npm\/12\.1\.0\b/);
  cliPath = realpathSync(resolve("dist/src/standalone/cli.js"));
  const operationsCli = realpathSync(
    resolve("dist/src/standalone/operations-cli.js"),
  );
  const codexExecutable = pathExecutable("codex");
  const gitExecutable = pathExecutable("git");
  const caffeinateExecutable = pathExecutable("caffeinate");
  assert.equal(codexExecutable, "/opt/homebrew/bin/codex");
  const codexVersion = execFileSync(codexExecutable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
  const loginStatus = execFileSync(codexExecutable, ["login", "status"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.match(loginStatus, /Logged in/);
  const domain = `gui/${process.getuid()}`;
  execFileSync(LAUNCHCTL, ["print", domain], {
    encoding: "utf8",
    timeout: 15_000,
  });
  EVIDENCE.source = {
    gitRevision: execFileSync(gitExecutable, ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
    workingTreeClean:
      execFileSync(gitExecutable, ["status", "--porcelain"], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim().length === 0,
  };
  EVIDENCE.runtime = {
    node: process.version,
    nodeExecutable: PINNED_NODE,
    nodeSha256: await fileSha256(PINNED_NODE),
    npm: "12.1.0",
    npmExecutable: PINNED_NPM,
    npmCliSha256: await fileSha256(PINNED_NPM),
    codexVersion,
    codexExecutable: realpathSync(codexExecutable),
    codexSha256: await fileSha256(codexExecutable),
    codexLogin:
      "existing ChatGPT login reported authenticated; no credential content read",
    launchdPath: LAUNCHD_PATH,
    gitExecutable: realpathSync(gitExecutable),
    caffeinateExecutable: realpathSync(caffeinateExecutable),
    compiledServiceCli: cliPath,
    compiledOperationsCli: operationsCli,
  };

  label = `com.chrisbanes.ensemble.s08a-${randomBytes(6).toString("hex")}`;
  target = `${domain}/${label}`;
  assert.equal(
    labelIsAbsent(),
    true,
    "unique per-user label must be absent before use",
  );
  port = await reserveLoopbackPort();
  origin = `http://127.0.0.1:${port}`;
  root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s08a-live-")));
  rootCreated = true;
  assert.equal(lstatSync(root).mode & 0o777 & 0o077, 0);
  sourceDataDirectory = join(root, "source", "data");
  const sourceLogs = join(root, "source", "logs");
  const restoredLogs = join(root, "restored", "logs");
  const authDirectory = join(root, "auth");
  snapshotPath = join(root, "snapshot");
  restoredDataDirectory = join(root, "restored", "data");
  const failedRestore = join(root, "restore-existing");
  plistPath = join(root, `${label}.plist`);
  for (const directory of [
    dirname(sourceDataDirectory),
    sourceDataDirectory,
    sourceLogs,
    dirname(restoredDataDirectory),
    restoredLogs,
    authDirectory,
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const directory of [
    dirname(sourceDataDirectory),
    sourceDataDirectory,
    sourceLogs,
    dirname(restoredDataDirectory),
    restoredLogs,
    authDirectory,
  ])
    assert.equal(statSync(directory).mode & 0o077, 0);
  authFile = join(authDirectory, "operator-auth.json");
  password = randomBytes(32).toString("base64url");
  await OperatorAuth.initialize(authFile, password);
  assert.equal(statSync(authFile).mode & 0o777, 0o600);
  await writeLaunchAgent(sourceDataDirectory, sourceLogs);
  EVIDENCE.launchd = {
    domain,
    label,
    initialPlistLint: "passed",
    exactEnvironment: [
      "ENSEMBLE_OPERATOR_AUTH_FILE",
      "ENSEMBLE_OPERATOR_ORIGIN",
      "PATH",
    ],
    keepAlive: false,
    runAtLoad: true,
    standardOutput: "private disposable log",
    standardError: "private disposable log; not read or included in evidence",
  };

  stage = "initial-start";
  stageLog(stage);
  let pid = await bootstrapAndWait(sourceDataDirectory);
  EVIDENCE.launchd.initialStartPid = pid;
  assert.equal(
    readFileSync(join(sourceDataDirectory, ".ensemble-standalone"), "utf8"),
    "ensemble-standalone-v1\n",
  );
  const ownerSource = treeSha256(sourceDataDirectory);
  const session = await authenticateOperator();
  const records = await seedPublicState(session);
  EVIDENCE.restoredPublicState.ids = {
    profile: records.profileId,
    project: records.projectId,
    task: records.taskId,
  };
  const sourceBeforeFailedBackup = treeSha256(sourceDataDirectory);
  assert.notEqual(sourceBeforeFailedBackup, ownerSource);

  stage = "backup-while-owned-refusal";
  stageLog(stage);
  const activeSnapshot = join(root, "active-backup-must-not-exist");
  const refusedBackup = runOperations(
    "backup",
    sourceDataDirectory,
    activeSnapshot,
  );
  assert.notEqual(refusedBackup.status, 0);
  assert.equal(existsSync(activeSnapshot), false);
  assert.equal(treeSha256(sourceDataDirectory), sourceBeforeFailedBackup);
  EVIDENCE.operations.activeBackupRefused = true;
  EVIDENCE.operations.sourceUnchangedOnActiveBackupFailure = true;

  stage = "restart";
  stageLog(stage);
  const oldPid = pid;
  launchctl(["kickstart", "-k", target]);
  await waitUntil(
    () => processIsExited(oldPid),
    30_000,
    "pre-restart process exit",
  );
  pid = await waitForOperator();
  EVIDENCE.launchd.restartPid = pid;
  const restartedSession = await authenticateOperator();
  const sourcePublicState = await readRestoredPublicState(
    restartedSession,
    records,
  );
  EVIDENCE.restoredPublicState.sourceBeforeSnapshot = sourcePublicState;
  EVIDENCE.launchd.restartPreservedPublicState = true;

  stage = "stop-and-backup";
  stageLog(stage);
  await bootoutAndVerify(sourceDataDirectory);
  const snapshotResult = runOperations(
    "backup",
    sourceDataDirectory,
    snapshotPath,
  );
  assert.equal(snapshotResult.status, 0);
  const manifest = operationJson(snapshotResult).manifest;
  assert.equal(manifest.format, "ensemble-sqlite-snapshot-v1");
  assert.equal(manifest.nodeVersion, "v24.21.0");
  const verifyResult = runOperations("verify", snapshotPath);
  assert.equal(verifyResult.status, 0);
  const verifiedManifest = operationJson(verifyResult).manifest;
  assert.equal(
    verifiedManifest.logicalContentSha256,
    manifest.logicalContentSha256,
  );
  assert.equal(verifiedManifest.databaseSha256, manifest.databaseSha256);
  const snapshotSha256 = await fileSha256(
    join(snapshotPath, "standalone.sqlite"),
  );
  assert.equal(snapshotSha256, manifest.databaseSha256);
  EVIDENCE.operations = {
    ...EVIDENCE.operations,
    offlineBackupVerified: true,
    manifestFormat: manifest.format,
    schemaVersion: manifest.schemaVersion,
    schemaFingerprint: manifest.schemaFingerprint,
    logicalContentSha256: manifest.logicalContentSha256,
    databaseSha256: manifest.databaseSha256,
    snapshotDatabaseSha256: snapshotSha256,
  };

  mkdirSync(failedRestore, { mode: 0o700 });
  const keepPath = join(failedRestore, "keep.txt");
  writeFileSync(
    keepPath,
    "pre-existing restore target must remain byte-identical\n",
    { mode: 0o600 },
  );
  const keepBytes = readFileSync(keepPath);
  const snapshotBeforeFailedRestore = await fileSha256(
    join(snapshotPath, "standalone.sqlite"),
  );
  const refusedRestore = runOperations("restore", snapshotPath, failedRestore);
  assert.notEqual(refusedRestore.status, 0);
  assert.equal(readdirSync(failedRestore).join(","), "keep.txt");
  assert.equal(readFileSync(keepPath).equals(keepBytes), true);
  assert.equal(
    await fileSha256(join(snapshotPath, "standalone.sqlite")),
    snapshotBeforeFailedRestore,
  );
  EVIDENCE.operations.existingRestoreTargetRefused = true;
  EVIDENCE.operations.snapshotUnchangedOnRestoreFailure = true;

  stage = "restore-and-verify";
  stageLog(stage);
  const restoreResult = runOperations(
    "restore",
    snapshotPath,
    restoredDataDirectory,
  );
  assert.equal(restoreResult.status, 0);
  const restoreManifest = operationJson(restoreResult).manifest;
  assert.equal(
    restoreManifest.logicalContentSha256,
    manifest.logicalContentSha256,
  );
  assert.equal(
    readFileSync(join(restoredDataDirectory, ".ensemble-standalone"), "utf8"),
    "ensemble-standalone-v1\n",
  );
  EVIDENCE.operations.restoreToNewMarkedDirectory = true;

  stage = "restored-launchagent-start";
  stageLog(stage);
  assert.equal(labelIsAbsent(), true);
  unlinkSync(plistPath);
  await writeLaunchAgent(restoredDataDirectory, restoredLogs);
  pid = await bootstrapAndWait(restoredDataDirectory);
  EVIDENCE.launchd.restoredStartPid = pid;
  const restoredSession = await authenticateOperator();
  EVIDENCE.restoredPublicState.afterRestore = await readRestoredPublicState(
    restoredSession,
    records,
  );
  launchctl(["kickstart", "-k", target]);
  const previousRestoredPid = pid;
  await waitUntil(
    () => processIsExited(previousRestoredPid),
    30_000,
    "restored pre-restart process exit",
  );
  pid = await waitForOperator();
  EVIDENCE.launchd.restoredRestartPid = pid;
  const afterRestart = await authenticateOperator();
  await readRestoredPublicState(afterRestart, records);
  EVIDENCE.launchd.restoredRestartPreservedPublicState = true;
  await bootoutAndVerify(restoredDataDirectory);
  EVIDENCE.launchd.restoredServiceBootout = true;
}

async function cleanup() {
  if (!rootCreated) return;
  stageLog("cleanup");
  try {
    if (!labelIsAbsent()) {
      const result = runCommand(LAUNCHCTL, ["bootout", target], {
        timeout: 20_000,
      });
      if (result.status !== 0)
        throw new Error("Disposable label bootout failed");
      EVIDENCE.cleanup.bootoutConfirmed = true;
    }
    const dataDirectories = [sourceDataDirectory, restoredDataDirectory].filter(
      Boolean,
    );
    await waitUntil(
      () => {
        const liveProcesses = dataDirectories.flatMap((path) =>
          processIdsFor(path).filter(
            (process) => !process.state.startsWith("Z"),
          ),
        );
        return (
          liveProcesses.length === 0 &&
          [...observedProcessIds].every(processIsExited)
        );
      },
      30_000,
      "all disposable service processes to exit",
    );
    EVIDENCE.cleanup.serviceProcessesExited = true;
    EVIDENCE.cleanup.labelAbsent = labelIsAbsent();
    if (!EVIDENCE.cleanup.labelAbsent)
      throw new Error("Disposable LaunchAgent label remains loaded");

    const exactFixturePaths = [
      sourceDataDirectory,
      authFile,
      snapshotPath,
      restoredDataDirectory,
      plistPath,
      join(root, "source", "logs"),
      join(root, "restored", "logs"),
    ].filter(Boolean);
    if (existsSync(root)) {
      assert.equal(
        realpathSync(root),
        root,
        "cleanup root identity remains exact",
      );
      rmSync(root, { recursive: true, force: false });
    }
    EVIDENCE.cleanup.fixtureRootRemoved = !existsSync(root);
    EVIDENCE.cleanup.fixturePathsAbsent = exactFixturePaths.every(
      (path) => !existsSync(path),
    );
    if (
      !EVIDENCE.cleanup.fixtureRootRemoved ||
      !EVIDENCE.cleanup.fixturePathsAbsent
    )
      throw new Error("Exact disposable fixture cleanup was not verified");
  } catch {
    EVIDENCE.cleanup.fixtureRootRemoved = false;
    EVIDENCE.cleanup.fixturePathsAbsent = false;
    EVIDENCE.failure ??= { stage: "cleanup", kind: "cleanup-not-confirmed" };
    process.exitCode = 1;
    if (root) EVIDENCE.cleanup.retainedFixtureRoot = root;
  }
}

if (!process.argv.slice(2).includes("--live")) {
  process.stderr.write(
    "Refusing live macOS launchctl proof without the explicit --live flag.\n",
  );
  process.exit(2);
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const kind = /timed? out|timeout/i.test(message)
    ? "timeout"
    : /login|auth|account/i.test(message)
      ? "authentication-or-account-check"
      : /launchctl|launchagent|process exit/i.test(message)
        ? "launchd-lifecycle"
        : "operations-or-assertion-failure";
  EVIDENCE.failure = { stage, kind };
  process.exitCode = 1;
} finally {
  await cleanup();
  process.stdout.write(`${JSON.stringify(EVIDENCE, null, 2)}\n`);
}
