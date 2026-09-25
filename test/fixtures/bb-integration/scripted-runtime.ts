import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function scriptedRuntime(bb: BbPluginApi): void {
  bb.providers.register({
    id: "ensemble-scripted",
    displayName: "Ensemble scripted integration provider",
    icon: "Workflow",
    strings: {
      signInHint: "Offline integration fixture",
      expiredHint: "Offline integration fixture",
      installUrl: "https://github.com/get-bb/bb",
      brandPrefix: "Ensemble test",
      planModeCopy: "Scripted integration test",
      iconTint: { light: "#222222", dark: "#eeeeee" },
    },
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: true,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits"],
      reasoningLevels: ["medium", "high"],
    },
    composerActions: [],
    reasoningLevels: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    models: {
      fallback: [
        {
          id: "fixture-model",
          displayName: "Fixture model",
          description: "Offline scripted provider used by T01.",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
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
}
