import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  renderLaunchAgent,
  writeLaunchAgent,
  type LaunchAgentConfiguration,
} from "../src/standalone/launchd.js";

function createFixture(): {
  root: string;
  configuration: LaunchAgentConfiguration;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-launchd-")));
  chmodSync(root, 0o700);
  const dataDirectory = join(root, "private & <data>");
  const authDirectory = join(root, "auth");
  const logs = join(root, "logs");
  mkdirSync(dataDirectory, { mode: 0o700 });
  mkdirSync(authDirectory, { mode: 0o700 });
  mkdirSync(logs, { mode: 0o700 });
  const authFile = join(authDirectory, "operator-auth.json");
  writeFileSync(authFile, "{}\n", { mode: 0o600 });
  const cliPath = resolve("dist/src/standalone/cli.js");
  return {
    root,
    configuration: {
      label: "com.example.ensemble.disposable",
      nodePath: process.execPath,
      cliPath,
      dataDirectory,
      authFile,
      origin: "http://127.0.0.1:28787",
      port: 28787,
      stdoutPath: join(logs, "stdout & <operator>.log"),
      stderrPath: join(logs, "stderr.log"),
    },
  };
}

function lintPlistIfAvailable(
  plistPath: string,
  environment: {
    platform: NodeJS.Platform;
    executablePath: string;
  } = { platform: process.platform, executablePath: "/usr/bin/plutil" },
): boolean {
  if (environment.platform !== "darwin") return false;
  try {
    accessSync(environment.executablePath, fsConstants.X_OK);
  } catch {
    return false;
  }
  execFileSync(environment.executablePath, ["-lint", plistPath], {
    encoding: "utf8",
  });
  return true;
}

test("native plist lint requires macOS and an available executable", () => {
  const fixture = createFixture();
  try {
    const plistPath = join(fixture.root, "not-created.plist");
    assert.equal(
      lintPlistIfAvailable(plistPath, {
        platform: "linux",
        executablePath: "/usr/bin/false",
      }),
      false,
    );
    assert.equal(
      lintPlistIfAvailable(plistPath, {
        platform: "darwin",
        executablePath: join(fixture.root, "missing-plutil"),
      }),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertLaunchAgentFields(
  plist: string,
  configuration: LaunchAgentConfiguration,
): void {
  const argumentsXml = [
    configuration.nodePath,
    configuration.cliPath,
    "operator",
    configuration.dataDirectory,
    String(configuration.port),
  ]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries({
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ENSEMBLE_OPERATOR_AUTH_FILE: configuration.authFile,
    ENSEMBLE_OPERATOR_ORIGIN: configuration.origin,
  })
    .map(
      ([key, value]) =>
        `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  const expectedFields = [
    `  <key>Label</key>\n  <string>${xmlEscape(configuration.label)}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${argumentsXml}\n  </array>`,
    `  <key>EnvironmentVariables</key>\n  <dict>\n${environmentXml}\n  </dict>`,
    `  <key>StandardOutPath</key>\n  <string>${xmlEscape(configuration.stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xmlEscape(configuration.stderrPath)}</string>`,
    "  <key>RunAtLoad</key>\n  <true/>",
    "  <key>KeepAlive</key>\n  <false/>",
  ];

  for (const field of expectedFields) {
    assert.ok(plist.includes(field), `plist must include ${field}`);
  }
}

test("LaunchAgent renders exact private operator arguments and writes exclusively", () => {
  const fixture = createFixture();
  const plistPath = join(fixture.root, `${fixture.configuration.label}.plist`);
  try {
    const plist = renderLaunchAgent(fixture.configuration);
    writeLaunchAgent(fixture.configuration, plistPath);
    assert.equal(readFileSync(plistPath, "utf8"), plist);
    assert.equal(statSync(plistPath).mode & 0o777, 0o600);
    assert.throws(() => writeLaunchAgent(fixture.configuration, plistPath));
    assert.equal(existsSync(plistPath), true);

    lintPlistIfAvailable(plistPath);
    assertLaunchAgentFields(
      readFileSync(plistPath, "utf8"),
      fixture.configuration,
    );
    assert.equal(plist.includes("password"), false);
    assert.equal(plist.includes("/bin/sh"), false);
    assert.equal(plist.includes("launchctl"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("LaunchAgent rejects unsafe identities, paths, origins, ports, and system targets", () => {
  const fixture = createFixture();
  const { configuration } = fixture;
  try {
    const bad = (change: Partial<LaunchAgentConfiguration>) =>
      renderLaunchAgent({ ...configuration, ...change });
    assert.throws(() => bad({ label: "../../system" }));
    assert.throws(() => bad({ nodePath: "relative/node" }));
    assert.throws(() => bad({ origin: "http://example.com:28787" }));
    assert.throws(() => bad({ origin: "https://user:pass@example.com" }));
    assert.throws(() => bad({ port: 65_536 }));
    assert.throws(() => bad({ port: 0 }));
    assert.throws(() => bad({ stderrPath: configuration.stdoutPath }));
    assert.throws(() => bad({ stdoutPath: configuration.authFile }));

    const symlinkNode = join(fixture.root, "node-link");
    symlinkSync(configuration.nodePath, symlinkNode);
    assert.throws(() => bad({ nodePath: symlinkNode }));

    const symlinkData = join(fixture.root, "data-link");
    symlinkSync(configuration.dataDirectory, symlinkData);
    assert.throws(() => bad({ dataDirectory: symlinkData }));

    const symlinkAuth = join(fixture.root, "auth-link");
    symlinkSync(configuration.authFile, symlinkAuth);
    assert.throws(() => bad({ authFile: symlinkAuth }));

    const symlinkLogs = join(fixture.root, "log-link");
    symlinkSync(dirname(configuration.stdoutPath), symlinkLogs);
    assert.throws(() => bad({ stdoutPath: join(symlinkLogs, "stdout.log") }));

    assert.throws(() =>
      writeLaunchAgent(
        configuration,
        "/Library/LaunchDaemons/com.example.ensemble.plist",
      ),
    );
    assert.throws(() =>
      writeLaunchAgent(
        configuration,
        "/Library/LaunchAgents/com.example.ensemble.plist",
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("operations CLI renders a private LaunchAgent without echoing paths", () => {
  const fixture = createFixture();
  const { configuration } = fixture;
  const plistPath = join(fixture.root, `${configuration.label}.plist`);
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "launchd CLI test must run from npm");
  try {
    const result = spawnSync(
      process.execPath,
      [
        npmCli,
        "run",
        "operations",
        "--",
        "render-launch-agent",
        configuration.label,
        configuration.nodePath,
        configuration.cliPath,
        configuration.dataDirectory,
        configuration.authFile,
        configuration.origin,
        String(configuration.port),
        configuration.stdoutPath,
        configuration.stderrPath,
        plistPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          npm_config_loglevel: "silent",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(fixture.root),
      false,
    );
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(output, {
      ok: true,
      operation: "render-launch-agent",
      label: configuration.label,
    });
    assert.equal(statSync(plistPath).mode & 0o777, 0o600);
    lintPlistIfAvailable(plistPath);
    assertLaunchAgentFields(readFileSync(plistPath, "utf8"), configuration);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
