import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../../dist/src/standalone/codex.js";
import { StandaloneService } from "../../dist/src/standalone/service.js";

const result = {
  source: {},
  runtime: {},
  executions: [],
  cancellation: null,
  cleanup: {
    fixtureCreated: false,
    fixtureRemoved: false,
    scope: "temporary Ensemble data and workspace directories only",
  },
  failure: null,
};
let service;
let root;
let stage = "identity";
const failureKind = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return "timeout";
  if (/login|auth|account/i.test(message))
    return "authentication-or-account-check";
  if (/interrupt|cancel/i.test(message)) return "cancellation-request";
  if (/approval|policy|sandbox/i.test(message)) return "execution-policy";
  return "runtime-or-service-error";
};

if (!process.argv.slice(2).includes("--live")) {
  process.stderr.write(
    "Refusing live Codex execution without the explicit --live flag.\n",
  );
  process.exit(2);
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${description} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function command(domain, body) {
  return domain.execute({ key: randomUUID(), ...body });
}

async function run() {
  const gitRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    encoding: "buffer",
    timeout: 10_000,
  });
  const untrackedFiles = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer", timeout: 10_000 },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedManifest = Buffer.concat(
    untrackedFiles.flatMap((path) => [
      Buffer.from(`\0${path}\0`),
      readFileSync(path),
    ]),
  );
  const npmUserAgent = process.env.npm_config_user_agent ?? "";
  const npmVersion = /(?:^|\s)npm\/([^\s]+)/.exec(npmUserAgent)?.[1] ?? null;
  result.source = {
    gitRevision,
    workingTreeClean: status.trim().length === 0,
    trackedDiffSha256: createHash("sha256").update(trackedDiff).digest("hex"),
    untrackedFiles,
    untrackedContentSha256: createHash("sha256")
      .update(untrackedManifest)
      .digest("hex"),
    workingTreeSha256: createHash("sha256")
      .update(trackedDiff)
      .update(untrackedManifest)
      .digest("hex"),
    node: process.version,
    npm: npmVersion,
    npmExecPath: process.env.npm_execpath ?? null,
  };
  result.runtime.codexVersion = execFileSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();

  root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s03b-live-")));
  result.cleanup.fixtureCreated = true;
  const dataDir = join(root, "data");
  const workspace = join(root, "direct-workspace");
  mkdirSync(workspace);
  let runtime;
  service = new StandaloneService(
    dataDir,
    (context) => (runtime = new CodexRuntime("codex", context)),
  );

  stage = "authenticated-runtime-start";
  await service.start();
  result.runtime.processIdentity = runtime.processIdentity();

  stage = "first-dispatch";
  const first = await service.submit(
    `s03b-live-first-${randomUUID()}`,
    "Do not use tools or edit files. Reply with exactly: first-turn-ok",
    workspace,
  );
  assert.equal(first.state, "completed");
  assert.ok(first.threadId && first.turnId);
  result.executions.push({
    label: "first",
    workId: first.workId,
    state: first.state,
    threadId: first.threadId,
    turnId: first.turnId,
  });

  stage = "normal-handoff";
  const followup = await service.submit(
    `s03b-live-followup-${randomUUID()}`,
    "Do not use tools or edit files. Reply with exactly: follow-up-ok",
    workspace,
    first.workId,
  );
  assert.equal(followup.state, "completed");
  assert.equal(followup.threadId, first.threadId);
  assert.ok(followup.turnId && followup.turnId !== first.turnId);
  result.executions.push({
    label: "normal-handoff",
    workId: followup.workId,
    state: followup.state,
    threadId: followup.threadId,
    turnId: followup.turnId,
  });

  stage = "task-cancellation-setup";
  const domain = service.domain();
  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(domain, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Live probe",
    instructions: "Complete only the supplied task.",
    capabilities: "code",
  });
  command(domain, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Disposable live probe",
    leadProfileId: profileId,
  });
  command(domain, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(domain, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Cancellation probe",
    outcome: "Produce a short poem for cancellation qualification",
    ready: false,
  });
  await service.provisionTask(taskId);
  command(domain, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief:
      "Write 300 words about an imaginary garden, without tools. It is acceptable to be interrupted before finishing.",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command(domain, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const workId = `assignment:${assignmentId}:initial`;
  await waitUntil(
    () => {
      const intent = service.list().find((item) => item.workId === workId);
      return (
        intent?.state === "running" && Boolean(intent.threadId && intent.turnId)
      );
    },
    60_000,
    "bound live task turn",
  );

  stage = "cancellation-request";
  const observation = await service.stopTask(taskId);
  const stopped = observation.outcomes.find((item) => item.workId === workId);
  assert.ok(stopped, "Stop must observe the exact active task generation");
  assert.equal(stopped.interrupt, "acknowledged");
  result.cancellation = {
    observationMs: observation.observationMs,
    workId,
    threadId: stopped.threadId,
    turnId: stopped.turnId,
    interrupt: stopped.interrupt,
    terminal: stopped.terminal,
    resultingState: service.list().find((item) => item.workId === workId)
      ?.state,
    power: service.powerStatus(),
  };
}

try {
  await run();
} catch (error) {
  result.failure = { stage, kind: failureKind(error) };
  process.exitCode = 1;
} finally {
  try {
    await service?.stop();
  } catch {
    result.failure ??= { stage: "service-shutdown", kind: "cleanup-error" };
    process.exitCode = 1;
  }
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
      result.cleanup.fixtureRemoved = true;
    } catch {
      result.cleanup.fixtureRemoved = false;
      result.failure ??= { stage: "fixture-cleanup", kind: "cleanup-error" };
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
