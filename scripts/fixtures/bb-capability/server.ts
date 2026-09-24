import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
export default function probe(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec(
    "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)",
  );
  db.prepare("INSERT OR IGNORE INTO probe VALUES (1, 0)").run();
  const settings = bb.settings.define({
    hold: { type: "boolean", label: "Hold dispatch", default: false },
  });
  bb.agents.registerTool({
    name: "capability_ping",
    description: "Record a durable test ping",
    parameters: z.object({}),
    execute: () => {
      db.prepare("UPDATE probe SET count=count+1 WHERE id=1").run();
      return "recorded";
    },
  });
  bb.providers.register({
    id: "ensemble-probe",
    displayName: "Ensemble probe",
    icon: "FlaskConical",
    strings: {
      signInHint: "Offline test",
      expiredHint: "Offline",
      installUrl: "https://github.com/get-bb/bb",
      brandPrefix: "Probe",
      planModeCopy: "Test",
      iconTint: { light: "#000000", dark: "#ffffff" },
    },
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    reasoningLevels: [{ id: "medium", label: "Medium" }],
    serviceTiers: [{ id: "default", label: "Default" }],
    models: {
      fallback: [
        {
          id: "fake-model",
          displayName: "Fake Model",
          description: "Scripted offline probe",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    },
    deriveProviderOptions: () => ({
      scripted: { uniqueProviderThreadIds: true },
    }),
  });
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    if (ctx.thread.providerId !== "ensemble-probe")
      return { action: "proceed" };
    return (await settings.get()).hold
      ? { action: "wait", reason: "Capability fixture hold" }
      : { action: "proceed" };
  });
  bb.rpc.register(
    {
      ping: { input: z.object({}), output: z.any() },
      recheck: { input: z.object({}), output: z.any() },
    },
    {
      ping: () => db.prepare("SELECT count FROM probe WHERE id=1").get(),
      recheck: async () => {
        await bb.experimental_hooks.recheck("message.dispatch");
        return { ok: true };
      },
    },
  );
}
