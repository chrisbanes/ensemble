import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ControlledGitRule = {
  commandPrefix: string;
  cwd?: string;
  behavior: "stall" | "complete-then-stall" | "overflow";
  holdPipe?: boolean;
};

export type ControlledGitEvent = {
  event: "start" | "ready" | "finish" | "term" | "descendant";
  pid: number;
  fixtureToken?: string;
  processPath?: string;
  processStartedAt?: string | null;
  command?: string;
  cwd?: string;
  operation?: string;
  elapsedMs?: number;
  exitCode?: number | null;
  effectComplete?: boolean;
  atMs?: number;
};

export function controlledGit(root?: string) {
  const fixtureRoot =
    root ?? mkdtempSync(join(tmpdir(), "ensemble-controlled-git-"));
  const fixtureToken = randomUUID();
  const executable = join(fixtureRoot, `controlled-git-${fixtureToken}.cjs`);
  const descendantExecutable = join(
    fixtureRoot,
    `controlled-git-descendant-${fixtureToken}.cjs`,
  );
  const controlPath = join(fixtureRoot, "controlled-git-control.json");
  const eventsPath = join(fixtureRoot, "controlled-git-events.jsonl");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(controlPath, JSON.stringify({}));
  const source = `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const controlPath = ${JSON.stringify(controlPath)};
const eventsPath = ${JSON.stringify(eventsPath)};
const realGit = ${JSON.stringify(realGit)};
const fixtureToken = ${JSON.stringify(fixtureToken)};
const executable = ${JSON.stringify(executable)};
const descendantExecutable = ${JSON.stringify(descendantExecutable)};
let ownProcessStartedAt;
const args = process.argv.slice(2);
const cwdIndex = args.indexOf("-C");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const command = args.slice(cwdIndex >= 0 ? cwdIndex + 2 : 0).join(" ");
const classify = (value) => {
  if (value.startsWith("worktree add")) return "worktree-add";
  if (value.startsWith("worktree remove")) return "worktree-remove";
  if (value.startsWith("status --porcelain=v1 --untracked-files=all")) return "archive-status";
  if (value.startsWith("status")) return "checkout-validation";
  if (value.startsWith("rev-parse --show-toplevel") || value.startsWith("rev-parse --git-common-dir")) return "repository-identity";
  if (value.startsWith("rev-parse --verify --end-of-options")) return "ref-resolution";
  if (value.startsWith("rev-parse --verify")) return "checkout-validation";
  return "other";
};
const processIdentity = (pid, processPath) => {
  if (pid === process.pid && ownProcessStartedAt !== undefined)
    return { fixtureToken, processPath, processStartedAt: ownProcessStartedAt };
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000 });
  const processStartedAt = !result.error && result.status === 0
    ? result.stdout.trim().split(/\\s+/).join(" ")
    : null;
  if (pid === process.pid) ownProcessStartedAt = processStartedAt;
  return { fixtureToken, processPath, processStartedAt };
};
const writeEvent = (value) => {
  const processPath = value.event === "descendant" ? descendantExecutable : executable;
  const identity = processIdentity(value.pid, processPath);
  appendFileSync(eventsPath, JSON.stringify({ ...value, ...(identity ?? {}), atMs: Date.now() }) + "\\n");
};
const onTerm = () => {
  writeEvent({ event: "term", pid: process.pid });
  if (
    control.behavior === "overflow" &&
    command.startsWith(control.commandPrefix) &&
    (!control.cwd || control.cwd === cwd)
  ) {
    process.removeListener("SIGTERM", onTerm);
    process.kill(process.pid, "SIGTERM");
  }
};
process.on("SIGTERM", onTerm);
const operation = classify(command);
const startedAt = Date.now();
const control = JSON.parse(readFileSync(controlPath, "utf8"));
writeEvent({ event: "start", pid: process.pid, operation, command, cwd });
if (control.behavior && command.startsWith(control.commandPrefix) && (!control.cwd || control.cwd === cwd)) {
  if (control.behavior === "overflow") {
    process.stderr.write("stderr-secret-shaped-output\\n");
    process.stdout.write(Buffer.alloc(1024 * 1024 + 5, 120));
    setInterval(() => {}, 1000);
  }
  const hang = (effectComplete = false) => {
    if (effectComplete)
      writeEvent({ event: "finish", pid: process.pid, operation, elapsedMs: Date.now() - startedAt, exitCode: 0, effectComplete: true });
    if (control.holdPipe) {
      const descendant = spawn(process.execPath, [descendantExecutable, fixtureToken], { stdio: "inherit" });
      writeEvent({ event: "descendant", pid: descendant.pid });
    }
    writeEvent({ event: "ready", pid: process.pid, operation });
    setInterval(() => {}, 1000);
  };
  if (control.behavior === "stall") {
    hang();
  } else if (control.behavior === "complete-then-stall") {
    const result = spawnSync(realGit, args, { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status ?? 1);
    hang(true);
  }
} else {
  const result = spawnSync(realGit, args, { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
  writeEvent({ event: "finish", pid: process.pid, operation, elapsedMs: Date.now() - startedAt, exitCode: result.status });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
`;
  const descendantSource = `#!${process.execPath}
if (process.argv[2] !== ${JSON.stringify(fixtureToken)}) process.exit(91);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
  writeFileSync(executable, source);
  writeFileSync(descendantExecutable, descendantSource);
  chmodSync(executable, 0o755);
  chmodSync(descendantExecutable, 0o755);

  return {
    root: fixtureRoot,
    executable,
    setRule(rule: ControlledGitRule | undefined) {
      writeFileSync(controlPath, JSON.stringify(rule ?? {}));
    },
    events(): ControlledGitEvent[] {
      try {
        return readFileSync(eventsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ControlledGitEvent);
      } catch {
        return [];
      }
    },
    recordStaleIdentityForTest(pid: number): void {
      appendFileSync(
        eventsPath,
        `${JSON.stringify({
          event: "start",
          pid,
          fixtureToken,
          processPath: executable,
          processStartedAt: "stale-process-birth-identity",
        })}\n`,
      );
    },
    async cleanup(): Promise<void> {
      const identities = new Map<string, ProcessIdentity>();
      let unresolvedIdentity = false;
      for (const event of this.events()) {
        if (event.event !== "start" && event.event !== "descendant") continue;
        if (
          event.fixtureToken !== fixtureToken ||
          (event.processPath !== executable &&
            event.processPath !== descendantExecutable)
        )
          continue;
        if (
          !Number.isSafeInteger(event.pid) ||
          event.pid <= 0 ||
          event.pid === process.pid
        )
          continue;
        if (!event.processStartedAt) {
          const current = currentProcessIdentity(event.pid);
          if (!current) {
            if (isAlive(event.pid)) unresolvedIdentity = true;
            continue;
          }
          if (
            current.command.includes(event.processPath) &&
            current.command.includes(fixtureToken)
          )
            unresolvedIdentity = true;
          continue;
        }
        const identity = {
          pid: event.pid,
          fixtureToken,
          processPath: event.processPath,
          processStartedAt: event.processStartedAt,
        };
        identities.set(
          `${identity.pid}:${identity.processStartedAt}:${identity.processPath}`,
          identity,
        );
      }
      for (const identity of identities.values()) {
        const current = verifyOwnedProcess(identity);
        if (current === "unverifiable")
          throw new Error(
            "Controlled Git fixture process identity could not be verified",
          );
        if (current !== "owned") continue;

        signalOwnedProcess(identity, "SIGTERM");
        if (!(await waitUntil(() => processIsGoneOrChanged(identity), 250))) {
          signalOwnedProcess(identity, "SIGKILL");
          if (!(await waitUntil(() => processIsGoneOrChanged(identity), 1000)))
            throw new Error(
              "Controlled Git fixture child did not stop within its cleanup bound",
            );
        }
      }
      if (unresolvedIdentity)
        throw new Error(
          "Controlled Git fixture has a live process without a captured birth identity",
        );
      if (!root) rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

type ProcessIdentity = {
  pid: number;
  fixtureToken: string;
  processPath: string;
  processStartedAt: string;
};

function currentProcessIdentity(pid: number): {
  processStartedAt: string;
  command: string;
} | null {
  const result = spawnSync(
    "ps",
    ["-ww", "-p", String(pid), "-o", "lstart=,command="],
    { encoding: "utf8", timeout: 250 },
  );
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
      throw new Error(
        "Controlled Git fixture process identity check timed out",
      );
    throw result.error;
  }
  if (result.status !== 0) return null;
  const fields = result.stdout.trim().split(/\s+/);
  if (fields.length < 6) return null;
  return {
    processStartedAt: fields.slice(0, 5).join(" "),
    command: fields.slice(5).join(" "),
  };
}

function verifyOwnedProcess(
  identity: ProcessIdentity,
): "owned" | "gone" | "changed" | "unverifiable" {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code !== "EPERM") throw error;
  }
  const current = currentProcessIdentity(identity.pid);
  if (!current) {
    try {
      process.kill(identity.pid, 0);
      return "unverifiable";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      throw error;
    }
  }
  if (
    current.processStartedAt !== identity.processStartedAt ||
    !current.command.includes(identity.processPath) ||
    !current.command.includes(identity.fixtureToken)
  )
    return "changed";
  return "owned";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalOwnedProcess(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): void {
  const current = verifyOwnedProcess(identity);
  if (current === "gone" || current === "changed") return;
  if (current === "unverifiable")
    throw new Error(
      "Controlled Git fixture process identity could not be verified before signal",
    );
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
}

function processIsGoneOrChanged(identity: ProcessIdentity): boolean {
  const current = verifyOwnedProcess(identity);
  if (current === "unverifiable")
    throw new Error(
      "Controlled Git fixture process identity could not be verified during cleanup",
    );
  return current === "gone" || current === "changed";
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}
