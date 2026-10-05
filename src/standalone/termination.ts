import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  RuntimeProcessIdentity,
  TerminationVerification,
  TerminationVerifier,
} from "./recovery-types.js";

const execFileAsync = promisify(execFile);

const processIdentitySchema = z.object({
  processId: z.string().regex(/^[1-9][0-9]{0,8}$/),
  processStartedAt: z.string().min(1).max(128),
  bootId: z.string().min(1).max(128),
});

async function readText(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    const output = result.stdout.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/** macOS boot-session identity; other hosts remain conservatively unverifiable. */
export async function readHostBootIdentity(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  return readText("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
}

export async function readProcessBirthIdentity(
  processId: string,
): Promise<string | null> {
  if (process.platform !== "darwin" || !/^[1-9][0-9]{0,8}$/.test(processId))
    return null;
  return readText("ps", ["-p", processId, "-o", "lstart="]);
}

export async function captureProcessIdentity(
  processId: number | undefined,
): Promise<RuntimeProcessIdentity | null> {
  if (
    processId === undefined ||
    processId <= 0 ||
    process.platform !== "darwin"
  )
    return null;
  const id = String(processId);
  const [processStartedAt, bootId] = await Promise.all([
    readProcessBirthIdentity(id),
    readHostBootIdentity(),
  ]);
  const parsed = processIdentitySchema.safeParse({
    processId: id,
    processStartedAt,
    bootId,
  });
  return parsed.success ? parsed.data : null;
}

function processIsAbsent(processId: number): boolean | undefined {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    return undefined;
  }
}

/**
 * Verifies only a same-boot macOS PID absence. A live/reused PID, changed boot,
 * missing birth identity, or unreadable OS evidence is never treated as exit.
 */
export class MacProcessTerminationVerifier implements TerminationVerifier {
  async verify(
    identity: RuntimeProcessIdentity,
  ): Promise<TerminationVerification> {
    const parsed = processIdentitySchema.safeParse(identity);
    if (!parsed.success)
      return {
        kind: "unknown",
        reason: "Original process identity is incomplete",
      };
    if (process.platform !== "darwin")
      return {
        kind: "unknown",
        reason: "Process-exit verification is unsupported on this host",
      };
    const currentBootId = await readHostBootIdentity();
    if (!currentBootId)
      return {
        kind: "unknown",
        reason: "Current host boot identity could not be read",
      };
    if (currentBootId !== parsed.data.bootId)
      return {
        kind: "conflict",
        reason: "Host boot identity differs from the original execution",
      };
    const pid = Number(parsed.data.processId);
    const absent = processIsAbsent(pid);
    if (absent === true)
      return {
        kind: "verified",
        processIdentity: parsed.data,
        verifiedAt: new Date().toISOString(),
        method: "mac-pid-absent-same-boot",
      };
    if (absent === undefined)
      return {
        kind: "unknown",
        reason: "Original process liveness could not be read",
      };
    const currentBirth = await readProcessBirthIdentity(parsed.data.processId);
    if (!currentBirth)
      return {
        kind: "unknown",
        reason: "Original process birth identity could not be read",
      };
    if (currentBirth === parsed.data.processStartedAt)
      return {
        kind: "conflict",
        reason: "Original execution process is still present",
      };
    return {
      kind: "conflict",
      reason: "Original process identifier is now reused",
    };
  }
}
