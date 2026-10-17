import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  credentialFreeEnvironment,
  setChildCredentialExclusions,
} from "../core/child-environment.js";
import {
  CommandResultValidationError,
  parseDomainCommandOutcome,
} from "../core/command-results.js";
import {
  type CoordinationCall,
  type CoordinationReceipt,
  CoordinationStore,
  type CoordinationToolResponse,
  type InboxDelivery,
  type RuntimeQuestionRecord,
} from "../core/coordination.js";
import { CachedDatabase } from "../core/database-cache.js";
import {
  canonicalMaterial,
  type DeliveryActionRecord,
  type DeliveryCaller,
  type DeliveryPolicy,
  DeliveryStore,
  isOperatorDeliveryCaller,
  materialDigest,
  type OperatorCommentReview,
  type OperatorDeliveryCaller,
  type RuntimeDeliveryCaller,
} from "../core/delivery.js";
import {
  type CapacityConfigureCommand,
  type CapacityLimits,
  DomainConflictError,
  DomainPolicyError,
  DomainStaleDispositionError,
  DomainStore,
} from "../core/domain.js";
import {
  type SupportedRuntimeSettings,
  supportedRuntimeSettingsSchema,
} from "../core/execution-runtime.js";
import { GitHubSourceStore } from "../core/github-source.js";
import { Store } from "../core/store.js";
import { reviewMetadataSchema } from "../core/task-review.js";
import type {
  HarnessStatus,
  RuntimeRestartFailure,
} from "../operator/contracts.js";
import { ClaudeRuntime, releaseClaudeTemporaryBase } from "./claude.js";
import {
  claudeTokenExclusions,
  claudeTokenSource,
  readClaudeToken,
} from "./claude-token.js";
import {
  CodexRuntime,
  parseFailureEvidence,
  type Runtime,
  type RuntimeConversationEvent,
  type RuntimeDiagnosticEvent,
  RuntimeNotEnabledError,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type RuntimeTurnSettings,
} from "./codex.js";
import { SqliteWorkspaceComparisonStore } from "./comparison-store.js";
import type { ConversationHistoryAssignmentRead } from "./conversation-history.js";
import {
  ConversationHistoryCapture,
  ConversationHistoryStore,
} from "./conversation-history.js";
import {
  coordinationTools,
  dispatchCoordinationTool,
  isCoordinationTool,
} from "./coordination-tools.js";
import { CoordinationView } from "./coordination-view.js";
import {
  STANDALONE_MARKER_CONTENTS,
  StandaloneDataDirectory,
} from "./data-directory.js";
import { DeliveryCoordinator } from "./delivery.js";
import {
  type DiagnosticKind,
  type DiagnosticLimits,
  ExecutionDiagnosticsCapture,
  ExecutionDiagnosticsStore,
} from "./execution-diagnostics.js";
import {
  defaultExecutionHarness,
  type ExecutionHarness,
  executionHarnessLabels,
  executionHarnessSchema,
} from "./execution-harness.js";
import {
  claudePolicyDisclosure,
  codexPolicyDisclosure,
  type PolicyDisclosure,
} from "./execution-policy.js";
import type { GhLoginScope } from "./gh-credential.js";
import {
  credentialReferenceExclusions,
  ghEnvironment,
  ghToken,
} from "./gh-credential.js";
import type { GitHubDeliveryProvider } from "./github-delivery.js";
import {
  CredentialGitHubSourceReader,
  gitHubSourceCredentialStatus,
} from "./github-source-credential.js";
import { type GitHubReaderFactory, GitHubSynchronizer } from "./github-sync.js";
import { resolveOnPath } from "./executable-path.js";
import { InboxStartupReconciliation } from "./inbox-startup.js";
import {
  encodeNativeInputReply,
  nativeEndpointKey,
  type RuntimeUserInputOutcome,
  type RuntimeUserInputRequest,
} from "./native-input.js";
import { OperatorApi } from "./operator-api.js";
import {
  managedAssignmentEnvironment,
  OperatorCredentialStore,
} from "./operator-credentials.js";
import { OperatorPushStore } from "./operator-push.js";
import {
  CaffeinateAssertion,
  ExecutionPower,
  MacPowerEventSource,
  type PowerEventSource,
} from "./power.js";
import {
  ArchivedResumeRejectedError,
  type HistoricalNoTurnAdoption,
  type HistoricalPreTurnAdoption,
  type NoTurnRecoveryCommand,
  noTurnRecoveryCommandSchema,
  type PreTurnRecoveryCommand,
  preTurnRecoveryCommandSchema,
  type ReplaceConversationCommand,
} from "./pre-turn-recovery.js";
import type {
  RecoveryReceipt,
  RecoveryRecord,
  TerminationVerifier,
} from "./recovery-types.js";
import {
  captureRetainedResultEvidence,
  captureRetainedReviewAnchor,
  failedRetainedResultEvidenceCandidate,
  type RetainedReviewAnchorStageRequest,
  retainedReviewAnchorMaterialHash,
  retainedReviewAnchorStageRequestSchema,
} from "./retained-evidence.js";
import { verifiedRepository } from "./repository-verification.js";
import {
  RoutingAttemptStore,
  type RoutingChoiceClient,
  RoutingCoordinator,
  RoutingOperationStaleError,
  type RoutingOutcome,
  type RoutingSnapshot,
  type RoutingStaleReason,
  routingClientFromEnvironment,
  routingModel,
} from "./routing.js";
import type { RuntimeSafetyPort } from "./runtime-retention.js";
import {
  SchedulerStore,
  type TurnRequest,
  TurnScheduler,
} from "./scheduler.js";
import { SchedulerWakeQueries } from "./scheduler-wake-queries.js";
import {
  type CoordinationExecutionBinding,
  type ExecutionIntent,
  ExecutionState,
  harnessRetrySupported,
  type StopTarget,
  type TaskControlReceipt,
  type TaskExecutionBinding,
  type TaskExecutionBindingRecord,
  type TaskExecutionContext,
} from "./state.js";
import {
  defaultRestartClock,
  newRestartState,
  type RestartState,
  type RuntimeRestartOptions,
  runtimeRestartDelaysMs,
  runtimeRestartStableMs,
} from "./runtime-restart.js";
import {
  ExecutionSupervisor,
  type ExecutionSupervisorOptions,
  type StopObservation,
  type SupervisorClock,
} from "./supervisor.js";
import { MacProcessTerminationVerifier } from "./termination.js";
import {
  compareWorkspaceTurnObservations,
  observeWorkspaceTurn,
  type WorkspaceComparisonExport,
  type WorkspaceComparisonSideContent,
  type WorkspaceComparisonSnapshot,
  type WorkspaceTurnCaptureReason,
  type WorkspaceTurnCaptureRecord,
  type WorkspaceTurnObservation,
} from "./workspace-comparison.js";
import {
  isWithin,
  type WorkspaceInspectionCurrent,
} from "./workspace-inspection.js";
import {
  SqliteWorkspaceBindingStore,
  type TaskWorkspaceBinding,
  type TaskWorkspaceRepositoryInput,
  type WorkspaceCleanupEvidence,
  WorkspaceManager,
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

/** The Claude turn's base environment and token, or why no turn may start. */
export type ClaudeTurnEnvironment =
  | { env: NodeJS.ProcessEnv; token: string }
  | {
      unavailable: string;
      /** Machine-readable cause for status reads; the reason text is unchanged. */
      code?: "not-configured" | "empty" | "restart-required";
    };

export interface RuntimeSpawnContext {
  spawnEnvironment: () => NodeJS.ProcessEnv;
  safety: RuntimeSafetyPort;
  claude?: {
    configDirectory: string;
    turnEnvironment: () => ClaudeTurnEnvironment;
  };
}
export function createRuntime(
  context: RuntimeSpawnContext,
  harness: ExecutionHarness,
): Runtime {
  const parsed = executionHarnessSchema.safeParse(harness);
  if (!parsed.success)
    throw new Error(`Unsupported execution harness: ${String(harness)}`);
  // Exhaustive: a new harness fails to compile until it is constructed here.
  switch (parsed.data) {
    case "codex":
      return new CodexRuntime("codex", context);
    case "claude":
      if (!context.claude)
        throw new Error("Claude runtime context unavailable");
      return new ClaudeRuntime({
        safety: context.safety,
        claude: context.claude,
      });
  }
}

/** Real harness runtimes are power-supervised; injected fakes stay unsupervised unless asked. */
export function powerSupervisionEnabled(
  power: StandaloneServiceOptions["power"],
  runtime: Pick<Runtime, "harness">,
): boolean {
  return (
    power?.enabled ??
    (power?.eventSource !== undefined || runtime.harness !== undefined)
  );
}

/** A synchronous throw from stop() becomes a rejection like any other. */
const stopRuntime = (runtime: Runtime) =>
  new Promise<void>((resolve) => resolve(runtime.stop()));

const runtimeFailedError = (): never => {
  throw new Error("Runtime failed");
};

/** Runtime-issued identities are only unique within one harness. */
const runtimeKey = (harness: ExecutionHarness, identity: string) =>
  JSON.stringify([harness, identity]);

interface PromptPart {
  name:
    | "request"
    | "role"
    | "review-references"
    | "project-instructions"
    | "profile-instructions";
  text: string;
  revision?: number;
}

const serviceItem = (
  name: string,
  severity: string,
  payload: Record<string, unknown>,
) => ({
  turnId: undefined,
  kind: "service" as DiagnosticKind,
  name,
  severity,
  itemId: undefined,
  payload,
});

/** Both lists or none: either missing fails closed to redaction-unavailable. */
const unionExclusions = (
  start: readonly string[] | undefined,
  current: readonly string[] | undefined,
) => (start && current ? [...new Set([...start, ...current])] : undefined);

/** The exact submitted prompt; captured segments cannot drift from it. */
const joinPromptParts = (parts: readonly PromptPart[]) =>
  parts.map((part) => part.text).join("\n\n");

/** Why `configureRuntime` refused before saving anything (ADR-1012). */
export class RuntimeConfigurationRefusedError extends Error {
  constructor(
    readonly code:
      | "runtime-executable-missing"
      | "runtime-confirmation-required"
      | "unavailable",
    readonly harness: ExecutionHarness,
    readonly boundTasks = 0,
  ) {
    super(code);
  }
}

export interface StandaloneServiceOptions {
  /** Harnesses this service can run; the operator's setting decides which it starts. */
  runtimeHarnesses?: readonly ExecutionHarness[];
  /** A live or secondary start cannot block healthy work; defaults to 10 seconds. */
  secondaryRuntimeStartTimeoutMs?: number;
  /** Clocks for the automatic restart schedule; tests inject fakes. */
  runtimeRestart?: RuntimeRestartOptions;
  /**
   * Whether the harness's executable (`codex`, `claude`) is on the service `PATH`. Defaults to a
   * `PATH` lookup for real runtimes and to true for injected factories.
   */
  resolveExecutable?: (harness: ExecutionHarness) => Promise<boolean>;
  delivery?: {
    fetcher?: typeof fetch;
    providerFactory?: (
      projectId: string,
      policy: DeliveryPolicy,
    ) => GitHubDeliveryProvider;
  };
  github?: { readerFactory?: GitHubReaderFactory; intervalMs?: number };
  routingClient?: RoutingChoiceClient | null;
  /** The `gh` executable for a `gh:github.com` discovery reference; defaults to `gh`. */
  ghExecutable?: string;
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
  /** Execution diagnostic retention; `cli.ts` passes the environment limits. */
  diagnostics?: {
    limits?: Partial<DiagnosticLimits>;
    pruneIntervalMs?: number;
    now?: () => number;
  };
  /** Controlled fixtures may replace the bounded, redacted service diagnostic sink. */
  backgroundDiagnosticSink?: (
    diagnostic: BackgroundFailureDiagnostic,
  ) => void | Promise<void>;
}

export type BackgroundFailureOperation =
  | "github-poll"
  | "power-poll"
  | "domain-wake"
  | "post-turn-wake"
  | "scheduler-drain"
  | "safe-shutdown";

export type BackgroundFailureCode =
  | "unexpected-background-failure"
  | "shutdown-failed"
  | "diagnostic-writer-failed";

export interface BackgroundFailureDiagnostic {
  serviceId: string;
  incident: number;
  operation: BackgroundFailureOperation;
  errorCode: BackgroundFailureCode;
}

interface ServiceGeneration {
  id: string;
  accepting: boolean;
  fatal: boolean;
  shutdownFailureReported: boolean;
  incident: number;
  failureNotification: Promise<BackgroundFailureDiagnostic>;
  resolveFailure: (diagnostic: BackgroundFailureDiagnostic) => void;
  shutdown?: Promise<void>;
  diagnosticQueue: Promise<void>;
}

/** Every component operations use; published whole once start-up can admit work. */
interface Started {
  state: ExecutionState;
  domain: DomainStore;
  githubSources: GitHubSourceStore;
  githubSynchronizer: GitHubSynchronizer;
  coordination: CoordinationStore;
  deliveryStore: DeliveryStore;
  deliveryCoordinator: DeliveryCoordinator;
  routingAttempts: RoutingAttemptStore;
  workspaces: WorkspaceManager;
  workspaceBindings: SqliteWorkspaceBindingStore;
  workspaceComparisons: SqliteWorkspaceComparisonStore;
  operatorCredentials: OperatorCredentialStore;
  operatorPush: OperatorPushStore;
  schedulerStore: SchedulerStore;
  wakeQueries: SchedulerWakeQueries;
  inboxStartup: InboxStartupReconciliation;
  supervisor: ExecutionSupervisor;
  scheduler: TurnScheduler;
  /** Absent when power supervision is disabled. */
  power: ExecutionPower | undefined;
  conversationHistory: ConversationHistoryStore;
  /** Absent when the store failed to open; executions then run uncaptured. */
  diagnostics: ExecutionDiagnosticsStore | undefined;
  /** Status reads use it without spawning anything. */
  claude: RuntimeSpawnContext["claude"];
}

function harnessForWork(
  state: ExecutionState,
  workId: string,
): ExecutionHarness {
  return state.taskBinding(workId)?.harness ?? defaultExecutionHarness;
}

function retractWriterAndSuccessors(
  state: ExecutionState,
  writer: ExecutionIntent,
  reason: string,
): void {
  for (const item of state.writerAndSuccessors(writer.workId))
    if (
      item.state === "completed" ||
      item.state === "submitting" ||
      item.state === "running"
    )
      state.holdTerminalConflict(item.id, reason);
}

/** Includes lifetime gh values even after every source/discovery reference has been cleared. */
function gitHubCredentialExclusions(domain: DomainStore) {
  const references = [
    domain.discoveryCredentialReference(),
    ...domain
      .projects()
      .map(
        (project) =>
          domain.githubConfiguration(String(project.id)).credentialRef,
      ),
    ...domain.pendingCredentialReferences(),
  ];
  const excluded = references.map((ref) => credentialReferenceExclusions(ref));
  return {
    names: [...new Set(excluded.flatMap((value) => value.names))],
    values: [...new Set(excluded.flatMap((value) => value.values))],
    redactions: [...new Set(excluded.flatMap((value) => value.redactions))],
  };
}

const backgroundDiagnosticTimeoutMs = 50;
const backgroundDiagnosticFallback =
  '{"errorCode":"diagnostic-writer-failed"}\n';

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
  /** Statement-caching facade over `db` for this generation; `db` stays the lifecycle handle. */
  private cache: CachedDatabase | undefined;
  /** The only operational view; see started(). */
  private current: Started | undefined;
  /** What start() has created so far; teardown releases from it, published or not. */
  private acquired: Partial<Started> | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly runtimes = new Map<ExecutionHarness, Runtime>();
  private readonly runtimeUnavailableSince = new Map<
    ExecutionHarness,
    number
  >();
  /** Automatic restart schedule per harness; in memory, so a service restart begins afresh. */
  private readonly runtimeRestarts = new Map<ExecutionHarness, RestartState>();
  private readonly runtimeHarnesses: readonly ExecutionHarness[];
  /** Harnesses whose runtime said at start that it cannot run here; see RuntimeNotEnabledError. */
  private readonly runtimeNotEnabled = new Set<ExecutionHarness>();
  /** A replacement runtime is starting: no work is admitted to it until its start succeeds. */
  private readonly runtimeStarting = new Set<ExecutionHarness>();
  /** Settles when a non-default runtime reports failure; see untilFailure. */
  private readonly runtimeFailed = new WeakMap<Runtime, Promise<void>>();
  /** A failed secondary runtime's cleanup; shutdown awaits and reports it. */
  private readonly detachedRuntimeStops = new Set<Promise<void>>();
  /** Creates and attaches a runtime with this generation's spawn context; set by start(). */
  private spawnRuntime: ((harness: ExecutionHarness) => Runtime) | undefined;
  /** Serialises enable/disable per harness; shutdown awaits them. */
  private readonly runtimeToggles = new Map<ExecutionHarness, Promise<void>>();
  /** Keyed like conversation captures; finished ones stay to count late events. */
  private readonly diagnosticCaptures = new Map<
    string,
    ExecutionDiagnosticsCapture
  >();
  private readonly conversationCaptures = new Map<
    string,
    ConversationHistoryCapture
  >();
  /** Per harness, so an unidentified anomaly can only retract its own work. */
  private readonly lastCompletedWorkId = new Map<ExecutionHarness, string>();
  private canonicalDataDir: string | undefined;
  private readonly active = new Set<Promise<ExecutionIntent>>();
  private readonly activeByWorkId = new Map<string, Promise<ExecutionIntent>>();
  private readonly nativeWaiters = new Map<
    string,
    { workId: string; interactionId: string; resolve: () => void }
  >();
  private readonly callbacks = new Map<string, Set<Promise<unknown>>>();
  private readonly routingCoordinators = new Map<string, RoutingCoordinator>();
  private readonly retryNow: () => number;
  private readonly restartClock: SupervisorClock;
  private readonly wallNow: () => number;
  private readonly fallbackBackoffMs: number;
  private readonly maxFallbackBackoffMs: number;
  private generation: ServiceGeneration | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly backgroundRuns = new Set<Promise<void>>();
  private readonly generationsByNotification = new WeakMap<
    Promise<BackgroundFailureDiagnostic>,
    ServiceGeneration
  >();

  constructor(
    private readonly dataDir: string,
    private readonly runtimeFactory: (
      context: RuntimeSpawnContext,
      harness: ExecutionHarness,
    ) => Runtime = createRuntime,
    private readonly markerWriter: (path: string, flag: "wx" | "w") => void = (
      path,
      flag,
    ) => writeFileSync(path, STANDALONE_MARKER_CONTENTS, { flag, mode: 0o600 }),
    private readonly options: StandaloneServiceOptions = {},
  ) {
    this.retryNow = options.retry?.now ?? Date.now;
    this.restartClock = options.runtimeRestart?.clock ?? defaultRestartClock;
    this.wallNow = options.runtimeRestart?.wallNow ?? Date.now;
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
    const harnesses = z
      .array(executionHarnessSchema)
      .parse(options.runtimeHarnesses ?? [defaultExecutionHarness]);
    if (new Set(harnesses).size !== harnesses.length)
      throw new Error("Runtime harnesses must be listed once each");
    this.runtimeHarnesses = harnesses;
    const startupTimeout = options.secondaryRuntimeStartTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(startupTimeout) ||
      startupTimeout <= 0 ||
      startupTimeout > 30_000
    )
      throw new Error(
        "Secondary runtime startup timeout must be between 1 and 30000 ms",
      );
  }

  async start(): Promise<void> {
    if (this.db || this.owner)
      throw new Error("Service already started or shutdown is incomplete");
    this.lastCompletedWorkId.clear();
    this.canonicalDataDir = undefined;
    const dataDirectory = StandaloneDataDirectory.openExclusive(this.dataDir, {
      markerWriter: this.markerWriter,
    });
    this.owner = dataDirectory;
    const generation = this.createGeneration();
    this.generation = generation;
    this.stopPromise = undefined;
    const { databasePath: database, workspacePath } = dataDirectory;
    // Re-created if stop() releases it mid-start, so the catch path still sees later parts.
    const acquire = <K extends keyof Started>(key: K, value: Started[K]) => {
      this.acquired ??= {};
      this.acquired[key] = value;
      return value;
    };
    try {
      const rawDb = new DatabaseSync(database);
      this.db = rawDb;
      // Created before the pragmas so every close path goes through the facade.
      const db = new CachedDatabase(rawDb, {
        close: () => {
          if (rawDb.isOpen) rawDb.close();
        },
      });
      this.cache = db;
      rawDb.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
      new Store(db).ensureHost("standalone-codex");
      const workspaceComparisons = new SqliteWorkspaceComparisonStore(db);
      const operatorCredentials = new OperatorCredentialStore(db);
      const operatorPush = new OperatorPushStore(db);
      const conversationHistory = new ConversationHistoryStore(db);
      let diagnostics: ExecutionDiagnosticsStore | undefined;
      try {
        const store = new ExecutionDiagnosticsStore(db, {
          ...(this.options.diagnostics?.limits
            ? { limits: this.options.diagnostics.limits }
            : {}),
          ...(this.options.diagnostics?.now
            ? { now: this.options.diagnostics.now }
            : {}),
        });
        store.reconcile();
        store.closeOpen();
        diagnostics = store;
      } catch {
        // Diagnostics are additive; without the store executions run uncaptured.
      }
      const domain = new DomainStore(
        db,
        () =>
          this.observeBackgroundFailure(generation, "domain-wake", () =>
            this.wakeScheduler(0, generation),
          ),
        verifiedRepository,
      );
      domain.migrate();
      const githubSources = new GitHubSourceStore(db);
      githubSources.migrate();
      githubSources.invalidateProviderObservations();
      const githubSynchronizer = acquire(
        "githubSynchronizer",
        new GitHubSynchronizer(domain, githubSources, (reference) =>
          this.sourceReader(() => domain, reference),
        ),
      );
      const routingAttempts = new RoutingAttemptStore(db);
      routingAttempts.migrate();
      const schedulerStore = new SchedulerStore(db);
      const workspaceBindings = new SqliteWorkspaceBindingStore(db);
      const workspaces = acquire(
        "workspaces",
        new WorkspaceManager(
          workspaceBindings,
          workspacePath,
          this.options.workspaceManager,
        ),
      );
      await workspaces.recover();
      workspaces.assertNotCancelled();
      const state = new ExecutionState(db);
      let afterWorkspaceRowId = 0;
      for (;;) {
        const page = state.workspaceNormalizationPage(afterWorkspaceRowId);
        if (page.length === 0) break;
        for (const item of page) {
          afterWorkspaceRowId = item.cursor;
          const bindingRootMismatch =
            item.workspacePath !== null &&
            item.workspaceId !== null &&
            item.workspacePath !== join(workspacePath, item.workspaceId);
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
      }
      state.holdUnfinishedOnOpen();
      acquire("state", state);
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
      // After every table the wake queries read has migrated.
      const wakeQueries = new SchedulerWakeQueries(db);
      wakeQueries.ensureIndexes();
      coordination.localReviews().purgeEditableDrafts();
      const inboxStartup = new InboxStartupReconciliation(db, domain);
      coordination.invalidateRuntimeQuestions(
        "Service restarted; native endpoints cannot be reconstructed",
      );
      acquire("coordination", coordination);
      // A runtime never reads or extends another harness's retained evidence.
      const own = <T extends { harness: ExecutionHarness } | null>(
        harness: ExecutionHarness,
        evidence: T,
      ): T => {
        if (evidence && evidence.harness !== harness)
          throw new Error("Runtime evidence belongs to another harness");
        return evidence;
      };
      // Checked before any write, so a foreign identity leaves no side effect.
      const ownIdentity = (harness: ExecutionHarness, threadId: string) => {
        if (
          state
            .runtimeIdentityHarnesses(threadId)
            .some((bound) => bound !== harness)
        )
          throw new Error("Runtime evidence belongs to another harness");
      };
      const runtimeSafety = (harness: ExecutionHarness): RuntimeSafetyPort => ({
        recordTerminal: (input) => {
          ownIdentity(harness, input.threadId);
          return state.recordRuntimeTerminal(input, harness);
        },
        terminal: (threadId, turnId, runtimeGeneration) =>
          own(
            harness,
            state.runtimeTerminal(threadId, turnId, runtimeGeneration),
          ),
        terminalForWait: (threadId, turnId, runtimeGeneration) =>
          own(
            harness,
            state.runtimeTerminalForWait(threadId, turnId, runtimeGeneration),
          ),
        registerThreadTools: (threadId, toolDigest) => {
          ownIdentity(harness, threadId);
          state.registerRuntimeThreadTools(threadId, toolDigest, harness);
        },
        threadQualification: (threadId) =>
          own(harness, state.runtimeThreadQualification(threadId)),
        recordThreadQualification: (input) => {
          ownIdentity(harness, input.threadId);
          own(harness, state.runtimeThreadQualification(input.threadId));
          state.recordRuntimeThreadQualification(input);
        },
        nativeEndpointHistory: (identity) =>
          coordination.runtimeNativeEndpointHistory(identity),
        recordTurnProcess: ({ threadId, processIdentity }) => {
          ownIdentity(harness, threadId);
          return state.recordTurnProcess(threadId, processIdentity);
        },
      });
      const deliveryStore = new DeliveryStore(db);
      deliveryStore.migrate();
      // Read by activationAllowed and the Claude turn environment; set by spawnEnvironment.
      let runtimeSpawnSnapshot: NodeJS.ProcessEnv | undefined;
      const deliveryCoordinator = new DeliveryCoordinator(deliveryStore, {
        ...(this.options.delivery?.fetcher
          ? { fetcher: this.options.delivery.fetcher }
          : {}),
        ...(this.options.delivery?.providerFactory
          ? { providerFactory: this.options.delivery.providerFactory }
          : {}),
        authorize: (caller, exceptOperationId, request) => {
          this.authorizeDelivery(
            { deliveryStore, state, domain, coordination },
            caller,
            exceptOperationId,
          );
          if (isOperatorDeliveryCaller(caller)) {
            if (request && request.action.kind !== "issue.comment")
              throw new DomainPolicyError(
                "forbidden",
                "Operator delivery only permits issue.comment",
              );
            return;
          }
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
          isOperatorDeliveryCaller(caller)
            ? deliveryStore.operatorApprovalCurrent(request, caller)
            : Boolean(
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
          (!runtimeSpawnSnapshot?.[policy.credentialRef.slice(4)] &&
            !Object.values(runtimeSpawnSnapshot ?? {}).includes(
              process.env[policy.credentialRef.slice(4)] ?? "",
            )),
      });
      acquire("deliveryCoordinator", deliveryCoordinator);
      const deliveryCredentialNames = () =>
        domain.projects().flatMap((p) => {
          const ref = deliveryStore.configuration(String(p.id)).credentialRef;
          return ref ? [ref.slice(4)] : [];
        });
      const claudeTokenExcluded = () => {
        const ref = domain.claudeTokenReference();
        return ref ? claudeTokenExclusions(ref) : { names: [], values: [] };
      };
      // Resolve a gh login once so its token value is excluded from the spawn snapshot too;
      // a failure does not block start.
      const startupGhReferences = [
        domain.discoveryCredentialReference(),
        ...domain
          .projects()
          .map((p) => domain.githubConfiguration(String(p.id)).credentialRef),
      ];
      if (startupGhReferences.includes("gh:github.com"))
        await ghToken({
          executable: this.options.ghExecutable,
          environment: ghEnvironment(domain, { reference: "gh:github.com" }),
        });
      const githubExcluded = () => gitHubCredentialExclusions(domain);
      // Helper children exclude configured delivery, Claude and GitHub credentials.
      setChildCredentialExclusions(() => {
        const claude = claudeTokenExcluded(),
          github = githubExcluded();
        return {
          names: [
            ...deliveryCredentialNames(),
            ...claude.names,
            ...github.names,
          ],
          values: [...claude.values, ...github.values],
        };
      });
      const spawnEnvironment = {
        spawnEnvironment: () => {
          const claude = claudeTokenExcluded(),
            github = githubExcluded();
          const snapshot = managedAssignmentEnvironment(
            credentialFreeEnvironment(
              process.env,
              [...deliveryCredentialNames(), ...claude.names, ...github.names],
              process.env,
              [...claude.values, ...github.values],
            ),
          );
          runtimeSpawnSnapshot = snapshot;
          return { ...snapshot };
        },
      };
      const unavailable = (
        reason: string,
        code: "not-configured" | "empty" | "restart-required",
      ) => ({
        unavailable: `Claude runtime unavailable: ${reason}`,
        code,
      });
      // Never wider than what the running runtimes inherited at start.
      const claude = {
        configDirectory: join(this.dataDir, "claude", "config"),
        turnEnvironment: (): ClaudeTurnEnvironment => {
          const ref = domain.claudeTokenReference();
          if (!ref)
            return unavailable(
              "subscription token is not configured",
              "not-configured",
            );
          const snapshot = runtimeSpawnSnapshot ?? {};
          const github = githubExcluded();
          const source = claudeTokenSource(ref);
          if (source.kind === "file") {
            // Read on every call, never cached: a replaced file applies from the next turn.
            const read = readClaudeToken(source);
            if ("problem" in read)
              return unavailable(
                `subscription token file ${read.problem}`,
                "empty",
              );
            if (Object.values(snapshot).includes(read.value))
              return unavailable(
                "Claude token is also in the service environment the running runtimes inherited; restart the service",
                "restart-required",
              );
            return {
              env: credentialFreeEnvironment(
                snapshot,
                [...deliveryCredentialNames(), ...github.names],
                process.env,
                [read.value, ...github.values],
              ),
              token: read.value,
            };
          }
          const name = source.name;
          const token = process.env[name];
          if (
            snapshot[name] !== undefined ||
            (token && Object.values(snapshot).includes(token))
          )
            return unavailable(
              "Claude token reference was configured after the service started; restart the service",
              "restart-required",
            );
          if (!token)
            return unavailable("subscription token is unavailable", "empty");
          return {
            env: credentialFreeEnvironment(
              snapshot,
              [...deliveryCredentialNames(), name, ...github.names],
              process.env,
              github.values,
            ),
            token,
          };
        },
      };
      // Preserve the snapshot even for injected runtimes which do not spawn a child.
      spawnEnvironment.spawnEnvironment();
      this.runtimeUnavailableSince.clear();
      this.runtimeStarting.clear();
      this.abortRuntimeRestarts();
      this.runtimeNotEnabled.clear();
      this.spawnRuntime = (harness) => {
        // Keyed by the requested harness: test fakes do not declare one.
        const runtime = this.runtimeFactory(
          { ...spawnEnvironment, safety: runtimeSafety(harness), claude },
          harness,
        );
        this.attachRuntime(
          harness,
          runtime,
          state,
          () => this.acquired?.supervisor,
        );
        return runtime;
      };
      // No runtime is required: a disabled, missing or failed one leaves the others running.
      for (const harness of this.runtimeHarnesses) {
        if (!domain.runtimeEnabled(harness)) continue;
        if (!(await this.executableResolves(harness))) {
          this.runtimeNotEnabled.add(harness);
          continue;
        }
        try {
          this.runtimes.set(harness, this.spawnRuntime(harness));
        } catch {
          this.noteRuntimeUnavailable(harness, "spawn-failed");
        }
      }
      const supervisor = new ExecutionSupervisor(
        state,
        // A failed harness is never awaited for inspection or interrupts.
        (workId) => {
          const runtime = this.runtimeUnavailableSince.has(
            harnessForWork(state, workId),
          )
            ? undefined
            : this.runtimeForWork(state, workId);
          if (!runtime) return undefined;
          const inspect = runtime.inspectExecution?.bind(runtime);
          return {
            ...(inspect
              ? {
                  inspectExecution: (identity: Parameters<typeof inspect>[0]) =>
                    this.untilFailure(
                      runtime,
                      inspect(identity),
                      runtimeFailedError,
                    ),
                }
              : {}),
            interruptTurn: (threadId: string, turnId: string) =>
              this.untilFailure(
                runtime,
                runtime.interruptTurn(threadId, turnId),
                runtimeFailedError,
              ),
          };
        },
        this.options.supervisor,
        this.options.terminationVerifier ?? new MacProcessTerminationVerifier(),
      );
      acquire("supervisor", supervisor);
      // Codex keeps its untimed start here; only its failure is no longer fatal.
      for (const [harness, runtime] of this.runtimes)
        await this.startOrDetach(
          harness,
          runtime,
          harness !== defaultExecutionHarness,
        );
      await supervisor.reconcileOnStart();
      await deliveryCoordinator.refresh();
      await this.reconcileOwnDeliveryClosures({
        domain,
        deliveryStore,
        githubSources,
        deliveryCoordinator,
      });
      await githubSynchronizer.refresh();
      this.completeSettledProviderClosures({ githubSources, state });
      this.emitSourceHoldNotices({ githubSources, domain, coordination });
      // Nothing is published until provider reconciliation and queued-inbox
      // supersession finish; domain notifications cannot admit work.
      inboxStartup.reconcile();
      const powerOptions = this.options.power;
      let power: ExecutionPower | undefined;
      // Production supervises even with no runtime started: one may be enabled later.
      if (
        (this.runtimeFactory === createRuntime &&
          powerOptions?.enabled !== false) ||
        [...this.runtimes.values()].some((runtime) =>
          powerSupervisionEnabled(powerOptions, runtime),
        )
      ) {
        const pollIntervalMs = powerOptions?.pollIntervalMs ?? 60_000;
        if (
          !Number.isSafeInteger(pollIntervalMs) ||
          pollIntervalMs <= 0 ||
          pollIntervalMs > 60_000
        )
          throw new Error(
            "Power-event poll interval must be a positive integer no greater than 60000",
          );
        const executionPower = new ExecutionPower(
          state,
          powerOptions?.eventSource ?? new MacPowerEventSource(),
          powerOptions?.assertion ?? new CaffeinateAssertion(),
          () => supervisor.reconcileOnStart(),
          () => this.wakeScheduler(0, generation),
        );
        power = acquire("power", executionPower);
        await executionPower.start();
        await executionPower.poll();
        this.timers.add(
          setInterval(() => {
            this.observeBackgroundFailure(generation, "power-poll", () =>
              executionPower.poll(),
            );
          }, pollIntervalMs).unref(),
        );
      }
      const githubInterval = this.options.github?.intervalMs ?? 300_000;
      if (
        !Number.isSafeInteger(githubInterval) ||
        githubInterval < 1000 ||
        githubInterval > 3_600_000
      )
        throw new Error(
          "GitHub refresh interval must be between 1000 and 3600000 milliseconds",
        );
      const scheduler = acquire(
        "scheduler",
        new TurnScheduler(
          schedulerStore,
          (request) => this.attemptRequest(request, generation),
          this.retryNow,
          (error) =>
            this.handleBackgroundFailure(generation, "scheduler-drain", error),
        ),
      );
      // Admission begins here: scheduler drains and wakes need the whole record.
      this.current = {
        state,
        domain,
        githubSources,
        githubSynchronizer,
        coordination,
        deliveryStore,
        deliveryCoordinator,
        routingAttempts,
        workspaces,
        workspaceBindings,
        workspaceComparisons,
        operatorCredentials,
        operatorPush,
        schedulerStore,
        wakeQueries,
        inboxStartup,
        supervisor,
        scheduler,
        power,
        conversationHistory,
        diagnostics,
        claude,
      };
      // Boot-time failures begin their schedule only now that attempts can be admitted.
      for (const harness of [...this.runtimeUnavailableSince.keys()])
        this.armRuntimeRestart(harness);
      scheduler.start();
      await this.wakeScheduler();
      this.timers.add(
        setInterval(() => {
          this.observeBackgroundFailure(generation, "github-poll", () =>
            this.refreshGitHub(),
          );
        }, githubInterval).unref(),
      );
      if (diagnostics) {
        const store = diagnostics;
        // prune() catches its own failures; it never stops or holds anything.
        void store.prune();
        this.timers.add(
          setInterval(
            () => void store.prune(),
            this.options.diagnostics?.pruneIntervalMs ?? 3_600_000,
          ).unref(),
        );
      }
    } catch (error) {
      generation.accepting = false;
      this.abortRuntimeRestarts();
      // Read live, as stop() may release these while start() is still running.
      const { scheduler, workspaces } = this.acquired ?? {};
      workspaces?.cancelGitWork();
      scheduler?.stop();
      try {
        this.acquired?.state?.holdReadyOnStartupFailure(
          "Runtime or login unavailable during startup",
        );
      } finally {
        try {
          for (const timer of this.timers) clearInterval(timer);
          this.timers.clear();
          await this.acquired?.power?.stop().catch(() => {});
          this.acquired?.supervisor?.cancelObservations();
          await this.acquired?.githubSynchronizer?.stop().catch(() => {});
          await this.acquired?.deliveryCoordinator?.stop().catch(() => {});
          // An attempt may be mid-start: let it land in `runtimes` so it is stopped below.
          await Promise.all([...this.runtimeToggles.values()]);
          await Promise.all([
            ...[...this.runtimes.values()].map((runtime) =>
              stopRuntime(runtime).catch(() => {}),
            ),
            ...[...this.detachedRuntimeStops].map((cleanup) =>
              cleanup.catch(() => {}),
            ),
          ]);
          this.detachedRuntimeStops.clear();
          await workspaces?.settle();
          try {
            await scheduler?.settle();
          } catch (cleanupError) {
            if (error instanceof Error && error.cause === undefined)
              error.cause = cleanupError;
          }
          await this.acquired?.supervisor?.settle();
        } finally {
          this.runtimes.clear();
          this.current = undefined;
          this.acquired = undefined;
          this.routingCoordinators.clear();
          this.clearConversationCaptures();
          try {
            this.closeDatabase();
          } finally {
            // A failed close leaves the raw handle open: keep it and the owner
            // so an explicit stop() can retry; start() rejects meanwhile.
            if (!this.db?.isOpen) {
              this.db = undefined;
              this.cache = undefined;
              dataDirectory.close();
              this.owner = undefined;
              if (this.generation === generation) this.generation = undefined;
            }
          }
        }
      }
      throw error;
    }
  }

  /**
   * Starts a created runtime. On failure it leaves `this.runtimes`, is marked not enabled
   * (`RuntimeNotEnabledError`) or unavailable, and is stopped without being awaited.
   */
  private async startOrDetach(
    harness: ExecutionHarness,
    runtime: Runtime,
    timed: boolean,
  ): Promise<boolean> {
    let startup: Promise<void> | undefined;
    let startupSettled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      startup = runtime.start().finally(() => {
        startupSettled = true;
      });
      await (timed
        ? Promise.race([
            this.untilFailure(runtime, startup, runtimeFailedError),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("Secondary runtime startup timed out"));
              }, this.options.secondaryRuntimeStartTimeoutMs ?? 10_000);
            }),
          ])
        : startup);
      if (!this.runtimeUnavailableSince.has(harness))
        this.restartStateOf(harness).availableAt =
          this.restartClock.monotonicNow();
      return true;
    } catch (error) {
      if (this.runtimes.get(harness) === runtime) this.runtimes.delete(harness);
      if (error instanceof RuntimeNotEnabledError)
        this.runtimeNotEnabled.add(harness);
      else
        this.noteRuntimeUnavailable(
          harness,
          timedOut ? "start-timed-out" : "start-failed",
        );
      // Healthy work never waits on a failed runtime's cleanup.
      const cleanup = this.detachRuntimeStop(runtime);
      if (startup && !startupSettled) {
        // stop() need not cancel start(). Retain ownership until startup
        // settles, then stop any resources it created after the first stop.
        const lateCleanup = Promise.allSettled([startup, cleanup]).then(() =>
          stopRuntime(runtime),
        );
        lateCleanup.catch(() => {});
        this.detachedRuntimeStops.add(lateCleanup);
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Stops a runtime without awaiting it; shutdown awaits and reports it. */
  private detachRuntimeStop(runtime: Runtime): Promise<void> {
    const cleanup = stopRuntime(runtime);
    cleanup.catch(() => {});
    this.detachedRuntimeStops.add(cleanup);
    return cleanup;
  }

  private executableResolves(harness: ExecutionHarness): Promise<boolean> {
    if (this.options.resolveExecutable)
      return this.options.resolveExecutable(harness);
    if (this.runtimeFactory !== createRuntime) return Promise.resolve(true);
    return resolveOnPath(harness, process.env).then((path) => path !== null);
  }

  /** Disabled tasks' count for confirmation, and each runtime's persisted setting. */
  runtimeSettings(): {
    harness: ExecutionHarness;
    enabled: boolean;
    boundTasks: number;
  }[] {
    const { domain, state } = this.started();
    return executionHarnessSchema.options.map((harness) => ({
      harness,
      enabled: domain.runtimeEnabled(harness),
      boundTasks: state.boundTaskCount(harness),
    }));
  }

  /**
   * Saves the operator's setting, then brings the live runtime to it (ADR-1012). Enabling is
   * refused while the executable is missing; disabling a runtime bound tasks use is refused
   * unless `confirmedBoundTasks` covers the current count. A recorded key skips both gates
   * and reconciles again.
   */
  async configureRuntime(command: {
    key: string;
    harness: ExecutionHarness;
    enabled: boolean;
    confirmedBoundTasks?: number | undefined;
  }): Promise<{ harness: ExecutionHarness; enabled: boolean }> {
    const { key, harness, enabled } = command;
    const domainCommand = {
      key,
      actor: "operator" as const,
      type: "runtime.configure" as const,
      harness,
      enabled,
    };
    return this.toggleRuntime(harness, async () => {
      const { domain, state } = this.started();
      let result = domain.recordedCommand(domainCommand);
      if (result === undefined) {
        if (enabled && !(await this.executableResolves(harness)))
          throw new RuntimeConfigurationRefusedError(
            "runtime-executable-missing",
            harness,
          );
        const boundTasks = state.boundTaskCount(harness);
        // A task bound after the operator saw the count needs a fresh confirmation.
        if (!enabled && boundTasks > (command.confirmedBoundTasks ?? 0))
          throw new RuntimeConfigurationRefusedError(
            "runtime-confirmation-required",
            harness,
            boundTasks,
          );
        result = domain.execute(domainCommand);
      }
      // The operator's toggle is the documented recovery: it begins a fresh schedule.
      this.clearRuntimeRestart(harness);
      await this.reconcileRuntime(harness);
      return parseDomainCommandOutcome("runtime.configure", result).result;
    });
  }

  /** Per-harness serialisation; refused once the service stops accepting work. */
  private toggleRuntime<T>(
    harness: ExecutionHarness,
    action: () => Promise<T>,
  ): Promise<T> {
    const generation = this.generation;
    const refused = () =>
      new RuntimeConfigurationRefusedError("unavailable", harness);
    if (!this.current || !generation?.accepting)
      return Promise.reject(refused());
    const previous = this.runtimeToggles.get(harness) ?? Promise.resolve();
    const next = previous.then(() => {
      if (this.generation !== generation || !generation.accepting)
        throw refused();
      return action();
    });
    const settled = next.then(
      () => {},
      () => {},
    );
    this.runtimeToggles.set(harness, settled);
    void settled.then(() => {
      if (this.runtimeToggles.get(harness) === settled)
        this.runtimeToggles.delete(harness);
    });
    return next;
  }

  /**
   * Brings the live runtime to the persisted setting. Disabled: stopped once no execution it
   * owns remains (see `stopDrainedRuntimes`). Enabled: an unavailable or absent runtime is
   * replaced by a fresh one; a running or draining one is kept, so nothing starts twice.
   */
  private async reconcileRuntime(harness: ExecutionHarness): Promise<void> {
    const { domain } = this.started();
    if (!domain.runtimeEnabled(harness)) {
      this.stopDrainedRuntimes();
      return;
    }
    if (!this.runtimeHarnesses.includes(harness) || !this.spawnRuntime) return;
    const current = this.runtimes.get(harness);
    // Still running or draining: keep it, and admit work that waited while it was disabled.
    if (current && !this.runtimeUnavailableSince.has(harness))
      return this.wakeScheduler();
    if (current) {
      this.runtimes.delete(harness);
      this.detachRuntimeStop(current);
    }
    this.runtimeUnavailableSince.delete(harness);
    this.runtimeNotEnabled.delete(harness);
    if (!(await this.executableResolves(harness))) {
      this.runtimeNotEnabled.add(harness);
      return;
    }
    let runtime: Runtime;
    try {
      runtime = this.spawnRuntime(harness);
    } catch {
      this.noteRuntimeUnavailable(harness, "spawn-failed");
      return;
    }
    this.runtimes.set(harness, runtime);
    // The runtime is listed before its start finishes, but queued work must wait for the start.
    this.runtimeStarting.add(harness);
    let started: boolean;
    try {
      started = await this.startOrDetach(harness, runtime, true);
    } finally {
      this.runtimeStarting.delete(harness);
    }
    if (started) await this.wakeScheduler();
  }

  private restartStateOf(harness: ExecutionHarness): RestartState {
    let state = this.runtimeRestarts.get(harness);
    if (!state) {
      state = newRestartState();
      this.runtimeRestarts.set(harness, state);
    }
    return state;
  }

  /**
   * The only place a runtime becomes unavailable. The first failure of an episode names it and
   * applies the stability rule (10 minutes available starts a fresh count); every report then
   * tries to arm the next attempt, which ignores duplicates.
   */
  private noteRuntimeUnavailable(
    harness: ExecutionHarness,
    failure: RuntimeRestartFailure,
  ): void {
    const state = this.restartStateOf(harness);
    if (!this.runtimeUnavailableSince.has(harness)) {
      this.runtimeUnavailableSince.set(harness, this.wallNow());
      state.lastFailure = failure;
      if (
        state.availableAt !== undefined &&
        this.restartClock.monotonicNow() - state.availableAt >=
          runtimeRestartStableMs
      ) {
        state.attempts = 0;
        state.history = [];
      }
      state.availableAt = undefined;
    }
    this.armRuntimeRestart(harness);
  }

  /**
   * Sleeps for the next attempt, or marks the schedule exhausted after the third. A disabled or
   * not-enabled runtime, a stopped or unpublished service, a pending sleep, an attempt in
   * flight and an exhausted schedule all arm nothing.
   */
  private armRuntimeRestart(harness: ExecutionHarness): void {
    const generation = this.generation;
    if (
      !this.current ||
      !generation?.accepting ||
      !this.spawnRuntime ||
      !this.runtimeHarnesses.includes(harness) ||
      !this.current.domain.runtimeEnabled(harness) ||
      this.runtimeNotEnabled.has(harness) ||
      !this.runtimeUnavailableSince.has(harness)
    )
      return;
    const state = this.restartStateOf(harness);
    if (state.pending || state.inFlight || state.exhaustedAt !== undefined)
      return;
    const delay = runtimeRestartDelaysMs[state.attempts];
    if (delay === undefined) {
      state.exhaustedAt = this.wallNow();
      return;
    }
    const token = {};
    const abort = new AbortController();
    state.pending = {
      token,
      abort,
      attempt: state.attempts + 1,
      nextAt: this.wallNow() + delay,
    };
    // Aborting resolves the sleep, so the signal tells a fired sleep from a cancelled one.
    void this.restartClock.sleep(delay, abort.signal).then(
      () => {
        if (!abort.signal.aborted)
          void this.runtimeRestartAttempt(harness, generation, state, token);
      },
      () => {},
    );
  }

  /** Goes through the toggle path, so it queues behind and yields to an operator toggle. */
  private async runtimeRestartAttempt(
    harness: ExecutionHarness,
    generation: ServiceGeneration,
    state: RestartState,
    token: object,
  ): Promise<void> {
    const current = () =>
      this.generation === generation &&
      generation.accepting &&
      this.runtimeRestarts.get(harness) === state &&
      state.pending?.token === token &&
      this.runtimeUnavailableSince.has(harness) &&
      this.current?.domain.runtimeEnabled(harness) === true &&
      !this.runtimeNotEnabled.has(harness);
    if (!current()) return;
    try {
      await this.toggleRuntime(harness, async () => {
        if (!current()) return;
        const attempt = state.attempts + 1;
        const at = this.wallNow();
        state.pending = undefined;
        state.inFlight = true;
        state.attempts = attempt;
        try {
          await this.reconcileRuntime(harness);
        } catch (error) {
          if (
            this.runtimes.has(harness) &&
            !this.runtimeUnavailableSince.has(harness)
          )
            // The runtime started and the scheduler wake after it failed: like any wake failure,
            // that is fatal to the service. It is not a failed start of a healthy runtime.
            this.handleBackgroundFailure(generation, "scheduler-drain", error);
          else if (!this.runtimeUnavailableSince.has(harness))
            // A reconcile that threw before listing a runtime; keep the schedule going.
            this.noteRuntimeUnavailable(harness, "start-failed");
        } finally {
          state.inFlight = false;
        }
        if (this.runtimeRestarts.get(harness) !== state) return;
        const started =
          this.runtimes.has(harness) &&
          !this.runtimeUnavailableSince.has(harness);
        state.history.push({
          attempt,
          at,
          outcome: started ? "started" : "failed",
          failure: started ? null : (state.lastFailure ?? "start-failed"),
        });
        if (this.runtimeNotEnabled.has(harness))
          this.runtimeRestarts.delete(harness);
        else if (!started) this.armRuntimeRestart(harness);
      });
    } catch {
      // Refused because the service stopped; nothing to retry and nothing to report.
    }
  }

  /** An operator toggle, or the start of a service: forgets the schedule and any sleep. */
  private clearRuntimeRestart(harness: ExecutionHarness): void {
    this.runtimeRestarts.get(harness)?.pending?.abort.abort();
    this.runtimeRestarts.delete(harness);
  }

  /** Stop and failed-start teardown: cancels every sleep so none can outlive the generation. */
  private abortRuntimeRestarts(): void {
    for (const state of this.runtimeRestarts.values())
      state.pending?.abort.abort();
    this.runtimeRestarts.clear();
  }

  private restartStatus(harness: ExecutionHarness) {
    const state = this.runtimeRestarts.get(harness);
    if (!state?.lastFailure) return undefined;
    const { lastFailure } = state;
    const attempts = state.history.map((entry) => ({ ...entry }));
    if (state.exhaustedAt !== undefined)
      return {
        state: "exhausted" as const,
        since: state.exhaustedAt,
        lastFailure,
        attempts,
      };
    if (state.pending)
      return {
        state: "pending" as const,
        attempt: state.pending.attempt,
        nextAt: state.pending.nextAt,
        lastFailure,
        attempts,
      };
    return undefined;
  }

  /** Stops each disabled runtime that no submitting, running or held execution still needs. */
  private stopDrainedRuntimes(): void {
    const { domain, state } = this.current ?? {};
    if (!domain || !state) return;
    for (const [harness, runtime] of this.runtimes)
      if (
        !domain.runtimeEnabled(harness) &&
        !state.hasRuntimeOwnedExecution(harness)
      ) {
        this.runtimes.delete(harness);
        this.detachRuntimeStop(runtime);
      }
  }

  /**
   * Listeners act only on work bound to the emitting runtime's harness. They run
   * before the service is published, so they use start-up's own components.
   */
  private attachRuntime(
    harness: ExecutionHarness,
    runtime: Runtime,
    state: ExecutionState,
    supervisor: () => ExecutionSupervisor | undefined,
  ): void {
    const ownWork = (workId: string) =>
      (state.taskBinding(workId)?.harness ?? defaultExecutionHarness) ===
      harness;
    /** A callback naming another harness's execution is rejected, not acted on. */
    const foreign = (threadId: string, turnId: string) => {
      try {
        return state
          .executionsForRuntimeIdentity(threadId, turnId)
          .some((item) => !ownWork(item.workId));
      } catch {
        return true;
      }
    };
    let failed = () => {};
    // After a non-default runtime fails, new inbound callbacks from it are
    // refused; outcomes for work it already registered may still settle.
    let refuseNew = false;
    if (harness !== defaultExecutionHarness)
      this.runtimeFailed.set(
        runtime,
        new Promise<void>((resolve) => {
          failed = resolve;
        }),
      );
    runtime.onFailure?.(() => {
      refuseNew = harness !== defaultExecutionHarness;
      failed();
      if (
        this.runtimes.get(harness) === runtime &&
        !this.runtimeUnavailableSince.has(harness)
      )
        this.noteRuntimeUnavailable(harness, "exited");
    });
    const acceptsNew = () =>
      !refuseNew &&
      this.runtimes.get(harness) === runtime &&
      (harness === defaultExecutionHarness ||
        !this.runtimeUnavailableSince.has(harness));
    runtime.onUnexpectedRequest((request) => {
      if (!acceptsNew()) return;
      const denied = `Unexpected runtime request denied: ${request.method}`;
      const active = state
        .activeExecutions()
        .filter((item) => ownWork(item.workId));
      // A runtime naming another harness's execution is misbehaving: hold only
      // its own active work and leave the named harness's work untouched.
      if (
        request.threadId &&
        request.turnId &&
        foreign(request.threadId, request.turnId)
      ) {
        for (const item of active) {
          state.hold(
            item.id,
            `Runtime reported another harness's execution: ${request.method}`,
          );
          supervisor()?.noteAnomaly(item.workId);
        }
        return;
      }
      const bound =
        request.threadId && request.turnId
          ? state
              .executionsForTerminalIdentity(request.threadId, request.turnId)
              .filter(
                (item) =>
                  ownWork(item.workId) &&
                  ["completed", "held", "submitting", "running"].includes(
                    item.state,
                  ),
              )
          : [];
      if (bound.length === 0 && request.threadId && request.turnId) {
        const awaiting = state
          .executionsForRuntimeIdentity(request.threadId, request.turnId)
          .filter(
            (item) =>
              item.turnId === null &&
              ownWork(item.workId) &&
              ["completed", "held", "submitting", "running"].includes(
                item.state,
              ),
          );
        const pending = awaiting.length === 1 ? awaiting[0] : undefined;
        if (
          pending &&
          state.holdPendingTurn(
            pending.id,
            request.threadId,
            request.turnId,
            denied,
          )
        ) {
          supervisor()?.turnBound(
            pending.workId,
            request.threadId,
            request.turnId,
          );
          return;
        }
      }
      if (bound.length === 1 && bound[0]?.state === "completed") {
        retractWriterAndSuccessors(state, bound[0], denied);
        return;
      }
      const affected = bound.length === 1 ? bound : active;
      for (const item of affected) {
        state.hold(item.id, denied);
        supervisor()?.noteAnomaly(item.workId);
        this.diagnosticServiceEvent(item.workId, "unexpected-request", "warn", {
          method: request.method,
        });
      }
    });
    // Before publication no turn of this generation exists to bind a callback to.
    runtime.onUserInputRequest?.((request) => {
      if (
        !this.current ||
        !acceptsNew() ||
        foreign(request.identity.threadId, request.identity.turnId)
      )
        runtime.cancelUserInput?.(
          request.identity,
          "Native callback binding failed",
        );
      else this.handleUserInputRequest(request, runtime);
    });
    runtime.onUserInputOutcome?.((outcome) => {
      if (!foreign(outcome.threadId, outcome.turnId))
        this.handleUserInputOutcome(outcome);
    });
    runtime.onToolCall?.((call) =>
      !this.current || !acceptsNew() || foreign(call.threadId, call.turnId)
        ? Promise.resolve({
            text: "Coordination call is not bound to current task work",
            success: false,
          })
        : this.observeToolCall(call, harness, this.handleToolCall(call)),
    );
    const generation = this.generation;
    runtime.onAdmissionChange?.(() => {
      if (acceptsNew() && generation)
        this.observeBackgroundFailure(generation, "domain-wake", () =>
          this.wakeScheduler(0, generation),
        );
    });
    runtime.onConversationEvent?.((event) => {
      if (acceptsNew() && !foreign(event.threadId, event.turnId))
        this.receiveConversationEvent(event, harness);
    });
    runtime.onDiagnosticEvent?.((event: RuntimeDiagnosticEvent) => {
      if (acceptsNew() && !foreign(event.threadId, event.turnId))
        this.diagnosticCaptures
          .get(runtimeKey(harness, event.threadId))
          ?.receive(event);
    });
    runtime.onTerminalAnomaly?.((anomaly) => {
      if (!acceptsNew()) return;
      const matched =
        anomaly.threadId && anomaly.turnId
          ? state
              .executionsForTerminalIdentity(anomaly.threadId, anomaly.turnId)
              .filter((item) => ownWork(item.workId))
          : state
              .activeOrLastCompleted(this.lastCompletedWorkId.get(harness))
              .filter((item) => ownWork(item.workId));
      for (const item of matched) {
        retractWriterAndSuccessors(state, item, anomaly.reason);
        supervisor()?.noteAnomaly(item.workId);
        this.diagnosticServiceEvent(item.workId, "terminal-anomaly", "warn", {
          reason: anomaly.reason,
        });
      }
    });
  }

  private runtimeForWork(
    state: ExecutionState,
    workId: string,
  ): Runtime | undefined {
    return this.runtimes.get(harnessForWork(state, workId));
  }

  /**
   * Shared paths never wait on a failed non-default runtime: its pending call
   * settles as `onFailure` decides. The default runtime keeps its own bounds.
   */
  private untilFailure<T>(
    runtime: Runtime,
    work: Promise<T>,
    onFailure: () => T,
  ): Promise<T> {
    const failed = this.runtimeFailed.get(runtime);
    return failed ? Promise.race([work, failed.then(onFailure)]) : work;
  }

  /** Enabled by the operator, in the service's harness list, and its executable was found. */
  private harnessEnabled(harness: ExecutionHarness): boolean {
    return (
      this.runtimeHarnesses.includes(harness) &&
      !this.runtimeNotEnabled.has(harness) &&
      (this.current?.domain.runtimeEnabled(harness) ?? true)
    );
  }

  /** Why work bound to this harness cannot be admitted now, if anything. */
  private runtimeWaitReason(harness: ExecutionHarness): string | undefined {
    if (!this.harnessEnabled(harness))
      return `${executionHarnessLabels[harness]} runtime is not configured`;
    if (
      this.runtimeUnavailableSince.has(harness) ||
      this.runtimeStarting.has(harness)
    )
      return `${executionHarnessLabels[harness]} runtime unavailable; turn it off and on in Settings → Runtime, or restart the service`;
    return undefined;
  }

  waitForBackgroundFailure(): Promise<BackgroundFailureDiagnostic> {
    if (!this.generation) throw new Error("Service is not started");
    return this.generation.failureNotification;
  }

  async waitForBackgroundShutdown(
    failureNotification?: Promise<BackgroundFailureDiagnostic>,
  ): Promise<void> {
    const generation = failureNotification
      ? this.generationsByNotification.get(failureNotification)
      : this.generation;
    const shutdown = generation?.shutdown;
    if (!generation) return;
    let failed = false;
    let failure: unknown;
    if (generation.fatal && shutdown) {
      try {
        await shutdown;
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    await generation.diagnosticQueue;
    if (failed) throw failure;
  }

  backgroundFailureObserved(
    failureNotification?: Promise<BackgroundFailureDiagnostic>,
  ): boolean {
    const generation = failureNotification
      ? this.generationsByNotification.get(failureNotification)
      : this.generation;
    return generation?.fatal ?? false;
  }

  stop(): Promise<void> {
    const generation = this.generation;
    if (generation) generation.accepting = false;
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopOwned();
    this.stopPromise = stopping;
    void stopping.then(
      () => {},
      () => {
        if (this.stopPromise === stopping) this.stopPromise = undefined;
        const diagnostic =
          generation &&
          this.generation === generation &&
          !generation.shutdownFailureReported
            ? this.nextBackgroundDiagnostic(
                generation,
                "safe-shutdown",
                "shutdown-failed",
              )
            : undefined;
        if (diagnostic && generation) {
          generation.shutdownFailureReported = true;
          void this.writeBackgroundDiagnostic(generation, diagnostic).catch(
            () => {},
          );
        }
      },
    );
    return stopping;
  }

  /** Clears the statement cache, then closes the raw handle; safe to retry after a failure. */
  private closeDatabase(): void {
    if (this.cache) this.cache.close();
    else this.db?.close();
  }

  private async stopOwned(): Promise<void> {
    // Before awaiting: a queued attempt then finds the generation closed and does nothing.
    this.abortRuntimeRestarts();
    // A live enable may be starting a runtime; let it land in `runtimes` first.
    await Promise.all([...this.runtimeToggles.values()]);
    this.spawnRuntime = undefined;
    const {
      scheduler,
      supervisor,
      githubSynchronizer: synchronizer,
      deliveryCoordinator: delivery,
      power,
      workspaces,
    } = this.acquired ?? {};
    const runtimes = new Map(this.runtimes);
    const db = this.db;
    const failures: Array<{ stage: string; error: unknown }> = [];
    const recordFailure = (stage: string, error: unknown) => {
      failures.push({ stage, error });
    };
    const attempt = async (stage: string, action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        recordFailure(stage, error);
      }
    };

    try {
      workspaces?.cancelGitWork();
    } catch (error) {
      recordFailure("workspace Git cancellation", error);
    }
    try {
      scheduler?.stop();
    } catch (error) {
      recordFailure("scheduler stop", error);
    }
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    try {
      supervisor?.cancelObservations();
    } catch (error) {
      recordFailure("supervisor observation cancellation", error);
    }

    await attempt("GitHub synchronization stop", () => synchronizer?.stop());
    await attempt("delivery stop", () => delivery?.stop());
    await attempt("runtime-question invalidation", () => {
      if (this.db?.isOpen && this.cache?.isOpen)
        this.acquired?.coordination?.invalidateRuntimeQuestions(
          "Service stopped; native endpoints lost",
        );
    });
    await attempt("conversation-capture cleanup", () =>
      this.clearConversationCaptures(),
    );
    this.runtimes.clear();
    const detachedStops = [...this.detachedRuntimeStops];
    this.detachedRuntimeStops.clear();
    // Concurrent, so a hung runtime of one harness cannot keep another running.
    await Promise.all([
      ...[...runtimes.values()].map((runtime) =>
        attempt("runtime stop", () => runtime.stop()),
      ),
      ...detachedStops.map((cleanup) => attempt("runtime stop", () => cleanup)),
    ]);
    await attempt("workspace settlement", () => workspaces?.settle());
    await attempt("scheduler settlement", () => scheduler?.settle());
    await attempt("active-work settlement", async () => {
      const settled = await Promise.allSettled([...this.active]);
      for (const result of settled)
        if (result.status === "rejected")
          recordFailure("active-work settlement", result.reason);
    });
    await attempt("power stop", () => power?.stop());
    await attempt("background callback settlement", async () => {
      await Promise.all([...this.backgroundRuns]);
    });
    await attempt("supervisor settlement", () => supervisor?.settle());

    if (db?.isOpen)
      await attempt("service database close", () => this.closeDatabase());
    if (!db?.isOpen) {
      if (this.db === db) {
        this.db = undefined;
        this.cache = undefined;
      }
      const owner = this.owner;
      if (owner) {
        let released = false;
        await attempt("data-directory owner release", () => {
          owner.close();
          released = true;
        });
        if (released && this.owner === owner) this.owner = undefined;
      }

      this.current = undefined;
      this.acquired = undefined;
      this.runtimes.clear();
      this.routingCoordinators.clear();
      this.activeByWorkId.clear();
      this.nativeWaiters.clear();
      this.callbacks.clear();
    } else {
      // Keep the runtimes available for another stop attempt while the database
      // and its data-directory owner remain held.
      for (const [harness, runtime] of runtimes)
        this.runtimes.set(harness, runtime);
    }

    if (failures.length === 1) {
      const [failure] = failures;
      if (failure) throw failure.error;
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Service shutdown failed during ${failures.map(({ stage }) => stage).join(", ")}`,
      );
  }

  private createGeneration(): ServiceGeneration {
    let resolveFailure!: (diagnostic: BackgroundFailureDiagnostic) => void;
    const failureNotification = new Promise<BackgroundFailureDiagnostic>(
      (resolve) => {
        resolveFailure = resolve;
      },
    );
    const generation: ServiceGeneration = {
      id: randomUUID(),
      accepting: true,
      fatal: false,
      shutdownFailureReported: false,
      incident: 0,
      failureNotification,
      resolveFailure,
      diagnosticQueue: Promise.resolve(),
    };
    this.generationsByNotification.set(failureNotification, generation);
    return generation;
  }

  private observeBackgroundFailure(
    generation: ServiceGeneration,
    operation: Exclude<BackgroundFailureOperation, "safe-shutdown">,
    action: () => Promise<unknown>,
  ): void {
    if (this.generation !== generation || !generation.accepting) return;
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(action());
    } catch (error) {
      this.handleBackgroundFailure(generation, operation, error);
      return;
    }
    const observed = pending.then(
      () => {},
      (error: unknown) =>
        this.handleBackgroundFailure(generation, operation, error),
    );
    this.backgroundRuns.add(observed);
    void observed.then(() => this.backgroundRuns.delete(observed));
  }

  private handleBackgroundFailure(
    generation: ServiceGeneration,
    operation: Exclude<BackgroundFailureOperation, "safe-shutdown">,
    _error: unknown,
  ): void {
    if (this.generation !== generation || generation.fatal) return;
    generation.accepting = false;
    generation.fatal = true;
    const shutdown = this.stop();
    generation.shutdown = shutdown;
    void shutdown.catch(() => {});
    const diagnostic = this.nextBackgroundDiagnostic(
      generation,
      operation,
      "unexpected-background-failure",
    );
    if (diagnostic)
      void this.writeBackgroundDiagnostic(generation, diagnostic).catch(
        () => {},
      );
    generation.resolveFailure(diagnostic!);
  }

  private nextBackgroundDiagnostic(
    generation: ServiceGeneration,
    operation: BackgroundFailureOperation,
    errorCode: BackgroundFailureCode,
  ): BackgroundFailureDiagnostic {
    generation.incident = Math.min(generation.incident + 1, 2);
    return {
      serviceId: generation.id,
      incident: generation.incident,
      operation,
      errorCode,
    };
  }

  private writeBackgroundDiagnostic(
    generation: ServiceGeneration,
    diagnostic: BackgroundFailureDiagnostic,
  ): Promise<void> {
    const write = generation.diagnosticQueue.then(async () => {
      const sink =
        this.options.backgroundDiagnosticSink ??
        ((event: BackgroundFailureDiagnostic) => {
          process.stderr.write(`${JSON.stringify(event)}\n`);
        });
      const result = Promise.resolve().then(() => sink(diagnostic));
      void result.catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      const completed = await Promise.race([
        result.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            backgroundDiagnosticTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!completed && this.generation === generation) {
        try {
          process.stderr.write(backgroundDiagnosticFallback);
        } catch {
          // The static fallback is best-effort and never calls the sink again.
        }
      }
    });
    generation.diagnosticQueue = write.catch(() => {});
    return generation.diagnosticQueue;
  }

  list(): ExecutionIntent[] {
    return this.started().state.list();
  }

  recoveryView(): RecoveryRecord[] {
    return this.started().state.recoveryView();
  }

  executionForWork(workId: string): ExecutionIntent | undefined {
    return this.started().state.byWorkId(workId);
  }

  recoveryFor(
    assignmentId: string,
    assignmentVersion: number,
    workId?: string,
  ): RecoveryRecord[] {
    return this.started().state.recoveryFor(
      assignmentId,
      assignmentVersion,
      workId,
    );
  }

  recoveryForTask(taskId: string, alsoWorkId?: string): RecoveryRecord[] {
    return this.started().state.recoveryForTask(taskId, alsoWorkId);
  }

  powerStatus() {
    return this.current?.power?.status() ?? null;
  }

  /** Whether any task in this installation has started a turn. */
  taskTurnStarted() {
    return this.started().state.taskTurnStarted();
  }

  /** The persisted harness of a bound work, or null before binding. */
  bindingHarness(workId: string): ExecutionHarness | null {
    return this.started().state.taskBinding(workId)?.harness ?? null;
  }

  /** Booleans and a closed state only; the token value never leaves this method. */
  claudeTokenStatus() {
    const { domain, claude } = this.started();
    const configured = domain.claudeTokenReference() !== null;
    const result = configured ? claude?.turnEnvironment() : undefined;
    const state = !configured
      ? "not-configured"
      : !result ||
          ("unavailable" in result && result.code !== "restart-required")
        ? "missing-value"
        : "unavailable" in result
          ? "restart-required"
          : "available";
    return { configured, available: state === "available", state } as const;
  }

  terminalFailure(workId: string) {
    return this.started().state.terminalFailure(workId);
  }

  /** In-memory only: a manual service restart is the recovery path. */
  runtimeStatus():
    | { state: "available" }
    | { state: "unavailable"; since: number } {
    const since = this.runtimeUnavailableSince.get(defaultExecutionHarness);
    return since === undefined
      ? { state: "available" }
      : { state: "unavailable", since };
  }

  /** In-memory only, one per harness in `executionHarnessSchema` order. */
  harnessStatuses(): HarnessStatus[] {
    return executionHarnessSchema.options.map((harness) => {
      const policy = this.harnessPolicy(harness),
        settings = this.harnessSettings(harness),
        enabled = this.current?.domain.runtimeEnabled(harness) ?? true;
      if (!enabled)
        return {
          harness,
          enabled,
          state: "not-configured",
          reason: "disabled",
          policy,
          settings,
        };
      if (!this.harnessEnabled(harness))
        return {
          harness,
          enabled,
          state: "not-configured",
          reason: "executable-missing",
          policy,
          settings,
        };
      const since = this.runtimeUnavailableSince.get(harness);
      if (since === undefined)
        return { harness, enabled, state: "available", policy, settings };
      const restart = this.restartStatus(harness);
      return {
        harness,
        enabled,
        state: "unavailable",
        since,
        ...(restart ? { restart } : {}),
        policy,
        settings,
      };
    });
  }

  /**
   * Re-runs the running Codex App Server's authentication check (`account/read`, `config/read`);
   * requests no model turn and leaves the runtime's state untouched whatever the result.
   */
  async verifyCodexLogin(): Promise<
    "verified" | "policy" | "failed" | "unavailable"
  > {
    const runtime = this.runtimes.get("codex") as
      | (Runtime & { verifyLoginAndPolicy?: () => Promise<void> })
      | undefined;
    if (!runtime || this.runtimeUnavailableSince.has("codex"))
      return "unavailable";
    if (!runtime.verifyLoginAndPolicy) return "failed";
    try {
      await runtime.verifyLoginAndPolicy();
      return "verified";
    } catch (error) {
      // A rejected `config/read` shape is a policy mismatch, not a missing login.
      const issues = (error as { issues?: { path?: unknown[] }[] }).issues;
      return issues?.[0]?.path?.[0] === "config" ? "policy" : "failed";
    }
  }

  /** Supported model and effort values from a started runtime that has read them, else null. */
  harnessSettings(harness: ExecutionHarness): SupportedRuntimeSettings | null {
    const runtime = this.runtimes.get(harness) as
      | (Runtime & { supportedSettings?: () => unknown })
      | undefined;
    if (
      !runtime?.supportedSettings ||
      this.runtimeUnavailableSince.has(harness)
    )
      return null;
    const raw = runtime.supportedSettings();
    if (!raw || typeof raw !== "object") return null;
    const parsed = supportedRuntimeSettingsSchema.safeParse({
      models: Object.entries(raw).map(([model, efforts]) => ({
        model,
        efforts,
      })),
    });
    return parsed.success ? parsed.data : null;
  }

  /** Codex's is static; Claude's comes from its started runtime, else null. */
  private harnessPolicy(harness: ExecutionHarness): PolicyDisclosure | null {
    if (harness === "codex") return codexPolicyDisclosure();
    const runtime = this.runtimes.get(harness) as
      | (Runtime & { effectivePolicy?: (workspace: string) => unknown })
      | undefined;
    if (!runtime?.effectivePolicy || this.runtimeUnavailableSince.has(harness))
      return null;
    // Any absolute workspace: the disclosure names roots by category only.
    const workspace = "/ensemble-task-workspace";
    try {
      return claudePolicyDisclosure(
        runtime.effectivePolicy(workspace),
        workspace,
      );
    } catch {
      return null;
    }
  }

  resolveHeldExecution(receipt: RecoveryReceipt) {
    return this.started().supervisor.resolveHeldExecution(receipt);
  }
  adoptHistoricalPreTurnRejection(command: HistoricalPreTurnAdoption) {
    return this.started().state.adoptHistoricalPreTurnRejection(command);
  }
  recoverPreTurnExecution(command: PreTurnRecoveryCommand) {
    const value = preTurnRecoveryCommandSchema.parse(command);
    const replay = this.started().state.preTurnCommandReplay("recover", value);
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
    return this.started().supervisor.resolveHeldExecution(value.receipt, value);
  }
  adoptHistoricalNoTurnSubmission(command: HistoricalNoTurnAdoption) {
    return this.started().state.adoptHistoricalNoTurnSubmission(command);
  }
  recoverNoTurnExecution(command: NoTurnRecoveryCommand) {
    const value = noTurnRecoveryCommandSchema.parse(command);
    const replay = this.started().state.preTurnCommandReplay(
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
    return this.started().supervisor.resolveHeldExecution(value.receipt, value);
  }
  replaceConversationCommand(command: ReplaceConversationCommand) {
    return this.started().state.replaceConversationCommand(command);
  }
  recoveryMaterial(workId: string) {
    return this.started().state.recoveryMaterial(workId);
  }
  replacementFacts(assignmentId: string) {
    return this.started().state.replacementFacts(assignmentId);
  }
  preTurnCommandRecord(key: string) {
    return this.started().state.preTurnCommandRecord(key);
  }

  /** Bounded execution list reads; see SchedulerStore.assignmentPage. */
  turnRequestPage(
    scope: "taskId" | "assignmentId" | "projectId",
    id: string,
    before: number | undefined,
    limit: number,
  ): TurnRequest[] {
    return this.started().schedulerStore.assignmentPage(
      scope,
      id,
      before,
      limit,
    );
  }

  turnRequest(workId: string): TurnRequest | undefined {
    return this.started().schedulerStore.find(workId);
  }

  turnRequests(): TurnRequest[] {
    return this.started().schedulerStore.list();
  }

  currentTurnRequest(
    assignmentId: string,
    version: number,
  ): TurnRequest | undefined {
    return this.started().schedulerStore.current(assignmentId, version);
  }

  turnRequestsForTask(taskId: string): TurnRequest[] {
    return this.started().schedulerStore.forTask(taskId);
  }

  /** Whether the task's own turn requests or recovery identities exceed `limit`, each kind counted separately. */
  taskRetainedRowsExceed(taskId: string, limit: number): boolean {
    return (
      this.started().schedulerStore.countForTaskUpTo(taskId, limit + 1) >
        limit ||
      this.started().state.recoveryCountForTaskUpTo(taskId, limit + 1) > limit
    );
  }

  taskReview() {
    return this.started().coordination.taskReview();
  }

  localReviews() {
    return this.started().coordination.localReviews();
  }

  retainedEvidence() {
    return this.started().coordination.retainedEvidence();
  }

  async stageReviewAnchorDraft(input: RetainedReviewAnchorStageRequest) {
    const request = retainedReviewAnchorStageRequestSchema.parse(input);
    this.domain().task(request.taskId);
    const evidence = this.retainedEvidence();
    const materialHash = retainedReviewAnchorMaterialHash(request);
    const prior = evidence.reviewAnchorOperation(
      request.taskId,
      request.operationId,
      "stage",
      materialHash,
    );
    if (prior) {
      if (prior.state !== "staged")
        throw new DomainConflictError(
          "Review anchor operation response kind mismatch",
        );
      return prior;
    }

    const { candidates } = await this.captureReviewAnchors(request);
    return evidence.stageReviewAnchorDraft(
      request.taskId,
      request.operationId,
      materialHash,
      candidates,
    );
  }

  /** Captures anchors under one policy and workspace binding, rechecked after capture. */
  private async captureReviewAnchors(
    request: RetainedReviewAnchorStageRequest,
  ) {
    const task = this.domain().task(request.taskId);
    const evidence = this.retainedEvidence();
    const operatorApi = new OperatorApi(this, [
      this.dataDir,
      process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
    ]);
    const currentPolicy = async () => {
      const policy = await operatorApi.retainedEvidencePolicy(request.taskId);
      return policy
        ? {
            taskVersion: policy.taskVersion,
            fingerprint: policy.fingerprint,
            accessFingerprint: policy.accessFingerprint,
            excluded: policy.excluded,
            authorizedRepositoryIds: policy.authorizedRepositoryIds,
          }
        : undefined;
    };
    const currentWorkspace = () =>
      this.turnWorkspaceInspectionCurrent(request.taskId);
    const initialWorkspace = await currentWorkspace();
    if (initialWorkspace.taskVersion !== Number(task.version))
      throw new DomainConflictError("Review anchor task version changed");
    const initialPolicy = await currentPolicy();
    if (!initialPolicy || initialPolicy.taskVersion !== Number(task.version))
      throw new DomainConflictError("Review anchor policy is unavailable");
    const candidates = [];
    for (const selection of request.anchors)
      candidates.push(
        await captureRetainedReviewAnchor({
          selection,
          identity: {
            taskId: request.taskId,
            captureTaskVersion: Number(task.version),
          },
          currentWorkspace,
          currentPolicy,
          exportComparison: (comparisonId) =>
            this.workspaceComparisonExport(request.taskId, comparisonId),
          comparisonOwner: (comparisonId) =>
            this.current?.workspaceComparisons.comparisonOwner(comparisonId),
          retainedEvidence: evidence,
        }),
      );
    const [latestPolicy, latestWorkspace] = await Promise.all([
      currentPolicy(),
      currentWorkspace(),
    ]);
    if (
      !latestPolicy ||
      latestPolicy.taskVersion !== initialPolicy.taskVersion ||
      latestPolicy.fingerprint !== initialPolicy.fingerprint ||
      latestWorkspace.taskVersion !== initialWorkspace.taskVersion ||
      latestWorkspace.visibility !== initialWorkspace.visibility
    )
      throw new DomainConflictError(
        "Review anchor task or access binding changed during capture",
      );
    return { candidates, accessFingerprint: initialPolicy.accessFingerprint };
  }

  async stageLocalReviewAnchorGroup(input: {
    commandKey: string;
    taskId: string;
    ownerKey: string;
    expectedDraftVersion: number;
    requestHash: string;
    anchors: RetainedReviewAnchorStageRequest["anchors"];
  }) {
    const command = {
      commandKey: input.commandKey,
      taskId: input.taskId,
      ownerKey: input.ownerKey,
      requestHash: input.requestHash,
    };
    const prior = this.localReviews().replayStage(command);
    if (prior) return prior;
    const request = retainedReviewAnchorStageRequestSchema.parse({
      taskId: input.taskId,
      operationId: randomUUID(),
      anchors: input.anchors,
    });
    const { candidates, accessFingerprint } =
      await this.captureReviewAnchors(request);
    return this.localReviews().stageGroup({
      commandKey: input.commandKey,
      taskId: request.taskId,
      ownerKey: input.ownerKey,
      expectedDraftVersion: input.expectedDraftVersion,
      requestHash: input.requestHash,
      stageOperationId: request.operationId,
      stageMaterialHash: retainedReviewAnchorMaterialHash(request),
      candidates,
      accessFingerprint,
    });
  }

  sealReviewAnchorDraft(input: {
    taskId: string;
    draftId: string;
    operationId: string;
    anchorIds: readonly string[];
  }) {
    this.domain().task(input.taskId);
    const materialHash = materialDigest({
      taskId: input.taskId,
      draftId: input.draftId,
      anchorIds: [...input.anchorIds],
    });
    return this.retainedEvidence().sealReviewAnchorDraft(
      input.taskId,
      input.draftId,
      input.operationId,
      materialHash,
      input.anchorIds,
    );
  }

  discardReviewAnchorDraft(input: {
    taskId: string;
    draftId: string;
    operationId: string;
  }) {
    this.domain().task(input.taskId);
    const materialHash = materialDigest({
      taskId: input.taskId,
      draftId: input.draftId,
    });
    return this.retainedEvidence().discardReviewAnchorDraft(
      input.taskId,
      input.draftId,
      input.operationId,
      materialHash,
    );
  }

  domain(): DomainStore {
    return this.started().domain;
  }

  /** One source-explicit factory shared by synchronizer and both operator preview surfaces. */
  gitHubSourceReader(reference: string) {
    return this.sourceReader(() => this.domain(), reference);
  }

  private sourceReader(domain: () => DomainStore, reference: string) {
    return (
      this.options.github?.readerFactory?.(reference) ??
      new CredentialGitHubSourceReader(reference, {
        gh: () => ({
          executable: this.options.ghExecutable,
          environment: ghEnvironment(domain(), { reference }),
        }),
      })
    );
  }

  async gitHubSourceCredentialStatus(projectId: string, scope?: GhLoginScope) {
    const config = this.domain().githubConfiguration(projectId);
    const reference = config.credentialRef;
    const status = await gitHubSourceCredentialStatus(
      reference,
      {
        gh: () => ({
          executable: this.options.ghExecutable,
          environment: ghEnvironment(this.domain(), {
            reference: "gh:github.com",
          }),
        }),
      },
      scope,
    );
    if (status.reason)
      this.githubSources().invalidateCredentialFailure(
        {
          projectId,
          configVersion: config.version,
          credentialRef: reference,
        },
        status.reason,
      );
    return status;
  }

  /** Includes lifetime gh values even after every source/discovery reference has been cleared. */
  gitHubCredentialExclusions() {
    return gitHubCredentialExclusions(this.domain());
  }

  operatorCredentials(): OperatorCredentialStore {
    return this.started().operatorCredentials;
  }

  operatorPush(): OperatorPushStore {
    return this.started().operatorPush;
  }

  githubSources(): GitHubSourceStore {
    return this.started().githubSources;
  }

  async settleHandback(input: unknown) {
    const result =
      await this.started().deliveryCoordinator.settleHandback(input);
    await this.wakeScheduler();
    return result;
  }
  private async finalizeDeliveryCompletion(requestId: string, workId: string) {
    const started = this.started();
    const request = started.coordination
      .completionRequests()
      .find((r) => r.requestId === requestId);
    if (!request) throw new Error("Unknown completion request");
    const deliveryValidation =
      await started.deliveryCoordinator.qualifyCompletion(request.taskId);
    await this.reconcileOwnDeliveryClosures(started);
    return started.coordination.finalizeTaskCompletion({
      requestId,
      workId,
      terminal: "completed",
      deliveryValidation,
    });
  }
  delivery(): DeliveryStore {
    return this.started().deliveryStore;
  }
  /** Takes its components because delivery refresh can authorize before publication. */
  private authorizeDelivery(
    {
      deliveryStore,
      state,
      domain,
      coordination,
    }: Pick<Started, "deliveryStore" | "state" | "domain" | "coordination">,
    caller: DeliveryCaller,
    exceptOperationId?: string,
  ): void {
    if (isOperatorDeliveryCaller(caller)) {
      deliveryStore.validateOperatorCaller(caller);
      if (
        state.taskHold(caller.taskId) ||
        domain
          .admission(caller.taskId)
          .reasons.filter((reason) => !reason.startsWith("external-action-"))
          .length ||
        deliveryStore.actionBlockers(caller.taskId, exceptOperationId).length
      )
        throw new DomainConflictError("Task admission is held");
      return;
    }
    const intent = state.byWorkId(caller.workId);
    if (!intent?.threadId || !intent.turnId || intent.state !== "running")
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
    const reasons = domain
      .assignmentAdmission(caller.assignmentId)
      .reasons.filter((reason) => !reason.startsWith("external-action-"));
    if (
      reasons.length ||
      deliveryStore.actionBlockers(caller.taskId, exceptOperationId).length
    )
      throw new DomainConflictError("Task admission is held");
  }
  operatorCommentCaller(taskId: string): OperatorDeliveryCaller {
    const d = this.domain(),
      task = d.task(taskId),
      imported = d.importedTask(taskId),
      source = this.taskReview().sources(taskId).at(-1),
      review = imported
        ? this.githubSources().review(String(imported.nodeId))
        : undefined;
    if (!imported || !source || !review)
      throw new DomainConflictError("Imported task source unavailable");
    return {
      actor: "operator",
      principal: "installation-operator",
      projectId: String(task.projectId),
      taskId,
      taskVersion: Number(task.version),
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      sourceDigest: String(review.observedDigest),
      sourceNodeId: String(imported.nodeId),
      sourceRepositoryId: String(imported.repositoryId),
      policyVersion: this.delivery().configuration(String(task.projectId))
        .version,
    };
  }
  private operatorCommentAction(caller: OperatorDeliveryCaller, body: string) {
    const issue = this.githubSources().issue(caller.sourceNodeId);
    if (!issue)
      throw new DomainConflictError("Imported task issue unavailable");
    return {
      kind: "issue.comment" as const,
      target: {
        nodeId: caller.sourceNodeId,
        repositoryId: caller.sourceRepositoryId,
        number: Number(issue.issueNumber),
      },
      body,
    };
  }
  reviewOperatorComment(command: {
    key: string;
    taskId: string;
    operationId: string;
    expectedTaskVersion: number;
    body: string;
  }): OperatorCommentReview {
    const prior = this.delivery().operatorReview(command.key);
    if (prior) {
      if (prior.commandHash !== materialDigest(command))
        throw new DomainConflictError(
          "Operator review key reused with different material",
        );
      return prior;
    }
    const caller = this.operatorCommentCaller(command.taskId);
    return this.delivery().reviewOperatorComment(
      command,
      caller,
      this.operatorCommentAction(caller, command.body),
    );
  }
  confirmOperatorComment(command: {
    key: string;
    taskId: string;
    reviewId: string;
    expectedRevision: number;
    materialHash: string;
    decision: "approved" | "denied";
  }) {
    return this.delivery().confirmOperatorComment(command, () => {
      const record = this.delivery().operatorReview(command.reviewId);
      if (!record) throw new DomainConflictError("Operator review unavailable");
      this.authorizeDelivery(this.started(), record.caller);
    });
  }
  async postOperatorComment(command: {
    key: string;
    taskId: string;
    expectedTaskVersion: number;
    body: string;
    reviewId?: string | undefined;
  }): Promise<DeliveryActionRecord> {
    const prior = this.delivery()
      .actions(command.taskId)
      .find((a) => a.operationId === command.key);
    if (prior) {
      if (
        !isOperatorDeliveryCaller(prior.binding) ||
        prior.request.action.kind !== "issue.comment" ||
        prior.request.action.body !== command.body ||
        prior.binding.taskVersion !== command.expectedTaskVersion ||
        prior.request.operatorReviewId !== command.reviewId
      )
        throw new DomainConflictError(
          "Operation key used with different material or caller",
        );
      return prior;
    }
    const caller = this.operatorCommentCaller(command.taskId);
    if (caller.taskVersion !== command.expectedTaskVersion)
      throw new DomainConflictError("Operator task revision conflict");
    return this.started().deliveryCoordinator.submit(
      {
        operationId: command.key,
        action: this.operatorCommentAction(caller, command.body),
        ...(command.reviewId ? { operatorReviewId: command.reviewId } : {}),
      },
      caller,
    );
  }
  async refreshGitHub(): Promise<void> {
    const started = this.started();
    await started.deliveryCoordinator.refresh();
    await this.reconcileOwnDeliveryClosures(started);
    await started.githubSynchronizer.refresh();
    this.completeSettledProviderClosures(started);
    this.emitSourceHoldNotices(started);
    await this.wakeScheduler();
  }

  /** Takes its components because start-up reconciles before publication. */
  private async reconcileOwnDeliveryClosures({
    domain,
    deliveryStore,
    githubSources,
    deliveryCoordinator,
  }: Pick<
    Started,
    "domain" | "deliveryStore" | "githubSources" | "deliveryCoordinator"
  >): Promise<void> {
    for (const project of domain.projects())
      for (const task of domain.tasks(String(project.id))) {
        const imported = domain.importedTask(String(task.id));
        if (
          !imported ||
          !deliveryStore.ownsConfirmedClosure(
            String(task.id),
            String(imported.nodeId),
          )
        )
          continue;
        const source = githubSources.issue(String(imported.nodeId));
        if (!source) continue;
        const config = domain.githubConfiguration(String(project.id));
        const nodeId = String(imported.nodeId);
        try {
          const result = await deliveryCoordinator.inspectOwnClosure(
            String(task.id),
            {
              repositoryId: String(source.repositoryId),
              nodeId: String(source.nodeId),
              number: Number(source.issueNumber),
            },
            githubSources.deliveryClosure(nodeId),
          );
          if (result.kind === "reopened")
            githubSources.supersedeDeliveryClosure(nodeId, result.operationId);
          else if (result.kind === "attribution-unproved")
            githubSources.recordDeliveryClosureAttributionUnproved(nodeId);
          else
            githubSources.recordDeliveryClosure(
              String(project.id),
              config.version,
              result.snapshot,
              result.operationId,
              result.closerPrNodeId,
              result.closedEventId,
            );
        } catch {
          githubSources.recordDeliveryClosureUnavailable(nodeId);
        }
      }
  }

  /** Done-mode sources complete closure-held tasks once their execution has settled. */
  private completeSettledProviderClosures({
    githubSources,
    state,
  }: Pick<Started, "githubSources" | "state">): void {
    for (const hold of githubSources.activeHolds())
      if (hold.reason === "closed")
        githubSources.completeFromProviderClosure(hold.taskId, () =>
          state.taskExecutionSettled(hold.taskId),
        );
  }

  private emitSourceHoldNotices({
    githubSources: sources,
    domain,
    coordination,
  }: Pick<Started, "githubSources" | "domain" | "coordination">): void {
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
    const { domain, coordination, state, routingAttempts } = this.started();
    return new CoordinationView(
      domain,
      coordination,
      state,
      routingAttempts,
      () => this.wakeScheduler(),
      (taskId, assignmentId, beforeSequence, beforeOmissionSequence, limit) =>
        this.readConversationHistory(
          taskId,
          assignmentId,
          beforeSequence,
          beforeOmissionSequence,
          limit,
        ),
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
    const outcome = parseDomainCommandOutcome(
      "capacity.configure",
      this.domain().execute({
        ...command,
        type: "capacity.configure",
        actor: "operator",
      }),
    );
    if (outcome.type !== "capacity.configure")
      throw new CommandResultValidationError(
        "Capacity configuration returned the wrong result type",
      );
    await this.wakeScheduler();
    return outcome.result;
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
    const binding = await this.started().workspaces.provision(
      taskId,
      repositories,
    );
    await this.wakeScheduler();
    return binding;
  }

  taskWorkspaceVisibility(taskId: string) {
    const binding = this.started().workspaceBindings.get(taskId);
    return createHash("sha256")
      .update(
        JSON.stringify(
          binding
            ? {
                workspaceId: binding.workspaceId,
                path: binding.path,
                repositories: binding.repositories.map((r) => [
                  r.repositoryId,
                  r.sourcePath,
                  r.workspacePath,
                  r.gitCommonDir,
                ]),
              }
            : null,
        ),
      )
      .digest("hex");
  }
  /**
   * Stored workspace, source and Git paths for redaction only. Reads the persisted binding
   * without identity or Git validation, so polled reads reflect last-known state.
   */
  taskWorkspaceRedactionPaths(taskId: string): string[] {
    this.domain().task(taskId);
    const binding = this.started().workspaceBindings.get(taskId);
    if (!binding) return [];
    return [
      ...new Set([
        binding.path,
        ...binding.repositories.flatMap((r) => [
          r.sourcePath,
          r.workspacePath,
          ...(r.gitCommonDir ? [r.gitCommonDir] : []),
        ]),
      ]),
    ];
  }
  taskWorkspace(taskId: string, options?: { reuseRecentIdentity?: boolean }) {
    this.domain().task(taskId);
    return this.started().workspaces.get(taskId, options);
  }

  replaceWorkspaceComparison(
    comparison: WorkspaceComparisonSnapshot,
    sides: readonly WorkspaceComparisonSideContent[],
  ): void {
    this.domain().task(comparison.taskId);
    this.started().workspaceComparisons.replaceCurrentComparison(
      comparison,
      sides,
    );
  }

  currentWorkspaceComparison(
    taskId: string,
    repositoryId: string,
    target: WorkspaceComparisonSnapshot["target"],
  ): WorkspaceComparisonExport | undefined {
    this.domain().task(taskId);
    return this.current?.workspaceComparisons.currentComparison(
      taskId,
      repositoryId,
      target,
    );
  }

  workspaceComparisonById(
    taskId: string,
    comparisonId: string,
  ): WorkspaceComparisonExport | undefined {
    this.domain().task(taskId);
    return this.current?.workspaceComparisons.comparisonById(
      taskId,
      comparisonId,
    );
  }

  workspaceComparisonExport(
    taskId: string,
    comparisonId: string,
  ): WorkspaceComparisonExport | undefined {
    this.domain().task(taskId);
    return this.current?.workspaceComparisons.exportComparison(
      taskId,
      comparisonId,
    );
  }

  workspaceComparisonOwner(comparisonId: string): string | undefined {
    return this.current?.workspaceComparisons.comparisonOwner(comparisonId);
  }

  workspaceTurnCaptureSlots(taskId: string) {
    this.domain().task(taskId);
    return this.current?.workspaceComparisons.latestTurnCaptures(taskId) ?? {};
  }

  private async turnWorkspaceInspectionCurrent(
    taskId: string,
  ): Promise<WorkspaceInspectionCurrent> {
    const task = this.domain().task(taskId);
    const binding = await this.taskWorkspace(taskId, {
      reuseRecentIdentity: true,
    });
    return {
      taskId,
      taskVersion: Number(task.version),
      visibility: this.taskWorkspaceVisibility(taskId),
      ...(binding ? { binding } : {}),
      controlPaths: [
        this.dataDir,
        process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
      ],
    };
  }

  private async observeTurnWorkspace(
    taskId: string,
  ): Promise<WorkspaceTurnObservation> {
    try {
      return await observeWorkspaceTurn(taskId, () =>
        this.turnWorkspaceInspectionCurrent(taskId),
      );
    } catch {
      return {
        observedAt: Date.now(),
        state: "gap",
        reason: "workspace-unavailable",
        files: [],
        truncated: false,
      };
    }
  }

  private async recordTurnCaptureAfter(
    capture: WorkspaceTurnCaptureRecord,
    outcome: "completed" | "failed" | "unknown",
    captureState: "pending" | "unsettled",
    reason?: WorkspaceTurnCaptureReason,
  ): Promise<WorkspaceTurnCaptureRecord | undefined> {
    const before = capture.before;
    const store = this.current?.workspaceComparisons;
    if (!before || !store) return undefined;
    const after = await this.observeTurnWorkspace(capture.identity.taskId);
    const sideContent = new Map<number, WorkspaceComparisonSideContent>();
    const identity = {
      ...capture.identity,
      ...(capture.threadId ? { threadId: capture.threadId } : {}),
      ...(capture.turnId ? { turnId: capture.turnId } : {}),
    };
    let comparison: ReturnType<typeof compareWorkspaceTurnObservations>;
    try {
      comparison = compareWorkspaceTurnObservations(
        identity,
        capture.comparisonId,
        capture.startedAt,
        before,
        after,
        outcome,
        (entryIndex, side, text) => {
          const item = sideContent.get(entryIndex) ?? { entryIndex };
          if (side === "left") item.leftText = text;
          else item.rightText = text;
          sideContent.set(entryIndex, item);
        },
      );
    } catch {
      return undefined;
    }
    const { before: _before, after: _after, ...withoutObservations } = capture;
    const next = {
      ...withoutObservations,
      captureState,
      outcome,
      observedAt: after.observedAt,
      comparison,
      sides: [...sideContent.values()].sort(
        (a, b) => a.entryIndex - b.entryIndex,
      ),
      ...((reason ?? after.reason ?? capture.reason)
        ? { reason: reason ?? after.reason ?? capture.reason }
        : {}),
    } satisfies WorkspaceTurnCaptureRecord;
    try {
      return store.updatePendingTurnCapture(next) ? next : undefined;
    } catch {
      return undefined;
    }
  }

  private persistUnsettledTurnCapture(
    capture: WorkspaceTurnCaptureRecord,
    reason: WorkspaceTurnCaptureReason,
  ): WorkspaceTurnCaptureRecord | undefined {
    const store = this.current?.workspaceComparisons;
    if (!store) return undefined;
    const next = {
      ...capture,
      captureState: "unsettled" as const,
      reason,
    } satisfies WorkspaceTurnCaptureRecord;
    try {
      return store.updatePendingTurnCapture(next) ? next : undefined;
    } catch {
      return undefined;
    }
  }

  private finishTurnCapture(capture: WorkspaceTurnCaptureRecord): void {
    const store = this.current?.workspaceComparisons;
    if (!store) return;
    const {
      before: _before,
      after: _after,
      comparison: _comparison,
      sides: _sides,
      ...identityOnly
    } = capture;
    let finished = false;
    try {
      finished = store.finishTurnCapture({
        ...identityOnly,
        ...(capture.comparison ? { comparison: capture.comparison } : {}),
        ...(capture.sides ? { sides: capture.sides } : {}),
        captureState: "finished",
        outcome: "completed",
      });
    } catch {
      // A capture write must not change the observed runtime terminal or hold.
    }
    if (!finished) {
      this.persistUnsettledTurnCapture(
        {
          ...identityOnly,
          captureState: "unsettled",
          outcome: "completed",
          observedAt: Date.now(),
        },
        "capture-store-failed",
      );
    }
  }

  async archiveTask(taskId: string, evidence: WorkspaceCleanupEvidence) {
    this.domain().task(taskId);
    const state = this.started().state;
    const acquired =
      evidence.writerOwnershipResolved && state.beginArchive(taskId);
    if (!acquired)
      return this.started().workspaces.archiveAndCleanup(taskId, {
        ...evidence,
        writerOwnershipResolved: false,
      });
    let releaseArchiveHold = false;
    try {
      const path = this.current?.workspaceBindings.get(taskId)?.path;
      const workspace = path && existsSync(path) ? realpathSync(path) : path;
      const result = await this.started().workspaces.archiveAndCleanup(
        taskId,
        evidence,
        () => state.confirmArchive(taskId),
      );
      // The Claude sandbox temporary base lives exactly as long as the workspace.
      if (result.outcome === "cleaned" && workspace)
        await releaseClaudeTemporaryBase(workspace).catch(() => {});
      releaseArchiveHold =
        result.outcome === "cleaned" ||
        (result.outcome === "retained" &&
          result.binding.state === "ready" &&
          !result.binding.gitUncertain);
      return result;
    } finally {
      if (releaseArchiveHold) state.endArchive(taskId);
      await this.wakeScheduler();
    }
  }

  /** A replacement keeps the durable assignment and its captured revisions. */
  replaceConversation(assignmentId: string): number {
    this.domain().assignment(assignmentId);
    return this.started().state.replaceConversation(assignmentId);
  }

  isCurrentResult(workId: string): boolean {
    return this.started().state.isCurrentResult(workId);
  }

  recordTaskResult(workId: string, payload: string): boolean {
    return this.started().state.recordResult(workId, payload);
  }

  stopTask(taskId: string): Promise<StopObservation> {
    this.domain().task(taskId);
    return this.afterStop(taskId, this.started().state.stopTask(taskId));
  }

  /** Receipted Stop or Resume; a replayed receipt repeats no post-commit work. */
  async controlTask(command: {
    type: "task.stop" | "task.resume";
    key: string;
    taskId: string;
    expectedVersion?: number | undefined;
  }): Promise<TaskControlReceipt> {
    this.domain().task(command.taskId);
    const state = this.started().state;
    const { receipt, replayed } = state.controlTask(command);
    if (!replayed) {
      if (command.type === "task.stop")
        await this.afterStop(command.taskId, state.stopTargets(command.taskId));
      else {
        // Post-commit: the Resume receipt stands even if the wake fails.
        const generation = this.generation;
        if (generation)
          this.observeBackgroundFailure(generation, "domain-wake", () =>
            this.wakeScheduler(0, generation),
          );
      }
    }
    return receipt;
  }

  /** Cancels pending native questions and observes the stop for a bounded window. */
  private afterStop(
    taskId: string,
    targets: StopTarget[],
  ): Promise<StopObservation> {
    const { state, coordination, supervisor } = this.started();
    for (const target of targets) {
      const runtime = this.runtimeForWork(state, target.workId);
      const runtimeGeneration = runtime?.currentUserInputGeneration?.();
      if (!runtimeGeneration) continue;
      for (const question of coordination.runtimeQuestionsForWork(
        target.workId,
        true,
        runtimeGeneration,
      ))
        runtime?.cancelUserInput?.(
          question.identity,
          "Task stopped before native receipt",
        );
    }
    return supervisor.observeStop(taskId, targets);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.domain().task(taskId);
    this.started().state.resumeTask(taskId);
    await this.wakeScheduler();
  }

  taskHold(taskId: string): string | undefined {
    return this.started().state.taskHold(taskId);
  }

  nonStopTaskHoldReason(taskId: string): string | undefined {
    return this.started().state.nonStopTaskHoldReason(taskId);
  }

  hasNonStopTaskHold(taskId: string): boolean {
    return this.started().state.hasNonStopTaskHold(taskId);
  }

  isTaskStopped(taskId: string): boolean {
    return this.started().state.isTaskStopped(taskId);
  }

  /** A known survivor or unfinished tool callback keeps ownership held. */
  holdKnownSurvivor(workId: string, reason: string): void {
    const { state, supervisor, coordination } = this.started();
    const intent = state.byWorkId(workId);
    if (!intent || intent.state === "ready")
      throw new Error("No active execution to hold");
    const holdReason = `Known unfinished execution: ${reason}`;
    supervisor.noteSurvivor(workId);
    if (
      intent.state === "reconciled" &&
      coordination.recoveryDispositionForWork(workId) === "operator-reconciled"
    ) {
      state.holdReconciledContinuationSurvivor(workId, holdReason);
    }
    retractWriterAndSuccessors(state, intent, holdReason);
  }

  registerExecutionCallback(workId: string, callback: Promise<unknown>): void {
    const { state: executions, coordination } = this.started();
    const state = executions.byWorkId(workId)?.state;
    if (
      state === "completed" ||
      (state === "reconciled" &&
        coordination.recoveryDispositionForWork(workId) ===
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

  private handleUserInputRequest(
    call: RuntimeUserInputRequest,
    runtime: Runtime,
  ): void {
    const { state, coordination, supervisor } = this.started();
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
        supervisor.turnBound(
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
      const executions = state.executionsForRuntimeIdentity(
        call.identity.threadId,
        call.identity.turnId,
      );
      for (const execution of executions) {
        state.hold(execution.id, "Native callback could not be durably bound");
        supervisor.noteAnomaly(execution.workId);
      }
      runtime.cancelUserInput?.(
        call.identity,
        "Native callback binding failed",
      );
    }
  }
  private handleUserInputOutcome(outcome: RuntimeUserInputOutcome): void {
    const waiter = this.nativeWaiters.get(nativeEndpointKey(outcome));
    // Outcomes also arrive while runtimes start, before the service is published.
    const { coordination, state, supervisor } = this.acquired ?? {};
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
        const execution = state?.byWorkId(record.requestingWorkId);
        if (execution) {
          state?.hold(
            execution.id,
            "Native input delivery unavailable or uncertain",
          );
          supervisor?.noteAnomaly(execution.workId);
        }
      }
    } catch {
      const record = coordination.runtimeQuestionByEndpoint({
        requestId: outcome.requestId,
        runtimeGeneration: outcome.runtimeGeneration,
        threadId: outcome.threadId,
        turnId: outcome.turnId,
        itemId: outcome.itemId,
      });
      if (
        record &&
        !["confirmed", "uncertain", "unavailable"].includes(
          record.deliveryState,
        )
      )
        try {
          coordination.recordRuntimeReplyOutcome({
            ...record.identity,
            ...(record.replyIntentId
              ? {
                  replyIntentId: record.replyIntentId,
                  answerDigest: record.answerDigest ?? undefined,
                }
              : {}),
            outcome: record.replyIntentId ? "uncertain" : "unavailable",
            reason: "Native outcome could not be durably committed",
          });
        } catch {
          // Keep the writer held if the uncertainty update fails too.
        }
      const workId = waiter?.workId ?? record?.requestingWorkId;
      const execution = workId ? state?.byWorkId(workId) : undefined;
      if (state && execution) {
        retractWriterAndSuccessors(
          state,
          execution,
          "Native receipt could not be durably committed",
        );
        supervisor?.noteAnomaly(execution.workId);
      }
    }
  }
  private runtimeAnswerEligibility(question: RuntimeQuestionRecord): string[] {
    const state = this.started().state,
      runtime = this.runtimeForWork(state, question.requestingWorkId),
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
      runtime?.currentUserInputGeneration?.() !==
      question.identity.runtimeGeneration
    )
      reasons.push("native-process-generation-changed");
    const process = runtime?.processIdentity?.();
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
    if (this.current?.supervisor.hasKnownRisk(question.requestingWorkId))
      reasons.push("known-execution-risk");
    if (
      state.hasCompetingTaskExecution(
        question.taskId,
        question.requestingWorkId,
      )
    )
      reasons.push("competing-task-generation");
    if (!this.nativeWaiters.has(nativeEndpointKey(question.identity)))
      reasons.push("native-endpoint-unavailable");
    return reasons;
  }
  private flushRuntimeAnswers(): void {
    for (const runtime of this.runtimes.values())
      this.flushRuntimeAnswersFor(runtime);
  }
  private flushRuntimeAnswersFor(runtime: Runtime): void {
    const coordination = this.current?.coordination;
    const runtimeGeneration = runtime.currentUserInputGeneration?.();
    if (!coordination || !runtimeGeneration || !runtime.replyUserInput) return;
    let cursor = "";
    for (;;) {
      const page = coordination.pendingRuntimeAnswersPage(
        runtimeGeneration,
        cursor,
      );
      if (page.length === 0) break;
      for (const question of page) {
        cursor = question.interactionId;
        // Generations are not unique across harnesses: reply only through the
        // runtime the question's work is bound to; its own flush delivers it.
        if (
          this.runtimeForWork(
            this.started().state,
            question.requestingWorkId,
          ) !== runtime
        )
          continue;
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
        void runtime
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
            const current =
              this.current?.coordination.runtimeQuestionByInteractionId(
                question.interactionId,
                question.taskId,
              );
            if (
              current?.replyIntentId &&
              [...this.runtimes.values()].includes(runtime)
            ) {
              runtime.cancelUserInput?.(
                question.identity,
                "Native reply failed",
              );
            }
          });
      }
    }
  }

  private handleToolCall(call: RuntimeToolCall): Promise<RuntimeToolResult> {
    const { coordination, state } = this.started();
    if (!isCoordinationTool(call.tool))
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
    if (
      call.tool === "ensemble_report_result" &&
      (binding.requestSequence === null || binding.admittedTaskVersion === null)
    )
      return Promise.resolve({
        text: "Result callback is missing its exact admitted request identity",
        success: false,
      });

    let capturedDeliveryCaller: RuntimeDeliveryCaller | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        if (call.tool === "ensemble_external_action") {
          const caller = coordination.deliveryCaller(call as CoordinationCall);
          capturedDeliveryCaller = caller;
          const result = await this.started().deliveryCoordinator.submit(
            call.arguments,
            caller,
          );
          if (
            result.state === "confirmed-success" &&
            result.request.action.kind.startsWith("pr.")
          )
            await this.started().deliveryCoordinator.refresh();
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
          // Post-commit: a wake failure must not report committed work as failed.
          const generation = this.generation;
          if (generation)
            this.observeBackgroundFailure(generation, "domain-wake", () =>
              this.wakeScheduler(0, generation),
            );
          return response;
        }
        if (call.tool === "ensemble_register_pr") {
          const caller = coordination.deliveryCaller(call as CoordinationCall);
          capturedDeliveryCaller = caller;
          const result = await this.started().deliveryCoordinator.registerPr(
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
        let response: CoordinationToolResponse;
        if (call.tool === "ensemble_report_result") {
          const resultCall = call as CoordinationCall;
          let candidate:
            | Awaited<ReturnType<typeof captureRetainedResultEvidence>>
            | undefined;
          const review = reviewMetadataSchema.safeParse(
            resultCall.arguments.review,
          );
          if (
            binding.requestSequence !== null &&
            binding.admittedTaskVersion !== null &&
            !coordination.hasResultForWork(
              binding.workId,
              binding.workRevision,
            ) &&
            (resultCall.arguments.review === undefined || review.success)
          ) {
            const api = new OperatorApi(this, [
              this.dataDir,
              process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
            ]);
            const policy = () =>
              api.retainedEvidencePolicy(binding.taskId).then((value) =>
                value
                  ? {
                      taskVersion: value.taskVersion,
                      fingerprint: value.fingerprint,
                      excluded: value.excluded,
                      authorizedRepositoryIds: value.authorizedRepositoryIds,
                    }
                  : undefined,
              );
            const identity = {
              taskId: binding.taskId,
              taskVersion: binding.admittedTaskVersion,
              captureTaskVersion: binding.taskVersion,
              assignmentId: binding.assignmentId,
              assignmentVersion: binding.assignmentVersion,
              workId: binding.workId,
              workRevision: binding.workRevision,
              requestSequence: binding.requestSequence,
              conversationRevision: binding.conversationRevision,
              instructionsRevision: binding.instructionsRevision,
              profileRevision: binding.profileRevision,
              profileId: binding.profileId,
              threadId: call.threadId,
              turnId: call.turnId,
            };
            const retainedReview = review.success ? review.data : undefined;
            try {
              candidate = await captureRetainedResultEvidence({
                identity,
                review: retainedReview,
                currentWorkspace: () =>
                  this.turnWorkspaceInspectionCurrent(binding.taskId),
                currentPolicy: policy,
                turnCaptures: this.workspaceTurnCaptureSlots(binding.taskId),
                exportComparison: (comparisonId) =>
                  this.workspaceComparisonExport(binding.taskId, comparisonId),
              });
            } catch {
              candidate = failedRetainedResultEvidenceCandidate(
                identity,
                retainedReview,
              );
            }
            const latestBinding = state.coordinationBinding(
              call.threadId,
              call.turnId,
            );
            const exactBindingFields = [
              "taskId",
              "taskVersion",
              "admittedTaskVersion",
              "assignmentId",
              "assignmentVersion",
              "workId",
              "workRevision",
              "requestSequence",
              "conversationRevision",
              "instructionsRevision",
              "profileRevision",
              "profileId",
            ] as const;
            if (
              !latestBinding ||
              exactBindingFields.some(
                (field) => latestBinding[field] !== binding[field],
              )
            )
              throw new Error(
                "Coordination callback binding changed during result capture",
              );
          }
          response = coordination.recordResult(resultCall, candidate, {
            nativeResultCallback: true,
          }).response;
        } else {
          response = dispatchCoordinationTool(
            coordination,
            call as CoordinationCall,
            () => !state.taskHold(binding.taskId),
          );
        }
        if (response.success) {
          // Post-commit: a wake failure must not make the agent retry committed work.
          const generation = this.generation;
          if (generation)
            this.observeBackgroundFailure(generation, "domain-wake", () =>
              this.wakeScheduler(0, generation),
            );
        }
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
    this.started().schedulerStore.ensure({
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
      const previous = this.started().state.byWorkId(previousWorkId);
      if (
        previous?.state !== "completed" ||
        !previous.threadId ||
        previous.workspace !== workspaceKey
      )
        throw new Error(
          "Previous work is not a completed binding in this workspace",
        );
    }
    this.started().schedulerStore.ensure({
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
    this.started().state.create(workId, prompt, workspaceKey, previousWorkId);
    return this.dispatchAndRead(workId);
  }

  private async dispatchAndRead(workId: string): Promise<ExecutionIntent> {
    await this.wakeScheduler();
    const active = this.activeByWorkId.get(workId);
    if (active) return active;
    const intent = this.started().state.byWorkId(workId);
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

  private async wakeScheduler(
    refusalRebindPass = 0,
    generation = this.generation,
  ): Promise<void> {
    if (!generation || this.generation !== generation || !generation.accepting)
      return;
    // Unpublished during start-up, so start-up wakes cannot admit work.
    if (!this.current) return;
    // Every settled turn and resolved hold wakes the scheduler: a drained runtime stops here.
    this.stopDrainedRuntimes();
    const {
      scheduler,
      schedulerStore: store,
      domain,
      state,
      coordination,
      routingAttempts,
      wakeQueries: queries,
      inboxStartup,
    } = this.current;
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

    for (const completion of queries.pendingCompletionIdentities()) {
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

    for (const operationId of queries.missingRoutingFallbackOperationIds()) {
      const operation = domain.routingOperation(operationId);
      const disposition = String(operation.disposition);
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

    for (const identity of queries.uncommittedRoutingAttemptIdentities()) {
      const operation = routingAttempts.operation(
        identity.projectId,
        identity.taskId,
        identity.taskVersion,
      );
      if (
        !operation ||
        operation.operationId !== identity.operationId ||
        operation.status === "stale"
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
        const staleReason =
          this.routingStaleReason(domain, state, snapshot) ??
          (error instanceof DomainStaleDispositionError
            ? error.reason === "external-admission"
              ? "task-held"
              : "domain-disposition-rejected"
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
      if (queries.hasWork(initialWorkId)) continue;
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
        const existing = queries.oldestAssignmentWorkId(assignmentId);
        if (existing)
          store.hold(
            existing,
            `Assignment request became obsolete: ${String(error)}`,
          );
      }
    }

    for (const delivery of coordination.queuedDeliveries()) {
      if (deliveryWorkCompleted(delivery)) {
        coordination.completeDeliveryBatch(delivery.deliveryWorkId);
        continue;
      }
      if (queries.hasWork(delivery.deliveryWorkId)) continue;
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
        queries
          .unsettledAssignmentWorkIds(recipientAssignmentId)
          .some((workId) => !coordination.isHistoricalWorkResolved(workId))
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
      if (queries.hasWork(repair.repairWorkId)) continue;
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
    for (const queued of store.queued()) inboxStartup.capture(queued);
    if (this.generation !== generation || !generation.accepting) return;
    await scheduler.wake();
    if (refusalRebindPass === 0 && withdrawStaleRefusedDeliveries() > 0)
      await this.wakeScheduler(1, generation);
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

  /** The submitted prompt's Ensemble-supplied segments, in submission order. */
  private executionPromptParts(request: TurnRequest): PromptPart[] {
    if (
      request.kind !== "assignment" ||
      request.taskId === null ||
      request.projectId === null ||
      request.assignmentId === null
    )
      return [{ name: "request", text: request.prompt }];

    const state = this.started().state;
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
    const capture = (() => {
      try {
        return this.taskReview().contextForWork(
          binding.taskId,
          binding.assignmentId,
          request.workId,
          binding.assignmentVersion,
        );
      } catch {
        return undefined;
      }
    })();
    const source = capture?.sourceId
      ? this.taskReview().source(binding.taskId, capture.sourceId)
      : undefined;
    const reviewReferences = source
      ? JSON.stringify({
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          criteriaOmittedCount: source.criteriaOmittedCount,
          criteria: source.criteria,
        })
      : "Unavailable: no retained source capture for this work";
    return [
      { name: "request", text: request.prompt },
      { name: "role", text: roleContext },
      {
        name: "review-references",
        text: `Captured review references (JSON): ${reviewReferences}`,
      },
      {
        name: "project-instructions",
        revision: binding.instructionsRevision,
        text: `Captured project instructions (revision ${binding.instructionsRevision}):\n${projectInstructions || "(none)"}`,
      },
      {
        name: "profile-instructions",
        revision: binding.profileRevision,
        text: `Captured profile instructions (revision ${binding.profileRevision}):\n${profileInstructions || "(none)"}`,
      },
    ];
  }

  /**
   * Whether an older held turn of this assignment was reconciled by the operator without a
   * recorded continuation. Admission and the task read share this check.
   */
  recoveryContinuationUnresolved(
    assignmentId: string,
    excludeWorkId: string,
  ): boolean {
    return (
      this.current?.coordination.hasUnresolvedRecoveryContinuation(
        assignmentId,
        excludeWorkId,
      ) ?? false
    );
  }

  /**
   * Whether an imported task's workspace uses a repository the project no longer links
   * exactly. Admission and the task read share this check; it defaults to the stored binding
   * once that is ready, as admission only checks a ready workspace.
   */
  repositoryAccessRevoked(
    taskId: string,
    repositories?: TaskWorkspaceBinding["repositories"],
  ): boolean {
    const domain = this.domain();
    if (!domain.importedTask(taskId)) return false;
    if (!repositories) {
      // As admission sees it: only a ready workspace, whose repositories are all bound.
      // A workspace still provisioning, or whose provisioning failed, has no identity yet.
      const binding = this.current?.workspaceBindings.get(taskId);
      repositories = binding?.state === "ready" ? binding.repositories : [];
    }
    const linked = domain.githubConfiguration(
      String(domain.task(taskId).projectId),
    ).repositories;
    return repositories.some(
      (repository) =>
        !linked.some(
          (link) =>
            link.repositoryId === repository.repositoryId &&
            link.path === repository.sourcePath &&
            link.ref === repository.ref &&
            link.gitCommonDirectory === repository.gitCommonDir,
        ),
    );
  }

  private async attemptRequest(
    request: TurnRequest,
    generation = this.generation,
  ): Promise<void> {
    if (!generation || this.generation !== generation || !generation.accepting)
      return;
    const state = this.started().state;
    const store = this.started().schedulerStore;
    let workspaceKey: string;
    let context: TaskExecutionContext | undefined;
    let validateAssignment: (() => string[]) | undefined;
    try {
      if (request.taskId && request.assignmentId && request.projectId) {
        // Initial local tasks need no repository grant. Existing bindings,
        // including held/missing workspaces, remain the recovery authority.
        if (
          !this.current?.workspaceBindings.get(request.taskId) &&
          !this.domain().importedTask(request.taskId) &&
          !state.taskHold(request.taskId) &&
          !state.hasTaskWorkspaceEvidence(request.taskId)
        )
          await this.started().workspaces.provision(request.taskId, []);
        const binding = await this.started().workspaces.forExecution(
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
          if (this.recoveryContinuationUnresolved(assignmentId, request.workId))
            reasons.push("recovery-continuation-unresolved");
          if (
            this.repositoryAccessRevoked(binding.taskId, binding.repositories)
          )
            reasons.push("repository-access-revoked");
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
        const reason =
          "Previous work is not a completed binding in this workspace";
        const queuedIntent = state.byWorkId(request.workId);
        // state.hold also holds the request unless the intent is already settled.
        if (!queuedIntent || !state.hold(queuedIntent.id, reason))
          store.hold(request.workId, reason);
        return;
      }
    }
    let intent: ExecutionIntent;
    let binding: TaskExecutionBindingRecord | undefined;
    try {
      intent = state.create(
        request.workId,
        request.prompt,
        workspaceKey,
        request.previousWorkId ?? undefined,
      );
      binding = context
        ? state.bindTask(
            request.workId,
            context,
            this.domain().profileRuntime(
              String(this.domain().assignment(context.assignmentId).profileId),
              context.profileRevision,
            ).harness,
          )
        : undefined;
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
    // Shutdown may finish while workspace or process admission is awaiting.
    // A request with no admitted effect remains queued for ordinary restart.
    const harness = binding?.harness ?? defaultExecutionHarness;
    const runtime = this.runtimes.get(harness);
    // Never falls back to another harness's runtime. Queued work stays queued:
    // nothing is admitted or held until restart.
    const waitForRuntime = () => {
      const unavailable = this.runtimeWaitReason(harness);
      if (unavailable) {
        state.wait(intent.id, unavailable);
        store.wait(request.workId, unavailable);
      }
      return unavailable !== undefined;
    };
    try {
      // Known-unavailable runtimes are never awaited: the scheduler is serial.
      if (waitForRuntime()) return;
      const processIdentity = await (runtime
        ? this.untilFailure(
            runtime,
            Promise.resolve(runtime.processIdentity?.() ?? null),
            () => null,
          )
        : Promise.resolve(null)
      ).catch(() => null);
      if (
        this.runtimes.get(harness) !== runtime ||
        this.generation !== generation ||
        !generation.accepting
      )
        return;
      if (waitForRuntime()) return;
      if (!runtime) return;
      if (runtime.preflightTurn) {
        const preflight = runtime.preflightTurn.bind(runtime);
        const failed = `${executionHarnessLabels[harness]} runtime unavailable: preflight failed`;
        // A settings lookup failure waits like any other preflight failure.
        const reason = await this.untilFailure(
          runtime,
          (async () => {
            const settings = this.turnSettings(request);
            return preflight({
              workspace: workspaceKey,
              ...(settings ? { settings } : {}),
            });
          })(),
          () => failed,
        ).catch(() => failed);
        if (
          this.runtimes.get(harness) !== runtime ||
          this.generation !== generation ||
          !generation.accepting
        )
          return;
        if (waitForRuntime()) return;
        if (reason !== undefined) {
          state.wait(intent.id, reason);
          store.wait(request.workId, reason);
          return;
        }
      }
      // A sleep/wake during a turn that ended before now must be observed
      // first. No await may separate this check from state.begin.
      const power = this.current?.power;
      if (power && !power.observedForAdmission()) {
        const listenerFailure = power.sleepWakeListenerFailure();
        const reason = listenerFailure ?? "Waiting for power-event observation";
        state.wait(intent.id, reason);
        store.wait(request.workId, reason);
        // The interval poll retries a failed listener; polling here would spin
        // because each poll wakes this scheduler again.
        if (listenerFailure === null) this.pollPowerThenWake(power, generation);
        return;
      }
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

  /** Model settings of the bound profile revision; only Claude profiles carry them. */
  private turnSettings(request: TurnRequest): RuntimeTurnSettings | undefined {
    if (!request.assignmentId || request.profileRevision === null)
      return undefined;
    const domain = this.domain();
    const runtime = domain.profileRuntime(
      String(domain.assignment(request.assignmentId).profileId),
      request.profileRevision,
    );
    return runtime.harness === "claude"
      ? { model: runtime.model, reasoningEffort: runtime.reasoningEffort }
      : undefined;
  }

  /** Never awaited by admission: admissionResumed wakes the scheduler drain. */
  private pollPowerThenWake(
    power: ExecutionPower,
    generation: ServiceGeneration,
  ): void {
    this.observeBackgroundFailure(generation, "power-poll", async () => {
      await power.poll();
      await this.wakeScheduler(0, generation);
    });
  }

  private startExecution(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
  ): void {
    const power = this.current?.power;
    const generation = this.generation;
    const action = (async () => {
      try {
        await power?.executionStarted(request.workId);
        return await this.executeAdmitted(
          request,
          intent,
          workspace,
          previous,
          generation,
        );
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
        if (generation)
          this.observeBackgroundFailure(generation, "post-turn-wake", () =>
            this.wakeScheduler(0, generation),
          );
      })
      .catch(() => {});
  }

  private async executeAdmitted(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    previous?: ExecutionIntent,
    generation?: ServiceGeneration,
  ): Promise<ExecutionIntent> {
    const state = this.started().state;
    const harness = harnessForWork(state, request.workId);
    const runtime = this.runtimes.get(harness);
    if (!runtime) throw new Error("Runtime unavailable");
    // Shutdown settles active work, so a failed runtime must not leave it pending.
    const guard = <T>(work: Promise<T>) =>
      this.untilFailure(runtime, work, runtimeFailedError);
    let submissionStage: "resume" | "thread" | "bound" | "turn" = "thread";
    let captureThreadId: string | undefined;
    let turnCapture: WorkspaceTurnCaptureRecord | undefined;
    let conversationCapture: ConversationHistoryCapture | undefined;
    let diagnostics: ExecutionDiagnosticsCapture | undefined;
    const comparisonStore = this.current?.workspaceComparisons;
    if (
      comparisonStore &&
      request.kind === "assignment" &&
      request.taskId &&
      request.assignmentId
    ) {
      try {
        const identity = state.taskTurnCaptureIdentity(request.workId);
        if (
          identity &&
          identity.taskId === request.taskId &&
          identity.assignmentId === request.assignmentId &&
          identity.assignmentVersion === request.assignmentVersion &&
          identity.instructionsRevision === request.instructionsRevision &&
          identity.profileRevision === request.profileRevision
        ) {
          const startedAt = Date.now();
          const before = await this.observeTurnWorkspace(request.taskId);
          const capture: WorkspaceTurnCaptureRecord = {
            comparisonId: randomUUID(),
            identity: {
              taskId: identity.taskId,
              taskVersion: identity.taskVersion,
              workId: identity.workId,
              workRevision: identity.workRevision,
              requestSequence: identity.requestSequence,
              assignmentId: identity.assignmentId,
              assignmentVersion: identity.assignmentVersion,
              instructionsRevision: identity.instructionsRevision,
              profileRevision: identity.profileRevision,
              profileId: identity.profileId,
            },
            captureState: "pending",
            outcome: "running",
            startedAt,
            observedAt: before.observedAt,
            before,
          };
          comparisonStore.beginTurnCapture(capture);
          turnCapture = capture;
        }
      } catch {
        // Capture is observational; its storage failure cannot change admission.
      }
    }
    try {
      if (
        !generation ||
        this.generation !== generation ||
        !generation.accepting ||
        this.runtimes.get(harness) !== runtime
      )
        throw new Error(
          "Runtime generation changed before task turn submission",
        );
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      let threadId: string;
      const tools =
        request.kind === "assignment" && request.assignmentId
          ? coordinationTools
          : undefined;
      if (previous?.threadId) {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        submissionStage = "resume";
        await guard(runtime.resumeThread(previous.threadId, tools));
        threadId = previous.threadId;
      } else {
        if (state.get(intent.id).state !== "submitting")
          throw new Error("Execution admission was held");
        threadId = await guard(runtime.startThread(workspace, tools));
      }
      submissionStage = "bound";
      const threadBound = state.bindThread(intent.id, threadId);
      this.started().supervisor.threadBound(request.workId, threadId);
      if (!threadBound) throw new Error("Thread binding was held or changed");
      captureThreadId = threadId;
      if (state.get(intent.id).state !== "submitting")
        throw new Error("Execution admission was held");
      conversationCapture = this.beginConversationCapture(
        request,
        workspace,
        runtimeKey(harness, threadId),
        threadId,
      );
      diagnostics = this.beginDiagnosticCapture(
        request,
        intent,
        workspace,
        harness,
        runtime,
        threadId,
      );
      submissionStage = "turn";
      const prebindingGeneration = runtime.currentUserInputGeneration?.();
      const settings = this.turnSettings(request);
      const promptParts = this.executionPromptParts(request);
      const prompt = joinPromptParts(promptParts);
      // Synchronous and caught: recorded before submission, never delaying it.
      if (diagnostics)
        this.recordDiagnosticInputs(diagnostics, request, promptParts, prompt);
      const turnId = await guard(
        settings
          ? runtime.startTurn(threadId, workspace, prompt, settings)
          : runtime.startTurn(threadId, workspace, prompt),
      );
      const runtimeGeneration = runtime.currentUserInputGeneration?.();
      let turnBound = runtimeGeneration
        ? state.bindTurn(intent.id, turnId, runtimeGeneration)
        : state.bindTurn(intent.id, turnId);
      let nativeRejected = false;
      if (!turnBound) {
        const reconciliation = state.reconcileNativeTurnStartResponse({
          intentId: intent.id,
          workId: request.workId,
          threadId,
          turnId,
          runtimeGeneration: runtime.currentUserInputGeneration?.(),
        });
        turnBound = reconciliation.status === "matched";
        if (reconciliation.status === "rejected") {
          nativeRejected = true;
          const proof = reconciliation.prebinding;
          const binding = state.runtimeQuestionBinding(
            proof.threadId,
            proof.turnId,
          );
          const bindingMatchesProof =
            proof.workId === request.workId &&
            proof.intentId === intent.id &&
            proof.threadId === threadId &&
            proof.runtimeGeneration === prebindingGeneration &&
            binding !== undefined &&
            (
              [
                "workId",
                "taskId",
                "assignmentId",
                "assignmentVersion",
                "instructionsRevision",
                "profileRevision",
                "conversationRevision",
              ] as const
            ).every((key) => binding[key] === proof[key]);
          const rejectedQuestions = bindingMatchesProof
            ? (
                this.current?.coordination.runtimeQuestionsForWork(
                  request.workId,
                ) ?? []
              ).filter(
                (question) =>
                  question.requestingWorkId === proof.workId &&
                  question.requestingAssignmentId === proof.assignmentId &&
                  question.identity.threadId === proof.threadId &&
                  question.identity.turnId === proof.turnId &&
                  question.identity.runtimeGeneration ===
                    proof.runtimeGeneration &&
                  !["confirmed", "uncertain", "unavailable"].includes(
                    question.deliveryState,
                  ),
              )
            : [];
          state.hold(
            intent.id,
            "Native turn start response disagrees with admitted prebinding",
          );
          for (const question of rejectedQuestions) {
            runtime.cancelUserInput?.(
              question.identity,
              "Native prebinding rejected",
            );
            const current =
              this.current?.coordination.runtimeQuestionByEndpoint(
                question.identity,
              );
            if (
              current &&
              !["confirmed", "uncertain", "unavailable"].includes(
                current.deliveryState,
              )
            )
              this.handleUserInputOutcome({
                ...current.identity,
                ...(current.replyIntentId
                  ? {
                      replyIntentId: current.replyIntentId,
                      answerDigest: current.answerDigest ?? undefined,
                    }
                  : {}),
                outcome: current.replyIntentId ? "uncertain" : "unavailable",
                reason: "Native prebinding rejected",
              });
          }
        }
      }
      if (!nativeRejected)
        this.started().supervisor.turnBound(request.workId, threadId, turnId);
      if (turnBound) {
        diagnostics?.bind(turnId);
        diagnostics?.add(serviceItem("turn-bound", "info", { turnId }));
      }
      if (!turnBound) {
        conversationCapture?.discard();
        if (conversationCapture)
          this.removeConversationCapture(
            runtimeKey(harness, threadId),
            conversationCapture,
          );
        throw new Error("Turn binding was held or changed");
      }
      if (turnCapture && comparisonStore) {
        try {
          if (
            comparisonStore.bindTurnCapture(
              turnCapture.comparisonId,
              threadId,
              turnId,
            )
          )
            turnCapture = { ...turnCapture, threadId, turnId };
          else
            turnCapture = this.persistUnsettledTurnCapture(
              turnCapture,
              "capture-store-failed",
            );
        } catch {
          turnCapture = undefined;
        }
      }
      const exactBinding = this.safeConversationHistoryBinding(
        state,
        request.workId,
        threadId,
        turnId,
      );
      if (exactBinding) conversationCapture?.bind(exactBinding);
      else conversationCapture?.discard();
      const outcome = await guard(runtime.waitForTurn(threadId, turnId));
      diagnostics?.add(serviceItem("terminal-observed", "info", { outcome }));
      conversationCapture?.finish();
      if (conversationCapture)
        this.removeConversationCapture(
          runtimeKey(harness, threadId),
          conversationCapture,
        );
      this.started().supervisor.terminalObserved(
        request.workId,
        threadId,
        turnId,
        outcome,
      );
      if (turnCapture) {
        const admittedCapture = turnCapture;
        try {
          turnCapture =
            (await this.recordTurnCaptureAfter(
              admittedCapture,
              outcome,
              outcome === "completed" ? "pending" : "unsettled",
            )) ??
            this.persistUnsettledTurnCapture(
              {
                ...admittedCapture,
                outcome,
                observedAt: Date.now(),
              },
              "workspace-unavailable",
            );
        } catch {
          turnCapture = this.persistUnsettledTurnCapture(
            {
              ...admittedCapture,
              outcome,
              observedAt: Date.now(),
            },
            "workspace-unavailable",
          );
        }
      }
      if (
        outcome === "completed" &&
        (this.callbacks.get(request.workId)?.size ?? 0) > 0
      ) {
        state.hold(
          intent.id,
          "Ensemble callback is unfinished at terminal status",
        );
        if (turnCapture)
          turnCapture = this.persistUnsettledTurnCapture(
            turnCapture,
            "callback-unfinished",
          );
      } else if (outcome === "completed") {
        state.complete(intent.id, threadId, turnId);
        if (turnCapture?.comparison) this.finishTurnCapture(turnCapture);
        this.lastCompletedWorkId.set(harness, request.workId);
        const coordination = this.current?.coordination;
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
          evidence.source === "harness" &&
          evidence.harnessRetries !== null &&
          harnessRetrySupported(harness) &&
          callbacksEnded &&
          !this.started().supervisor.hasKnownRisk(request.workId) &&
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
            harness,
            source: "harness",
            harnessRetries: evidence.harnessRetries,
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
      if (turnCapture) {
        const admittedCapture = turnCapture;
        try {
          if (admittedCapture.comparison) {
            this.persistUnsettledTurnCapture(
              admittedCapture,
              admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
            );
          } else {
            turnCapture =
              (await this.recordTurnCaptureAfter(
                admittedCapture,
                "unknown",
                "unsettled",
                admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
              )) ??
              this.persistUnsettledTurnCapture(
                {
                  ...admittedCapture,
                  outcome: "unknown",
                  observedAt: Date.now(),
                },
                admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
              );
          }
        } catch {
          this.persistUnsettledTurnCapture(
            {
              ...admittedCapture,
              outcome: "unknown",
              observedAt: Date.now(),
            },
            admittedCapture.turnId ? "runtime-uncertain" : "turn-unbound",
          );
        }
      }
    } finally {
      if (conversationCapture) {
        conversationCapture.discard();
        if (captureThreadId)
          this.removeConversationCapture(
            runtimeKey(harness, captureThreadId),
            conversationCapture,
          );
      }
      if (diagnostics) {
        try {
          const settled = state.get(intent.id);
          diagnostics.add(
            serviceItem(
              "execution-settled",
              settled.state === "completed" ? "info" : "warn",
              { state: settled.state, reason: settled.reason },
            ),
          );
        } catch {
          // Display only; the settled state stays authoritative in its own table.
        }
        diagnostics.finish();
      }
    }
    return state.get(intent.id);
  }

  private beginConversationCapture(
    request: TurnRequest,
    workspace: string,
    captureKey: string,
    threadId: string,
  ): ConversationHistoryCapture | undefined {
    try {
      const { conversationHistory: history, state } = this.current ?? {};
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
      const previous = this.conversationCaptures.get(captureKey);
      previous?.discard();
      this.conversationCaptures.set(captureKey, capture);
      return capture;
    } catch {
      return undefined;
    }
  }

  /** Diagnostic store for operator reads; undefined until started or when unavailable. */
  executionDiagnostics(): ExecutionDiagnosticsStore | undefined {
    return this.current?.diagnostics;
  }

  /**
   * Starts capture for a task-bound execution once its thread is bound. Baseline
   * projects get an execution row and a `capture-baseline` gap only. Never throws.
   */
  private beginDiagnosticCapture(
    request: TurnRequest,
    intent: ExecutionIntent,
    workspace: string,
    harness: ExecutionHarness,
    runtime: Runtime,
    threadId: string,
  ): ExecutionDiagnosticsCapture | undefined {
    try {
      const store = this.current?.diagnostics;
      const binding = this.current?.state.taskBinding(request.workId);
      if (!store || !binding || !request.projectId) return undefined;
      const domain = this.domain();
      const mode = domain.diagnosticCaptureMode(request.projectId);
      store.begin({
        workId: request.workId,
        taskId: binding.taskId,
        projectId: request.projectId,
        assignmentId: binding.assignmentId,
        assignmentVersion: binding.assignmentVersion,
        instructionsRevision: binding.instructionsRevision,
        profileRevision: binding.profileRevision,
        conversationRevision: binding.conversationRevision,
        harness,
        mode,
        eventSource: runtime.onDiagnosticEvent ? "supported" : "unsupported",
      });
      store.bindThread(request.workId, threadId);
      if (mode === "baseline") {
        store.gap(request.workId, "capture-baseline");
        store.finish(request.workId);
        return undefined;
      }
      // Computed once per execution; every read re-sanitises with current exclusions.
      const exclusions = unionExclusions(
        this.conversationExclusions(binding, workspace, true),
        this.conversationExclusions(binding, workspace, false),
      );
      const capture = new ExecutionDiagnosticsCapture({
        store,
        workId: request.workId,
        threadId,
        exclusions,
      });
      const key = runtimeKey(harness, threadId);
      this.diagnosticCaptures.delete(key);
      this.diagnosticCaptures.set(key, capture);
      for (const old of this.diagnosticCaptures.keys()) {
        if (this.diagnosticCaptures.size <= 128) break;
        this.diagnosticCaptures.delete(old);
      }
      capture.add(serviceItem("thread-bound", "info", { threadId }));
      capture.add({
        turnId: undefined,
        kind: "setting",
        name: "settings",
        severity: "info",
        itemId: undefined,
        payload: {
          entries: this.diagnosticSettings(
            request,
            intent,
            harness,
            runtime,
            threadId,
          ),
        },
      });
      return capture;
    } catch {
      return undefined;
    }
  }

  private diagnosticSettings(
    request: TurnRequest,
    intent: ExecutionIntent,
    harness: ExecutionHarness,
    runtime: Runtime,
    threadId: string,
  ) {
    const admitted = (name: string, value: unknown) => ({
      name,
      value,
      source: "service-admitted",
    });
    const entries = [
      admitted("harness", harness),
      admitted("sandbox", intent.sandbox),
      admitted("approval", intent.approval),
      admitted("accountType", intent.accountType),
    ];
    try {
      const domain = this.domain();
      if (request.assignmentId && request.profileRevision !== null) {
        const configured = domain.profileRuntime(
          String(domain.assignment(request.assignmentId).profileId),
          request.profileRevision,
        );
        if (configured.harness === "claude")
          entries.push(
            admitted("profile.model", configured.model),
            admitted("profile.reasoningEffort", configured.reasoningEffort),
          );
      }
    } catch {
      // A missing profile revision leaves only the intent's settings.
    }
    let observed: Record<string, unknown> | undefined;
    try {
      observed = runtime.observedSettings?.(threadId) as
        | Record<string, unknown>
        | undefined;
    } catch {
      observed = undefined;
    }
    for (const name of [
      "model",
      "modelProvider",
      "reasoningEffort",
      "serviceTier",
    ])
      entries.push(
        observed && name in observed
          ? { name, value: observed[name], source: "runtime-reported" }
          : { name, value: null, source: "unknown" },
      );
    return entries;
  }

  /**
   * Records each supplied segment and the submitted size and digest. Instruction
   * segments keep the execution's own profile and project instruction texts
   * readable; every other value stays redacted.
   */
  private recordDiagnosticInputs(
    capture: ExecutionDiagnosticsCapture,
    request: TurnRequest,
    parts: readonly PromptPart[],
    prompt: string,
  ): void {
    try {
      const binding = this.started().state.taskBinding(request.workId);
      if (!binding) throw new Error("Execution binding unavailable");
      const general = capture.exclusions;
      const domain = this.domain();
      const assignment = domain.assignment(binding.assignmentId);
      const projectId = String(assignment.projectId),
        profileId = String(assignment.profileId);
      const own = new Set([
        String(
          domain.profileRevision(profileId, binding.profileRevision)
            .instructions ?? "",
        ),
        String(domain.profile(profileId).instructions ?? ""),
        domain.instructionRevision(projectId, binding.instructionsRevision),
        domain.instructionRevision(
          projectId,
          Number(domain.project(projectId).instructionsRevision),
        ),
      ]);
      const disclosing = general?.filter((value) => !own.has(value));
      for (const part of parts)
        capture.recordNow(
          "input",
          part.name,
          {
            text: part.text,
            ...(part.revision === undefined ? {} : { revision: part.revision }),
          },
          part.name.endsWith("-instructions") ? disclosing : general,
        );
      capture.recordNow(
        "input",
        "submitted",
        {
          bytes: Buffer.byteLength(prompt, "utf8"),
          sha256: createHash("sha256").update(prompt).digest("hex"),
        },
        [],
      );
      capture.add(
        serviceItem("input-captured", "info", { segments: parts.length }),
      );
    } catch {
      capture.gap("input-failed");
    }
  }

  /** Returns the listener's own result or rejection untouched. */
  private observeToolCall(
    call: RuntimeToolCall,
    harness: ExecutionHarness,
    result: Promise<RuntimeToolResult>,
  ): Promise<RuntimeToolResult> {
    const record = (payload: Record<string, unknown>, severity: string) => {
      try {
        this.diagnosticCaptures.get(runtimeKey(harness, call.threadId))?.add({
          turnId: call.turnId,
          kind: "tool",
          name: call.tool,
          severity,
          itemId: call.callId,
          payload: { arguments: call.arguments, ...payload },
        });
      } catch {
        // Diagnostics never change the tool response.
      }
    };
    return result.then(
      (value) => {
        record(
          { success: value.success, result: value.text },
          value.success ? "info" : "warn",
        );
        return value;
      },
      (error: unknown) => {
        record({ success: false, error: "rejected" }, "error");
        throw error;
      },
    );
  }

  private diagnosticServiceEvent(
    workId: string,
    name: string,
    severity: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      for (const capture of this.diagnosticCaptures.values())
        if (capture.workId === workId)
          capture.add(serviceItem(name, severity, payload));
    } catch {
      // Diagnostics never change anomaly handling.
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

  private receiveConversationEvent(
    event: RuntimeConversationEvent,
    harness: ExecutionHarness,
  ): void {
    this.conversationCaptures
      .get(runtimeKey(harness, event.threadId))
      ?.receive(event);
  }

  private removeConversationCapture(
    captureKey: string,
    capture: ConversationHistoryCapture,
  ): void {
    if (this.conversationCaptures.get(captureKey) === capture)
      this.conversationCaptures.delete(captureKey);
  }

  private clearConversationCaptures(): void {
    for (const capture of this.conversationCaptures.values()) capture.discard();
    this.conversationCaptures.clear();
    // Unfinished rows are marked interrupted by closeOpen at the next start.
    this.diagnosticCaptures.clear();
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
    beforeSequence?: number,
    beforeOmissionSequence?: number,
    limit = 200,
  ): ConversationHistoryAssignmentRead {
    return this.started().conversationHistory.readAssignment(
      taskId,
      assignmentId,
      limit,
      this.conversationExclusionsForAssignment(taskId, assignmentId),
      beforeSequence,
      beforeOmissionSequence,
    );
  }

  private conversationExclusionsForAssignment(
    taskId: string,
    assignmentId: string,
    revisions?: { profileRevision: number; instructionsRevision: number },
    additionalPaths: readonly string[] = [],
  ): readonly string[] | undefined {
    const domain = this.current?.domain;
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
      const claudeRef = domain.claudeTokenReference();
      const fixtureValues =
        this.options.conversationHistoryExclusions?.() ?? [];
      const workspace = this.current?.workspaceBindings.get(taskId);
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
      this.canonicalDataDir ??= existsSync(this.dataDir)
        ? realpathSync(this.dataDir)
        : this.dataDir;
      const values = [
        String(profileInstructions ?? ""),
        projectInstructions,
        this.dataDir,
        this.canonicalDataDir,
        ...managedPaths,
        ...additionalPaths,
        ...Object.entries(process.env).flatMap(([name, value]) =>
          /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/.test(name) && value
            ? [value]
            : [],
        ),
        ...this.gitHubCredentialExclusions().redactions,
        ...(claudeRef ? claudeTokenExclusions(claudeRef).redactions : []),
        ...fixtureValues,
        ...domain.projects().flatMap((p) => {
          const id = String(p.id);
          return [
            domain.routingCredentialReference(id),
            this.current?.deliveryStore.configuration(id).credentialRef,
          ].flatMap((ref) =>
            ref ? [ref, ref.slice(4), process.env[ref.slice(4)] ?? ""] : [],
          );
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
    if (isWithin(managedRoot, workspaceKey))
      throw new Error("Task workspaces require a durable assignment binding");
    return workspaceKey;
  }

  private started(): Started {
    if (!this.current) throw new Error("Service is not started");
    return this.current;
  }
}
