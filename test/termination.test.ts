import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { renderLaunchAgent } from "../src/standalone/launchd.js";

test("generated macOS LaunchAgent environment captures complete boot birth and process identity without sbin in PATH", {
  skip: process.platform !== "darwin",
}, () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-termination-")),
  );
  chmodSync(root, 0o700);
  try {
    const data = join(root, "data"),
      auth = join(root, "auth"),
      logs = join(root, "logs");
    for (const path of [data, auth, logs]) mkdirSync(path, { mode: 0o700 });
    const authFile = join(auth, "auth.json");
    writeFileSync(authFile, "{}", { mode: 0o600 });
    const plist = join(root, "com.example.ensemble.identity.plist");
    writeFileSync(
      plist,
      renderLaunchAgent({
        label: "com.example.ensemble.identity",
        nodePath: realpathSync(process.execPath),
        cliPath: resolve("dist/src/standalone/cli.js"),
        dataDirectory: data,
        authFile,
        origin: "http://127.0.0.1:28787",
        port: 28787,
        stdoutPath: join(logs, "out"),
        stderrPath: join(logs, "err"),
      }),
      { mode: 0o600 },
    );
    const env = JSON.parse(
      execFileSync(
        "/usr/bin/plutil",
        ["-extract", "EnvironmentVariables", "json", "-o", "-", plist],
        { encoding: "utf8", timeout: 5000 },
      ),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(env).sort(), [
      "ENSEMBLE_OPERATOR_AUTH_FILE",
      "ENSEMBLE_OPERATOR_ORIGIN",
      "PATH",
    ]);
    assert.equal(env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    const code =
      "import {captureProcessIdentity} from './dist/src/standalone/termination.js'; console.log(JSON.stringify(await captureProcessIdentity(process.pid)))";
    const identity = JSON.parse(
      execFileSync(
        realpathSync(process.execPath),
        ["--input-type=module", "-e", code],
        { env, encoding: "utf8", timeout: 5000 },
      ),
    );
    assert.ok(
      identity,
      "generated environment must capture a complete identity",
    );
    assert.match(identity.processId, /^[1-9][0-9]*$/);
    assert.ok(identity.processStartedAt);
    assert.match(identity.bootId, /^[A-Fa-f0-9-]+$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
