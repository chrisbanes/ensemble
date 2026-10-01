import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StandaloneService,
  type RuntimeSpawnContext,
} from "../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../src/standalone/codex.js";
import type { GitHubDeliveryProvider } from "../src/standalone/github-delivery.js";
import type {
  ExternalAction,
  PrDeliveryObservation,
} from "../src/core/delivery.js";

export async function deliveryFixture(
  mode: "reviewable-pr" | "through-merge" = "reviewable-pr",
  imported = false,
) {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "ensemble-delivery-bound-")),
    ),
    projectId = randomUUID(),
    profileId = randomUUID();
  let taskId: string = randomUUID();
  let sourceLabels = ["ready"];
  let tool: ((call: RuntimeToolCall) => Promise<RuntimeToolResult>) | undefined;
  let stopped = false;
  const turns: Array<{
    threadId: string;
    turnId: string;
    release: () => void;
  }> = [];
  let waiter: (() => void) | undefined;
  let sequence = 0;
  let spawnContext: RuntimeSpawnContext | undefined;
  const runtime: Runtime = {
    async start() {},
    async stop() {
      stopped = true;
      waiter?.();
    },
    onUnexpectedRequest() {},
    onToolCall(handler) {
      tool = handler;
    },
    async startThread() {
      return "thread";
    },
    async resumeThread() {},
    async startTurn(threadId) {
      const turnId = `turn-${++sequence}`;
      turns.push({ threadId, turnId, release: () => waiter?.() });
      return turnId;
    },
    async interruptTurn() {
      waiter?.();
    },
    async waitForTurn() {
      await new Promise<void>((resolve) => {
        waiter = resolve;
        if (stopped) resolve();
      });
      return "completed";
    },
  };
  let pr: PrDeliveryObservation = {
    repositoryId: "R1",
    nodeId: "P7",
    number: 7,
    baseRef: "main",
    headRef: "cb/change",
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    state: "OPEN",
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash"],
  };
  const effects: ExternalAction[] = [];
  let preflightWait: Promise<void> | undefined;
  let readFailure = false;
  const provider: GitHubDeliveryProvider = {
    async inspectClosedIssue() {
      return {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "org/repo",
        number: 1,
        title: "T",
        body: "O",
        state: "closed",
        labels: sourceLabels,
        projectFields: [],
      };
    },
    async preflight(action) {
      if (preflightWait) await preflightWait;
      if (action.kind === "pr.merge" && pr.mergeBlockers.length)
        throw new Error("held");
      return { nodeId: "target" };
    },
    async performAction(record) {
      effects.push(record.request.action);
      if (record.request.action.kind === "pr.merge")
        pr = {
          ...pr,
          state: "MERGED",
          merged: true,
          closedIssueNodeIds: imported ? ["I1"] : [],
        };
      return {
        state: "confirmed-success",
        reason: null,
        receipt: {
          nodeId: record.request.action.kind.startsWith("pr.") ? "P7" : "C1",
          ...(record.request.action.kind === "pr.merge"
            ? { merged: true, headSha: pr.headSha }
            : {}),
        },
      };
    },
    async inspectAction() {
      return { state: "uncertain", reason: "unproved", receipt: null };
    },
    async inspectPr() {
      if (readFailure) throw new Error("unavailable");
      return pr;
    },
  };
  const service = new StandaloneService(
    join(root, "data"),
    (context) => {
      spawnContext = context;
      return runtime;
    },
    undefined,
    {
      delivery: { providerFactory: () => provider },
      github: {
        readerFactory: () => ({
          async readSelection() {
            return {
              complete: true,
              issues: pr.merged
                ? []
                : [
                    {
                      providerInstance: "github.com",
                      nodeId: "I1",
                      repositoryId: "R1",
                      repositoryName: "org/repo",
                      number: 1,
                      title: "T",
                      body: "O",
                      state: "open",
                      labels: sourceLabels,
                      projectFields: [],
                    },
                  ],
              reason: null,
            };
          },
          async readBlockers() {
            return { complete: true, blockers: [], reason: null };
          },
          async readIssueStatus() {
            return { status: pr.merged ? "closed" : "open" };
          },
        }),
      },
      power: { enabled: false },
    },
  );
  await service.start();
  const domain = service.domain();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "P",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "Deliver the scoped task and satisfy provider gates.",
  });
  if (imported) {
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:FIXTURE_SOURCE",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R1",
          owner: "org",
          name: "repo",
        },
      ],
      readiness: {
        mode: "any",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 2,
    });
    await service.refreshGitHub();
    taskId = String(service.githubSources().issue("I1")?.taskId);
  } else
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
      ready: true,
    });
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode,
    credentialRef: null,
    grants: [
      { action: "issue.comment", repositoryId: "R1", mode: "allow" },
      { action: "issue.edit", repositoryId: "R1", mode: "allow" },
      { action: "pr.merge", repositoryId: "R1", mode: "allow" },
    ],
    requiredChecks: [],
  });
  await service.provisionTask(taskId);
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    paused: false,
  });
  async function waitTurn(index = 0) {
    const deadline = Date.now() + 5000;
    while (
      !turns[index] ||
      !service
        .list()
        .some((i) => i.turnId === turns[index]?.turnId && i.state === "running")
    ) {
      if (Date.now() > deadline) throw new Error("Bound turn did not start");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const turn = turns[index];
    assert.ok(turn);
    return turn;
  }
  const call = async (
    toolName: string,
    args: Record<string, unknown>,
    index = turns.length - 1,
  ) => {
    const turn = await waitTurn(index);
    assert.ok(tool);
    return tool({
      threadId: turn.threadId,
      turnId: turn.turnId,
      callId: randomUUID(),
      tool: toolName,
      arguments: args,
    });
  };
  await waitTurn();
  return {
    root,
    projectId,
    taskId,
    profileId,
    service,
    domain,
    effects,
    turns,
    call,
    waitTurn,
    spawn: () => spawnContext,
    setSourceLabels: (labels: string[]) => {
      sourceLabels = labels;
    },
    getPr: () => pr,
    setPr: (value: PrDeliveryObservation) => {
      pr = value;
    },
    holdPreflight: (value: Promise<void> | undefined) => {
      preflightWait = value;
    },
    failReads: (value: boolean) => {
      readFailure = value;
    },
    async close() {
      stopped = true;
      waiter?.();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
