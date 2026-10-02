import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeGateReasons } from "../src/standalone/github-delivery.js";

test("actual classic queue, strict status, deployments and app identity hold merge", () => {
  const baseline: Parameters<typeof mergeGateReasons>[0] = {
    draft: false,
    merged: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    queue: false,
    reviewDecision: "APPROVED",
    unresolvedThreads: false,
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    strict: false,
    deployments: [],
    requiredEnvironments: [],
    checks: [
      { name: "build", appId: 17, sha: "1".repeat(40), status: "success" },
    ],
    requiredChecks: [{ name: "build", appId: 17 }],
    unsupportedRules: [],
    allowedMethods: ["squash"],
  };
  assert.deepEqual(mergeGateReasons(baseline), []);
  assert.deepEqual(mergeGateReasons({ ...baseline, queue: true }), [
    "merge-queue-required",
  ]);
  assert.ok(
    mergeGateReasons({
      ...baseline,
      strict: true,
      mergeStateStatus: "BEHIND",
    }).includes("strict-head-behind"),
  );
  assert.ok(
    mergeGateReasons({
      ...baseline,
      requiredEnvironments: ["production"],
    }).includes("deployment-production-unproved"),
  );
  assert.ok(
    mergeGateReasons({
      ...baseline,
      checks: [
        { name: "build", appId: 18, sha: "1".repeat(40), status: "success" },
      ],
    }).includes("check-build-unproved"),
  );
  assert.ok(
    mergeGateReasons({
      ...baseline,
      checks: [
        { name: "build", appId: 17, sha: "3".repeat(40), status: "success" },
      ],
    }).includes("check-build-unproved"),
  );
});

import { randomUUID } from "node:crypto";
import { GitHubHttpDeliveryProvider } from "../src/standalone/github-delivery.js";
import type { DeliveryActionRecord } from "../src/core/delivery.js";
function commentRecord(): DeliveryActionRecord {
  const projectId = randomUUID(),
    taskId = randomUUID(),
    operationId = randomUUID();
  return {
    operationId,
    request: {
      operationId,
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", number: 7, nodeId: "I7" },
        body: "Reviewed text",
      },
    },
    binding: {
      projectId,
      taskId,
      assignmentId: randomUUID(),
      taskVersion: 1,
      assignmentVersion: 1,
      workId: "w",
      workRevision: 1,
      conversationRevision: 1,
    },
    policyVersion: 2,
    state: "attempting",
    attempts: 1,
    beforeState: { repositoryPath: "/repos/org/repo" },
    observation: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
test("lost create response is reconciled only by complete exact-author marker readback", async () => {
  const record = commentRecord();
  let effects = 0;
  let duplicate = false;
  let partial = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST" && url.pathname.endsWith("/comments")) {
      effects++;
      throw new Error("lost response");
    }
    if (url.pathname === "/graphql")
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname === "/user") return Response.json({ node_id: "U1" });
    if (url.pathname.endsWith("/issues/7"))
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "open",
        title: "T",
        body: "B",
        labels: [],
      });
    if (url.searchParams.get("page") === "2") {
      if (partial) throw new Error("page lost");
      const c = {
        node_id: "C1",
        body: `Reviewed text\n\n<!-- ensemble-operation:${record.operationId} -->`,
        user: { node_id: "U1" },
      };
      return Response.json(duplicate ? [c, { ...c, node_id: "C2" }] : [c]);
    }
    if (url.pathname.endsWith("/comments"))
      return Response.json([], {
        headers: {
          link: '<https://api.github.com/repos/org/repo/issues/7/comments?page=2>; rel="next"',
        },
      });
    throw new Error("unexpected route");
  };
  const provider = new GitHubHttpDeliveryProvider("non-secret-marker", fetcher);
  assert.equal((await provider.performAction(record)).state, "uncertain");
  assert.equal(
    (await provider.inspectAction(record)).state,
    "confirmed-success",
  );
  assert.equal(effects, 1);
  duplicate = true;
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  duplicate = false;
  partial = true;
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  assert.equal(effects, 1);
});

function prProviderFixture(change: Record<string, unknown> = {}) {
  const head = "1".repeat(40),
    base = "2".repeat(40);
  let writes = 0;
  const graphPr = {
    id: "P7",
    number: 7,
    repository: { id: "R1", nameWithOwner: "org/repo" },
    baseRefName: "main",
    headRefName: "cb/change",
    headRefOid: head,
    baseRefOid: base,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isMergeQueueEnabled: false,
    closingIssuesReferences: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    baseRef: { target: { oid: base }, branchProtectionRule: null },
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...change,
  };
  const raw = {
    node_id: "P7",
    number: 7,
    title: "PR",
    body: "B",
    draft: false,
    merged: false,
    head: { sha: head, ref: "cb/change", repo: { node_id: "R1" } },
    base: { sha: base, ref: "main", repo: { node_id: "R1" } },
  };
  let protection: unknown = null;
  let rules: unknown[] = [],
    checks: unknown[] = [
      {
        node_id: "CR1",
        completed_at: "2026-10-01T10:00:00Z",
        started_at: null,
        name: "build",
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { id: 17 },
      },
    ];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT") {
      writes++;
      return Response.json({ merged: true });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("EnsembleDeliveryPr")) {
        assert.match(body.query, /isMergeQueueEnabled/);
        assert.match(body.query, /requiresDeployments/);
        assert.match(body.query, /requiredDeploymentEnvironments/);
        assert.match(body.query, /requiresStrictStatusChecks/);
        return Response.json({ data: { node: graphPr } });
      }
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    }
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname.endsWith("/pulls/7")) return Response.json(raw);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: checks.length, check_runs: checks });
    if (
      url.pathname.endsWith("/statuses") ||
      url.pathname.endsWith("/comments") ||
      url.pathname.endsWith("/reviews")
    )
      return Response.json([]);
    if (url.pathname.includes("/rules/branches/")) return Response.json(rules);
    if (url.pathname.endsWith("/protection"))
      return protection === null
        ? new Response("", { status: 404 })
        : Response.json(protection);
    if (url.pathname.endsWith("/deployments")) return Response.json([]);
    throw new Error("unexpected provider route");
  };
  const provider = new GitHubHttpDeliveryProvider("fixture-marker", fetcher),
    identity = {
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: head,
    };
  const policy = {
    version: 2,
    mode: "through-merge" as const,
    credentialRef: null,
    grants: [],
    requiredChecks: [{ name: "build", appId: 17 }],
  };
  return {
    provider,
    identity,
    policy,
    graphPr,
    raw,
    getWrites: () => writes,
    setProtection: (value: unknown) => {
      protection = value;
    },
    setRules: (v: unknown[]) => {
      rules = v;
    },
    setChecks: (v: unknown[]) => {
      checks = v;
    },
  };
}
test("HTTP provider holds actual classic queue/strict/deployment and unsupported effective update rules", async () => {
  for (const [change, reason] of [
    [{ isMergeQueueEnabled: true }, "merge-queue-required"],
    [
      {
        mergeStateStatus: "BEHIND",
        baseRef: {
          target: { oid: "2".repeat(40) },
          branchProtectionRule: {
            requiresDeployments: false,
            requiredDeploymentEnvironments: [],
            requiresStrictStatusChecks: true,
          },
        },
      },
      "strict-head-behind",
    ],
    [
      {
        baseRef: {
          target: { oid: "2".repeat(40) },
          branchProtectionRule: {
            requiresDeployments: true,
            requiredDeploymentEnvironments: ["production"],
            requiresStrictStatusChecks: false,
          },
        },
      },
      "deployment-production-unproved",
    ],
  ] as const) {
    const f = prProviderFixture(change);
    const observation = await f.provider.inspectPr(f.identity, f.policy);
    assert.ok(observation.mergeBlockers.includes(reason));
    await assert.rejects(
      () =>
        f.provider.preflight(
          {
            kind: "pr.merge",
            target: {
              repositoryId: "R1",
              number: 7,
              nodeId: "P7",
              baseRef: "main",
              headRef: "cb/change",
              expectedHeadSha: f.identity.expectedHeadSha,
            },
            method: "squash",
            reviewedResultIds: [],
          },
          f.policy,
        ),
      /gates-held/,
    );
    assert.equal(f.getWrites(), 0);
  }
  const f = prProviderFixture();
  f.setRules([{ type: "update" }]);
  assert.ok(
    (await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers.includes(
      "unsupported-rule-update",
    ),
  );
  assert.equal(f.getWrites(), 0);
});
test("HTTP exact-head observation rejects app spoofing, missing data and malformed classic queue", async () => {
  const f = prProviderFixture();
  assert.deepEqual(
    (await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers,
    [],
  );
  f.setChecks([
    {
      node_id: "CR2",
      completed_at: "2026-10-01T11:00:00Z",
      started_at: null,
      name: "build",
      head_sha: "1".repeat(40),
      status: "completed",
      conclusion: "success",
      app: { id: 18 },
    },
  ]);
  assert.ok(
    (await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers.includes(
      "check-build-unproved",
    ),
  );
  f.graphPr.isMergeQueueEnabled = null as unknown as boolean;
  await assert.rejects(() => f.provider.inspectPr(f.identity, f.policy));
  assert.equal(f.getWrites(), 0);
});

test("effective pull-request merge methods and conversation requirements constrain actual merge", async () => {
  const f = prProviderFixture({
    reviewThreads: {
      nodes: [{ isResolved: false }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  assert.ok(
    !(await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers.includes(
      "unresolved-review-thread",
    ),
  );
  f.setRules([
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
  ]);
  const p = await f.provider.inspectPr(f.identity, f.policy);
  assert.deepEqual(p.allowedMethods, ["squash"]);
  assert.ok(p.mergeBlockers.includes("unresolved-review-thread"));
});

test("fresh closed-issue readback attributes merge closure to the exact ClosedEvent closer", async () => {
  let closer = "P_other";
  const f = prProviderFixture();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("EnsembleDeliveryClosure"))
        return Response.json({
          data: {
            node: {
              id: "I1",
              repository: { id: "R1" },
              timelineItems: {
                nodes: [{ closer: { __typename: "PullRequest", id: closer } }],
              },
            },
          },
        });
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    }
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname.endsWith("/issues/1"))
      return Response.json({
        node_id: "I1",
        number: 1,
        state: "closed",
        title: "T",
        body: "O",
        labels: [{ name: "ready" }],
      });
    throw new Error("unexpected read");
  };
  const provider = new GitHubHttpDeliveryProvider("fixture-marker", fetcher),
    target = {
      repositoryId: "R1",
      nodeId: "I1",
      number: 1,
      expectedCloserPrNodeId: f.identity.expectedPrNodeId,
    };
  await assert.rejects(
    () => provider.inspectClosedIssue(target),
    /attribution-unproved/,
  );
  closer = "P7";
  assert.deepEqual((await provider.inspectClosedIssue(target)).labels, [
    "ready",
  ]);
});

import type { ExternalAction } from "../src/core/delivery.js";
test("all nine concrete action transports preserve exact target, incremental labels and readback", async () => {
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  let reads = 0;
  class DispatchProvider extends GitHubHttpDeliveryProvider {
    override async inspectAction() {
      reads++;
      return {
        state: "confirmed-success" as const,
        reason: null,
        receipt: { nodeId: "confirmed" },
      };
    }
  }
  const provider = new DispatchProvider(
    "fixture-marker",
    async (input, init) => {
      writes.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ data: {} });
    },
  );
  const issue = { repositoryId: "R1", nodeId: "I7", number: 7 },
    pr = {
      repositoryId: "R1",
      nodeId: "P7",
      number: 7,
      baseRef: "main",
      headRef: "cb/change",
      expectedHeadSha: "1".repeat(40),
    };
  const actions: ExternalAction[] = [
    { kind: "issue.comment", target: issue, body: "Comment" },
    { kind: "issue.labels", target: issue, add: ["progress"], remove: ["old"] },
    { kind: "issue.edit", target: issue, fields: { title: "Title" } },
    {
      kind: "project.field",
      target: issue,
      projectNodeId: "P1",
      itemNodeId: "ITEM1",
      fieldNodeId: "F1",
      optionNodeId: "O1",
    },
    {
      kind: "pr.create",
      target: {
        repositoryId: "R1",
        baseRef: "main",
        headRef: "cb/change",
        expectedHeadSha: "1".repeat(40),
      },
      title: "PR",
      body: "Body",
      draft: true,
    },
    { kind: "pr.edit", target: pr, fields: { body: "Reviewed" } },
    { kind: "pr.ready", target: pr },
    { kind: "pr.merge", target: pr, method: "squash", reviewedResultIds: [] },
    { kind: "issue.close", target: issue, reviewedResultIds: [] },
  ];
  for (const action of actions) {
    const record = commentRecord();
    record.request.action = action;
    assert.equal(
      (await provider.performAction(record)).state,
      "confirmed-success",
    );
  }
  assert.equal(reads, 9);
  assert.deepEqual(
    writes.map((w) => [w.method, w.path]),
    [
      ["POST", "/repos/org/repo/issues/7/comments"],
      ["DELETE", "/repos/org/repo/issues/7/labels/old"],
      ["POST", "/repos/org/repo/issues/7/labels"],
      ["PATCH", "/repos/org/repo/issues/7"],
      ["POST", "/graphql"],
      ["POST", "/repos/org/repo/pulls"],
      ["PATCH", "/repos/org/repo/pulls/7"],
      ["POST", "/graphql"],
      ["PUT", "/repos/org/repo/pulls/7/merge"],
      ["PATCH", "/repos/org/repo/issues/7"],
    ],
  );
  assert.deepEqual(writes[8]?.body, {
    sha: pr.expectedHeadSha,
    merge_method: "squash",
  });
  assert.deepEqual(writes[2]?.body, { labels: ["progress"] });
  assert.match(JSON.stringify(writes[0]?.body), /ensemble-operation:/);
  assert.match(JSON.stringify(writes[5]?.body), /ensemble-operation:/);
});

test("legacy signature/update restrictions hold and linear history restricts merge method", async () => {
  const f = prProviderFixture();
  f.setProtection({
    required_signatures: { enabled: true },
    restrictions: { users: [], teams: [], apps: [] },
    required_linear_history: { enabled: true },
  });
  const p = await f.provider.inspectPr(f.identity, f.policy);
  assert.ok(p.mergeBlockers.includes("classic-signature-proof-unsupported"));
  assert.ok(p.mergeBlockers.includes("classic-update-restriction-unproved"));
  assert.deepEqual(p.allowedMethods, ["squash"]);
});
