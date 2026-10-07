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
  const executable = join(fixtureRoot, "controlled-git.cjs");
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
const writeEvent = (value) => appendFileSync(eventsPath, JSON.stringify({ ...value, atMs: Date.now() }) + "\\n");
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
    process.on("SIGTERM", () => writeEvent({ event: "term", pid: process.pid }));
    if (control.holdPipe) {
      const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], { stdio: "inherit" });
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
  writeFileSync(executable, source);
  chmodSync(executable, 0o755);

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
    async cleanup(): Promise<void> {
      const pids = new Set(
        this.events()
          .filter(({ event }) => event === "start" || event === "descendant")
          .map(({ pid }) => pid)
          .filter(
            (pid) =>
              Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
          ),
      );
      for (const pid of pids) {
        if (isAlive(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // The exact fixture child may have exited between the liveness check and signal.
          }
          if (!(await waitUntil(() => !isAlive(pid), 250))) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The exact fixture child may have exited before escalation.
            }
            if (!(await waitUntil(() => !isAlive(pid), 1000)))
              throw new Error(
                "Controlled Git fixture child did not stop within its cleanup bound",
              );
          }
        }
      }
      if (!root) rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
