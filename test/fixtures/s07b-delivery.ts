import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { GitHubHttpDeliveryProvider } from "../../src/standalone/github-delivery.js";
import type { RoutingChoiceClient } from "../../src/standalone/routing.js";
import type { RuntimeConversationEvent } from "../../src/standalone/codex.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import type { FixtureLifecycleOptions } from "./fixture-lifecycle.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./operator-web.js";

class ReleaseRuntime extends OperatorFixtureRuntime {
  private readonly generation = randomUUID();
  private conversationEvent:
    | ((event: RuntimeConversationEvent) => void)
    | undefined;
  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversationEvent = listener;
  }
  emitHistory(index: number, text: string) {
    this.conversationEvent?.({
      threadId: this.threadFor(index),
      turnId: this.turnId(index),
      itemId: randomUUID(),
      kind: "completed",
      text,
    });
  }
  private readonly terminals = new Map<
    string,
    (value: "completed" | "failed") => void
  >();
  private readonly threads = new Map<number, string>();
  threadFor(index: number) {
    const thread = this.threads.get(index);
    assert.ok(thread);
    return thread;
  }
  turnId(index: number) {
    return `release-turn-${this.generation}-${index}`;
  }
  override async startThread() {
    return `release-thread-${randomUUID()}`;
  }
  override async resumeThread() {}
  override async startTurn(
    thread?: string,
    _workspace?: string,
    prompt?: string,
  ) {
    assert.ok(thread);
    if (prompt) this.prompts.push(prompt);
    this.threads.set(++this.turns, thread);
    return this.turnId(this.turns);
  }
  override waitForTurn(
    _thread: string,
    turn: string,
  ): Promise<"completed" | "failed"> {
    return new Promise((resolve) => this.terminals.set(turn, resolve));
  }
  override complete(index: number) {
    this.terminals.get(this.turnId(index))?.("completed");
  }
  override async stop() {
    for (const resolve of this.terminals.values()) resolve("completed");
  }
}

/** Closed dispatcher: these synthetic responses can never reach external fetch. */
export function scriptedDeliveryProvider() {
  const state = {
    head: "1".repeat(40),
    base: "2".repeat(40),
    merged: false,
    check: "success",
    feedback: false,
    outage: false,
    lostResponse: false,
    unknownEffect: false,
    writes: 0,
    sourceBody: "Deliver O",
    sourceReads: 0,
    sourceWait: undefined as Promise<void> | undefined,
    commentWrites: 0,
    unknownComment: false,
    comments: [] as Array<{
      node_id: string;
      user: { node_id: string };
      body: string;
    }>,
    requests: [] as string[],
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    state.requests.push(route);
    assert.equal(url.origin, "https://api.github.com");
    if (state.outage) throw Error("scripted provider unavailable");
    if (route === "PUT /repos/org/repo/pulls/7/merge") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        sha: state.head,
        merge_method: "squash",
      });
      state.writes++;
      if (!state.unknownEffect) state.merged = true;
      if (state.lostResponse || state.unknownEffect)
        throw Error("scripted lost merge response");
      return Response.json({ merged: true });
    }
    if (route === "POST /repos/org/repo/issues/1/comments") {
      state.commentWrites++;
      if (state.unknownComment) throw Error("scripted unknown comment effect");
      state.comments.push({
        node_id: `COMMENT${state.commentWrites}`,
        user: { node_id: "U1" },
        body: JSON.parse(String(init?.body)).body,
      });
      return Response.json({ id: state.commentWrites });
    }
    if (route === "POST /graphql") {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("EnsembleDeliveryRepository"))
        return Response.json({
          data: { node: { id: "R1", nameWithOwner: "org/repo" } },
        });
      if (query.includes("EnsembleDeliveryClosure"))
        return Response.json({
          data: {
            node: {
              id: "I1",
              repository: { id: "R1" },
              timelineItems: {
                nodes: [{ closer: { __typename: "PullRequest", id: "P7" } }],
              },
            },
          },
        });
      if (query.includes("EnsembleDeliveryPr"))
        return Response.json({
          data: {
            node: {
              id: "P7",
              number: 7,
              repository: { id: "R1", nameWithOwner: "org/repo" },
              baseRefName: "main",
              headRefName: "cb/change",
              headRefOid: state.head,
              baseRefOid: state.base,
              state: state.merged ? "MERGED" : "OPEN",
              isDraft: false,
              merged: state.merged,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              isMergeQueueEnabled: false,
              closingIssuesReferences: {
                nodes: [
                  {
                    id: "I1",
                    state: state.merged ? "CLOSED" : "OPEN",
                    repository: { id: "R1" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              baseRef: {
                target: { oid: state.base },
                branchProtectionRule: null,
              },
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      throw Error(`Unhandled scripted GraphQL document: ${query}`);
    }
    if (method !== "GET") throw Error(`Unhandled scripted write: ${route}`);
    switch (url.pathname) {
      case "/user":
        return Response.json({ node_id: "U1" });
      case "/repos/org/repo":
        return Response.json({
          node_id: "R1",
          full_name: "org/repo",
          allow_merge_commit: false,
          allow_squash_merge: true,
          allow_rebase_merge: false,
        });
      case "/repos/org/repo/pulls/7":
        return Response.json({
          node_id: "P7",
          number: 7,
          title: "Release PR",
          body: "Closes #1",
          merged: state.merged,
          draft: false,
          head: { sha: state.head, ref: "cb/change", repo: { node_id: "R1" } },
          base: { sha: state.base, ref: "main", repo: { node_id: "R1" } },
        });
      case "/repos/org/repo/issues/1":
        return Response.json({
          node_id: "I1",
          number: 1,
          state: state.merged ? "closed" : "open",
          title: "Release delivery",
          body: "Deliver O",
          labels: [{ name: "ready" }],
        });
      case `/repos/org/repo/commits/${state.head}/check-runs`:
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              node_id: "CR1",
              name: "build",
              head_sha: state.head,
              status: "completed",
              conclusion: state.check,
              completed_at: "2026-10-05T12:00:00Z",
              started_at: null,
              app: { id: 17 },
            },
          ],
        });
      case `/repos/org/repo/commits/${state.head}/statuses`:
      case "/repos/org/repo/pulls/7/reviews":
      case "/repos/org/repo/pulls/7/comments":
      case "/repos/org/repo/rules/branches/main":
      case "/repos/org/repo/deployments":
        return Response.json([]);
      case "/repos/org/repo/issues/1/comments":
        return Response.json(state.comments);
      case "/repos/org/repo/issues/7/comments":
        return Response.json(
          state.feedback
            ? [
                {
                  node_id: "C1",
                  user: { node_id: "U1" },
                  body: "Repair literal feedback C1",
                  updated_at: "2026-10-05T12:01:00Z",
                },
              ]
            : [],
        );
      case "/repos/org/repo/branches/main/protection":
        return new Response("", { status: 404 });
      default:
        throw Error(`Unhandled scripted endpoint: ${route}`);
    }
  };
  return {
    state,
    provider: new GitHubHttpDeliveryProvider(
      "synthetic-release-marker",
      fetcher,
    ),
  };
}

export async function createReleaseDeliveryFixture(
  mode: "reviewable-pr" | "through-merge" = "reviewable-pr",
  lifecycleOptions: FixtureLifecycleOptions = {},
  localTask = false,
  routingClient: RoutingChoiceClient | null = null,
) {
  const scripted = scriptedDeliveryProvider();
  const readerFactory: GitHubReaderFactory = () => ({
    async readSelection() {
      scripted.state.sourceReads++;
      await scripted.state.sourceWait;
      return {
        complete: true,
        reason: null,
        issues: scripted.state.merged
          ? []
          : [
              {
                providerInstance: "github.com",
                nodeId: "I1",
                repositoryId: "R1",
                repositoryName: "org/repo",
                number: 1,
                title: "Release delivery",
                body: scripted.state.sourceBody,
                state: "open",
                labels: ["ready"],
                projectFields: [],
              },
            ],
      };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: scripted.state.merged ? "closed" : "open" };
    },
  });
  const f = await createOperatorFixture(
    routingClient,
    readerFactory,
    { providerFactory: () => scripted.provider },
    lifecycleOptions,
    () => new ReleaseRuntime(),
  );
  const projectId = randomUUID(),
    profileId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Release project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "Deliver scoped task",
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:SYNTHETIC_SOURCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  let taskId: string;
  if (localTask) {
    taskId = randomUUID();
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "Release delivery",
      outcome: "Deliver O",
      ready: true,
    });
  } else {
    await f.service.refreshGitHub();
    taskId = String(f.service.githubSources().issue("I1")?.taskId);
  }
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode,
    credentialRef: null,
    grants: [{ action: "pr.merge", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [{ name: "build", appId: 17 }],
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    paused: false,
  });
  const waitTurn = async (index = f.runtime.turns) => {
    await until(
      () =>
        f.service
          .list()
          .some(
            (i) =>
              i.turnId === f.runtime.turnId(index) && i.state === "running",
          ),
      "bound turn",
    );
    return {
      threadId: f.runtime.threadFor(index),
      turnId: f.runtime.turnId(index),
    };
  };
  const call = async (
    tool: string,
    args: Record<string, unknown>,
    index = f.runtime.turns,
  ) =>
    f.runtime.callTool({
      ...(await waitTurn(index)),
      callId: randomUUID(),
      tool,
      arguments: args,
    });
  await waitTurn(1);
  return Object.assign(f, {
    projectId,
    profileId,
    taskId,
    scripted,
    call,
    waitTurn,
    async register() {
      const r = await call("ensemble_register_pr", {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: scripted.state.head,
      });
      assert.equal(r.success, true, r.text);
    },
    async merge(operationId = randomUUID()) {
      return call("ensemble_external_action", {
        operationId,
        action: {
          kind: "pr.merge",
          target: {
            repositoryId: "R1",
            nodeId: "P7",
            number: 7,
            headRef: "cb/change",
            baseRef: "main",
            expectedHeadSha: scripted.state.head,
          },
          method: "squash",
          reviewedResultIds: [],
        },
      });
    },
    settlement() {
      const b = f.service.delivery().delivery(taskId);
      assert.ok(b);
      return {
        actor: "operator" as const,
        key: randomUUID(),
        taskId,
        expectedTaskVersion: Number(f.service.domain().task(taskId).version),
        expectedDeliveryRevision: b.revision,
        expectedPolicyVersion: f.service.delivery().configuration(projectId)
          .version,
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: scripted.state.head,
        decision: "accepted" as const,
      };
    },
    async terminal(index = f.runtime.turns) {
      f.runtime.complete(index);
      await until(
        () =>
          f.service
            .list()
            .some(
              (i) =>
                i.turnId === f.runtime.turnId(index) && i.state === "completed",
            ),
        "terminal settlement",
      );
    },
    readDb<T>(read: (db: DatabaseSync) => T): T {
      const db = new DatabaseSync(
        join(f.directory, "data", "standalone.sqlite"),
      );
      try {
        return read(db);
      } finally {
        db.close();
      }
    },
  });
}

export async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
