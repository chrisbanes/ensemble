import { isOperatorDeliveryCaller } from "../core/delivery.js";
import { z } from "zod";
import { githubApi as api, githubFetch, nextPageLink } from "./github-http.js";
import {
  actionObservationSchema,
  prObservationSchema,
  type DeliveryActionRecord,
  type DeliveryPolicy,
  type ExternalAction,
  type PrDeliveryObservation,
  type ProviderActionObservation,
} from "../core/delivery.js";
export type {
  PrDeliveryObservation,
  ProviderActionObservation,
} from "../core/delivery.js";
export interface PrIdentity {
  repositoryId: string;
  prNumber: number;
  expectedPrNodeId: string;
  expectedHeadSha: string;
}
export interface GitHubDeliveryProvider {
  inspectClosedIssue?(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
    expectedCloserPrNodeId?: string;
  }): Promise<import("../core/github-source.js").IssueSnapshot>;
  inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  preflight(
    action: ExternalAction,
    policy: DeliveryPolicy,
  ): Promise<Record<string, z.output<ReturnType<typeof z.json>>>>;
  performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation>;
  inspectPr(
    identity: PrIdentity,
    policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation>;
}
export const deliveryDocuments = {
  EnsembleDeliveryPr: `query EnsembleDeliveryPr($id:ID!,$after:String){node(id:$id){... on PullRequest{id number repository{id nameWithOwner} baseRefName headRefName headRefOid baseRefOid state isDraft merged mergeable mergeStateStatus reviewDecision isMergeQueueEnabled closingIssuesReferences(first:100){nodes{id state repository{id}} pageInfo{hasNextPage endCursor}} baseRef{target{oid} branchProtectionRule{requiresDeployments requiredDeploymentEnvironments requiresStrictStatusChecks}} reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`,
  EnsembleDeliveryRepository: `query EnsembleDeliveryRepository($id:ID!){node(id:$id){... on Repository{id nameWithOwner}}}`,
  EnsembleDeliveryClosure: `query EnsembleDeliveryClosure($id:ID!){node(id:$id){... on Issue{id repository{id} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{__typename ... on PullRequest{id}}}}}}}}`,
  EnsembleDeliveryField: `query EnsembleDeliveryField($item:ID!,$field:ID!,$after:String){node(id:$item){... on ProjectV2Item{id project{id} content{... on Issue{id repository{id}}} fieldValues(first:100,after:$after){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2SingleSelectField{id}}}} pageInfo{hasNextPage endCursor}}}} field:node(id:$field){... on ProjectV2SingleSelectField{id options{id} project{id}}}}`,
  EnsembleDeliveryProject: `mutation EnsembleDeliveryProject($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
  EnsembleDeliveryReady: `mutation EnsembleDeliveryReady($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`,
} as const;
const name = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const page = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const prQuery = deliveryDocuments.EnsembleDeliveryPr;
class ProviderFailure extends Error {
  constructor(readonly status: number) {
    super(`provider-http-${status}`);
  }
}

export function mergeGateReasons(g: {
  draft: boolean;
  merged: boolean;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  queue: boolean;
  reviewDecision: string | null;
  unresolvedThreads: boolean;
  headSha: string;
  baseSha: string;
  strict: boolean;
  deployments: Array<{ environment: string; sha: string; success: boolean }>;
  requiredEnvironments: string[];
  checks: PrDeliveryObservation["checks"];
  requiredChecks: DeliveryPolicy["requiredChecks"];
  unsupportedRules: string[];
  allowedMethods: string[];
}): string[] {
  const reasons = [...g.unsupportedRules];
  if (g.state !== "OPEN" || g.merged) reasons.push("pr-not-open");
  if (g.draft) reasons.push("pr-draft");
  if (g.mergeable !== "MERGEABLE") reasons.push("mergeability-unproved");
  if (g.queue) reasons.push("merge-queue-required");
  if (g.strict && g.mergeStateStatus !== "CLEAN")
    reasons.push(
      g.mergeStateStatus === "BEHIND"
        ? "strict-head-behind"
        : "strict-head-current-unproved",
    );
  if (
    g.reviewDecision === "CHANGES_REQUESTED" ||
    g.reviewDecision === "REVIEW_REQUIRED"
  )
    reasons.push("review-not-satisfied");
  if (g.unresolvedThreads) reasons.push("unresolved-review-thread");
  for (const check of g.requiredChecks)
    if (
      !g.checks.some(
        (c) =>
          c.name === check.name &&
          (check.appId === undefined || c.appId === check.appId) &&
          c.sha === g.headSha &&
          c.status === "success",
      )
    )
      reasons.push(`check-${check.name}-unproved`);
  for (const environment of g.requiredEnvironments)
    if (
      !g.deployments.some(
        (d) =>
          d.environment === environment && d.sha === g.headSha && d.success,
      )
    )
      reasons.push(`deployment-${environment}-unproved`);
  if (!g.allowedMethods.length) reasons.push("merge-method-unavailable");
  return [...new Set(reasons)];
}

/** Narrow GitHub.com transport; every effect is settled by an independent read. */
export class GitHubHttpDeliveryProvider implements GitHubDeliveryProvider {
  constructor(
    private readonly credential: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<{ json: unknown; response: Response }> {
    const url = new URL(path, api);
    if (url.origin !== api) throw new Error("provider-origin-mismatch");
    if (!this.credential) throw new Error("provider-credential-unavailable");
    const response = await githubFetch(
      this.fetcher,
      url.href,
      {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.credential}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      () => new Error("provider-origin-mismatch"),
    );
    if (!response.ok) throw new ProviderFailure(response.status);
    return {
      json: response.status === 204 ? null : await response.json(),
      response,
    };
  }
  private async graph(query: string, variables: unknown): Promise<unknown> {
    const result = z
      .object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
      .parse(
        (await this.request("/graphql", "POST", { query, variables })).json,
      );
    if (result.errors?.length) throw new Error("provider-graphql-incomplete");
    return result.data;
  }
  private async pages(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    let next: string | null = path;
    const seen = new Set<string>();
    for (let count = 0; next; count++) {
      if (count >= 100 || seen.has(next))
        throw new Error("provider-pagination-incomplete");
      seen.add(next);
      const result = await this.request(next);
      rows.push(...z.array(z.unknown()).parse(result.json));
      next = nextPageLink(
        result.response,
        () => new Error("provider-pagination-incomplete"),
      );
    }
    return rows;
  }
  private async repository(id: string) {
    const data = z
      .object({
        node: z.object({
          id: name,
          nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
        }),
      })
      .parse(
        await this.graph(deliveryDocuments.EnsembleDeliveryRepository, { id }),
      );
    if (data.node.id !== id) throw new Error("provider-repository-mismatch");
    const path = `/repos/${data.node.nameWithOwner.split("/").map(encodeURIComponent).join("/")}`;
    const repo = z
      .object({
        node_id: name,
        full_name: name,
        allow_merge_commit: z.boolean(),
        allow_squash_merge: z.boolean(),
        allow_rebase_merge: z.boolean(),
      })
      .parse((await this.request(path)).json);
    if (repo.node_id !== id || repo.full_name !== data.node.nameWithOwner)
      throw new Error("provider-repository-mismatch");
    return {
      path,
      methods: [
        ...(repo.allow_merge_commit ? ["merge"] : []),
        ...(repo.allow_squash_merge ? ["squash"] : []),
        ...(repo.allow_rebase_merge ? ["rebase"] : []),
      ] as PrDeliveryObservation["allowedMethods"],
    };
  }
  private async issue(
    path: string,
    target: { nodeId: string; number: number },
  ) {
    const value = z
      .object({
        node_id: name,
        number: z.number().int().positive(),
        state: z.enum(["open", "closed"]),
        title: z.string(),
        body: z.string().nullable(),
        labels: z.array(z.object({ name })),
        pull_request: z.unknown().optional(),
      })
      .parse((await this.request(`${path}/issues/${target.number}`)).json);
    if (
      value.node_id !== target.nodeId ||
      value.number !== target.number ||
      value.pull_request
    )
      throw new Error("provider-issue-mismatch");
    return value;
  }
  private async ref(path: string, ref: string): Promise<string> {
    const value = z
      .object({ ref: name, object: z.object({ sha }) })
      .parse(
        (await this.request(`${path}/git/ref/heads/${encodeURIComponent(ref)}`))
          .json,
      );
    if (value.ref !== `refs/heads/${ref}`)
      throw new Error("provider-ref-mismatch");
    return value.object.sha;
  }
  async inspectClosedIssue(target: {
    repositoryId: string;
    nodeId: string;
    number: number;
    expectedCloserPrNodeId?: string;
  }): Promise<import("../core/github-source.js").IssueSnapshot> {
    const repo = await this.repository(target.repositoryId),
      issue = await this.issue(repo.path, target);
    if (issue.state !== "closed")
      throw new Error("provider-own-closure-unproved");
    if (target.expectedCloserPrNodeId) {
      const data = z
        .object({
          node: z.object({
            id: name,
            repository: z.object({ id: name }),
            timelineItems: z.object({
              nodes: z.array(
                z.object({
                  closer: z
                    .object({ __typename: z.literal("PullRequest"), id: name })
                    .nullable(),
                }),
              ),
            }),
          }),
        })
        .parse(
          await this.graph(deliveryDocuments.EnsembleDeliveryClosure, {
            id: target.nodeId,
          }),
        );
      if (
        data.node.id !== target.nodeId ||
        data.node.repository.id !== target.repositoryId ||
        data.node.timelineItems.nodes.length !== 1 ||
        data.node.timelineItems.nodes[0]?.closer?.id !==
          target.expectedCloserPrNodeId
      )
        throw new Error("provider-closure-attribution-unproved");
    }

    return {
      providerInstance: "github.com",
      nodeId: issue.node_id,
      repositoryId: target.repositoryId,
      repositoryName: repo.path.slice("/repos/".length),
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: "closed",
      labels: issue.labels.map((v) => v.name),
      projectFields: [],
    };
  }
  private async projectField(
    action: Extract<ExternalAction, { kind: "project.field" }>,
  ): Promise<string | null> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let option: string | null = null;
    let matches = 0;
    for (let count = 0; count < 100; count++) {
      const data = z
        .object({
          node: z.object({
            id: name,
            project: z.object({ id: name }),
            content: z.object({ id: name, repository: z.object({ id: name }) }),
            fieldValues: z.object({
              nodes: z.array(
                z.object({
                  __typename: name,
                  optionId: name.optional(),
                  field: z.object({ id: name }).optional(),
                }),
              ),
              pageInfo: page,
            }),
          }),
          field: z.object({
            id: name,
            options: z.array(z.object({ id: name })),
            project: z.object({ id: name }),
          }),
        })
        .parse(
          await this.graph(deliveryDocuments.EnsembleDeliveryField, {
            item: action.itemNodeId,
            field: action.fieldNodeId,
            after: cursor,
          }),
        );
      if (
        data.node.id !== action.itemNodeId ||
        data.node.project.id !== action.projectNodeId ||
        data.node.content.id !== action.target.nodeId ||
        data.node.content.repository.id !== action.target.repositoryId ||
        data.field.id !== action.fieldNodeId ||
        data.field.project.id !== action.projectNodeId ||
        !data.field.options.some((o) => o.id === action.optionNodeId)
      )
        throw new Error("provider-project-field-unproved");
      for (const value of data.node.fieldValues.nodes)
        if (value.field?.id === action.fieldNodeId) {
          if (
            value.__typename !== "ProjectV2ItemFieldSingleSelectValue" ||
            !value.optionId ||
            ++matches > 1
          )
            throw new Error("provider-project-field-unproved");
          option = value.optionId;
        }
      if (!data.node.fieldValues.pageInfo.hasNextPage) return option;
      cursor = data.node.fieldValues.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error("provider-field-pagination-incomplete");
  }

  async inspectPr(
    identity: PrIdentity,
    policy: DeliveryPolicy,
  ): Promise<PrDeliveryObservation> {
    const repo = await this.repository(identity.repositoryId);
    const raw = z
      .object({
        node_id: name,
        number: z.number().int().positive(),
        head: z.object({ sha, ref: name, repo: z.object({ node_id: name }) }),
        base: z.object({ sha, ref: name, repo: z.object({ node_id: name }) }),
      })
      .parse(
        (await this.request(`${repo.path}/pulls/${identity.prNumber}`)).json,
      );
    if (
      raw.node_id !== identity.expectedPrNodeId ||
      raw.number !== identity.prNumber ||
      raw.head.repo.node_id !== identity.repositoryId ||
      raw.base.repo.node_id !== identity.repositoryId
    )
      throw new Error("provider-pr-mismatch");
    const graphSchema = z.object({
      node: z.object({
        id: name,
        number: z.number().int().positive(),
        repository: z.object({ id: name, nameWithOwner: name }),
        baseRefName: name,
        headRefName: name,
        headRefOid: sha,
        baseRefOid: sha,
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        isDraft: z.boolean(),
        merged: z.boolean(),
        mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
        mergeStateStatus: name,
        reviewDecision: z
          .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
          .nullable(),
        isMergeQueueEnabled: z.boolean(),
        closingIssuesReferences: z.object({
          nodes: z.array(
            z.object({
              id: name,
              state: z.enum(["OPEN", "CLOSED"]),
              repository: z.object({ id: name }),
            }),
          ),
          pageInfo: page,
        }),
        baseRef: z
          .object({
            target: z.object({ oid: sha }),
            branchProtectionRule: z
              .object({
                requiresDeployments: z.boolean(),
                requiredDeploymentEnvironments: z.array(name),
                requiresStrictStatusChecks: z.boolean(),
              })
              .nullable(),
          })
          .nullable(),
        reviewThreads: z.object({
          nodes: z.array(z.object({ isResolved: z.boolean() })),
          pageInfo: page,
        }),
      }),
    });
    let cursor: string | null = null;
    const seen = new Set<string>();
    let graph: ReturnType<typeof graphSchema.parse>["node"] | undefined;
    let unresolved = false;
    for (let count = 0; count < 100; count++) {
      const value: z.output<typeof graphSchema>["node"] = graphSchema.parse(
        await this.graph(prQuery, {
          id: identity.expectedPrNodeId,
          after: cursor,
        }),
      ).node;
      if (
        value.id !== raw.node_id ||
        value.repository.id !== identity.repositoryId ||
        value.number !== raw.number ||
        value.headRefOid !== raw.head.sha ||
        value.baseRefOid !== raw.base.sha ||
        value.headRefName !== raw.head.ref ||
        value.baseRefName !== raw.base.ref
      )
        throw new Error("provider-pr-snapshot-changed");
      graph = value;
      unresolved ||= value.reviewThreads.nodes.some((t) => !t.isResolved);
      if (!value.reviewThreads.pageInfo.hasNextPage) break;
      cursor = value.reviewThreads.pageInfo.endCursor;
      if (!cursor || seen.has(cursor) || count === 99)
        throw new Error("provider-review-pagination-incomplete");
      seen.add(cursor);
    }
    if (!graph) throw new Error("provider-pr-unavailable");
    const checks: PrDeliveryObservation["checks"] = [];
    let next: string | null =
      `${repo.path}/commits/${raw.head.sha}/check-runs?per_page=100&filter=latest`;
    const checkPages = new Set<string>();
    while (next) {
      if (checkPages.size >= 100 || checkPages.has(next))
        throw new Error("provider-check-pagination-incomplete");
      checkPages.add(next);
      const result = await this.request(next);
      const runs = z
        .object({
          total_count: z.number().int(),
          check_runs: z.array(
            z.object({
              name,
              node_id: name,
              completed_at: name.nullable(),
              started_at: name.nullable(),
              head_sha: sha,
              status: name,
              conclusion: name.nullable(),
              app: z.object({ id: z.number().int() }).nullable(),
            }),
          ),
        })
        .parse(result.json);
      for (const run of runs.check_runs)
        checks.push({
          name: run.name,
          nodeId: run.node_id,
          updatedAt: run.completed_at ?? run.started_at ?? "unproved",
          appId: run.app?.id ?? null,
          sha: run.head_sha,
          status:
            run.status !== "completed"
              ? "pending"
              : ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
                ? "success"
                : "failure",
        });
      next = nextPageLink(
        result.response,
        () => new Error("provider-check-pagination-incomplete"),
      );
      if (!next && checks.length < runs.total_count)
        throw new Error("provider-check-pagination-incomplete");
    }
    for (const value of await this.pages(
      `${repo.path}/commits/${raw.head.sha}/statuses?per_page=100`,
    )) {
      const status = z
        .object({
          context: name,
          node_id: name,
          updated_at: name,
          state: z.enum(["success", "pending", "failure", "error"]),
          sha: sha.optional(),
        })
        .parse(value);
      // Legacy status identities cannot impersonate a required GitHub App.
      if (!checks.some((c) => c.name === status.context && c.appId === null))
        checks.push({
          name: status.context,
          nodeId: status.node_id,
          updatedAt: status.updated_at,
          appId: null,
          sha: status.sha ?? raw.head.sha,
          status:
            status.state === "success"
              ? "success"
              : status.state === "pending"
                ? "pending"
                : "failure",
        });
    }
    const requirements = [...policy.requiredChecks];
    let requireThreads = false;
    let allowedMethods = [...repo.methods];
    const unsupportedRules: string[] = [];
    let strict =
      graph.baseRef?.branchProtectionRule?.requiresStrictStatusChecks ?? false;
    const environments = [
      ...(graph.baseRef?.branchProtectionRule?.requiredDeploymentEnvironments ??
        []),
    ];
    if (!graph.baseRef || graph.baseRef.target.oid !== raw.base.sha)
      unsupportedRules.push("base-ref-current-unproved");
    const rules = z
      .array(z.object({ type: name, parameters: z.unknown().optional() }))
      .parse(
        (
          await this.request(
            `${repo.path}/rules/branches/${encodeURIComponent(raw.base.ref)}`,
          )
        ).json,
      );
    for (const rule of rules) {
      if (rule.type === "required_status_checks") {
        const p = z
          .object({
            strict_required_status_checks_policy: z.boolean(),
            required_status_checks: z.array(
              z.object({
                context: name,
                integration_id: z.number().int().nullable().optional(),
              }),
            ),
          })
          .parse(rule.parameters);
        strict ||= p.strict_required_status_checks_policy;
        requirements.push(
          ...p.required_status_checks.map((c) => ({
            name: c.context,
            ...(c.integration_id && c.integration_id > 0
              ? { appId: c.integration_id }
              : {}),
          })),
        );
      } else if (rule.type === "pull_request") {
        const p = z
          .object({
            required_approving_review_count: z.number().int(),
            required_review_thread_resolution: z.boolean(),
            allowed_merge_methods: z
              .array(z.enum(["merge", "squash", "rebase"]))
              .min(1)
              .optional(),
            require_code_owner_review: z.boolean().optional(),
            require_last_push_approval: z.boolean().optional(),
            required_reviewers: z.array(z.unknown()).optional(),
          })
          .parse(rule.parameters);
        requireThreads ||= p.required_review_thread_resolution;
        if (p.allowed_merge_methods)
          allowedMethods = allowedMethods.filter((m) =>
            p.allowed_merge_methods?.includes(m),
          );
        if (p.required_reviewers?.length)
          unsupportedRules.push("required-reviewer-proof-unsupported");
        if (
          (p.required_approving_review_count > 0 ||
            p.require_code_owner_review ||
            p.require_last_push_approval) &&
          graph.reviewDecision !== "APPROVED"
        )
          unsupportedRules.push("required-review-unproved");
      } else if (rule.type === "required_deployments")
        environments.push(
          ...z
            .object({ required_deployment_environments: z.array(name) })
            .parse(rule.parameters).required_deployment_environments,
        );
      else if (rule.type === "merge_queue")
        unsupportedRules.push("merge-queue-required");
      else if (
        !["deletion", "non_fast_forward", "creation"].includes(rule.type)
      )
        unsupportedRules.push(`unsupported-rule-${rule.type}`);
    }
    try {
      const protection = z
        .object({
          required_status_checks: z
            .object({
              strict: z.boolean(),
              checks: z.array(
                z.object({
                  context: name,
                  app_id: z.number().int().nullable(),
                }),
              ),
            })
            .nullable()
            .optional(),
          required_pull_request_reviews: z
            .object({
              required_approving_review_count: z.number().int(),
              require_code_owner_reviews: z.boolean().optional(),
              require_last_push_approval: z.boolean().optional(),
            })
            .nullable()
            .optional(),
          restrictions: z.object({}).passthrough().nullable().optional(),
          required_signatures: z.object({ enabled: z.boolean() }).optional(),
          required_linear_history: z
            .object({ enabled: z.boolean() })
            .optional(),
          lock_branch: z.object({ enabled: z.boolean() }).optional(),
          required_conversation_resolution: z
            .object({ enabled: z.boolean() })
            .optional(),
        })
        .parse(
          (
            await this.request(
              `${repo.path}/branches/${encodeURIComponent(raw.base.ref)}/protection`,
            )
          ).json,
        );
      if (protection.restrictions)
        unsupportedRules.push("classic-update-restriction-unproved");
      if (protection.required_signatures?.enabled)
        unsupportedRules.push("classic-signature-proof-unsupported");
      if (protection.lock_branch?.enabled)
        unsupportedRules.push("classic-locked-branch");
      if (protection.required_linear_history?.enabled)
        allowedMethods = allowedMethods.filter((method) => method !== "merge");
      strict ||= protection.required_status_checks?.strict ?? false;
      requireThreads ||=
        protection.required_conversation_resolution?.enabled ?? false;
      requirements.push(
        ...(protection.required_status_checks?.checks ?? []).map((c) => ({
          name: c.context,
          ...(c.app_id && c.app_id > 0 ? { appId: c.app_id } : {}),
        })),
      );
      if (
        ((protection.required_pull_request_reviews
          ?.required_approving_review_count ?? 0) > 0 ||
          protection.required_pull_request_reviews
            ?.require_code_owner_reviews ||
          protection.required_pull_request_reviews
            ?.require_last_push_approval) &&
        graph.reviewDecision !== "APPROVED"
      )
        unsupportedRules.push("required-review-unproved");
    } catch (error) {
      if (
        !(
          error instanceof ProviderFailure &&
          error.status === 404 &&
          graph.baseRef?.branchProtectionRule === null
        )
      )
        unsupportedRules.push("classic-protection-unproved");
    }
    if (
      graph.baseRef?.branchProtectionRule?.requiresDeployments &&
      !environments.length
    )
      unsupportedRules.push("deployment-requirements-unproved");
    const deployments: Array<{
      environment: string;
      sha: string;
      success: boolean;
    }> = [];
    if (environments.length)
      for (const value of await this.pages(
        `${repo.path}/deployments?sha=${raw.head.sha}&per_page=100`,
      )) {
        const d = z
          .object({ id: z.number().int(), environment: name, sha })
          .parse(value);
        const statuses = (
          await this.pages(
            `${repo.path}/deployments/${d.id}/statuses?per_page=100`,
          )
        ).map((v) => z.object({ state: name }).parse(v));
        deployments.push({
          environment: d.environment,
          sha: d.sha,
          success: statuses[0]?.state === "success",
        });
      }
    if (graph.closingIssuesReferences.pageInfo.hasNextPage)
      unsupportedRules.push("closing-issue-pagination-unproved");
    const mergeBlockers = mergeGateReasons({
      draft: graph.isDraft,
      merged: graph.merged,
      state: graph.state,
      mergeable: graph.mergeable,
      mergeStateStatus: graph.mergeStateStatus,
      queue: graph.isMergeQueueEnabled,
      reviewDecision: graph.reviewDecision,
      unresolvedThreads: requireThreads && unresolved,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      strict,
      requiredEnvironments: [...new Set(environments)],
      deployments,
      checks,
      requiredChecks: requirements,
      unsupportedRules,
      allowedMethods,
    });
    const feedback: NonNullable<PrDeliveryObservation["feedback"]> = [];
    for (const [kind, path] of [
      ["comment", `${repo.path}/issues/${raw.number}/comments?per_page=100`],
      ["review", `${repo.path}/pulls/${raw.number}/reviews?per_page=100`],
      [
        "review-comment",
        `${repo.path}/pulls/${raw.number}/comments?per_page=100`,
      ],
    ] as const) {
      for (const value of await this.pages(path)) {
        const entry = z
          .object({
            node_id: name,
            user: z.object({ node_id: name }),
            body: z.string().nullable(),
            updated_at: name.optional(),
            submitted_at: name.nullable().optional(),
            state: name.optional(),
            commit_id: sha.optional(),
          })
          .parse(value);
        const updatedAt = entry.updated_at ?? entry.submitted_at;
        if (!updatedAt) throw new Error("provider-feedback-incomplete");
        feedback.push({
          kind,
          nodeId: entry.node_id,
          author: entry.user.node_id,
          updatedAt,
          state: entry.state ?? "COMMENTED",
          body: (entry.body ?? "").slice(0, 2000),
          commitSha: entry.commit_id ?? null,
        });
      }
    }
    feedback.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.nodeId.localeCompare(b.nodeId),
    );
    return prObservationSchema.parse({
      repositoryId: identity.repositoryId,
      nodeId: raw.node_id,
      number: raw.number,
      baseRef: raw.base.ref,
      headRef: raw.head.ref,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      state: graph.state,
      draft: graph.isDraft,
      merged: graph.merged,
      reviewDecision: graph.reviewDecision,
      checks,
      feedback,
      mergeBlockers,
      closedIssueNodeIds: graph.closingIssuesReferences.pageInfo.hasNextPage
        ? []
        : graph.closingIssuesReferences.nodes
            .filter(
              (i) =>
                i.state === "CLOSED" &&
                i.repository.id === identity.repositoryId,
            )
            .map((i) => i.id),
      allowedMethods,
    });
  }
  async preflight(action: ExternalAction, policy: DeliveryPolicy) {
    const repo = await this.repository(action.target.repositoryId);
    if (action.kind === "pr.create") {
      const head = await this.ref(repo.path, action.target.headRef);
      await this.ref(repo.path, action.target.baseRef);
      if (head !== action.target.expectedHeadSha)
        throw new Error("provider-head-changed");
      return {
        repositoryPath: repo.path,
        repositoryId: action.target.repositoryId,
        headSha: head,
      };
    }
    if (action.kind.startsWith("pr.") && "expectedHeadSha" in action.target) {
      const observation = await this.inspectPr(
        {
          repositoryId: action.target.repositoryId,
          prNumber: action.target.number,
          expectedPrNodeId: action.target.nodeId,
          expectedHeadSha: action.target.expectedHeadSha,
        },
        policy,
      );
      if (
        observation.headSha !== action.target.expectedHeadSha ||
        observation.baseRef !== action.target.baseRef ||
        observation.headRef !== action.target.headRef
      )
        throw new Error("provider-head-changed");
      if (
        action.kind === "pr.merge" &&
        (observation.mergeBlockers.length ||
          !observation.allowedMethods.includes(action.method))
      )
        throw new Error("provider-merge-gates-held");
      return {
        repositoryPath: repo.path,
        nodeId: observation.nodeId,
        headSha: observation.headSha,
      };
    }
    if (!("number" in action.target))
      throw new Error("provider-target-invalid");
    const issue = await this.issue(repo.path, action.target);
    if (action.kind === "project.field")
      return {
        repositoryPath: repo.path,
        nodeId: issue.node_id,
        optionId: await this.projectField(action),
      };
    return {
      repositoryPath: repo.path,
      nodeId: issue.node_id,
      state: issue.state,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((v) => v.name),
    };
  }
  async performAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    if (
      isOperatorDeliveryCaller(record.binding) &&
      (record.request.action.kind !== "issue.comment" ||
        record.request.approval ||
        record.request.action.target.nodeId !== record.binding.sourceNodeId ||
        record.request.action.target.repositoryId !==
          record.binding.sourceRepositoryId)
    )
      throw Error("Operator delivery only permits the bound issue.comment");
    const a = record.request.action;
    try {
      const repo = {
        path: z
          .string()
          .regex(/^\/repos\/[^/]+\/[^/]+$/)
          .parse(record.beforeState?.repositoryPath),
      };
      const marker = `<!-- ensemble-operation:${record.operationId} -->`;
      switch (a.kind) {
        case "issue.comment":
          await this.request(
            `${repo.path}/issues/${a.target.number}/comments`,
            "POST",
            { body: `${a.body}\n\n${marker}` },
          );
          break;
        case "issue.labels":
          for (const label of a.remove)
            await this.request(
              `${repo.path}/issues/${a.target.number}/labels/${encodeURIComponent(label)}`,
              "DELETE",
            );
          if (a.add.length)
            await this.request(
              `${repo.path}/issues/${a.target.number}/labels`,
              "POST",
              { labels: a.add },
            );
          break;
        case "issue.edit":
          await this.request(
            `${repo.path}/issues/${a.target.number}`,
            "PATCH",
            a.fields,
          );
          break;
        case "issue.close":
          await this.request(
            `${repo.path}/issues/${a.target.number}`,
            "PATCH",
            { state: "closed" },
          );
          break;
        case "project.field":
          await this.graph(deliveryDocuments.EnsembleDeliveryProject, {
            project: a.projectNodeId,
            item: a.itemNodeId,
            field: a.fieldNodeId,
            option: a.optionNodeId,
          });
          break;
        case "pr.create":
          await this.request(`${repo.path}/pulls`, "POST", {
            title: a.title,
            body: `${a.body}\n\n${marker}`,
            head: a.target.headRef,
            base: a.target.baseRef,
            draft: a.draft,
          });
          break;
        case "pr.edit":
          await this.request(
            `${repo.path}/pulls/${a.target.number}`,
            "PATCH",
            a.fields,
          );
          break;
        case "pr.ready":
          await this.graph(deliveryDocuments.EnsembleDeliveryReady, {
            id: a.target.nodeId,
          });
          break;
        case "pr.merge":
          await this.request(
            `${repo.path}/pulls/${a.target.number}/merge`,
            "PUT",
            { sha: a.target.expectedHeadSha, merge_method: a.method },
          );
          break;
      }
      // The write response never establishes success.
      return await this.inspectAction(record);
    } catch (error) {
      // Only a single-request rejection is definitive. Label removal is multi-effect.
      if (
        error instanceof ProviderFailure &&
        a.kind !== "issue.labels" &&
        [400, 401, 403, 404, 405, 409, 422, 429].includes(error.status)
      )
        return {
          state: "confirmed-failure",
          reason: `provider-http-${error.status}`,
          receipt: null,
          retryable: error.status === 429,
        };
      return {
        state: "uncertain",
        reason: "provider-effect-unproved",
        receipt: null,
      };
    }
  }
  async inspectAction(
    record: DeliveryActionRecord,
  ): Promise<ProviderActionObservation> {
    try {
      const a = record.request.action,
        repo = await this.repository(a.target.repositoryId),
        marker = `<!-- ensemble-operation:${record.operationId} -->`;
      const user = z
        .object({ node_id: name })
        .parse((await this.request("/user")).json);
      let receipt: ProviderActionObservation["receipt"] = null;
      if (a.kind === "issue.comment") {
        await this.issue(repo.path, a.target);
        const comments = (
          await this.pages(
            `${repo.path}/issues/${a.target.number}/comments?per_page=100`,
          )
        ).map((v) =>
          z
            .object({
              node_id: name,
              body: z.string(),
              user: z.object({ node_id: name }),
            })
            .parse(v),
        );
        const matching = comments.filter((c) => c.body.includes(marker));
        if (
          matching.length === 1 &&
          matching[0]?.body === `${a.body}\n\n${marker}` &&
          matching[0].user.node_id === user.node_id
        )
          receipt = { nodeId: matching[0].node_id };
      } else if (a.kind === "pr.create") {
        const pulls = (
          await this.pages(`${repo.path}/pulls?state=all&per_page=100`)
        ).map((v) =>
          z
            .object({
              node_id: name,
              number: z.number().int().positive(),
              title: z.string(),
              body: z.string().nullable(),
              draft: z.boolean(),
              user: z.object({ node_id: name }),
              head: z.object({
                sha,
                ref: name,
                repo: z.object({ node_id: name }),
              }),
              base: z.object({ ref: name, repo: z.object({ node_id: name }) }),
            })
            .parse(v),
        );
        const matches = pulls.filter((p) => p.body?.includes(marker));
        const p = matches[0];
        if (
          matches.length === 1 &&
          p &&
          p.body === `${a.body}\n\n${marker}` &&
          p.title === a.title &&
          p.draft === a.draft &&
          p.user.node_id === user.node_id &&
          p.head.sha === a.target.expectedHeadSha &&
          p.head.ref === a.target.headRef &&
          p.base.ref === a.target.baseRef &&
          p.head.repo.node_id === a.target.repositoryId &&
          p.base.repo.node_id === a.target.repositoryId
        )
          receipt = {
            nodeId: p.node_id,
            number: p.number,
            headSha: p.head.sha,
          };
      } else if (a.kind.startsWith("pr.") && "expectedHeadSha" in a.target) {
        const p = z
          .object({
            node_id: name,
            number: z.number().int().positive(),
            title: z.string(),
            body: z.string().nullable(),
            draft: z.boolean(),
            merged: z.boolean(),
            head: z.object({
              sha,
              ref: name,
              repo: z.object({ node_id: name }),
            }),
            base: z.object({ ref: name, repo: z.object({ node_id: name }) }),
          })
          .parse(
            (await this.request(`${repo.path}/pulls/${a.target.number}`)).json,
          );
        if (
          p.node_id !== a.target.nodeId ||
          p.number !== a.target.number ||
          p.head.sha !== a.target.expectedHeadSha ||
          p.head.ref !== a.target.headRef ||
          p.base.ref !== a.target.baseRef ||
          p.head.repo.node_id !== a.target.repositoryId ||
          p.base.repo.node_id !== a.target.repositoryId
        )
          throw new Error("provider-pr-mismatch");
        const matches =
          a.kind === "pr.ready"
            ? !p.draft
            : a.kind === "pr.merge"
              ? p.merged
              : a.kind === "pr.edit"
                ? (a.fields.title === undefined ||
                    p.title === a.fields.title) &&
                  (a.fields.body === undefined || p.body === a.fields.body)
                : false;
        if (matches)
          receipt = {
            nodeId: p.node_id,
            number: p.number,
            headSha: p.head.sha,
            merged: p.merged,
          };
      } else if ("number" in a.target) {
        const issue = await this.issue(repo.path, a.target);
        let matches = false;
        if (a.kind === "issue.close") matches = issue.state === "closed";
        if (a.kind === "issue.edit")
          matches =
            (a.fields.title === undefined || issue.title === a.fields.title) &&
            (a.fields.body === undefined || issue.body === a.fields.body);
        if (a.kind === "issue.labels")
          matches =
            a.add.every((l) => issue.labels.some((v) => v.name === l)) &&
            a.remove.every((l) => !issue.labels.some((v) => v.name === l));
        if (a.kind === "project.field")
          matches = (await this.projectField(a)) === a.optionNodeId;
        if (matches)
          receipt = {
            nodeId: issue.node_id,
            number: issue.number,
            issueClosed: issue.state === "closed",
          };
      }
      return actionObservationSchema.parse({
        state: receipt ? "confirmed-success" : "uncertain",
        reason: receipt ? null : "provider-effect-unproved",
        receipt,
      });
    } catch {
      return {
        state: "uncertain",
        reason: "provider-readback-unavailable",
        receipt: null,
      };
    }
  }
}
