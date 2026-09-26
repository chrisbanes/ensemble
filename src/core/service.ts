import { z } from "zod";
import type { Coordinator } from "./coordinator.js";
import type { Assignment, Store } from "./store.js";

export interface CallerContext {
  hostKey: string;
  externalProjectId: string;
  externalConversationId: string;
}

interface ProjectConfiguration {
  externalProjectId: string;
  coordinatorConversationId: string;
  instructions: string;
}

interface EnsembleServiceOptions {
  hostKey: string;
  getConfiguration(): Promise<unknown>;
  validateLaunch(assignment: Assignment): Promise<void>;
}

const callerContextSchema = z
  .object({
    hostKey: z.string().uuid(),
    externalProjectId: z.string().min(1).max(512),
    externalConversationId: z.string().min(1).max(512),
  })
  .strict();
const projectConfigurationSchema: z.ZodType<ProjectConfiguration> = z
  .object({
    externalProjectId: z.string().min(1).max(512),
    coordinatorConversationId: z.string().min(1).max(512),
    instructions: z.string().max(16000),
  })
  .strict();
const id = z.string().uuid();
const text = z.string().trim().min(1).max(16000);
const createTaskSchema = z.object({ id, title: text }).strict();
const delegateSchema = z.object({ id, taskId: id, brief: text }).strict();
const reportSchema = z.object({ assignmentId: id, result: text }).strict();

export class EnsembleService {
  constructor(
    private readonly store: Store,
    private readonly coordinator: Coordinator,
    private readonly options: EnsembleServiceOptions,
  ) {}

  async createTask(context: unknown, input: unknown) {
    const caller = callerContextSchema.parse(context);
    const parsed = createTaskSchema.parse(input);
    const { project } = await this.requireCoordinator(caller);
    return this.store.createTask(parsed.id, project.projectId, parsed.title);
  }

  async delegate(context: unknown, input: unknown): Promise<Assignment> {
    const caller = callerContextSchema.parse(context);
    const parsed = delegateSchema.parse(input);
    const { project, configuration } = await this.requireCoordinator(caller);
    let assignment = this.store.assign(
      parsed.id,
      parsed.taskId,
      project.projectId,
      parsed.brief,
    );
    if (assignment.state === "pending") {
      assignment = this.store.captureInstructions(
        assignment.id,
        configuration.instructions,
      );
      await this.options.validateLaunch(assignment);
    }
    return this.coordinator.launch(assignment.id);
  }

  async report(context: unknown, input: unknown): Promise<Assignment> {
    const caller = callerContextSchema.parse(context);
    const parsed = reportSchema.parse(input);
    if (caller.hostKey !== this.options.hostKey)
      throw new Error("Caller belongs to another execution host");
    const assignment = this.store.get(parsed.assignmentId);
    const project = this.store.getProjectBinding(assignment.projectId);
    if (
      project.hostKey !== caller.hostKey ||
      project.externalProjectId !== caller.externalProjectId
    )
      throw new Error("Assignment belongs to another host project");

    if (assignment.state === "launching") await this.coordinator.reconcile();
    const conversation = this.store.getConversationBinding(assignment.id);
    if (
      !conversation ||
      conversation.hostKey !== caller.hostKey ||
      conversation.externalConversationId !== caller.externalConversationId
    )
      throw new Error(
        "Only the assigned host conversation can report its result",
      );
    return this.store.complete(
      assignment.id,
      assignment.projectId,
      caller.hostKey,
      caller.externalConversationId,
      parsed.result,
    );
  }

  async assignments(context: unknown): Promise<Assignment[]> {
    const caller = callerContextSchema.parse(context);
    const { project } = await this.requireCoordinator(caller);
    await this.coordinator.reconcile();
    return this.store.list(project.projectId);
  }

  async reconcile(): Promise<void> {
    await this.coordinator.reconcile();
  }

  private async requireCoordinator(caller: CallerContext): Promise<{
    project: ReturnType<Store["resolveProject"]>;
    configuration: ProjectConfiguration;
  }> {
    if (caller.hostKey !== this.options.hostKey)
      throw new Error("Caller belongs to another execution host");
    const configuration = projectConfigurationSchema.parse(
      await this.options.getConfiguration(),
    );
    if (caller.externalProjectId !== configuration.externalProjectId)
      throw new Error(
        "Only the configured coordinator project may manage tasks",
      );
    if (
      caller.externalConversationId !== configuration.coordinatorConversationId
    )
      throw new Error(
        "Only the configured coordinator conversation may manage tasks",
      );

    const project = this.store.bindProject(
      this.options.hostKey,
      configuration.externalProjectId,
      configuration.coordinatorConversationId,
    );
    this.store.setProjectInstructions(
      project.projectId,
      configuration.instructions,
    );
    return { project, configuration };
  }
}
