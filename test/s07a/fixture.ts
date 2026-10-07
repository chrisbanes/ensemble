import { createHash } from "node:crypto";
import { z } from "zod";
import { deliveryDocuments } from "../../src/standalone/github-delivery.js";
import { actionKinds } from "../../src/core/delivery.js";
const id = z.string().min(1).max(512),
  uuid = z.string().uuid(),
  sha = z.string().regex(/^[0-9a-f]{40}$/),
  ref = z.string().regex(/^[a-zA-Z0-9_/-]+$/);
const journey = z
  .object({
    mode: z.enum(["reviewable-pr", "through-merge"]),
    serviceProjectId: uuid,
    profileId: uuid,
    issue: z
      .object({
        nodeId: id,
        number: z.number().int().positive(),
        itemNodeId: id,
      })
      .strict(),
    pr: z
      .object({
        nodeId: id,
        number: z.number().int().positive(),
        baseRef: ref,
        headRef: ref,
        headSha: sha,
      })
      .strict(),
  })
  .strict();
export const fixtureManifestSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("github.com"),
    account: z.object({ nodeId: id, login: z.literal("chrisbanes") }).strict(),
    repository: z
      .object({
        nodeId: id,
        fullName: z.literal("chrisbanes/ensemble-s07a-fixture"),
        private: z.boolean(),
        defaultBranch: ref,
      })
      .strict(),
    project: z
      .object({ nodeId: id, fieldNodeId: id, progressOptionId: id })
      .strict(),
    credentialRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
    progressLabel: id,
    readinessLabel: id,
    requiredCheck: z.literal("s07a-ci"),
    runtimeTurnLimit: z.number().int().min(1).max(12),
    actions: z.array(z.enum(actionKinds)).min(1),
    fixtureOperations: z.array(z.enum(["status", "feedback"])).min(1),
    journeys: z.array(journey).length(2),
  })
  .strict()
  .superRefine((m, c) => {
    const modes = new Set(m.journeys.map((j) => j.mode)),
      ids = m.journeys.flatMap((j) => [
        j.issue.nodeId,
        j.pr.nodeId,
        j.issue.itemNodeId,
        j.serviceProjectId,
        j.profileId,
      ]),
      numbers = m.journeys.flatMap((j) => [j.issue.number, j.pr.number]);
    if (
      modes.size !== 2 ||
      new Set(ids).size !== ids.length ||
      new Set(numbers).size !== numbers.length ||
      m.progressLabel === m.readinessLabel ||
      m.journeys.some(
        (j) =>
          j.pr.baseRef !== m.repository.defaultBranch ||
          j.pr.headRef === j.pr.baseRef,
      )
    )
      c.addIssue({
        code: "custom",
        message:
          "Fixture identities, modes and default base must be distinct and exact",
      });
  });
const grantSchema = z
  .object({
    version: z.literal(1),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    accountNodeId: id,
    repositoryNodeId: id,
    repositoryVisibility: z.enum(["private", "public"]),
    projectNodeId: id,
    credentialRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
    actions: z.array(z.enum(actionKinds)),
    fixtureOperations: z.array(z.enum(["status", "feedback"])),
    runtimeTurnLimit: z.number().int().min(1).max(12),
    expiresAt: z.iso.datetime(),
    cleanup: z
      .object({
        closeRecordedIssues: z.boolean(),
        closeRecordedPrs: z.boolean(),
        deleteRecordedHeads: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type FixtureManifest = z.output<typeof fixtureManifestSchema>;

/** This guard approves no resources: it only enforces a separately supplied exact grant. */
export class FixtureGuard {
  readonly manifest: FixtureManifest;
  readonly grant: z.output<typeof grantSchema>;
  private turns = 0;
  constructor(manifestText: string, grant: unknown, now = Date.now()) {
    if (grant === undefined) throw new Error("Named live grant is required");
    this.manifest = fixtureManifestSchema.parse(JSON.parse(manifestText));
    this.grant = grantSchema.parse(grant);
    const m = this.manifest,
      g = this.grant;
    if (
      g.manifestSha256 !==
        createHash("sha256").update(manifestText).digest("hex") ||
      g.repositoryNodeId !== m.repository.nodeId ||
      g.repositoryVisibility !==
        (m.repository.private ? "private" : "public") ||
      g.accountNodeId !== m.account.nodeId ||
      g.projectNodeId !== m.project.nodeId ||
      g.credentialRef !== m.credentialRef ||
      (g.expiresAt && Date.parse(g.expiresAt) <= now) ||
      m.actions.some((a) => !g.actions.includes(a)) ||
      g.actions.some((a) => !m.actions.includes(a)) ||
      g.fixtureOperations.some((a) => !m.fixtureOperations.includes(a)) ||
      m.fixtureOperations.some((a) => !g.fixtureOperations.includes(a)) ||
      g.runtimeTurnLimit > m.runtimeTurnLimit
    )
      throw new Error(
        "Live grant does not match current manifest or has expired",
      );
  }
  assertCredentialReference(value: string) {
    if (value !== this.manifest.credentialRef)
      throw new Error("Unexpected credential reference");
  }
  assertDefaultBranch(value: string) {
    if (value !== this.manifest.repository.defaultBranch)
      throw new Error("Fixture base is not the observed default branch");
  }
  assertRepositoryVisibility(value: unknown) {
    this.currentGrant();
    const observed = z.boolean().parse(value);
    if (
      observed !== this.manifest.repository.private ||
      this.grant.repositoryVisibility !== (observed ? "private" : "public")
    )
      throw new Error(
        "Observed fixture visibility does not match the explicit grant",
      );
  }
  private currentGrant() {
    if (Date.now() >= Date.parse(this.grant.expiresAt))
      throw new Error("Live grant expired");
  }
  beginRuntimeTurn() {
    this.currentGrant();
    if (
      this.turns >=
      Math.min(this.grant.runtimeTurnLimit, this.manifest.runtimeTurnLimit)
    )
      throw new Error("Live runtime turn limit exhausted");
    this.turns++;
    return this.turns;
  }
  get runtimeTurns() {
    return this.turns;
  }
  private permits(action: (typeof actionKinds)[number]) {
    if (!this.grant.actions.includes(action))
      throw new Error("Fixture action is not granted");
  }
  assertRequest(
    input: string | URL | Request,
    init: RequestInit = {},
    cleanup = false,
  ): void {
    this.currentGrant();
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://api.github.com" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Unexpected fixture endpoint");
    const method = (
        init.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase(),
      m = this.manifest,
      root = `/repos/${m.repository.fullName}`;
    const body =
      init.body === undefined
        ? {}
        : z
            .record(z.string(), z.unknown())
            .parse(JSON.parse(String(init.body)));
    if (url.pathname === "/graphql") {
      if (method !== "POST") throw new Error("Unexpected GraphQL method");
      const query = z.string().parse(body.query),
        variables = z
          .record(z.string(), z.unknown())
          .parse(body.variables ?? {}),
        operation = /^(query|mutation)\s+(EnsembleDelivery\w+)\b/.exec(query);
      if (
        !operation ||
        !Object.values(deliveryDocuments).some((document) => document === query)
      )
        throw new Error("Unexpected fixture GraphQL operation");
      const permittedQueries = new Set([
        "EnsembleDeliveryRepository",
        "EnsembleDeliveryPr",
        "EnsembleDeliveryField",
        "EnsembleDeliveryClosure",
      ]);
      const allowedIds = new Set([
        m.repository.nodeId,
        m.project.nodeId,
        m.project.fieldNodeId,
        m.project.progressOptionId,
        ...m.journeys.flatMap((j) => [
          j.issue.nodeId,
          j.issue.itemNodeId,
          j.pr.nodeId,
        ]),
      ]);
      for (const [key, value] of Object.entries(variables))
        if (
          key !== "after" &&
          typeof value === "string" &&
          !allowedIds.has(value)
        )
          throw new Error("Unexpected fixture GraphQL identity");
      if (operation[1] === "query" && permittedQueries.has(operation[2] ?? ""))
        return;
      if (operation[2] === "EnsembleDeliveryProject") {
        this.permits("project.field");
        if (
          variables.project !== m.project.nodeId ||
          variables.field !== m.project.fieldNodeId ||
          variables.option !== m.project.progressOptionId ||
          !m.journeys.some((j) => j.issue.itemNodeId === variables.item)
        )
          throw new Error("Unexpected fixture Project field material");
        return;
      }
      if (operation[2] === "EnsembleDeliveryReady") {
        this.permits("pr.ready");
        if (!m.journeys.some((j) => j.pr.nodeId === variables.id))
          throw new Error("Unexpected fixture PR identity");
        return;
      }
      throw new Error("Unexpected fixture GraphQL mutation");
    }
    if (method === "GET") {
      if (url.pathname === "/user" || url.pathname === root) return;
      if (!url.pathname.startsWith(`${root}/`))
        throw new Error("Unexpected fixture repository");
      const path = url.pathname.slice(root.length);
      if (
        /^\/(issues|pulls)\/\d+(\/(comments|reviews|dependencies\/blocked_by))?$/.test(
          path,
        ) &&
        m.journeys.some((j) =>
          [j.issue.number, j.pr.number].includes(Number(path.split("/")[2])),
        )
      )
        return;
      if (
        m.journeys.some(
          (j) =>
            path === `/commits/${j.pr.headSha}/check-runs` ||
            path === `/commits/${j.pr.headSha}/statuses` ||
            path === `/git/ref/heads/${encodeURIComponent(j.pr.headRef)}` ||
            path === `/git/ref/heads/${encodeURIComponent(j.pr.baseRef)}`,
        )
      )
        return;
      if (
        path ===
          `/rules/branches/${encodeURIComponent(m.repository.defaultBranch)}` ||
        path ===
          `/branches/${encodeURIComponent(m.repository.defaultBranch)}/protection`
      )
        return;
      if (
        path === "/deployments" &&
        m.journeys.some((j) => url.searchParams.get("sha") === j.pr.headSha)
      )
        return;
      throw new Error("Unexpected fixture read");
    }
    if (!url.pathname.startsWith(`${root}/`))
      throw new Error("Unexpected fixture repository");
    const path = url.pathname.slice(root.length),
      match = /^\/(issues|pulls)\/(\d+)(.*)$/.exec(path),
      number = Number(match?.[2]),
      j = m.journeys.find(
        (j) => j.issue.number === number || j.pr.number === number,
      ),
      suffix = match?.[3];
    if (cleanup) {
      if (
        method === "PATCH" &&
        j &&
        suffix === "" &&
        body.state === "closed" &&
        Object.keys(body).length === 1 &&
        ((match?.[1] === "issues" &&
          number === j.issue.number &&
          this.grant.cleanup.closeRecordedIssues) ||
          (match?.[1] === "pulls" &&
            number === j.pr.number &&
            this.grant.cleanup.closeRecordedPrs))
      )
        return;
      if (
        method === "DELETE" &&
        this.grant.cleanup.deleteRecordedHeads &&
        m.journeys.some(
          (j) => path === `/git/refs/heads/${encodeURIComponent(j.pr.headRef)}`,
        )
      )
        return;
      throw new Error("Unexpected fixture cleanup");
    }
    if (method === "POST" && path.startsWith("/statuses/")) {
      if (
        this.grant.fixtureOperations.includes("status") &&
        m.journeys.some((j) => path === `/statuses/${j.pr.headSha}`) &&
        body.context === m.requiredCheck &&
        ["failure", "success", "pending"].includes(String(body.state)) &&
        Object.keys(body).every((k) =>
          ["context", "state", "description"].includes(k),
        )
      )
        return;
      throw new Error("Unexpected fixture status");
    }
    if (method === "POST" && path === "/pulls") {
      this.permits("pr.create");
      if (
        m.journeys.some(
          (j) => body.head === j.pr.headRef && body.base === j.pr.baseRef,
        ) &&
        Object.keys(body).every((k) =>
          ["title", "body", "head", "base", "draft"].includes(k),
        )
      )
        return;
      throw new Error("Unexpected fixture PR creation");
    }
    if (!j) throw new Error("Unexpected fixture issue or PR");
    if (
      method === "PUT" &&
      match?.[1] === "pulls" &&
      number === j.pr.number &&
      suffix === "/merge"
    ) {
      this.permits("pr.merge");
      if (
        j.mode === "through-merge" &&
        body.sha === j.pr.headSha &&
        body.merge_method === "squash" &&
        Object.keys(body).length === 2
      )
        return;
      throw new Error("Unexpected fixture merge");
    }
    if (
      method === "POST" &&
      match?.[1] === "issues" &&
      suffix === "/comments" &&
      typeof body.body === "string" &&
      Object.keys(body).length === 1
    ) {
      this.permits("issue.comment");
      return;
    }
    if (
      method === "POST" &&
      number === j.issue.number &&
      suffix === "/labels" &&
      Array.isArray(body.labels) &&
      body.labels.length === 1 &&
      body.labels[0] === m.progressLabel
    ) {
      this.permits("issue.labels");
      return;
    }
    if (
      method === "DELETE" &&
      number === j.issue.number &&
      suffix === `/labels/${encodeURIComponent(m.progressLabel)}`
    ) {
      this.permits("issue.labels");
      return;
    }
    if (method === "PATCH" && suffix === "") {
      if (
        match?.[1] === "issues" &&
        number === j.issue.number &&
        body.state === "closed" &&
        Object.keys(body).length === 1
      ) {
        this.permits("issue.close");
        return;
      }
      if (
        Object.keys(body).length &&
        Object.keys(body).every((k) => ["title", "body"].includes(k)) &&
        Object.values(body).every((v) => typeof v === "string")
      ) {
        this.permits(match?.[1] === "issues" ? "issue.edit" : "pr.edit");
        return;
      }
    }
    throw new Error("Unexpected fixture effect");
  }
  fetcher(fetcher: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
      this.assertRequest(input, init);
      return fetcher(input, { ...init, redirect: "error" });
    };
  }
}
export function qualificationDisposition(results: {
  handback: "passed" | "failed" | "unproved";
  throughMerge: "passed" | "failed" | "unproved";
  cleanup: "passed" | "failed" | "unproved";
}) {
  const values = Object.values(results);
  return values.includes("failed")
    ? "failed"
    : values.every((v) => v === "passed")
      ? "passed"
      : "unproved";
}

/** A restart checkpoint requires successful terminal work, not merely no active intent. */
export function qualificationTaskIdle(
  taskId: string,
  requests: ReadonlyArray<{
    taskId: string | null;
    workId: string;
    state: string;
  }>,
  intents: ReadonlyArray<{ workId: string; state: string }>,
): boolean {
  const taskRequests = requests.filter((request) => request.taskId === taskId);
  return (
    taskRequests.length > 0 &&
    taskRequests.every(
      (request) =>
        request.state === "completed" &&
        intents.some(
          (intent) =>
            intent.workId === request.workId && intent.state === "completed",
        ),
    )
  );
}
