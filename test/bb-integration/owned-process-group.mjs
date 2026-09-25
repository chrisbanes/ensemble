import { setTimeout as delay } from "node:timers/promises";

function signalProcessGroup(child, processGroupId, signal) {
  if (!processGroupId) return;
  try {
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    } else {
      process.kill(-processGroupId, signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function terminateOwnedProcessGroup({
  child,
  processGroupId = child.pid,
  closePromise,
  graceMs = 2_000,
  closeTimeoutMs = 2_000,
}) {
  signalProcessGroup(child, processGroupId, "SIGTERM");
  await delay(graceMs);

  // The leader may have exited while a descendant still owns its stdio pipes.
  // Keep signaling the captured PGID so that the rest of the owned tree exits.
  signalProcessGroup(child, processGroupId, "SIGKILL");

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => resolve({ timedOut: true }),
      closeTimeoutMs,
    );
    closePromise.then(
      (closed) => {
        clearTimeout(timeout);
        resolve({ closed });
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
  if (result.timedOut) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    throw new Error(
      `Owned process group ${processGroupId} did not close within ${closeTimeoutMs}ms after SIGKILL`,
    );
  }
  return result.closed;
}
