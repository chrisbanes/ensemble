import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { tmpdir } from "./temp.js";

interface RunnerResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  exitObserved: boolean;
  elapsedMs: number;
  terminationSignals: string[];
  stdout: { lines: string[]; omitted: number; truncated: number };
  stderr: { lines: string[]; omitted: number; truncated: number };
}
const runner = (await import(
  pathToFileURL(resolve("scripts/run-tests.mjs")).href
)) as {
  runTestProcess(
    args: string[],
    options?: {
      cwd?: string;
      deadlineMs?: number;
      graceMs?: number;
      forceWaitMs?: number;
    },
  ): Promise<RunnerResult>;
  runnerStatus(
    result: Pick<RunnerResult, "timedOut" | "exitObserved" | "code">,
  ): number;
};

test("the owned runner preserves an actual npm run check failure status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-runner-status-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "synthetic-check-failure",
        scripts: { check: 'node -e "process.exit(23)"' },
      }),
    );
    const npmCli = process.env.npm_execpath;
    assert.ok(
      npmCli,
      "Run this test through the pinned npm process or supply its standard npm_execpath",
    );
    const result = await runner.runTestProcess([npmCli, "run", "check"], {
      cwd: directory,
      deadlineMs: 5000,
    });
    assert.equal(result.exitObserved, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 23);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the runner deadline ends waiting and observes graceful exact-child exit", async () => {
  const result = await runner.runTestProcess(
    [
      "-e",
      'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 2000);',
    ],
    { deadlineMs: 150, graceMs: 100, forceWaitMs: 100 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.terminationSignals, ["SIGTERM"]);
  assert.ok(
    result.elapsedMs >= 140 && result.elapsedMs < 600,
    `Observed ${result.elapsedMs}ms`,
  );
});

test("bounded followup forces only the retained child group after ignored SIGTERM", async () => {
  const result = await runner.runTestProcess(
    [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 2000);',
    ],
    { deadlineMs: 150, graceMs: 50, forceWaitMs: 100 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(result.terminationSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(
    result.elapsedMs >= 190 && result.elapsedMs < 600,
    `Observed ${result.elapsedMs}ms`,
  );
});

test("runner evidence retains only bounded known synthetic stdout and stderr", async () => {
  const result = await runner.runTestProcess([
    "-e",
    'console.log("ensemble-test-evidence stdout synthetic-ci-probe"); console.error("ensemble-test-evidence stderr synthetic-ci-probe"); console.error("AssertionError [ERR_ASSERTION]: Injected CI browser assertion remains primary"); console.log("SYNTHETIC_PRIVATE_MARKER token=private"); console.error("x".repeat(10000)); for(let i=0;i<100;i++) console.log("ensemble-test-evidence stdout synthetic-ci-probe"); process.exitCode=1;',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.lines.length, 40);
  assert.equal(result.stdout.omitted, 62);
  assert.equal(result.stderr.truncated, 1);
  assert.deepEqual(result.stderr.lines, [
    "ensemble-test-evidence stderr synthetic-ci-probe",
    "AssertionError [ERR_ASSERTION]: Injected CI browser assertion remains primary",
  ]);
  assert.equal(
    JSON.stringify(result).includes("SYNTHETIC_PRIVATE_MARKER"),
    false,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result.stdout)) < 65536);
});

test("wrapper timeout and uncertainty statuses remain separate from observed child status", () => {
  assert.equal(
    runner.runnerStatus({ timedOut: true, exitObserved: true, code: 0 }),
    124,
  );
  assert.equal(
    runner.runnerStatus({ timedOut: true, exitObserved: false, code: null }),
    125,
  );
  assert.equal(
    runner.runnerStatus({ timedOut: false, exitObserved: false, code: null }),
    125,
  );
  assert.equal(
    runner.runnerStatus({ timedOut: false, exitObserved: true, code: 23 }),
    23,
  );
});

test("wrapper interruption uses bounded exact-child cleanup before returning", async () => {
  const code = `const {runTestProcess}=await import(${JSON.stringify(pathToFileURL(resolve("scripts/run-tests.mjs")).href)}); setTimeout(()=>process.kill(process.pid,"SIGTERM"),150); const r=await runTestProcess(["-e",'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);setTimeout(()=>process.exit(99),2000)'],{forwardSignals:true,deadlineMs:1000,graceMs:100,forceWaitMs:100}); if(r.interrupted==="SIGTERM"&&r.exitObserved&&r.code===0&&!r.timedOut) console.log("ensemble-test-evidence stdout synthetic-ci-probe"); else process.exitCode=17;`;
  const result = await runner.runTestProcess(
    ["--input-type=module", "-e", code],
    { deadlineMs: 5000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout.lines, [
    "ensemble-test-evidence stdout synthetic-ci-probe",
  ]);
});
