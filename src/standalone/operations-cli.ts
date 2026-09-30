import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "./operations.js";
import {
  renderLaunchAgent,
  writeLaunchAgent,
  type LaunchAgentConfiguration,
} from "./launchd.js";

const USAGE =
  "Usage: npm run operations -- <backup SOURCE SNAPSHOT | verify SNAPSHOT | restore SNAPSHOT DESTINATION | render-launch-agent LABEL NODE CLI DATA AUTH ORIGIN PORT STDOUT STDERR PLIST>\n";

function parsePort(value: string): number {
  if (!/^(?:[1-9]\d{0,4})$/.test(value)) throw new Error("invalid port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535)
    throw new Error("invalid port");
  return port;
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "backup" && args.length === 2) {
    writeResult({
      ok: true,
      operation: "backup",
      manifest: await createSnapshot(args[0] as string, args[1] as string),
    });
    return;
  }
  if (command === "verify" && args.length === 1) {
    writeResult({
      ok: true,
      operation: "verify",
      manifest: await verifySnapshot(args[0] as string),
    });
    return;
  }
  if (command === "restore" && args.length === 2) {
    writeResult({
      ok: true,
      operation: "restore",
      manifest: await restoreSnapshot(args[0] as string, args[1] as string),
    });
    return;
  }
  if (command === "render-launch-agent" && args.length === 10) {
    const configuration: LaunchAgentConfiguration = {
      label: args[0] as string,
      nodePath: args[1] as string,
      cliPath: args[2] as string,
      dataDirectory: args[3] as string,
      authFile: args[4] as string,
      origin: args[5] as string,
      port: parsePort(args[6] as string),
      stdoutPath: args[7] as string,
      stderrPath: args[8] as string,
    };
    const plistPath = args[9] as string;
    // Validate before creating the destination. The rendered text is written
    // with exclusive mode by the same renderer used by tests and the CLI.
    renderLaunchAgent(configuration);
    writeLaunchAgent(configuration, plistPath);
    writeResult({
      ok: true,
      operation: "render-launch-agent",
      label: configuration.label,
    });
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 2;
}

try {
  await main();
} catch {
  // Causes can contain local paths. The CLI intentionally emits no raw error.
  process.stderr.write('{"ok":false,"error":"operation failed"}\n');
  process.exitCode = 1;
}
