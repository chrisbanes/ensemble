import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import {
  createTestEvidenceDirectory,
  writeTestEvidence,
} from "./fixtures/browser-diagnostics.js";
import { tmpdir } from "./temp.js";

interface ProbeResult {
  pid: number;
  code: number | null;
  timedOut: boolean;
  exitObserved: boolean;
  stdout: { lines: string[] };
  stderr: { lines: string[] };
}
const runner = (await import(
  pathToFileURL(resolve("scripts/run-tests.mjs")).href
)) as {
  runTestProcess(
    args: string[],
    options?: { deadlineMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<ProbeResult>;
  recordRunnerEvidence(
    result: ProbeResult,
    name: string,
    evidenceRoot?: string,
  ): Promise<string>;
};

test("fixture preflight binds real listeners under the portable writable temporary root", {
  timeout: 30000,
}, async () => {
  if (process.env.TMPDIR)
    assert.equal(tmpdir(), await realpath(process.env.TMPDIR));
  const fixture = await createOperatorFixture();
  try {
    assert.equal(fixture.directory.startsWith(`${tmpdir()}/`), true);
    const web = await fixture.startWeb();
    assert.equal((await fetch(`${web.origin}/login`)).status, 200);
    const directory = await createTestEvidenceDirectory(
      "preflight",
      "writable synthetic evidence",
    );
    await writeTestEvidence(
      directory,
      "stdout.sanitized.log",
      "fixture preflight writable\n",
    );
    assert.equal(
      await readFile(join(directory, "stdout.sanitized.log"), "utf8"),
      "fixture preflight writable\n",
    );
  } finally {
    await fixture.close();
  }
  assert.equal(
    fixture.lifecycle.steps
      .filter((step) => step.phase === "cleanup")
      .every((step) => step.status === "completed"),
    true,
  );
});

test("fixture preflight proves expected child assertion failure with sanitized logs and readable PNG", {
  timeout: 60000,
}, async () => {
  const configured = process.env.ENSEMBLE_TEST_EVIDENCE_DIR;
  const root =
    configured ?? (await mkdtemp(join(tmpdir(), "ensemble-ci-preflight-")));
  try {
    const result = await runner.runTestProcess(
      ["dist/test/fixtures/operator-ci-evidence-failure.js"],
      {
        deadlineMs: 45000,
        env: { ...process.env, ENSEMBLE_TEST_EVIDENCE_DIR: root },
      },
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.exitObserved, true);
    assert.equal(result.code, 1);
    assert.ok(
      result.stdout.lines.includes(
        "ensemble-test-evidence stdout synthetic-ci-probe",
      ),
    );
    assert.ok(
      result.stderr.lines.includes(
        "ensemble-test-evidence stderr synthetic-ci-probe",
      ),
    );
    assert.ok(
      result.stderr.lines.includes(
        "AssertionError [ERR_ASSERTION]: Injected CI browser assertion remains primary",
      ),
    );
    const runnerDirectory = await runner.recordRunnerEvidence(
      result,
      "expected synthetic assertion failure",
      root,
    );
    assert.match(
      await readFile(join(runnerDirectory, "stderr.sanitized.log"), "utf8"),
      /Injected CI browser assertion remains primary/,
    );
    const runnerManifest = JSON.parse(
      await readFile(join(runnerDirectory, "manifest.json"), "utf8"),
    );
    assert.equal(runnerManifest.nodeVersion, process.version);
    const parent = join(root, `ci-failure-${result.pid}`);
    const entries = await readdir(parent);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    const directory = join(parent, entry);
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.phases.execution.status, "failed");
    assert.equal(manifest.cleanup.incomplete, false);
    const png = await readFile(join(directory, "synthetic-failure.png"));
    assert.deepEqual(
      png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    assert.ok(png.byteLength <= 2 * 1024 * 1024);
    const files = await readdir(directory);
    assert.deepEqual(files.sort(), [
      "manifest.json",
      "stderr.sanitized.log",
      "stdout.sanitized.log",
      "synthetic-failure.png",
    ]);
    for (const name of files.filter((name) => !name.endsWith(".png")))
      assert.equal(
        (await readFile(join(directory, name), "utf8")).includes(
          "SYNTHETIC_PRIVATE_MARKER",
        ),
        false,
      );
    assert.equal(
      JSON.stringify(result).includes("SYNTHETIC_PRIVATE_MARKER"),
      false,
    );
  } finally {
    if (!configured) await rm(root, { recursive: true, force: true });
  }
});
