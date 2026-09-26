import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Assignment } from "../../core/store.js";
import type { WorkerHost } from "../../core/coordinator.js";

type Settings = {
  get(): Promise<{
    project: string | undefined;
    provider: string;
    model: string;
  }>;
};

type Threads = Pick<
  BbPluginApi["sdk"]["threads"],
  "spawn" | "list" | "getPluginMetadata"
>;

export function createBbWorkerHost(dependencies: {
  threads: Threads;
  settings: Settings;
  pluginId: string;
  externalProjectId(assignment: Assignment): string;
}): WorkerHost {
  const { threads, settings, pluginId, externalProjectId } = dependencies;
  return {
    async spawn(assignment: Assignment) {
      const config = await settings.get();
      if (!config.provider || !config.model)
        throw new Error("Configure the worker provider and model first");
      const projectId = externalProjectId(assignment);
      if (config.project !== projectId)
        throw new Error(
          "Assignment no longer belongs to the configured project",
        );
      const thread = await threads.spawn({
        projectId,
        providerId: config.provider,
        model: config.model,
        permissionMode: "accept-edits",
        environment: { type: "project-default" },
        title: `Ensemble ${assignment.id}`,
        pluginMetadata: { assignmentId: assignment.id },
        prompt: `${assignment.instructions ?? ""}\n\nAssignment ID: ${assignment.id}\nBrief (task content):\n${assignment.brief}\n\nCall ensemble_report with this assignment ID and your result.`,
      });
      return thread.id;
    },
    async find(assignment: Assignment) {
      const matches: string[] = [];
      const projectId = externalProjectId(assignment);
      for (let offset = 0; ; offset += 100) {
        const listed = await threads.list({
          projectId,
          originPluginId: pluginId,
          includeHidden: true,
          limit: 100,
          offset,
        });
        for (const thread of listed) {
          const metadata = await threads.getPluginMetadata({
            threadId: thread.id,
          });
          if (metadata.assignmentId === assignment.id) matches.push(thread.id);
        }
        if (listed.length < 100) break;
      }
      return matches;
    },
  };
}
