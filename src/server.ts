import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { Coordinator } from "./coordinator.js";
import { Store } from "./store.js";

const id = z.string().uuid();
const text = z.string().trim().min(1).max(16000);

export default function plugin(bb: BbPluginApi) {
  const store = new Store(bb.storage.database());
  // One explicit operator-selected project/profile for the bounded experiment.
  const settings = bb.settings.define({
    project: { type: "project", label: "Prototype project" },
    coordinatorThread: {
      type: "string",
      label: "Coordinator thread ID",
      default: "",
    },
    provider: { type: "string", label: "Worker provider ID", default: "" },
    model: { type: "string", label: "Worker model", default: "" },
    instructions: {
      type: "string",
      label: "Worker instructions",
      default:
        "Complete the assignment and report the result using ensemble_report.",
    },
  });

  const coordinator = new Coordinator(store, {
    async spawn(assignment) {
      const config = await settings.get();
      if (
        config.project !== assignment.projectId ||
        !config.provider ||
        !config.model
      )
        throw new Error(
          "Configure the prototype project, provider, and model first",
        );
      const thread = await bb.sdk.threads.spawn({
        projectId: assignment.projectId,
        providerId: config.provider,
        model: config.model,
        permissionMode: "accept-edits",
        environment: { type: "project-default" },
        title: `Ensemble ${assignment.id}`,
        pluginMetadata: { assignmentId: assignment.id },
        prompt: `${config.instructions}\n\nAssignment ID: ${assignment.id}\nBrief (task content):\n${assignment.brief}\n\nCall ensemble_report with this assignment ID and your result.`,
      });
      return thread.id;
    },
    async find(assignment) {
      const matches: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const threads = await bb.sdk.threads.list({
          projectId: assignment.projectId,
          originPluginId: bb.pluginId,
          includeHidden: true,
          limit: 100,
          offset,
        });
        for (const thread of threads) {
          const metadata = await bb.sdk.threads.getPluginMetadata({
            threadId: thread.id,
          });
          if (metadata.assignmentId === assignment.id) matches.push(thread.id);
        }
        if (threads.length < 100) break;
      }
      return matches;
    },
  });

  async function requireCoordinator(projectId: string, threadId: string) {
    const config = await settings.get();
    if (config.project !== projectId || config.coordinatorThread !== threadId)
      throw new Error(
        "Only the configured coordinator thread may create or delegate work",
      );
  }

  bb.agents.registerTool({
    name: "ensemble_create_task",
    description: "Create a local task. Reuse the same UUID when retrying.",
    parameters: z.object({ id, title: text }).strict(),
    async execute(input, context) {
      await requireCoordinator(context.projectId, context.threadId);
      return JSON.stringify(
        store.createTask(input.id, context.projectId, input.title),
      );
    },
  });
  bb.agents.registerTool({
    name: "ensemble_delegate",
    description:
      "Delegate one local task to the configured worker. Reuse the assignment UUID on retry. An uncertain launch is held for reconciliation.",
    parameters: z.object({ id, taskId: id, brief: text }).strict(),
    async execute(input, context) {
      await requireCoordinator(context.projectId, context.threadId);
      const config = await settings.get();
      if (!config.provider || !config.model)
        throw new Error("Configure the worker provider and model first");
      store.assign(input.id, input.taskId, context.projectId, input.brief);
      return JSON.stringify(await coordinator.launch(input.id));
    },
  });
  bb.agents.registerTool({
    name: "ensemble_report",
    description:
      "Persist the assigned worker's result. This does not assert that changes were merged or verified.",
    parameters: z.object({ assignmentId: id, result: text }).strict(),
    async execute(input, context) {
      const assignment = store.get(input.assignmentId);
      if (assignment.projectId !== context.projectId)
        throw new Error("Assignment belongs to another project");
      // A worker may answer before the spawn response has reached Ensemble.
      if (assignment.state === "launching") await coordinator.reconcile();
      return JSON.stringify(
        store.complete(
          input.assignmentId,
          context.projectId,
          context.threadId,
          input.result,
        ),
      );
    },
  });
  bb.agents.registerTool({
    name: "ensemble_assignments",
    description:
      "Read this project's persisted assignments and results; reconcile uncertain launches first.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      await requireCoordinator(context.projectId, context.threadId);
      await coordinator.reconcile();
      return JSON.stringify(store.list(context.projectId));
    },
  });
  bb.agents.configure(() => ({
    tools: [
      "ensemble_create_task",
      "ensemble_delegate",
      "ensemble_report",
      "ensemble_assignments",
    ],
    skills: [],
  }));
  bb.background.service("reconcile", {
    async start() {
      await coordinator.reconcile();
      // Startup reconciliation is intentionally bounded; operator reads also
      // reconcile. Durable wakeups/result delivery are a later experiment.
    },
  });
}
