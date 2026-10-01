import type { z } from "zod";
import {
  type DeliveryStore,
  externalActionArgumentsSchema,
  registerPrArgumentsSchema,
  handbackSettlementSchema,
  materialDigest,
  type DeliveryActionRecord,
  type DeliveryCaller,
  type ExternalActionArguments,
  type DeliveryPolicy,
  type PrDeliveryBinding,
  type PrDeliveryObservation,
  type ProviderActionObservation,
} from "../core/delivery.js";
import {
  type GitHubDeliveryProvider,
  GitHubHttpDeliveryProvider,
} from "./github-delivery.js";

/** Only provider inspection failures are recoverable per-binding read holds. */
class DeliveryReadUnavailable extends Error {
  constructor() {
    super("Delivery provider inspection unavailable");
  }
}

export interface DeliveryCoordinatorOptions {
  fetcher?: typeof fetch;
  providerFactory?: (
    projectId: string,
    policy: DeliveryPolicy,
  ) => GitHubDeliveryProvider;
  authorize: (
    caller: DeliveryCaller,
    exceptOperationId?: string,
    request?: ExternalActionArguments,
  ) => void;
  approved: (
    request: ExternalActionArguments,
    caller: DeliveryCaller,
  ) => boolean;
  taskVersion?: (taskId: string) => number;
  leadAssignmentId?: (taskId: string) => string;
  feedback?: (taskId: string, reason: string, identity: string) => void;
  activationAllowed?: (policy: DeliveryPolicy) => boolean;
}
function actionKeys(record: {
  binding: DeliveryCaller;
  request: ExternalActionArguments;
}): string[] {
  const target = record.request.action.target;
  return [
    `task:${record.binding.taskId}`,
    `target:${target.repositoryId}:${"number" in target ? target.number : target.headRef}`,
  ];
}
/** Serializes a task and exact target; awaits provider I/O outside SQLite transactions. */
export class DeliveryCoordinator {
  private readonly tails = new Map<string, Promise<unknown>>();
  private stopped = false;
  constructor(
    private readonly store: DeliveryStore,
    private readonly options: DeliveryCoordinatorOptions,
  ) {}
  private provider(
    projectId: string,
    policy = this.store.configuration(projectId),
  ): GitHubDeliveryProvider {
    if (this.options.providerFactory)
      return this.options.providerFactory(projectId, policy);
    const credential = policy.credentialRef
      ? process.env[policy.credentialRef.slice(4)]
      : undefined;
    return new GitHubHttpDeliveryProvider(
      credential ?? "",
      this.options.fetcher,
    );
  }
  private serialize<T>(keys: string[], run: () => Promise<T>): Promise<T> {
    const prior = [
      ...new Set(
        keys
          .map((k) => this.tails.get(k))
          .filter((p): p is Promise<unknown> => p !== undefined),
      ),
    ];
    const promise = Promise.allSettled(prior).then(run);
    for (const key of keys) this.tails.set(key, promise);
    void promise
      .finally(() => {
        for (const key of keys)
          if (this.tails.get(key) === promise) this.tails.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  submit(
    input: unknown,
    caller: DeliveryCaller,
  ): Promise<DeliveryActionRecord> {
    const request = externalActionArgumentsSchema.parse(input);
    return this.serialize(
      actionKeys({ binding: caller, request }),
      async () => {
        if (this.stopped) throw new Error("Delivery coordinator stopped");
        const prior = this.store
          .actions(caller.taskId)
          .find((r) => r.operationId === request.operationId);

        const record = this.store.prepareAction(
          request,
          caller,
          this.options.approved(request, caller),
          () => {
            if (!prior) this.options.authorize(caller);
          },
        );
        if (record.state !== "prepared") return record;
        return this.attempt(record);
      },
    );
  }
  private async attempt(
    record: DeliveryActionRecord,
  ): Promise<DeliveryActionRecord> {
    const caller = record.binding,
      policy = this.store.configuration(caller.projectId);
    const provider = this.provider(caller.projectId, policy);
    let before: Record<string, z.output<ReturnType<typeof z.json>>>;
    try {
      before = await provider.preflight(record.request.action, policy);
    } catch {
      return this.store.recordObservation(record.operationId, {
        state: "confirmed-failure",
        reason: "provider-preflight-held",
        receipt: null,
      });
    }
    // Reuse final-completion evidence under the already-held task serialization.
    // The action's own prepared intent is the only delivery effect excluded.
    const closureGuard =
      record.request.action.kind === "issue.close"
        ? await this.qualifyCompletionWithinTask(
            caller.taskId,
            record.operationId,
          )
        : undefined;
    // All new authority is checked synchronously after the final provider await.
    let attempting: DeliveryActionRecord;
    try {
      attempting = this.store.beginAttempt(record.operationId, before, () => {
        if (closureGuard?.().length)
          throw new Error("PR delivery boundary held");
        if (this.stopped || this.options.activationAllowed?.(policy) === false)
          throw new Error(
            "Delivery credential activation requires safe runtime restart",
          );
        this.options.authorize(caller, record.operationId, record.request);
        this.store.authorize(
          record.request,
          caller,
          this.options.approved(record.request, caller),
          record.policyVersion,
        );
      });
    } catch {
      return this.store.recordObservation(record.operationId, {
        state: "confirmed-failure",
        reason: "delivery-authority-stale-or-held",
        receipt: null,
      });
    }
    let observation: ProviderActionObservation;
    try {
      observation = await provider.performAction(attempting);
    } catch {
      observation = {
        state: "uncertain" as const,
        reason: "provider-effect-unproved",
        receipt: null,
      };
    }
    const observed = this.store.recordObservation(
      record.operationId,
      observation,
    );
    if (
      observed.state === "confirmed-failure" &&
      observed.observation?.retryable &&
      observed.attempts < 3
    )
      return this.attempt(observed);
    return observed;
  }
  async registerPr(input: unknown, caller: DeliveryCaller) {
    const identity = registerPrArgumentsSchema.parse(input);
    return this.serialize([`task:${caller.taskId}`], async () => {
      this.options.authorize(caller);
      const policy = this.store.configuration(caller.projectId),
        taskVersion =
          this.options.taskVersion?.(caller.taskId) ?? caller.taskVersion;
      const observation = await this.provider(
        caller.projectId,
        policy,
      ).inspectPr(identity, policy);
      return this.store.transaction(() => {
        this.options.authorize(caller);
        if (
          policy.version !==
            this.store.configuration(caller.projectId).version ||
          taskVersion !==
            (this.options.taskVersion?.(caller.taskId) ?? caller.taskVersion) ||
          observation.headSha !== identity.expectedHeadSha
        )
          throw new Error("PR registration material changed");
        const lead =
          this.options.leadAssignmentId?.(caller.taskId) ?? caller.assignmentId;
        if (lead !== caller.assignmentId)
          throw new Error("Only the task lead registers PR delivery");
        return this.store.registerPrWithinTransaction(
          caller,
          observation,
          lead,
        );
      });
    });
  }
  async inspectOwnClosure(
    taskId: string,
    target: { repositoryId: string; nodeId: string; number: number },
  ) {
    if (!this.store.ownsConfirmedClosure(taskId, target.nodeId))
      throw new Error("Closure is not attributed to this task");
    const record = this.store
      .actions(taskId)
      .find(
        (a) =>
          a.state === "confirmed-success" &&
          ((a.request.action.kind === "issue.close" &&
            a.request.action.target.nodeId === target.nodeId &&
            a.beforeState?.state === "open") ||
            a.request.action.kind === "pr.merge"),
      );
    if (!record) throw new Error("Confirmed closure receipt unavailable");
    return this.serialize(
      [`task:${taskId}`, `target:${target.repositoryId}:${target.number}`],
      async () => {
        const provider = this.provider(record.binding.projectId);
        if (!provider.inspectClosedIssue)
          throw new Error("Fresh closure inspection unavailable");
        const closerPrNodeId =
          record.request.action.kind === "pr.merge"
            ? record.request.action.target.nodeId
            : null;
        const snapshot = await provider.inspectClosedIssue({
          ...target,
          ...(closerPrNodeId ? { expectedCloserPrNodeId: closerPrNodeId } : {}),
        });
        return { snapshot, operationId: record.operationId, closerPrNodeId };
      },
    );
  }
  async refresh(): Promise<void> {
    await this.reconcile();
    for (const binding of this.store.deliveries())
      await this.serialize([`task:${binding.taskId}`], async () => {
        if (this.stopped) return;
        try {
          await this.inspectBinding(binding.taskId);
        } catch (error) {
          if (!(error instanceof DeliveryReadUnavailable)) throw error;
        }
      });
  }
  private async inspectBinding(taskId: string) {
    const binding = this.store.delivery(taskId);
    if (!binding) throw new Error("Unknown PR delivery");
    const policy = this.store.configuration(binding.projectId),
      p = binding.observation,
      provider = this.provider(binding.projectId, policy);
    let observation: PrDeliveryObservation;
    try {
      observation = await provider.inspectPr(
        {
          repositoryId: p.repositoryId,
          prNumber: p.number,
          expectedPrNodeId: p.nodeId,
          expectedHeadSha: p.headSha,
        },
        policy,
      );
    } catch {
      this.store.recordPrReadFailure(taskId);
      throw new DeliveryReadUnavailable();
    }
    return this.store.transaction(() => {
      const current = this.store.delivery(taskId);
      if (!current || current.revision !== binding.revision)
        throw new Error("PR delivery changed during inspection");
      const result = this.store.observePrWithinTransaction(taskId, observation);
      if (result.changed)
        this.options.feedback?.(
          taskId,
          `PR delivery feedback changed: ${observation.checks.map((c) => `${c.name}: ${c.status}`).join("; ")}. ${(
            observation.feedback ?? []
          )
            .slice(-10)
            .map((f) => `${f.kind} ${f.nodeId} (${f.state}): ${f.body}`)
            .join("\n")}`,
          `${result.binding.revision}:${result.binding.observationDigest}`,
        );
      return result.binding;
    });
  }
  async settleHandback(input: unknown) {
    const command = handbackSettlementSchema.parse(input);
    return this.serialize([`task:${command.taskId}`], async () => {
      const receipt = this.store.settlementReceipt(command);
      if (receipt) return receipt;
      const prior = this.store.delivery(command.taskId);
      if (!prior) throw new Error("Unknown PR delivery");
      const taskVersion =
          this.options.taskVersion?.(command.taskId) ??
          command.expectedTaskVersion,
        policy = this.store.configuration(prior.projectId);
      if (
        prior.observation.repositoryId !== command.repositoryId ||
        prior.observation.nodeId !== command.expectedPrNodeId ||
        prior.observation.number !== command.prNumber
      )
        throw new Error("Handback target changed");
      const observed = await this.inspectBinding(command.taskId);
      // Changed observations and their durable feedback survive a rejected command.
      return this.store.transaction(() => {
        if (
          taskVersion !== command.expectedTaskVersion ||
          (this.options.taskVersion?.(command.taskId) ?? taskVersion) !==
            taskVersion ||
          policy.version !== command.expectedPolicyVersion ||
          this.store.configuration(prior.projectId).version !==
            policy.version ||
          prior.revision !== command.expectedDeliveryRevision ||
          observed.revision !== prior.revision ||
          observed.observation.headSha !== command.expectedHeadSha
        )
          throw new Error("Handback material changed during fresh inspection");
        const result = this.store.settleHandbackWithinTransaction(command);
        this.options.feedback?.(
          command.taskId,
          "Operator handback settled",
          `settlement:${command.key}`,
        );
        return result;
      });
    });
  }
  async qualifyCompletion(taskId: string): Promise<() => string[]> {
    return this.serialize([`task:${taskId}`], () =>
      this.qualifyCompletionWithinTask(taskId),
    );
  }
  private async qualifyCompletionWithinTask(
    taskId: string,
    exceptOperationId?: string,
  ): Promise<() => string[]> {
    const binding = this.store.delivery(taskId),
      taskVersion = this.options.taskVersion?.(taskId);
    if (!binding)
      return () =>
        this.store.delivery(taskId)
          ? ["delivery-completion-evidence-changed"]
          : this.store.completionBlockers(
              taskId,
              taskVersion,
              exceptOperationId,
            );
    const policyVersion = this.store.configuration(binding.projectId).version;
    let observed: PrDeliveryBinding;
    try {
      observed = await this.inspectBinding(taskId);
    } catch (error) {
      if (!(error instanceof DeliveryReadUnavailable)) throw error;
      return () => ["delivery-provider-read-unavailable"];
    }
    const revision = observed.revision,
      digest = materialDigest(observed.observation);
    return () => {
      const current = this.store.delivery(taskId);
      if (
        !current ||
        current.revision !== revision ||
        materialDigest(current.observation) !== digest ||
        this.store.configuration(binding.projectId).version !== policyVersion ||
        this.options.taskVersion?.(taskId) !== taskVersion
      )
        return ["delivery-completion-evidence-changed"];
      if (revision !== binding.revision)
        return ["delivery-changed-before-completion"];
      return this.store.completionBlockers(
        taskId,
        taskVersion,
        exceptOperationId,
      );
    };
  }
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    for (const record of this.store.actions()) {
      if (
        !["prepared", "attempting", "uncertain"].includes(record.state) &&
        !(
          record.state === "confirmed-failure" &&
          record.observation?.retryable &&
          record.attempts < 3
        )
      )
        continue;
      await this.serialize(actionKeys(record), async () => {
        const current = this.store.action(record.operationId);
        if (
          current.state === "prepared" ||
          (current.state === "confirmed-failure" &&
            current.observation?.retryable &&
            current.attempts < 3)
        ) {
          await this.attempt(current);
          return;
        }
        if (!["attempting", "uncertain"].includes(current.state)) return;
        let observation: ProviderActionObservation;
        try {
          observation = await this.provider(
            current.binding.projectId,
          ).inspectAction(current);
        } catch {
          observation = {
            state: "uncertain" as const,
            reason: "provider-readback-unavailable",
            receipt: null,
          };
        }
        this.store.recordObservation(current.operationId, observation);
      });
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...new Set(this.tails.values())]);
  }
}

/** Spawn snapshot only: accepted host reads and ordinary Codex login remain available. */
export function deliveryRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  policies: readonly DeliveryPolicy[],
): NodeJS.ProcessEnv {
  const result = { ...environment },
    keys = policies.flatMap((p) =>
      p.credentialRef ? [p.credentialRef.slice(4)] : [],
    );
  const values = new Set(
    keys.map((k) => environment[k]).filter((v): v is string => Boolean(v)),
  );
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (keys.includes(key) || (value !== undefined && values.has(value)))
      delete result[key];
  }
  return result;
}
