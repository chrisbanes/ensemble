import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const providerId = "ensemble-scripted";

export default function otherWaitFixture(bb: BbPluginApi): void {
  const failPath = process.env.T4_FAIL_WAITER_PATH;
  if (failPath && existsSync(failPath)) {
    throw new Error(
      "T4 intentional external wait plugin initialization failure",
    );
  }
  const enabledPath = process.env.T4_WAITER_ENABLED_PATH;
  if (!enabledPath) throw new Error("T4_WAITER_ENABLED_PATH is required");

  bb.experimental_hooks.on("message.dispatch", (context) => {
    if (context.requestedExecution.providerId !== providerId) {
      return { action: "proceed" };
    }
    if (existsSync(enabledPath)) {
      return { action: "wait", reason: "T4 external wait plugin hold" };
    }
    return { action: "proceed" };
  });
}
