import { definePluginApp } from "@get-bb/plugin-sdk/app";

function CapabilityPanel() {
  return (
    <main>
      <p>Capability fixture active</p>
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "t1-capability-panel",
    title: "T1 Capability Fixture",
    icon: "Workflow",
    path: "capability",
    component: CapabilityPanel,
  });
});
