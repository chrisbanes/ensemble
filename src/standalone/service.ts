import { z } from "zod";
import {
  ArchivedResumeRejectedError,
  preTurnRecoveryCommandSchema,
  noTurnRecoveryCommandSchema,
  type HistoricalNoTurnAdoption,
  type NoTurnRecoveryCommand,
  type HistoricalPreTurnAdoption,
  type PreTurnRecoveryCommand,
  type ReplaceConversationCommand,
} from "./pre-turn-recovery.js";
import {
  DeliveryStore,
  canonicalMaterial,
  type DeliveryCaller,
  type DeliveryPolicy,
} from "../core/delivery.js";
import { DeliveryCoordinator, deliveryRuntimeEnvironment } from "./delivery.js";
import type { GitHubDeliveryProvider } from "./github-delivery.js";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  STANDALONE_MARKER_CONTENTS,
  StandaloneDataDirectory,
} from "./data-directory.js";
import { Store } from "../core/store.js";
import { verifiedRepository } from "../core/github-source.js";
import { GitHubSourceStore } from "../core/github-source.js";
import { GitHubSynchronizer, type GitHubReaderFactory } from "./github-sync.js";
import {
  CoordinationStore,
  type CoordinationCall,
  type CoordinationReceipt,
  type InboxDelivery,
  type RuntimeQuestionRecord,
} from "../core/coordination.js";
import {
  dispatchCoordinationTool,
  isCoordinationTool,
  coordinationTools,
} from "./coordination-tools.js";
import {
  nativeEndpointKey,
  encodeNativeInputReply,
  type RuntimeUserInputRequest,
  type RuntimeUserInputOutcome,
} from "./native-input.js";
import { CoordinationView } from "./coordination-view.js";
import {
  DomainStore,
  type CapacityConfigureCommand,
  type CapacityLimits,
} from "../core/domain.js";
import {
  CodexRuntime,
  parseFailureEvidence,
  type Runtime,
  type RuntimeConversationEvent,
  type RuntimeToolCall,
  type RuntimeToolResult,
} from "./codex.js";
import {
  ConversationHistoryCapture,
  ConversationHistoryStore,
} from "./conversation-history.js";
import type { ConversationHistoryAssignmentRead } from "./conversation-history.js";
import type {
  RecoveryRecord,
  RecoveryReceipt,
  TerminationVerifier,
} from "./recovery-types.js";
import {
  SchedulerStore,
  TurnScheduler,
  type TurnRequest,
} from "./scheduler.js";
import {
  RoutingAttemptStore,
  RoutingCoordinator,
  RoutingOperationStaleError,
  routingClientFromEnvironment,
  routingModel,
  type RoutingChoiceClient,
  type RoutingOutcome,
  type RoutingSnapshot,
  type RoutingStaleReason,
} from "./routing.js";
import {
  ExecutionSupervisor,
  type ExecutionSupervisorOptions,
  type StopObservation,
} from "./supervisor.js";
import { MacProcessTerminationVerifier } from "./termination.js";
import {
  ExecutionState,
  type CoordinationExecutionBinding,
  type ExecutionIntent,
  type TaskExecutionBinding,
  type TaskExecutionContext,
} from "./state.js";
import {
  CaffeinateAssertion,
  ExecutionPower,
  MacPowerEventSource,
  type PowerEventSource,
} from "./power.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
  type TaskWorkspaceRepositoryInput,
  type WorkspaceCleanupEvidence,
  type WorkspaceManagerOptions,
} from "./workspaces.js";

const immutableRevisionMismatches = new Set([
  "assignment-revision-changed",
  "assignment-instructions-changed",
  "assignment-profile-changed",
  "assignment-instructions-revision-stale",
  "assignment-profile-revision-stale",
  "task-revision-changed",
]);

export interface RuntimeSpawnContext {
  spawnEnvironment: () => NodeJS.ProcessEnv;
}
export interface StandaloneServiceOptions {
  delivery?: {
    fetcher?: typeof fetch;
    providerFactory?: (
      projectId: string,
      policy: DeliveryPolicy,
    ) => GitHubDeliveryProvider;
  };
  github?: { readerFactory?: GitHubReaderFactory; intervalMs?: number };
  routingClient?: RoutingChoiceClient | null;
  /** Test-only values remain in memory and are never persisted. */
  conversationHistoryExclusions?: () => readonly string[];
  supervisor?: ExecutionSupervisorOptions;
  terminationVerifier?: TerminationVerifier;
  workspaceManager?: WorkspaceManagerOptions;
  power?: {
    enabled?: boolean;
    eventSource?: PowerEventSource;
    assertion?: CaffeinateAssertion;
    pollIntervalMs?: number;
  };
  retry?: {
    now?: () => number;
    fallbackBackoffMs?: number;
    maxFallbackBackoffMs?: number;
  };
}

export type RoutingAvailabilityReason =
  | "disabled"
  | "missing-client-credentials"
  | "no-eligible-candidates"
  | null;

export interface RoutingAvailability {
  enabled: boolean;
  credentialReferenceConfigured: boolean;
  routingClientAvailable: boolean;
  eligibleCandidateCount: number;
  available: boolean;
  reason: RoutingAvailabilityReason;
}
/** Owns only standalone.sqlite in a marked data directory. No import or attach path exists. */
export class StandaloneService {
  private owner: StandaloneDataDirectory | undefined;
  private db: DatabaseSync | undefined;
  private state: ExecutionState | undefined;
  private domainState: DomainStore | undefined;
  private githubSourceStore: GitHubSourceStore | undefined;
  private githubSynchronizer: GitHubSynchronizer | undefined;
  private githubPollTimer: NodeJS.Timeout | undefined;
  private coordination: CoordinationStore | undefined;
  private deliveryStore: DeliveryStore | undefined;
  private deliveryCoordinator: DeliveryCoordinator | undefined;
  private runtimeSpawnSnapshot: NodeJS.ProcessEnv | undefined;
  private routingAttempts: RoutingAttemptStore | undefined;
  private workspaces: WorkspaceManager | undefined;
  private workspaceBindings: SqliteWorkspaceBindingStore | undefined;
  private schedulerStore: SchedulerStore | undefined;
  private scheduler: TurnScheduler | undefined;
  private supervisor: ExecutionSupervisor | undefined;
  private power: ExecutionPower | undefined;
  private powerPollTimer: NodeJS.Timeout | undefined;
  private runtime: Runtime | undefined;
  private conversationHistory: ConversationHistoryStore | undefined;
  private readonly conversationCaptures = new Map<
    string,
    ConversationHistoryCapture
  >();
  private lastCompletedWorkId: string | undefined;
  private readonly active = new Set<Promise<ExecutionIntent>>();
  private readonly activeByWorkId = new Map<string, Promise<ExecutionIntent>>();
  private readonly nativeWaiters = new Map<
    string,
    { workId: string; interactionId: string; resolve: () => void }
  >();
  private readonly callbacks = new Map<string, Set<Promise<unknown>>>();
  private readonly routingCoordinators = new Map<string, RoutingCoordinator>();
  private readonly retryNow: () => number;
  private readonly fallbackBackoffMs: number;
  private readonly maxFallbackBackoffMs: number;

  constructor(
    private readonly dataDir: string,
    private readonly runtimeFactory: (
      context: RuntimeSpawnContext,
    ) => Runtime = (context) => new CodexRuntime("codex", context),
    private readonly markerWriter: (path: string, flag: "wx" | "w") => void = (
      path,
      flag,
    ) => writeFileSync(path, STANDALONE_MARKER_CONTENTS, { flag, mode: 0o600 }),
    private readonly options: StandaloneServiceOptions = {},
  ) {
    this.retryNow = options.retry?.now ?? Date.now;
    const fallback = options.retry?.fallbackBackoffMs ?? 1000;
    const maximum = options.retry?.maxFallbackBackoffMs ?? 30_000;
    if (
      !Number.isSafeInteger(fallback) ||
      fallback < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0 ||
      maximum > 30_000
    )
      throw new Error(
        "Retry fallback backoff must be a bounded non-negative integer",
      );
    this.maxFallbackBackoffMs = maximum;
    this.fallbackBackoffMs = Math.min(fallback, maximum);
  }

  async start(): Promise<void> {
    if (this.db) throw new Error("Service already started");
    this.lastCompletedWorkId = undefined;
    const dataDirectory = StandaloneDataDirectory.openExclusive(this.dataDir, {
      markerWriter: this.markerWriter,
    });
    this.owner = dataDirectory;
    const { databasePath: database, workspacePath } = dataDirectory;
    try {
      const db = new DatabaseSync(database);
      this.db = db;
      db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      new Store(db).ensureHost("standalone-codex");
      this.conversationHistory = new ConversationHistoryStore(db);
      const domain = new DomainStore(db, () => {
        void this.wakeScheduler().catch(() => {});
      });
      domain.migrate();
      this.domainState = domain;
      const githubSources = new GitHubSourceStore(db);
      githubSources.migrate();
      githubSources.invalidateProviderObservations();
      this.githubSourceStore = githubSources;
      this.githubSynchronizer = new GitHubSynchronizer(
        domain,
        githubSources,
        this.options.github?.readerFactory,
      );
      const routingAttempts = new RoutingAttemptStore(db);
      routingAttempts.migrate();
      this.routingAttempts = routingAttempts;
      const schedulerStore = new SchedulerStore(db);
      this.schedulerStore = schedulerStore;
      const workspaceBindings = new SqliteWorkspaceBindingStore(db);
      this.workspaceBindings = workspaceBindings;
      const workspaces = new WorkspaceManager(
        workspaceBindings,
        workspacePath,
        this.options.workspaceManager,
      );
      await workspaces.recover();
      this.workspaces = workspaces;
      const state = new ExecutionState(db);
      for (const item of state.list()) {
        const executionBinding = state.taskBinding(item.workId);
        const workspaceBinding = executionBinding
          ? workspaceBindings.get(executionBinding.taskId)
          : undefined;
        const bindingRootMismatch =
          workspaceBinding !== undefined &&
          workspaceBinding.path !==
            join(workspacePath, workspaceBinding.workspaceId);
        if (bindingRootMismatch) continue;
        this.options.workspaceManager?.beforePathAccess?.(item.workspace);
        let workspaceKey: string;
        try {
          workspaceKey = realpathSync(item.workspace);
        } catch {
          workspaceKey = resolve(item.workspace);
        }
        if (workspaceKey !== item.workspace)
          state.setWorkspaceKey(item.id, workspaceKey);
      }
      state.holdUnfinishedOnOpen();
      this.state = state;
      const coordination = new CoordinationStore(
        db,
        domain,
        (workId) => state.isNeverAdmittedRefusedAssignmentWork(workId),
        (workId) =>
          (this.callbacks.get(workId)?.size ?? 0) === 0
            ? state.reconciledAssignmentProof(workId)
            : undefined,
      );
      coordination.migrate();
      coordination.invalidateRuntimeQuestions(
        "Service restarted; native endpoints cannot be reconstructed",
      );
      this.coordination = coordination;
      const deliveryStore = new DeliveryStore(db);
      deliveryStore.migrate();
      this.deliveryStore = deliveryStore;
      this.deliveryCoordinator = new DeliveryCoordinator(deliveryStore, {
        ...(this.options.delivery?.fetcher
          ? { fetcher: this.options.delivery.fetcher }
          : {}),
        ...(this.options.delivery?.providerFactory
          ? { providerFactory: this.options.delivery.providerFactory }
          : {}),
        authorize: (caller, exceptOperationId, request) => {
          this.authorizeDelivery(caller, exceptOperationId);
          if (
            request &&
            (request.action.kind === "pr.merge" ||
              request.action.kind === "issue.close")
          ) {
            const reasons = coordination.deliveryActionBlockers(
              caller,
              request.action.reviewedResultIds,
              request.operationId,
            );
            if ((this.callbacks.get(caller.workId)?.size ?? 0) > 1)
              reasons.push("unfinished-callback");
            if (request.action.kind === "pr.merge") {
              const binding = deliveryStore.delivery(caller.taskId),
                target = request.action.target;
              if (
                !binding ||
                binding.observation.nodeId !== target.nodeId ||
                binding.observation.repositoryId !== target.repositoryId ||
                binding.observation.number !== target.number ||
                binding.observation.headSha !== target.expectedHeadSha
              )
                reasons.push("merge-target-not-current-delivery");
              if (!String(domain.project(caller.projectId).instructions).trim())
                reasons.push("merge-instructions-unconfigured");
            } else {
              const imported = domain.importedTask(caller.taskId);
              if (
                !imported ||
                imported.nodeId !== request.action.target.nodeId ||
                imported.repositoryId !== request.action.target.repositoryId
              )
                reasons.push("closure-target-not-task-issue");
            }
            if (reasons.length) throw new Error("Completion action held");
          }
        },
        taskVersion: (taskId) => Number(domain.task(taskId).version),
        leadAssignmentId: (taskId) =>
          String(
            domain.leadBindings().find((b) => b.taskId === taskId)
              ?.assignmentId ?? "",
          ),
        feedback: (taskId, reason, identity) =>
          coordination.ensureDeliveryEventWithinTransaction(
            taskId,
            reason,
            identity,
          ),
        approved: (request, caller) =>
          Boolean(
            request.approval &&
              deliveryStore.approvalCurrent(
                request.approval.interactionId,
                caller,
                request.action,
                request.operationId,
              ) &&
              coordination.authorizationFor({
                assignmentId: caller.assignmentId,
                ...request.approval,
                action: request.action.kind,
                target: canonicalMaterial(request.action.target),
                material: request.action,
              }),
          ),
        activationAllowed: (policy) =>
          !policy.credentialRef ||
          (!this.runtimeSpawnSnapshot?.[policy.credentialRef.slice(4)] &&
            !Object.values(this.runtimeSpawnSnapshot ?? {}).includes(
              process.env[policy.credentialRef.slice(4)] ?? "",
            )),
      });
      const context: RuntimeSpawnContext = {
        spawnEnvironment: () => {
          const policies = domain
            .projects()
            .map((p) => deliveryStore.configuration(String(p.id)));
          const snapshot = deliveryRuntimeEnvironment(process.env, policies);
          this.runtimeSpawnSnapshot = snapshot;
          return { ...snapshot };
        },
      };
      // Preserve the snapshot even for injected runtimes which do not spawn a child.
      context.spawnEnvironment();
      const runtime = this.runtimeFactory(context);
      this.runtime = runtime;
      this.supervisor = new ExecutionSupervisor(
        state,
        runtime,
        this.options.supervisor,
        this.options.terminationVerifier ?? new MacProcessTerminationVerifier(),
      );
      runtime.onUnexpectedRequest((request) => {
        const executions = state.list();
        const active = executions.filter(
          (item) => item.state === "submitting" || item.state === "running",
        );
        const attributable = executions.filter(
          (item) =>
            item.state === "completed" ||
            item.state === "held" ||
            item.state === "submitting" ||
            item.state === "running",
        );
        const bound =
          request.threadId && request.turnId
            ? attributable.filter(
                (item) =>
                  item.threadId === request.threadId &&
                  item.turnId === request.turnId,
              )
            : [];
        if (bound.length === 0 && request.threadId && request.turnId) {
          const awaiting = attributable.filter(
            (item) =>
              item.threadId === request.threadId && item.turnId === null,
          );
          const pending = awaiting.length === 1 ? awaiting[0] : undefined;
          if (
            pending &&
            state.holdPendingTurn(
              pending.id,
              request.threadId,
              request.turnId,
              `Unexpected App Server request denied: ${request.method}`,
            )
          ) {
            this.supervisor?.turnBound(
              pending.workId,
              request.threadId,
              request.turnId,
            );
            return;
          }
        }
        if (bound.length === 1 && bound[0]?.state === "completed") {
          this.retractWriterAndSuccessors(
            bound[0],
            `Unexpected App Server request denied: ${request.method}`,
          );
          return;
        }
        const affected = bound.length === 1 ? bound : active;
        for (const item of affected) {
          state.hold(
            item.id,
            `Unexpected App Server request denied: ${request.method}`,
          );
          this.supervisor?.noteAnomaly(item.workId);
        }
      });
      runtime.onUserInputRequest?.((request) =>
        this.handleUserInputRequest(request),
      );
      runtime.onUserInputOutcome?.((outcome) =>
        this.handleUserInputOutcome(outcome),
      );
      runtime.onToolCall?.((call) => this.handleToolCall(call));
      runtime.onConversationEvent?.((event) =>
        this.receiveConversationEvent(event),
      );
      runtime.onTerminalAnomaly?.((anomaly) => {
        const items = state.list();
        const matched =
          anomaly.threadId && anomaly.turnId
            ? items.filter(
                (item) =>
                  item.threadId === anomaly.threadId &&
                  item.turnId === anomaly.turnId,
              )
            : items.filter(
                (item) =>
                  item.state === "submitting" ||
                  item.state === "running" ||
                  (item.state === "completed" &&
                    item.workId === this.lastCompletedWorkId),
              );
        for (const item of matched) {
          this.retractWriterAndSuccessors(item, anomaly.reason);
          this.supervisor?.noteAnomaly(item.workId);
        }
      });
      await runtime.start();
      await this.supervisor.reconcileOnStart();
      await this.deliveryCoordinator.refresh();
      await this.reconcileOwnDeliveryClosures();
      await this.githubSynchronizer.refresh();
      this.emitSourceHoldNotices();
      const powerOptions = this.options.power;
      const powerEnabled =
        powerOptions?.enabled ??
        (powerOptions?.eventSource !== undefined ||
          runtime instanceof CodexRuntime);
      if (powerEnabled) {
        const pollIntervalMs = powerOptions?.pollIntervalMs ?? 5000;
        if (
          !Number.isSafeInteger(pollIntervalMs) ||
          pollIntervalMs <= 0 ||
          pollIntervalMs > 60_000
        )
          throw new Error(
            "Power-event poll interval must be a positive integer no greater than 60000",
          );
        const power = new ExecutionPower(
          state,
          powerOptions?.eventSource ?? new MacPowerEventSource(),
          powerOptions?.assertion ?? new CaffeinateAssertion(),
          () => this.requireSupervisor().reconcileOnStart(),
          () => this.wakeScheduler(),
        );
        this.power = power;
        await power.start();
        await power.poll();
        this.powerPollTimer = setInterval(() => {
          void power.poll().catch(() => {});
        }, pollIntervalMs);
        this.powerPollTimer.unref();
      }
      const scheduler = new TurnScheduler(
        schedulerStore,
        (request) => this.attemptRequest(request),
        this.retryNow,
      );
      this.scheduler = scheduler;
      scheduler.start();
      await this.wakeScheduler();
      const githubInterval = this.options.github?.intervalMs ?? 60_000;
      if (
        !Number.isSafeInteger(githubInterval) ||
        githubInterval < 1000 ||
        githubInterval > 3_600_000
      )
        throw new Error(
          "GitHub refresh interval must be between 1000 and 3600000 milliseconds",
        );
      this.githubPollTimer = setInterval(() => {
        void this.refreshGitHub().catch(() => {});
      }, githubInterval);
      this.githubPollTimer.unref();
    } catch (error) {
      try {
        if (this.state)
          for (const item of this.state.list())
            if (item.state === "ready")
              this.state.hold(
                item.id,
                "Runtime or login unavailable during startup",
              );
      } finally {
        try {
          if (this.powerPollTimer) clearInterval(this.powerPollTimer);
          if (this.githubPollTimer) clearInterval(this.githubPollTimer);
          this.githubPollTimer = undefined;
          this.powerPollTimer = undefined;
          await this.power?.stop().catch(() => {});
          this.power = undefined;
          this.supervisor?.cancelObservations();
          await this.githubSynchronizer?.stop().catch(() => {});
          await this.deliveryCoordinator?.stop().catch(() => {});
          await this.runtime?.stop().catch(() => {});
          await this.supervisor?.settle();
        } finally {
          this.runtime = undefined;
          this.supervisor = undefined;
          this.domainState = undefined;
          this.githubSourceStore = undefined;
          this.githubSynchronizer = undefined;
          this.coordination = undefined;
          this.deliveryCoordinator = undefined;
          this.deliveryStore = undefined;
          this.runtimeSpawnSnapshot = undefined;
          this.routingAttempts = undefined;
          this.routingCoordinators.clear();
          this.schedulerStore = undefined;
          this.scheduler = undefined;
          this.workspaces = undefined;
          this.workspaceBindings = undefined;
          this.clearConversationCaptures();
          this.conversationHistory = undefined;
          this.state = undefined;
          try {
            this.db?.close();
          } finally {
            this.db = undefined;
            dataDirectory.close();
            this.owner = undefined;
          }
        }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.scheduler = undefined;
    if (this.githubPollTimer) clearInterval(this.githubPollTimer);
    this.githubPollTimer = undefined;
    await this.githubSynchronizer?.stop();
    await this.deliveryCoordinator?.stop();
    if (this.powerPollTimer) clearInterval(this.powerPollTimer);
    this.powerPollTimer = undefined;
    const supervisor = this.supervisor;
    supervisor?.cancelObservations();
    const runtime = this.runtime;
    let failure: unknown;
    try {
      if (this.db?.isOpen)
        this.coordination?.invalidateRuntimeQuestions(
          "Service stopped; native endpoints lost",
        );
    } catch (error) {
      failure = error;
    }
    this.runtime = undefined;
    this.clearConversationCaptures();
    try {
      if (runtime) await runtime.stop();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    await Promise.allSettled(this.active);
    const power = this.power;
    this.power = undefined;
    try {
      await power?.stop();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    await supervisor?.settle();
    this.supervisor = undefined;
    const db = this.db;
    this.db = undefined;
    this.state = undefined;
    this.domainState = undefined;
    this.githubSourceStore = undefined;
    this.githubSynchronizer = undefined;
    this.coordination = undefined;
    this.deliveryCoordinator = undefined;
    this.deliveryStore = undefined;
    this.runtimeSpawnSnapshot = undefined;
    this.routingAttempts = undefined;
    this.routingCoordinators.clear();
    this.schedulerStore = undefined;
    this.workspaces = undefined;
    this.workspaceBindings = undefined;
    this.conversationHistory = undefined;
    this.activeByWorkId.clear();
    this.nativeWaiters.clear();
    this.callbacks.clear();
    try {
      db?.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    try {
      this.owner?.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    } finally {
      this.owner = undefined;
    }
    if (failure !== undefined) throw failure;
  }

  list(): ExecutionIntent[] {
    return this.requireState().list();
  }

  recoveryView(): RecoveryRecord[] {
    return this.requireState().recoveryView();
  }

  powerStatus() {
    return this.power?.status() ?? null;
  }

  resolveHeldExecution(receipt: RecoveryReceipt) {
    return this.requireSupervisor().resolveHeldExecution(receipt);
  }
  adoptHistoricalPreTurnRejection(command: HistoricalPreTurnAdoption) {
    return this.requireState().adoptHistoricalPreTurnRejection(command);
  }
  recoverPreTurnExecution(command: PreTurnRecoveryCommand) {
    const value = preTurnRecoveryCommandSchema.parse(command);
    const replay = this.requireState().preTurnCommandReplay("recover", value);
    if (replay)
      return Promise.resolve(
        z
          .object({
            id: z.string().uuid(),
            workId: z.string().min(1),
            state: z.literal("reconciled"),
          })
          .strict()
          .parse(replay),
      );
    return this.requireSupervisor().resolveHeldExecution(value.receipt, value);
  }
  adoptHistoricalNoTurnSubmission(command: HistoricalNoTurnAdoption) {
    return this.requireState().adoptHistoricalNoTurnSubmission(command);
  }
  recoverNoTurnExecution(command: NoTurnRecoveryCommand) {
    const value = noTurnRecoveryCommandSchema.parse(command);
    const replay = this.requireState().preTurnCommandReplay(
      "recover-no-turn",
      value,
    );
    if (replay)
      return Promise.resolve(
        z
          .object({
            id: z.string().uuid(),
            workId: z.string().min(1),
            state: z.literal("reconciled"),
          })
          .strict()
          .parse(replay),
      );
    return this.requireSupervisor().resolveHeldExecution(value.receipt, value);
  }
  replaceConversationCommand(command: ReplaceConversationCommand) {
    return this.requireState().replaceConversationCommand(command);
  }

  turnRequests(): TurnRequest[] {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore.list();
  }

  taskReview() {
    if (!this.coordination) throw Error("Service not started");
    return this.coordination.taskReview();
  }

  domain(): DomainStore {
    if (!this.domainState) throw new Error("Service is not started");
    return this.domainState;
  }

  githubSources(): GitHubSourceStore {
    if (!this.githubSourceStore) throw new Error("Service is not started");
    return this.githubSourceStore;
  }

  async settleHandback(input: unknown) {
    if (!this.deliveryCoordinator) throw new Error("Service is not started");
    const result = await this.deliveryCoordinator.settleHandback(input);
    await this.wakeScheduler();
    return result;
  }
  private async finalizeDeliveryCompletion(requestId: string, workId: string) {
    const coordination = this.coordination;
    if (!coordination) throw new Error("Service is not started");
    const request = coordination
      .completionRequests()
      .find((r) => r.requestId === requestId);
    if (!request) throw new Error("Unknown completion request");
    const deliveryValidation =
      await this.requireDeliveryCoordinator().qualifyCompletion(request.taskId);
    await this.reconcileOwnDeliveryClosures();
    return coordination.finalizeTaskCompletion({
      requestId,
      workId,
      terminal: "completed",
      deliveryValidation,
    });
  }
  private requireDeliveryCoordinator(): DeliveryCoordinator {
    if (!this.deliveryCoordinator) throw new Error("Service is not started");
    return this.deliveryCoordinator;
  }
  delivery(): DeliveryStore {
    if (!this.deliveryStore) throw new Error("Service is not started");
    return this.deliveryStore;
  }
  private authorizeDelivery(
    caller: DeliveryCaller,
    exceptOperationId?: string,
  ): void {
    const state = this.requireState(),
      coordination = this.coordination,
      intent = state.byWorkId(caller.workId);
    if (
      !coordination ||
      !intent?.threadId ||
      !intent.turnId ||
      intent.state !== "running"
    )
      throw new Error("Delivery caller is stale");
    const current = coordination.deliveryCaller({
      threadId: intent.threadId,
      turnId: intent.turnId,
      callId: "delivery-authority",
      tool: "ensemble_external_action",
      arguments: {},
    });
    if (canonicalMaterial(current) !== canonicalMaterial(caller))
      throw new Error("Delivery caller revision changed");
    if (state.taskHold(caller.taskId)) throw new Error("Task is held");
    const reasons = this.domain()
      .assignmentAdmission(caller.assignmentId)
      .reasons.filter((reason) => !reason.startsWith("external-action-"));
    if (
      reasons.length ||
      this.delivery().actionBlockers(caller.taskId, exceptOperationId).length
    )
      throw new Error("Task admission is held");
  }
  async refreshGitHub(): Promise<void> {
    if (!this.githubSynchronizer) throw new Error("Service is not started");
    await this.deliveryCoordinator?.refresh();
    await this.reconcileOwnDeliveryClosures();
    await this.githubSynchronizer.refresh();
    this.emitSourceHoldNotices();
    await this.wakeScheduler();
  }

  private async reconcileOwnDeliveryClosures(): Promise<void> {
    for (const project of this.domain().projects())
      for (const task of this.domain().tasks(String(project.id))) {
        const imported = this.domain().importedTask(String(task.id));
        if (
          !imported ||
          !this.delivery().ownsConfirmedClosure(
            String(task.id),
            String(imported.nodeId),
          )
        )
          continue;
        const source = this.githubSources().issue(String(imported.nodeId));
        if (!source) continue;
        const config = this.domain().githubConfiguration(String(project.id));
        try {
          const proof =
            await this.requireDeliveryCoordinator().inspectOwnClosure(
              String(task.id),
              {
                repositoryId: String(source.repositoryId),
                nodeId: String(source.nodeId),
                number: Number(source.issueNumber),
              },
            );
          this.githubSources().recordDeliveryClosure(
            String(project.id),
            config.version,
            proof.snapshot,
            proof.operationId,
            proof.closerPrNodeId,
          );
        } catch {
          this.githubSources().recordDeliveryClosureUnavailable(
            String(imported.nodeId),
          );
        }
      }
  }

  private emitSourceHoldNotices(): void {
    const sources = this.githubSourceStore;
    const domain = this.domainState;
    const coordination = this.coordination;
    if (!sources || !domain || !coordination) return;
    const leadByTask = new Map(
      domain
        .leadBindings()
        .map((binding) => [
          String(binding.taskId),
          String(binding.assignmentId),
        ]),
    );
    for (const hold of sources.activeHolds()) {
      const recipients = new Set(
        domain
          .assignments(hold.taskId)
          .filter(
            (assignment) =>
              assignment.state === "pending" || assignment.state === "running",
          )
          .map((assignment) => String(assignment.id)),
      );
      const leadId = leadByTask.get(hold.taskId);
      if (leadId) recipients.add(leadId);
      for (const recipientAssignmentId of recipients)
        coordination.ensureSourceHoldEvent({ ...hold, recipientAssignmentId });
    }
  }

  routingAvailability(projectId: string): RoutingAvailability {
    const domain = this.domain();
    const routing = domain.routing(projectId);
    const credentialReference = domain.routingCredentialReference(projectId);
    const credentialReferenceConfigured = credentialReference !== null;
    const routingClientAvailable =
      this.options.routingClient === undefined
        ? routingClientFromEnvironment(credentialReference) !== undefined
        : this.options.routingClient !== null;
    const enabled = Number(routing.enabled) === 1;
    const eligibleCandidateCount = domain.routingCandidates(projectId).length;
    const reason: RoutingAvailabilityReason = !enabled
      ? "disabled"
      : !credentialReferenceConfigured || !routingClientAvailable
        ? "missing-client-credentials"
        : eligibleCandidateCount === 0
          ? "no-eligible-candidates"
          : null;
    return {
      enabled,
      credentialReferenceConfigured,
      routingClientAvailable,
      eligibleCandidateCount,
      available: reason === null,
      reason,
    };
  }

  coordinationView(): CoordinationView {
    if (
      !this.coordination ||
      !this.routingAttempts ||
      !this.state ||
      !this.domainState
    )
      throw new Error("Service is not started");
    return new CoordinationView(
      this.domainState,
      this.coordination,
      this.state,
      this.routingAttempts,
      () => this.wakeScheduler(),
      (taskId, assignmentId) =>
        this.readConversationHistory(taskId, assignmentId),
      {
        readTask: (taskId) => this.delivery().publicTask(taskId),
        settleHandback: (command) => this.settleHandback(command),
        refresh: () => this.refreshGitHub(),
      },
    );
  }

  capacityLimits(projectIds: string[] = []): CapacityLimits {
    return this.domain().capacityLimits(projectIds);
  }

  async configureCapacity(
    command: Omit<CapacityConfigureCommand, "actor" | "type">,
  ): Promise<CapacityLimits> {
    const result = this.domain().execute({
      ...command,
      type: "capacity.configure",
      actor: "operator",
    });
    await this.wakeScheduler();
    return result as CapacityLimits;
  }

  /** The task command owns identity; provisioning never follows a conversation ID. */
  async provisionTask(
    taskId: string,
    repositories: TaskWorkspaceRepositoryInput[] = [],
  ) {
    const task = this.domain().task(taskId);
    const imported = this.domain().importedTask(taskId);
    if (imported) {
      const config = this.domain().githubConfiguration(String(task.projectId));
      const linked = config.repositories;
      for (const repository of repositories) {
        const match = linked.find(
          (candidate) => candidate.repositoryId === repository.repositoryId,
        );
        if (
          !match ||
          repository.path !== match.path ||
          (repository.ref ?? "HEAD") !== match.ref
        )
          throw new Error(
            "Imported task requires an exact linked repository binding",
          );
        const current = await verifiedRepository({
          repositoryId: match.repositoryId,
          path: match.path,
          ref: match.ref,
        });
        if (
          current.gitCommonDirectory !== match.gitCommonDirectory ||
          current.path !== match.path
        )
          throw new Error("Linked repository identity changed");
      }
      const latestTask = this.domain().task(taskId);
      const latestImported = this.domain().importedTask(taskId);
      const latestConfig = this.domain().githubConfiguration(
        String(task.projectId),
      );
      if (
        latestTask.version !== task.version ||
        latestTask.projectId !== task.projectId ||
        latestImported?.nodeId !== imported.nodeId ||
        latestImported?.repositoryId !== imported.repositoryId ||
        latestConfig.version !== config.version ||
        JSON.stringify(latestConfig.repositories) !== JSON.stringify(linked)
      )
        throw new Error(
          "Imported task repository grant changed during verification",
        );
    }
    const binding = await this.requireWorkspaces().provision(
      taskId,
      repositories,
    );
    await this.wakeScheduler();
    return binding;
  }

  taskWorkspace(taskId: string) {
    this.domain().task(taskId);
    return this.requireWorkspaces().get(taskId);
  }

  async archiveTask(taskId: string, evidence: WorkspaceCleanupEvidence) {
    this.domain().task(taskId);
    const state = this.requireState();
    const acquired =
      evidence.writerOwnershipResolved && state.beginArchive(taskId);
    if (!acquired)
      return this.requireWorkspaces().archiveAndCleanup(taskId, {
        ...evidence,
        writerOwnershipResolved: false,
      });
    try {
      return await this.requireWorkspaces().archiveAndCleanup(
        taskId,
        evidence,
        () => state.confirmArchive(taskId),
      );
    } finally {
      state.endArchive(taskId);
      await this.wakeScheduler();
    }
  }

  /** A replacement keeps the durable assignment and its captured revisions. */
  replaceConversation(assignmentId: string): number {
    this.domain().assignment(assignmentId);
    return this.requireState().replaceConversation(assignmentId);
  }

  isCurrentResult(workId: string): boolean {
    return this.requireState().isCurrentResult(workId);
  }

  recordTaskResult(workId: string, payload: string): boolean {
    return this.requireState().recordResult(workId, payload);
  }

  stopTask(taskId: string): Promise<StopObservation> {
    this.domain().task(taskId);
    const state = this.requireState();
    const targets = state.stopTask(taskId);
    for (const question of this.coordination?.runtimeQuestions(taskId) ?? [])
      if (targets.some((target) => target.workId === question.requestingWorkId))
        this.runtime?.cancelUserInput?.(
          question.identity,
          "Task stopped before native receipt",
        );
    return this.requireSupervisor().observeStop(taskId, targets);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.domain().task(taskId);
    this.requireState().resumeTask(taskId);
    await this.wakeScheduler();
  }

  taskHold(taskId: string): string | undefined {
    return this.requireState().taskHold(taskId);
  }

  /** A known survivor or unfinished tool callback keeps ownership held. */
  holdKnownSurvivor(workId: string, reason: string): void {
    const state = this.requireState();
    const intent = state.byWorkId(workId);
    if (!intent || intent.state === "ready")
      throw new Error("No active execution to hold");
    const holdReason = `Known unfinished execution: ${reason}`;
    this.supervisor?.noteSurvivor(workId);
    if (
      intent.state === "reconciled" &&
      this.coordination?.recoveryDispositionForWork(workId) ===
        "operator-reconciled"
    ) {
      state.holdReconciledContinuationSurvivor(workId, holdReason);
    }
    this.retractWriterAndSuccessors(intent, holdReason);
  }

  private retractWriterAndSuccessors(
    writer: ExecutionIntent,
    reason: string,
  ): void {
    const state = this.requireState();
    for (const item of state.writerAndSuccessors(writer.workId))
      if (
        item.state === "completed" ||
        item.state === "submitting" ||
        item.state === "running"
      )
        state.holdTerminalConflict(item.id, reason);
  }

  registerExecutionCallback(workId: string, callback: Promise<unknown>): void {
    const state = this.requireState().byWorkId(workId)?.state;
    if (
      state === "completed" ||
      (state === "reconciled" &&
        this.coordination?.recoveryDispositionForWork(workId) ===
          "operator-reconciled")
    )
      this.holdKnownSurvivor(workId, "late Ensemble callback");
    const set = this.callbacks.get(workId) ?? new Set<Promise<unknown>>();
    set.add(callback);
    this.callbacks.set(workId, set);
    void callback
      .finally(() => {
        set.delete(callback);
        if (set.size === 0) this.callbacks.delete(workId);
      })
      .catch(() => {});
  }

  private handleUserInputRequest(call: RuntimeUserInputRequest): void {
    const state = this.requireState();
    const runtime = this.requireRuntime();
    const coordination = this.coordination;
    if (!coordination) return;
    try {
      if (
        runtime.currentUserInputGeneration?.() !==
        call.identity.runtimeGeneration
      )
        throw new Error("Native process generation mismatch");
      let binding = state.runtimeQuestionBinding(
        call.identity.threadId,
        call.identity.turnId,
      );
      if (!binding) {
        const snapshot = state.nativeTurnPrebinding(
          call.identity.threadId,
          call.identity.turnId,
          call.identity.runtimeGeneration,
        );
        if (!snapshot || !state.prebindNativeTurn(snapshot))
          throw new Error("Native callback has no exact admitted binding");
        this.requireSupervisor().turnBound(
          snapshot.workId,
          call.identity.threadId,
          call.identity.turnId,
        );
        binding = state.runtimeQuestionBinding(
          call.identity.threadId,
          call.identity.turnId,
        );
      }
      if (!binding) throw new Error("Native callback binding unavailable");
      const recovery = state.recoveryIdentity(binding.workId);
      const currentProcess = runtime.processIdentity?.();
      if (
        !recovery?.processIdentity ||
        !currentProcess ||
        currentProcess instanceof Promise ||
        JSON.stringify(currentProcess) !==
          JSON.stringify(recovery.processIdentity)
      )
        throw new Error("Native admitted process identity mismatch");
      const question = coordination.recordRuntimeQuestion(call);
      const key = nativeEndpointKey(call.identity);
      if (this.nativeWaiters.has(key)) return;
      let resolve!: () => void;
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      this.nativeWaiters.set(key, {
        workId: binding.workId,
        interactionId: question.interactionId,
        resolve,
      });
      this.registerExecutionCallback(binding.workId, pending);
    } catch {
      const execution = state
        .list()
        .find(
          (intent) =>
            intent.threadId === call.identity.threadId &&
            (intent.turnId === call.identity.turnId || intent.turnId === null),
        );
      if (execution) {
        state.hold(execution.id, "Native callback could not be durably bound");
        this.supervisor?.noteAnomaly(execution.workId);
      }
      runtime.cancelUserInput?.(
        call.identity,
        "Native callback binding failed",
      );
    }
  }
  private handleUserInputOutcome(outcome: RuntimeUserInputOutcome): void {
    const waiter = this.nativeWaiters.get(nativeEndpointKey(outcome));
    const coordination = this.coordination;
    if (!coordination) return;
    try {
      const record = coordination.recordRuntimeReplyOutcome(outcome);
      if (record.deliveryState === "confirmed" && waiter) {
        this.nativeWaiters.delete(nativeEndpointKey(outcome));
        waiter.resolve();
      } else if (
        outcome.outcome === "uncertain" ||
        outcome.outcome === "unavailable"
      ) {
        const execution = this.state?.byWorkId(record.requestingWorkId);
        if (execution) {
          this.state?.hold(
            execution.id,
            "Native input delivery unavailable or uncertain",
          );
          this.supervisor?.noteAnomaly(execution.workId);
        }
      }
    } catch {
      const record = coordination
        .runtimeQuestions()
        .find(
          (q) => nativeEndpointKey(q.identity) === nativeEndpointKey(outcome),
        );
      const workId = waiter?.workId ?? record?.requestingWorkId;
      const execution = workId ? this.state?.byWorkId(workId) : undefined;
      if (execution) {
        this.retractWriterAndSuccessors(
          execution,
          "Native receipt could not be durably committed",
        );
        this.supervisor?.noteAnomaly(execution.workId);
      }
    }
  }
  private runtimeAnswerEligibility(question: RuntimeQuestionRecord): string[] {
    const state = this.requireState(),
      runtime = this.requireRuntime(),
      domain = this.domain();
    const reasons: string[] = [
      ...domain.admission(question.taskId, false).reasons,
    ];
    const binding = state.runtimeQuestionBinding(
      question.identity.threadId,
      question.identity.turnId,
    );
    const recovery = state.recoveryIdentity(question.requestingWorkId);
    const intent = state.byWorkId(question.requestingWorkId);
    if (
      !binding ||
      binding.workId !== question.requestingWorkId ||
      binding.assignmentId !== question.requestingAssignmentId ||
      intent?.state !== "running"
    )
      reasons.push("requesting-generation-not-running");
    if (
      runtime.currentUserInputGeneration?.() !==
      question.identity.runtimeGeneration
    )
      reasons.push("native-process-generation-changed");
    const process = runtime.processIdentity?.();
    if (
      !process ||
      process instanceof Promise ||
      JSON.stringify(process) !== JSON.stringify(recovery?.processIdentity)
    )
      reasons.push("native-process-identity-changed");
    if (binding) {
      reasons.push(...domain.assignmentAdmission(binding.assignmentId).reasons);
      const assignment = domain.assignment(binding.assignmentId);
      if (
        Number(assignment.version) !== binding.assignmentVersion ||
        Number(assignment.instructionsRevision) !==
          binding.instructionsRevision ||
        Number(assignment.profileRevision) !== binding.profileRevision
      )
        reasons.push("native-immutable-revision-changed");
    }
    const hold = state.taskHold(question.taskId);
    if (hold) reasons.push(hold);
    if (state.stopTarget(question.requestingWorkId))
      reasons.push("task-stopped");
    if (state.powerAdmissionState().held) reasons.push("power-held");
    if (this.supervisor?.hasKnownRisk(question.requestingWorkId))
      reasons.push("known-execution-risk");
    if (
      state
        .list()
        .some(
          (other) =>
            other.workId !== question.requestingWorkId &&
            ["submitting", "running", "held"].includes(other.state) &&
            state.taskBinding(other.workId)?.taskId === question.taskId,
        )
    )
      reasons.push("competing-task-generation");
    if (!this.nativeWaiters.has(nativeEndpointKey(question.identity)))
      reasons.push("native-endpoint-unavailable");
    return reasons;
  }
  private flushRuntimeAnswers(): void {
    const coordination = this.coordination;
    if (!coordination || !this.runtime?.replyUserInput) return;
    for (const question of coordination.runtimeQuestions()) {
      if (
        !question.answers ||
        question.replyIntentId ||
        question.requestState !== "available"
      )
        continue;
      const reasons = this.runtimeAnswerEligibility(question);
      if (reasons.length) {
        coordination.holdRuntimeAnswer(
          question.interactionId,
          reasons.join("; "),
        );
        continue;
      }
      void this.runtime
        .replyUserInput(
          question.identity,
          encodeNativeInputReply(question.request, question.answers),
          () => {
            const reasons = this.runtimeAnswerEligibility(question);
            if (reasons.length) {
              coordination.holdRuntimeAnswer(
                question.interactionId,
                reasons.join("; "),
              );
              throw new Error("Native reply held");
            }
            return coordination.beginRuntimeReply(
              question.interactionId,
              question.identity,
            );
          },
        )
        .catch(() => {
          const current = this.coordination
            ?.runtimeQuestions(question.taskId)
            .find((q) => q.interactionId === question.interactionId);
          if (current?.replyIntentId) {
            this.runtime?.cancelUserInput?.(
              question.identity,
              "Native reply failed",
            );
          }
        });
    }
  }

  private handleToolCall(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    const coordination = this.coordination;
    const state = this.state;
    if (!coordination || !state || !isCoordinationTool(call.tool))
      return Promise.resolve({
        text: "Coordination tool is unavailable for this execution",
        success: false,
      });
    let receipt: CoordinationReceipt | undefined;
    try {
      receipt = coordination.receipt(call as CoordinationCall);
    } catch (error) {
      return Promise.resolve({
        text: String(error).slice(0, 1000),
        success: false,
      });
    }
    if (receipt) return Promise.resolve(receipt.response);

    let binding: CoordinationExecutionBinding | undefined;
    try {
      binding = state.coordinationBinding(call.threadId, call.turnId);
    } catch (error) {
      return Promise.resolve({
        text: String(error).slice(0, 1000),
        success: false,
      });
    }
    if (!binding)
      return Promise.resolve({
        text: "Coordination call is not bound to current task work",
        success: false,
      });

    let capturedDeliveryCaller: DeliveryCaller | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        if (call.tool === "ensemble_external_action") {
          const caller = coordination.deliveryCaller(call as CoordinationCall);
          capturedDeliveryCaller = caller;
          const result = await this.requireDeliveryCoordinator().submit(
            call.arguments,
            caller,
          );
          if (
            result.state === "confirmed-success" &&
            result.request.action.kind.startsWith("pr.")
          )
            await this.requireDeliveryCoordinator().refresh();
          if (
            result.state === "confirmed-success" &&
            (result.request.action.kind === "pr.merge" ||
              result.request.action.kind === "issue.close")
          )
            await this.refreshGitHub();
          const response = coordination.recordAsyncReceipt(
            call as CoordinationCall,
            caller,
            {
              text: `External action ${result.operationId}: ${result.state}${result.observation?.reason ? ` (${result.observation.reason})` : ""}${result.observation?.receipt ? `; confirmed provider receipt ${JSON.stringify(result.observation.receipt)}` : ""}`,
              success: result.state === "confirmed-success",
            },
          );
          await this.wakeScheduler();
          return response;
        }
        if (call.tool === "ensemble_register_pr") {
          const caller = coordination.deliveryCaller(call as CoordinationCall);
          capturedDeliveryCaller = caller;
          const result = await this.requireDeliveryCoordinator().registerPr(
            call.arguments,
            caller,
          );
          return coordination.recordAsyncReceipt(
            call as CoordinationCall,
            caller,
            {
              text: `PR delivery retained ${result.observation.nodeId} at ${result.observation.headSha}`,
              success: true,
            },
          );
        }
        const response = dispatchCoordinationTool(
          coordination,
          call as CoordinationCall,
          () => !state.taskHold(binding.taskId),
        );
        if (response.success) await this.wakeScheduler();
        return response;
      })
      .catch((error: unknown) => {
        const deliveryCall =
          call.tool === "ensemble_external_action" ||
          call.tool === "ensemble_register_pr";
        const response = {
          text: deliveryCall
            ? "Delivery request rejected or held"
            : String(error).slice(0, 1000),
          success: false,
        };
        if (deliveryCall && capturedDeliveryCaller)
          return coordination.recordAsyncReceipt(
            call as CoordinationCall,
            capturedDeliveryCaller,
            response,
          );
        return response;
      });
    this.registerExecutionCallback(binding.workId, pending);
    return pending;
  }

  async submitTask(
    workId: string,
    assignmentId: string,
    prompt: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const domain = this.domain();
    const assignment = domain.assignment(assignmentId);
    const taskId = String(assignment.taskId);
    const task = domain.task(taskId);
    this.requireSchedulerStore().ensure({
      requestKey: `task:${workId}`,
      workId,
      kind: "assignment",
      taskId,
      projectId: String(assignment.projectId),
      assignmentId,
      taskVersion: Number(task.version),
      assignmentVersion: Number(assignment.version),
      instructionsRevision: Number(assignment.instructionsRevision),
      profileRevision: Number(assignment.profileRevision),
      prompt,
      workspace: null,
      previousWorkId: previousWorkId ?? null,
    });
    return this.dispatchAndRead(workId);
  }

  /** One explicit dispatch; same work ID never submits twice, including after errors. */
  async submit(
    workId: string,
    prompt: string,
    workspace: string,
    previousWorkId?: string,
  ): Promise<ExecutionIntent> {
    const workspaceKey = this.validateDirectWorkspace(workspace);
    if (previousWorkId) {
      const previous = this.requireState().byWorkId(previousWorkId);
      if (
        previous?.state !== "completed" ||
        !previous.threadId ||
        previous.workspace !== workspaceKey
      )
        throw new Error(
          "Previous work is not a completed binding in this workspace",
        );
    }
    this.requireSchedulerStore().ensure({
      requestKey: `direct:${workId}`,
      workId,
      kind: "direct",
      taskId: null,
      projectId: null,
      assignmentId: null,
      taskVersion: null,
      assignmentVersion: null,
      instructionsRevision: null,
      profileRevision: null,
      prompt,
      workspace: workspaceKey,
      previousWorkId: previousWorkId ?? null,
    });
    this.requireState().create(workId, prompt, workspaceKey, previousWorkId);
    return this.dispatchAndRead(workId);
  }

  private async dispatchAndRead(workId: string): Promise<ExecutionIntent> {
    await this.wakeScheduler();
    const active = this.activeByWorkId.get(workId);
    if (active) return active;
    const intent = this.requireState().byWorkId(workId);
    if (intent) return intent;
    throw new Error("Turn request is queued until its task workspace is ready");
  }

  private routingStaleReason(
    domain: DomainStore,
    state: ExecutionState,
    snapshot: RoutingSnapshot,
  ): RoutingStaleReason | undefined {
    if (state.taskHold(snapshot.taskId)) return "task-held";
    const task = domain.task(snapshot.taskId);
    if (Number(task.version) !== snapshot.taskVersion)
      return "task-revision-changed";
    const routing = domain.routing(snapshot.projectId);
    if (
      Number(routing.version) !== snapshot.guidanceRevision ||
      Number(routing.enabled) !== 1
    )
      return "routing-revision-changed";
    const candidates = domain.routingCandidates(snapshot.projectId);
    const capturedIds = snapshot.candidates
      .map((candidate) => candidate.profileId)
      .sort();
    const currentIds = candidates
      .map((candidate) => String(candidate.profileId))
      .sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(capturedIds))
      return "candidate-set-changed";
    if (
      candidates.some((candidate) => {
        const captured = snapshot.candidates.find(
          (item) => item.profileId === candidate.profileId,
        );
        return Number(candidate.profileRevision) !== captured?.profileRevision;
      })
    )
      return "candidate-profile-changed";
    if (!domain.admission(snapshot.taskId).eligible) return "admission-held";
    if (domain.assignments(snapshot.taskId).length > 0)
      return "assignment-already-exists";
    return undefined;
  }

  private async wakeScheduler(refusalRebindPass = 0): Promise<void> {
    const scheduler = this.scheduler;
    const store = this.schedulerStore;
    const domain = this.domainState;
    const state = this.state;
    const coordination = this.coordination;
    const routingAttempts = this.routingAttempts;
    if (
      !scheduler ||
      !store ||
      !domain ||
      !state ||
      !coordination ||
      !routingAttempts
    )
      return;
    this.flushRuntimeAnswers();
    const deliveryWorkCompleted = (delivery: InboxDelivery): boolean => {
      const intent = state.byWorkId(delivery.deliveryWorkId);
      const binding = state.taskBinding(delivery.deliveryWorkId);
      return Boolean(
        intent?.state === "completed" &&
          binding?.workId === delivery.deliveryWorkId &&
          binding.taskId === delivery.taskId &&
          binding.assignmentId === delivery.recipientAssignmentId &&
          binding.assignmentVersion === delivery.assignmentVersion,
      );
    };
    for (const delivery of coordination.queuedDeliveries())
      if (deliveryWorkCompleted(delivery))
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);

    const withdrawStaleRefusedDeliveries = (): number => {
      let withdrawn = 0;
      for (const delivery of coordination.queuedDeliveries())
        if (coordination.withdrawStaleRefusedDelivery(delivery.deliveryWorkId))
          withdrawn++;
      return withdrawn;
    };
    withdrawStaleRefusedDeliveries();

    for (const completion of coordination.completionRequests()) {
      if (completion.status !== "pending") continue;
      const intent = state.byWorkId(completion.leadWorkId);
      const binding = state.taskBinding(completion.leadWorkId);
      if (
        intent?.state !== "completed" ||
        !binding ||
        binding.taskId !== completion.taskId ||
        binding.assignmentId !== completion.leadAssignmentId
      )
        continue;
      await this.finalizeDeliveryCompletion(
        completion.requestId,
        completion.leadWorkId,
      );
    }
    for (const workId of coordination.completedWorkNeedingDisposition())
      coordination.recordSuccessfulTerminal(workId);

    for (const operation of domain.routingOperations()) {
      const disposition = String(operation.disposition);
      if (!disposition.startsWith("lead-review:")) continue;
      const taskId = String(operation.taskId);
      const leadAssignment = domain.ensureLeadAssignment(taskId);
      if (!leadAssignment) continue;
      coordination.ensureRoutingFallbackEvent({
        routingOperationId: String(operation.id),
        taskId,
        recipientAssignmentId: String(leadAssignment.id),
        brief: String(operation.brief),
        reason: disposition.slice("lead-review:".length),
        evidence: String(operation.judgment ?? ""),
      });
    }

    const committedRoutingIds = new Set(
      domain.routingOperations().map((operation) => String(operation.id)),
    );
    for (const operation of routingAttempts.operations()) {
      if (
        operation.status === "stale" ||
        committedRoutingIds.has(operation.operationId)
      )
        continue;
      const staleReason = this.routingStaleReason(
        domain,
        state,
        operation.snapshot,
      );
      if (staleReason)
        routingAttempts.markStale(operation.operationId, staleReason);
    }

    for (const task of domain.readyTasksWithLead()) {
      const taskId = String(task.id);
      const taskAssignments = domain.assignments(taskId);
      if (taskAssignments.length > 0) continue;
      const route = domain.routing(String(task.projectId));
      if (Number(route.enabled) !== 1) {
        domain.ensureLeadAssignment(taskId);
        continue;
      }
      if (!domain.admission(taskId).eligible || state.taskHold(taskId))
        continue;
      const leadBinding = domain.ensureLeadBinding(taskId);
      if (!leadBinding) continue;

      const projectId = String(task.projectId);
      const currentTask = domain.task(taskId);
      const candidates = domain
        .routingCandidates(projectId)
        .map((candidate) => ({
          profileId: String(candidate.profileId),
          name: String(candidate.name),
          capabilities: String(candidate.capabilities),
          profileRevision: Number(candidate.profileRevision),
        }));
      const snapshot: RoutingSnapshot = {
        projectId,
        taskId,
        taskVersion: Number(currentTask.version),
        guidanceRevision: Number(route.version),
        brief: String(currentTask.outcome),
        findings: "",
        guidance: String(route.guidance),
        candidates,
      };
      const existingAttempt = routingAttempts.operation(
        projectId,
        taskId,
        snapshot.taskVersion,
      );
      if (existingAttempt?.status === "stale") continue;
      if (
        existingAttempt &&
        JSON.stringify(existingAttempt.snapshot) !== JSON.stringify(snapshot)
      ) {
        routingAttempts.markStale(
          existingAttempt.operationId,
          this.routingStaleReason(domain, state, existingAttempt.snapshot) ??
            "domain-disposition-rejected",
        );
        continue;
      }
      const attempt =
        existingAttempt ?? routingAttempts.ensureOperation(snapshot);
      if (attempt.status === "stale") continue;

      let outcome: RoutingOutcome;
      if (candidates.length === 0) {
        outcome = routingAttempts.completeFallback(attempt.operationId, {
          kind: "lead-review",
          reason: "no-candidates",
          requestedModel: routingModel,
        });
      } else if (!snapshot.brief.trim()) {
        outcome = routingAttempts.completeFallback(attempt.operationId, {
          kind: "lead-review",
          reason: "missing-context",
          requestedModel: routingModel,
        });
      } else {
        const credentialReference =
          domain.routingCredentialReference(projectId);
        const client =
          this.options.routingClient === undefined
            ? routingClientFromEnvironment(credentialReference)
            : (this.options.routingClient ?? undefined);
        if (!route.credentialAvailable || !client) {
          outcome = routingAttempts.completeFallback(attempt.operationId, {
            kind: "lead-review",
            reason: "missing-credentials",
            requestedModel: routingModel,
          });
        } else {
          const cacheKey =
            this.options.routingClient === undefined
              ? (credentialReference ?? "missing-credential-reference")
              : "injected-routing-client";
          let coordinator = this.routingCoordinators.get(cacheKey);
          if (!coordinator) {
            coordinator = new RoutingCoordinator(routingAttempts, client);
            this.routingCoordinators.set(cacheKey, coordinator);
          }
          try {
            outcome = await coordinator.route(snapshot);
          } catch (error) {
            if (error instanceof RoutingOperationStaleError) continue;
            throw error;
          }
        }
      }

      const staleReason = this.routingStaleReason(domain, state, snapshot);
      if (staleReason) {
        routingAttempts.markStale(attempt.operationId, staleReason);
        continue;
      }
      const disposition =
        outcome.kind === "assigned"
          ? "assigned"
          : `lead-review:${outcome.reason}`;
      let recorded: ReturnType<DomainStore["recordRouting"]>;
      try {
        recorded = domain.recordRouting(
          {
            id: attempt.operationId,
            projectId,
            taskId,
            taskVersion: snapshot.taskVersion,
            assignmentId:
              outcome.kind === "assigned" ? attempt.operationId : null,
            candidateRevisions: Object.fromEntries(
              candidates.map((candidate) => [
                candidate.profileId,
                candidate.profileRevision,
              ]),
            ),
            guidanceRevision: snapshot.guidanceRevision,
            model: outcome.requestedModel,
            question:
              "Choose the best eligible initial assignee, or return for lead review.",
            judgment: JSON.stringify(outcome),
            disposition,
            resultDestination: "lead:task",
            brief: snapshot.brief,
            ...(outcome.kind === "assigned"
              ? {
                  assignment: {
                    profileId: outcome.profileId,
                    brief: snapshot.brief,
                    requesterAssignmentId: null,
                  },
                }
              : {}),
          },
          () => !state.taskHold(taskId),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const staleReason =
          this.routingStaleReason(domain, state, snapshot) ??
          (message === "External admission rejected routing disposition"
            ? "task-held"
            : /stale|held|candidate|revision|already assigned/i.test(message)
              ? "domain-disposition-rejected"
              : undefined);
        if (!staleReason) throw error;
        routingAttempts.markStale(attempt.operationId, staleReason);
        continue;
      }
      if (outcome.kind === "lead-review") {
        const leadAssignment = domain.ensureLeadAssignment(taskId);
        if (!leadAssignment)
          throw new Error("Routing fallback requires a configured task lead");
        coordination.ensureRoutingFallbackEvent({
          routingOperationId: String(recorded.id),
          taskId,
          recipientAssignmentId: String(leadAssignment.id),
          brief: snapshot.brief,
          reason: outcome.reason,
          evidence: JSON.stringify(outcome),
        });
      }
    }
    for (const assignment of domain.pendingAssignments()) {
      const taskId = String(assignment.taskId);
      const task = domain.task(taskId);
      if (Number(task.ready) !== 1 || task.state !== "open") continue;
      const assignmentId = String(assignment.id);
      const initialWorkId = `assignment:${assignmentId}:initial`;
      if (store.list().some((item) => item.workId === initialWorkId)) continue;
      const queued = coordination
        .queuedDeliveries()
        .find((item) => item.recipientAssignmentId === assignmentId);
      let delivery: InboxDelivery | undefined = queued;
      if (!delivery && coordination.pendingEvents(assignmentId).length > 0)
        delivery = coordination.bindDeliveryBatch(
          assignmentId,
          initialWorkId,
          Number(assignment.version),
        );
      const requestWorkId = delivery?.deliveryWorkId ?? initialWorkId;
      try {
        store.createAssignment(
          {
            taskId,
            projectId: String(assignment.projectId),
            assignmentId,
            taskVersion: Number(task.version),
            assignmentVersion: Number(assignment.version),
            instructionsRevision: Number(assignment.instructionsRevision),
            profileRevision: Number(assignment.profileRevision),
            prompt: this.assignmentPrompt(String(assignment.brief), delivery),
            previousWorkId: delivery
              ? (state.latestCompletedAssignmentWork(assignmentId) ?? null)
              : null,
          },
          delivery
            ? { requestKey: requestWorkId, workId: requestWorkId }
            : undefined,
        );
      } catch (error) {
        const existing = store
          .list()
          .find((item) => item.assignmentId === assignment.id);
        if (existing)
          store.hold(
            existing.workId,
            `Assignment request became obsolete: ${String(error)}`,
          );
      }
    }

    const requests = store.list();
    for (const delivery of coordination.queuedDeliveries()) {
      if (deliveryWorkCompleted(delivery)) {
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);
        continue;
      }
      if (requests.some((item) => item.workId === delivery.deliveryWorkId))
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(delivery.recipientAssignmentId);
      } catch {
        continue;
      }
      const task = domain.task(delivery.taskId);
      if (
        Number(assignment.version) !== delivery.assignmentVersion ||
        (assignment.state !== "pending" && assignment.state !== "running") ||
        (Number(task.ready) !== 1 &&
          !domain.hasOwnDeliveryClosure(String(task.id))) ||
        task.state !== "open"
      )
        continue;
      const workId = delivery.deliveryWorkId;
      store.createAssignment(
        {
          taskId: delivery.taskId,
          projectId: String(assignment.projectId),
          assignmentId: delivery.recipientAssignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: delivery.assignmentVersion,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: this.assignmentPrompt(String(assignment.brief), delivery),
          previousWorkId:
            state.latestCompletedAssignmentWork(
              delivery.recipientAssignmentId,
            ) ?? null,
        },
        { requestKey: workId, workId },
      );
    }

    for (const recipientAssignmentId of coordination.pendingEventRecipients()) {
      if (
        coordination
          .queuedDeliveries()
          .some((item) => item.recipientAssignmentId === recipientAssignmentId)
      )
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(recipientAssignmentId);
      } catch {
        const pendingLeadResult = coordination
          .pendingEvents(recipientAssignmentId)
          .find((event) => {
            if (event.eventType !== "assignment-result" || !event.resultId)
              return false;
            const leadBinding = domain
              .leadBindings()
              .find(
                (binding) =>
                  binding.taskId === event.taskId &&
                  binding.assignmentId === recipientAssignmentId,
              );
            if (!leadBinding) return false;
            return coordination
              .results(event.taskId)
              .some(
                (result) =>
                  result.resultId === event.resultId &&
                  result.recipientAssignmentId === recipientAssignmentId &&
                  result.destinationDisposition === "delivered",
              );
          });
        if (!pendingLeadResult) continue;
        const leadAssignment = domain.ensureLeadAssignment(
          pendingLeadResult.taskId,
        );
        if (
          !leadAssignment ||
          String(leadAssignment.id) !== recipientAssignmentId
        )
          continue;
        assignment = leadAssignment;
      }
      const task = domain.task(String(assignment.taskId));
      if (
        (assignment.state !== "pending" && assignment.state !== "running") ||
        (Number(task.ready) !== 1 &&
          !domain.hasOwnDeliveryClosure(String(task.id))) ||
        task.state !== "open" ||
        state.taskHold(String(assignment.taskId)) !== undefined ||
        state.assignmentHasUnfinishedExecution(recipientAssignmentId) ||
        store
          .list()
          .some(
            (item) =>
              item.assignmentId === recipientAssignmentId &&
              (item.state === "queued" ||
                item.state === "active" ||
                item.state === "held") &&
              !coordination.isHistoricalWorkResolved(item.workId),
          )
      )
        continue;
      const pending = coordination.pendingEvents(recipientAssignmentId);
      const first = pending[0];
      if (!first) continue;
      const version = Number(assignment.version);
      const workId = `assignment:${recipientAssignmentId}:v${version}:inbox:${first.eventId}`;
      const delivery = coordination.bindDeliveryBatch(
        recipientAssignmentId,
        workId,
        version,
      );
      if (!delivery) continue;
      store.createAssignment(
        {
          taskId: delivery.taskId,
          projectId: String(assignment.projectId),
          assignmentId: recipientAssignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: version,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt: this.assignmentPrompt(
            String(assignment.brief),
            delivery,
            state.isNeverAdmittedRefusedAssignmentWork(
              `assignment:${recipientAssignmentId}:initial`,
            )
              ? {
                  version: Number(task.version),
                  title: String(task.title),
                  outcome: String(task.outcome),
                }
              : undefined,
          ),
          previousWorkId:
            state.latestCompletedAssignmentWork(recipientAssignmentId) ?? null,
        },
        { requestKey: workId, workId },
      );
    }

    for (const repair of coordination.reportingRepairs()) {
      if (repair.state !== "queued") continue;
      if (store.list().some((item) => item.workId === repair.repairWorkId))
        continue;
      let assignment: ReturnType<DomainStore["assignment"]>;
      try {
        assignment = domain.assignment(repair.assignmentId);
      } catch {
        continue;
      }
      const task = domain.task(repair.taskId);
      if (
        Number(assignment.version) !== repair.assignmentVersion ||
        assignment.state === "held" ||
        (Number(task.ready) !== 1 &&
          !domain.hasOwnDeliveryClosure(String(task.id))) ||
        task.state !== "open"
      )
        continue;
      const prompt = `${String(assignment.brief)}\n\nReporting repair: the previous successful turn ended without a saved result or durable waiting action. Continue this assignment and record a result or request a durable next action before ending.`;
      store.createAssignment(
        {
          taskId: repair.taskId,
          projectId: String(assignment.projectId),
          assignmentId: repair.assignmentId,
          taskVersion: Number(task.version),
          assignmentVersion: repair.assignmentVersion,
          instructionsRevision: Number(assignment.instructionsRevision),
          profileRevision: Number(assignment.profileRevision),
          prompt,
          previousWorkId:
            state.latestCompletedAssignmentWork(repair.assignmentId) ??
            repair.missedWorkId,
        },
        { requestKey: repair.repairWorkId, workId: repair.repairWorkId },
      );
    }
    await scheduler.wake();
    if (refusalRebindPass === 0 && withdrawStaleRefusedDeliveries() > 0)
      await this.wakeScheduler(1);
  }

  private assignmentPrompt(
    brief: string,
    delivery?: InboxDelivery,
    currentTask?: { version: number; title: string; outcome: string },
  ): string {
    if (!delivery) return brief;
    const events = delivery.events.map(
      (event) => `- ${event.eventType}: ${event.payload}`,
    );
    const context = currentTask
      ? `Current task (revision ${currentTask.version}): ${currentTask.title}\nCurrent outcome: ${currentTask.outcome}\n\nPreserved assignment brief:\n`
      : "";
    return `${context}${brief}\n\nDurable assignment inbox through event ${delivery.highWaterSequence}:\n${events.join("\n")}`;
  }

  private executionPrompt(request: TurnRequest): string {
    if (
      request.kind !== "assignment" ||
      request.taskId === null ||
      request.projectId === null ||
      request.assignmentId === null
    )
      return request.prompt;

    const state = this.requireState();
    const domain = this.domain();
    const binding = state.taskBinding(request.workId);
    if (
      !binding ||
      binding.taskId !== request.taskId ||
      binding.assignmentId !== request.assignmentId
    )
      throw new Error(
        "Assignment prompt is missing its exact execution binding",
      );
    const assignment = domain.assignment(binding.assignmentId);
    const projectId = String(assignment.projectId);
    if (
      String(assignment.taskId) !== binding.taskId ||
      projectId !== request.projectId
    )
      throw new Error("Assignment prompt binding no longer matches its task");

    const leadBinding = domain
      .leadBindings()
      .find(
        (item) =>
          item.taskId === binding.taskId &&
          item.projectId === projectId &&
          item.assignmentId === binding.assignmentId,
      );
    const profileInstructions = String(
      domain.profileRevision(
        String(assignment.profileId),
        binding.profileRevision,
      ).instructions,
    );
    const projectInstructions = domain.instructionRevision(
      projectId,
      binding.instructionsRevision,
    );
    const roleContext = leadBinding
      ? "Assignment role: project lead. You are accountable for coordinating this task, reviewing its results, and deciding whether to request completion."
      : "Assignment role: project assignee. The project lead remains accountable for coordinating this task and reviewing its results before completion. Report your result and durable next action through Ensemble.";
    return [
      request.prompt,
      roleContext,
      `Captured project instructions (revision ${binding.instructionsRevision}):\n${projectInstructions || "(none)"}`,
      `Captured profile instructions (revision ${binding.profileRevision}):\n${profileInstructions || "(none)"}`,
    ].join("\n\n");
  }

  private async attemptRequest(request: TurnRequest): Promise<void> {
    const state = this.requireState();
    const store = this.requireSchedulerStore();
    let workspaceKey: string;
    let context: TaskExecutionContext | undefined;
    let validateAssignment: (() => string[]) | undefined;
    try {
      if (request.taskId && request.assignmentId && request.projectId) {
        const binding = await this.requireWorkspaces().forExecution(
          request.taskId,
        );
        workspaceKey = realpathSync(binding.path);
        if (
          request.taskVersion === null ||
          request.assignmentVersion === null ||
          request.instructionsRevision === null ||
          request.profileRevision === null
        )
          throw new Error("Task request is missing captured revisions");
        context = {
          taskId: request.taskId,
          assignmentId: request.assignmentId,
          assignmentVersion: request.assignmentVersion,
          instructionsRevision: request.instructionsRevision,
          profileRevision: request.profileRevision,
        };
        const {
          assignmentId,
          taskVersion,
          assignmentVersion,
          instructionsRevision,
          profileRevision,
        } = request;
        if (
          assignmentId === null ||
          taskVersion === null ||
          assignmentVersion === null ||
          instructionsRevision === null ||
          profileRevision === null
        )
          throw new Error("Task request is missing captured revisions");
        validateAssignment = () => {
          const domain = this.domain();
          const reasons = domain.assignmentAdmission(assignmentId, {
            taskVersion,
            assignmentVersion,
            instructionsRevision,
            profileRevision,
          }).reasons;
          if (
            this.requireSchedulerStore()
              .list()
              .some(
                (older) =>
                  older.assignmentId === assignmentId &&
                  older.workId !== request.workId &&
                  older.state === "held" &&
                  this.coordination?.recoveryDispositionForWork(
                    older.workId,
                  ) === "operator-reconciled" &&
                  !this.coordination.hasRecoveryContinuation(older.workId),
              )
          )
            reasons.push("recovery-continuation-unresolved");
          if (domain.importedTask(binding.taskId)) {
            const task = domain.task(binding.taskId);
            const linked = domain.githubConfiguration(
              String(task.projectId),
            ).repositories;
            if (
              binding.repositories.some(
                (repository) =>
                  !linked.some(
                    (link) =>
                      link.repositoryId === repository.repositoryId &&
                      link.path === repository.sourcePath &&
                      link.ref === repository.ref &&
                      link.gitCommonDirectory === repository.gitCommonDir,
                  ),
              )
            )
              reasons.push("repository-access-revoked");
          }
          return reasons;
        };
      } else if (request.workspace) {
        workspaceKey = this.validateDirectWorkspace(request.workspace);
      } else throw new Error("Turn request has no workspace or task binding");
      if (!isAbsolute(workspaceKey) || !lstatSync(workspaceKey).isDirectory())
        throw new Error("Workspace must be an existing real directory");
      store.setWorkspace(request.workId, workspaceKey);
    } catch (error) {
      const reason = `Workspace admission waiting: ${String(error)}`;
      store.wait(request.workId, reason);
      const queuedIntent = state.byWorkId(request.workId);
      if (queuedIntent?.state === "ready") state.wait(queuedIntent.id, reason);
      return;
    }
    let previous: ExecutionIntent | undefined;
    let priorBinding: TaskExecutionBinding | undefined;
    let waitsForPredecessor = false;
    if (request.previousWorkId) {
      previous = state.byWorkId(request.previousWorkId);
      priorBinding = state.taskBinding(request.previousWorkId);
      waitsForPredecessor = Boolean(
        context &&
          previous &&
          previous.state !== "completed" &&
          previous.workspace === workspaceKey &&
          priorBinding?.taskId === context.taskId &&
          priorBinding.assignmentId === context.assignmentId,
      );
      if (
        !previous ||
        (!waitsForPredecessor &&
          (previous.state !== "completed" ||
            !previous.threadId ||
            previous.workspace !== workspaceKey ||
            (context &&
              (priorBinding?.taskId !== context.taskId ||
                priorBinding.assignmentId !== context.assignmentId))))
      ) {
        store.hold(
          request.workId,
          "Previous work is not a completed binding in this workspace",
        );
        const queuedIntent = state.byWorkId(request.workId);
        if (queuedIntent)
          state.hold(
            queuedIntent.id,
            "Previous work is not a completed binding in this workspace",
          );
        return;
      }
    }
    let intent: ExecutionIntent;
    let binding: TaskExecutionBinding | undefined;
    try {
      intent = state.create(
        request.workId,
        request.prompt,
        workspaceKey,
        request.previousWorkId ?? undefined,
      );
      binding = context ? state.bindTask(request.workId, context) : undefined;
    } catch (error) {
      store.hold(request.workId, `Request binding refused: ${String(error)}`);
      return;
    }
    if (intent.state !== "ready" && intent.state !== "capacity-waiting") return;
    if (waitsForPredecessor) {
      state.wait(intent.id, "Waiting for the prior turn to complete");
      return;
    }
    if (
      binding &&
      priorBinding?.conversationRevision !== binding.conversationRevision
    )
      previous = undefined;
    try {
      const runtime = this.requireRuntime();
      const processIdentity = await Promise.resolve(
        runtime.processIdentity?.() ?? null,
      ).catch(() => null);
      const admitted = state.begin(intent.id, {
        projectId: request.projectId,
        requestSequence: store.sequence(request.workId),
        processIdentity,
        ...(validateAssignment
          ? {
              validate: validateAssignment,
              refuse: (reasons) =>
                reasons.some((reason) =>
                  immutableRevisionMismatches.has(reason),
                ),
            }
          : {}),
      });
      if (!admitted) {
        const current = state.get(intent.id);
        if (current.state === "ready") {
          state.wait(intent.id, current.reason ?? "Waiting for admission");
          store.wait(request.workId, current.reason ?? "Waiting for admission");
        }
        return;
      }
    } catch (error) {
      state.hold(
        intent.id,
        `Storage failure before submission: ${String(error)}`,
      );
      return;
    }
    this.startExecution(request, intent, workspaceKey, previous);
  }

  private startExecution(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
  ): void {
    const power = this.power;
    const action = (async () => {
      try {
        await power?.executionStarted(request.workId);
        return await this.executeAdmitted(request, intent, workspace, previous);
      } finally {
        await power?.executionEnded(request.workId).catch(() => {});
      }
    })();
    this.active.add(action);
    this.activeByWorkId.set(request.workId, action);
    void action
      .finally(() => {
        this.active.delete(action);
        this.activeByWorkId.delete(request.workId);
        void this.wakeScheduler().catch(() => {});
      })
      .catch(() => {});
  }

  private async executeAdmitted(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
  ): Promise<ExecutionIntent> {
    const state = this.requireState();
    const runtime = this.requireRuntime();
    let submissionStage: "resume" | "thread" | "bound" | "turn" = "thread";
    let captureThreadId: string | undefined;
    let conversationCapture: ConversationHistoryCapture | undefined;
    try {
      let threadId: string;
      const tools =
        request.kind === "assignment" && request.assignmentId
          ? coordinationTools
          : undefined;
      if (previous?.threadId) {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        submissionStage = "resume";
        await runtime.resumeThread(previous.threadId, tools);
        threadId = previous.threadId;
      } else {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        threadId = await runtime.startThread(workspace, tools);
      }
      submissionStage = "bound";
      const threadBound = state.bindThread(intent.id, threadId);
      this.requireSupervisor().threadBound(request.workId, threadId);
      if (!threadBound) throw new Error("Thread binding was held or changed");
      captureThreadId = threadId;
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      conversationCapture = this.beginConversationCapture(
        request,
        workspace,
        threadId,
      );
      submissionStage = "turn";
      const turnId = await runtime.startTurn(
        threadId,
        workspace,
        this.executionPrompt(request),
      );
      let turnBound = state.bindTurn(intent.id, turnId);
      let nativeRejected = false;
      if (!turnBound) {
        const reconciliation = state.reconcileNativeTurnStartResponse({
          intentId: intent.id,
          workId: request.workId,
          threadId,
          turnId,
          runtimeGeneration: runtime.currentUserInputGeneration?.(),
        });
        turnBound = reconciliation === "matched";
        if (reconciliation === "rejected") {
          nativeRejected = true;
          state.hold(
            intent.id,
            "Native turn start response disagrees with admitted prebinding",
          );
          for (const question of this.coordination?.runtimeQuestions() ?? [])
            if (question.requestingWorkId === request.workId)
              runtime.cancelUserInput?.(
                question.identity,
                "Native prebinding rejected",
              );
        }
      }
      if (!nativeRejected)
        this.requireSupervisor().turnBound(request.workId, threadId, turnId);
      if (!turnBound) {
        conversationCapture?.discard();
        if (conversationCapture)
          this.removeConversationCapture(threadId, conversationCapture);
        throw new Error("Turn binding was held or changed");
      }
      const exactBinding = this.safeConversationHistoryBinding(
        state,
        request.workId,
        threadId,
        turnId,
      );
      if (exactBinding) conversationCapture?.bind(exactBinding);
      else conversationCapture?.discard();
      const outcome = await runtime.waitForTurn(threadId, turnId);
      conversationCapture?.finish();
      if (conversationCapture)
        this.removeConversationCapture(threadId, conversationCapture);
      this.requireSupervisor().terminalObserved(
        request.workId,
        threadId,
        turnId,
        outcome,
      );
      if (
        outcome === "completed" &&
        (this.callbacks.get(request.workId)?.size ?? 0) > 0
      )
        state.hold(
          intent.id,
          "Ensemble callback is unfinished at terminal status",
        );
      else if (outcome === "completed") {
        state.complete(intent.id, threadId, turnId);
        this.lastCompletedWorkId = request.workId;
        const coordination = this.coordination;
        const binding = state.taskBinding(request.workId);
        if (coordination) {
          const delivery = coordination.deliveryForWork(request.workId);
          if (delivery?.state === "queued")
            coordination.completeDeliveryBatch(request.workId);
          if (binding) {
            for (const completion of coordination.completionRequests(
              binding.taskId,
            ))
              if (
                completion.leadWorkId === request.workId &&
                completion.status === "pending"
              )
                await this.finalizeDeliveryCompletion(
                  completion.requestId,
                  request.workId,
                );
            coordination.recordSuccessfulTerminal(request.workId);
          }
        }
      } else {
        state.hold(intent.id, "Bound turn failed or was interrupted");
        const evidence = parseFailureEvidence(
          runtime.failureEvidence?.(threadId, turnId),
        );
        const identity = state.recoveryIdentity(request.workId);
        const callbacksEnded =
          (this.callbacks.get(request.workId)?.size ?? 0) === 0;
        const backoffMs = evidence?.retryAfterMs ?? this.fallbackBackoffMs;
        const now = this.retryNow();
        const nextEligibleAt = now + backoffMs;
        if (
          evidence?.status === "failed" &&
          evidence.threadId === threadId &&
          evidence.turnId === turnId &&
          evidence.classification === "transient" &&
          (evidence.reasonCode === "serverOverloaded" ||
            evidence.reasonCode === "rateLimitExceeded") &&
          evidence.source === "codexErrorInfo" &&
          evidence.codexRetries !== null &&
          callbacksEnded &&
          !this.requireSupervisor().hasKnownRisk(request.workId) &&
          !state.stopTarget(request.workId) &&
          identity?.threadId === threadId &&
          identity.turnId === turnId &&
          Number.isSafeInteger(now) &&
          now >= 0 &&
          Number.isSafeInteger(nextEligibleAt) &&
          nextEligibleAt >= now
        ) {
          state.resolveFailedGeneration({
            workId: request.workId,
            workRevision: identity.workRevision,
            requestSequence: identity.requestSequence,
            threadId,
            turnId,
            terminalStatus: "failed",
            classification: "transient",
            reasonCode: evidence.reasonCode,
            source: "codexErrorInfo",
            codexRetries: evidence.codexRetries,
            callbacksEnded: true,
            noSurvivor: true,
            effects: "settled",
            nextEligibleAt,
          });
        }
      }
    } catch (error) {
      if (
        submissionStage === "resume" &&
        error instanceof ArchivedResumeRejectedError &&
        previous?.threadId === error.rejection.threadId &&
        state.get(intent.id).state === "submitting"
      )
        state.capturePreTurnRejection(request.workId, error.rejection);
      if (state.get(intent.id).state !== "held")
        state.hold(
          intent.id,
          `Runtime submission or observation uncertain: ${String(error)}`,
        );
    } finally {
      if (conversationCapture) {
        conversationCapture.discard();
        if (captureThreadId)
          this.removeConversationCapture(captureThreadId, conversationCapture);
      }
    }
    return state.get(intent.id);
  }

  private beginConversationCapture(
    request: TurnRequest,
    workspace: string,
    threadId: string,
  ): ConversationHistoryCapture | undefined {
    try {
      const history = this.conversationHistory;
      const state = this.state;
      if (!history || !state || !request.taskId) return undefined;
      const binding = state.taskBinding(request.workId);
      if (!binding || binding.taskId !== request.taskId) return undefined;
      const capture = new ConversationHistoryCapture({
        store: history,
        workId: request.workId,
        threadId,
        captureStartExclusions: this.conversationExclusions(
          binding,
          workspace,
          true,
        ),
        currentExclusions: () =>
          this.conversationExclusions(binding, workspace, false),
      });
      const previous = this.conversationCaptures.get(threadId);
      previous?.discard();
      this.conversationCaptures.set(threadId, capture);
      return capture;
    } catch {
      return undefined;
    }
  }

  private safeConversationHistoryBinding(
    state: ExecutionState,
    workId: string,
    threadId: string,
    turnId: string,
  ) {
    try {
      return state.conversationHistoryBinding(workId, threadId, turnId);
    } catch {
      return undefined;
    }
  }

  private receiveConversationEvent(event: RuntimeConversationEvent): void {
    this.conversationCaptures.get(event.threadId)?.receive(event);
  }

  private removeConversationCapture(
    threadId: string,
    capture: ConversationHistoryCapture,
  ): void {
    if (this.conversationCaptures.get(threadId) === capture)
      this.conversationCaptures.delete(threadId);
  }

  private clearConversationCaptures(): void {
    for (const capture of this.conversationCaptures.values()) capture.discard();
    this.conversationCaptures.clear();
  }

  private conversationExclusions(
    binding: TaskExecutionBinding,
    workspace: string,
    captureStart: boolean,
  ): readonly string[] | undefined {
    return this.conversationExclusionsForAssignment(
      binding.taskId,
      binding.assignmentId,
      captureStart
        ? {
            profileRevision: binding.profileRevision,
            instructionsRevision: binding.instructionsRevision,
          }
        : undefined,
      [workspace],
    );
  }

  private readConversationHistory(
    taskId: string,
    assignmentId: string,
  ): ConversationHistoryAssignmentRead {
    const history = this.conversationHistory;
    if (!history) throw new Error("Service is not started");
    return history.readAssignment(
      taskId,
      assignmentId,
      200,
      this.conversationExclusionsForAssignment(taskId, assignmentId),
    );
  }

  private conversationExclusionsForAssignment(
    taskId: string,
    assignmentId: string,
    revisions?: { profileRevision: number; instructionsRevision: number },
    additionalPaths: readonly string[] = [],
  ): readonly string[] | undefined {
    const domain = this.domainState;
    if (!domain) return undefined;
    try {
      const assignment = domain.assignment(assignmentId);
      if (String(assignment.taskId) !== taskId) return undefined;
      const projectId = String(assignment.projectId);
      const profileId = String(assignment.profileId);
      const profileInstructions = revisions
        ? domain.profileRevision(profileId, revisions.profileRevision)
            .instructions
        : domain.profile(profileId).instructions;
      const project = domain.project(projectId);
      const projectInstructions = domain.instructionRevision(
        projectId,
        revisions?.instructionsRevision ?? Number(project.instructionsRevision),
      );
      const reference = domain.routingCredentialReference(projectId);
      const credential = reference?.startsWith("env:")
        ? process.env[reference.slice("env:".length)]
        : undefined;
      const fixtureValues =
        this.options.conversationHistoryExclusions?.() ?? [];
      const workspace = this.workspaceBindings?.get(taskId);
      const managedPaths = workspace
        ? [
            workspace.path,
            ...workspace.repositories.flatMap((repository) => [
              repository.sourcePath,
              repository.workspacePath,
              ...(repository.gitCommonDir ? [repository.gitCommonDir] : []),
            ]),
          ]
        : [];
      const canonicalDataDir = existsSync(this.dataDir)
        ? realpathSync(this.dataDir)
        : this.dataDir;
      const values = [
        String(profileInstructions ?? ""),
        projectInstructions,
        this.dataDir,
        canonicalDataDir,
        ...managedPaths,
        ...additionalPaths,
        ...(reference ? [reference] : []),
        ...(credential ? [credential] : []),
        ...fixtureValues,
        ...domain.projects().flatMap((p) => {
          const ref = this.deliveryStore?.configuration(
            String(p.id),
          ).credentialRef;
          return ref
            ? [ref, ref.slice(4), process.env[ref.slice(4)] ?? ""]
            : [];
        }),
      ];
      return values.filter((value) => value.length > 0);
    } catch {
      return undefined;
    }
  }

  private validateDirectWorkspace(workspace: string): string {
    if (
      !isAbsolute(workspace) ||
      !existsSync(workspace) ||
      !lstatSync(workspace).isDirectory()
    )
      throw new Error("Workspace must be an existing real directory");
    const workspaceKey = realpathSync(workspace);
    const managedRoot = join(realpathSync(this.dataDir), "workspaces");
    if (
      workspaceKey === managedRoot ||
      workspaceKey.startsWith(`${managedRoot}${sep}`)
    )
      throw new Error("Task workspaces require a durable assignment binding");
    return workspaceKey;
  }

  private requireSchedulerStore(): SchedulerStore {
    if (!this.schedulerStore) throw new Error("Service is not started");
    return this.schedulerStore;
  }

  private requireSupervisor(): ExecutionSupervisor {
    if (!this.supervisor) throw new Error("Service is not started");
    return this.supervisor;
  }

  private requireState(): ExecutionState {
    if (!this.state) throw new Error("Service is not started");
    return this.state;
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw new Error("Runtime unavailable");
    return this.runtime;
  }

  private requireWorkspaces(): WorkspaceManager {
    if (!this.workspaces) throw new Error("Service is not started");
    return this.workspaces;
  }
}
