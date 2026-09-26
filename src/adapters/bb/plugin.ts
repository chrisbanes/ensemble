import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  Coordinator,
  EnsembleService,
  Store,
  type Assignment,
} from "../../core/index.js";
import { createBbWorkerHost } from "./worker-host.js";

const id = z.string().uuid();
const text = z.string().trim().min(1).max(16000);

export default function plugin(bb: BbPluginApi) {
  const store = new Store(bb.storage.database());
  const hostKey = store.ensureHost("bb");
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

  const coordinator = new Coordinator(
    store,
    createBbWorkerHost({
      threads: bb.sdk.threads,
      settings,
      pluginId: bb.pluginId,
      externalProjectId: (assignment) =>
        store.getProjectBinding(assignment.projectId).externalProjectId,
    }),
    hostKey,
  );
  const service = new EnsembleService(store, coordinator, {
    hostKey,
    async getConfiguration() {
      const config = await settings.get();
      return {
        externalProjectId: config.project,
        coordinatorConversationId: config.coordinatorThread,
        instructions: config.instructions,
      };
    },
    async validateLaunch() {
      const config = await settings.get();
      if (!config.provider || !config.model)
        throw new Error("Configure the worker provider and model first");
    },
  });

  function caller(context: PluginAgentToolContext) {
    return {
      hostKey,
      externalProjectId: context.projectId,
      externalConversationId: context.threadId,
    };
  }

  function toBbAssignment(assignment: Assignment) {
    return {
      id: assignment.id,
      taskId: assignment.taskId,
      projectId: store.getProjectBinding(assignment.projectId)
        .externalProjectId,
      brief: assignment.brief,
      state: assignment.state,
      threadId:
        store.getConversationBinding(assignment.id)?.externalConversationId ??
        null,
      result: assignment.result,
    };
  }

  bb.agents.registerTool({
    name: "ensemble_create_task",
    description: "Create a local task. Reuse the same UUID when retrying.",
    parameters: z.object({ id, title: text }).strict(),
    async execute(input, context) {
      const task = await service.createTask(caller(context), input);
      return JSON.stringify({
        ...task,
        projectId: store.getProjectBinding(task.projectId).externalProjectId,
      });
    },
  });
  bb.agents.registerTool({
    name: "ensemble_delegate",
    description:
      "Delegate one local task to the configured worker. Reuse the assignment UUID on retry. An uncertain launch is held for reconciliation.",
    parameters: z.object({ id, taskId: id, brief: text }).strict(),
    async execute(input, context) {
      const assignment = await service.delegate(caller(context), input);
      return JSON.stringify(toBbAssignment(assignment));
    },
  });
  bb.agents.registerTool({
    name: "ensemble_report",
    description:
      "Persist the assigned worker's result. This does not assert that changes were merged or verified.",
    parameters: z.object({ assignmentId: id, result: text }).strict(),
    async execute(input, context) {
      const assignment = await service.report(caller(context), input);
      return JSON.stringify(toBbAssignment(assignment));
    },
  });
  bb.agents.registerTool({
    name: "ensemble_assignments",
    description:
      "Read this project's persisted assignments and results; reconcile uncertain launches first.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      const assignments = await service.assignments(caller(context));
      return JSON.stringify(assignments.map(toBbAssignment));
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
      await service.reconcile();
      // Startup reconciliation is intentionally bounded; operator reads also
      // reconcile. Durable wakeups/result delivery are a later experiment.
    },
  });
}
