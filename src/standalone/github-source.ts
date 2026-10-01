import { z } from "zod";
import type {
  GitHubSelection,
  IssueSnapshot,
  SelectionSnapshot,
  IssueStatus,
  BlockerSnapshot,
  IssueReference,
} from "../core/github-source.js";
export type {
  IssueSnapshot,
  SelectionSnapshot,
  IssueStatus,
  BlockerSnapshot,
  IssueReference,
} from "../core/github-source.js";

const name = z.string().min(1);
const issueSchema = z
  .object({
    node_id: name,
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    repository_url: z.string().url(),
    labels: z.array(z.union([z.string(), z.object({ name }).passthrough()])),
    pull_request: z.unknown().optional(),
  })
  .passthrough();
const repositorySchema = z
  .object({ node_id: name, full_name: name })
  .passthrough();
const searchSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    incomplete_results: z.boolean(),
    items: z.array(issueSchema),
  })
  .passthrough();
const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const fieldValueSchema = z
  .object({
    __typename: z.string(),
    optionId: z.string().nullable().optional(),
    field: z.object({ id: name }).optional(),
  })
  .passthrough();
const fieldValueConnectionSchema = z.object({
  nodes: z.array(fieldValueSchema),
  pageInfo: pageInfoSchema,
});
const fieldDefinitionSchema = z
  .object({
    __typename: z.string(),
    id: name.optional(),
    options: z.array(z.object({ id: name, name: z.string() })).optional(),
  })
  .passthrough();
const fieldDefinitionConnectionSchema = z.object({
  nodes: z.array(fieldDefinitionSchema),
  pageInfo: pageInfoSchema,
});
const projectItemSchema = z.object({
  id: name,
  content: z.object({ __typename: z.string() }).passthrough().nullable(),
  fieldValues: fieldValueConnectionSchema,
});
const projectPageSchema = z.object({
  data: z.object({
    node: z.object({
      id: name,
      items: z.object({
        nodes: z.array(projectItemSchema),
        pageInfo: pageInfoSchema,
      }),
      fields: fieldDefinitionConnectionSchema,
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const projectFieldPageSchema = z.object({
  data: z.object({
    node: z.object({ id: name, fields: fieldDefinitionConnectionSchema }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const projectValuePageSchema = z.object({
  data: z.object({
    node: z.object({ id: name, fieldValues: fieldValueConnectionSchema }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const projectIssueSchema = z.object({
  __typename: z.literal("Issue"),
  id: name,
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED"]),
  repository: z.object({ id: name, nameWithOwner: name }),
  labels: z.object({
    nodes: z.array(z.object({ name })),
    pageInfo: pageInfoSchema,
  }),
});

const projectPageQuery = `query EnsembleProjectPage($id:ID!,$query:String!,$after:String){node(id:$id){... on ProjectV2{id items(first:100,after:$after,query:$query){nodes{id content{__typename ... on Issue{id number title body state repository{id nameWithOwner} labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}}} fieldValues(first:100){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2SingleSelectField{id}}}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}} fields(first:100){nodes{__typename ... on ProjectV2SingleSelectField{id options{id name}}} pageInfo{hasNextPage endCursor}}}}}`;
const projectValuesQuery = `query EnsembleProjectFieldValues($id:ID!,$after:String){node(id:$id){... on ProjectV2Item{id fieldValues(first:100,after:$after){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{optionId field{... on ProjectV2SingleSelectField{id}}}} pageInfo{hasNextPage endCursor}}}}}`;
const projectFieldsQuery = `query EnsembleProjectFields($id:ID!,$after:String){node(id:$id){... on ProjectV2{id fields(first:100,after:$after){nodes{__typename ... on ProjectV2SingleSelectField{id options{id name}}} pageInfo{hasNextPage endCursor}}}}}`;

export interface GitHubSourceReader {
  readSelection(selection: GitHubSelection): Promise<SelectionSnapshot>;
  readIssueStatus(reference: IssueReference): Promise<IssueStatus>;
  readBlockers(reference: IssueReference): Promise<BlockerSnapshot>;
  previewSelection(selection: GitHubSelection): Promise<SelectionSnapshot>;
}

const MAX_PAGES = 100;
const api = "https://api.github.com";

function nextLink(response: Response): string | null {
  const header = response.headers.get("link");
  if (!header) return null;
  const links = header.split(",");
  const next = links.find((part) => /;\s*rel="next"/.test(part));
  if (!next) return null;
  const match = /<([^>]+)>/.exec(next);
  if (!match?.[1]) throw new Error("invalid-pagination");
  const url = new URL(match[1]);
  if (url.origin !== api) throw new Error("invalid-pagination-origin");
  return url.href;
}

function issueFromRest(
  value: z.output<typeof issueSchema>,
  repository: z.output<typeof repositorySchema>,
): IssueSnapshot {
  return {
    providerInstance: "github.com",
    nodeId: value.node_id,
    repositoryId: repository.node_id,
    repositoryName: repository.full_name,
    number: value.number,
    title: value.title,
    body: value.body ?? "",
    state: value.state,
    labels: value.labels.map((label) =>
      typeof label === "string" ? label : label.name,
    ),
    projectFields: [],
  };
}

function safeReason(error: unknown): string {
  if (
    error instanceof Error &&
    /^(missing-credential|page-limit|search-window|invalid-|http-|repository-mismatch)/.test(
      error.message,
    )
  )
    return error.message;
  return "unreadable-provider-data";
}

export class GitHubHttpSourceReader implements GitHubSourceReader {
  constructor(
    private readonly token: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    url: string,
    body?: object,
  ): Promise<{ response: Response; value: unknown }> {
    if (!this.token) throw new Error("missing-credential");
    const target = new URL(url);
    if (target.origin !== api) throw new Error("invalid-provider-origin");
    const response = await this.fetcher(target.href, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    try {
      return { response, value: (await response.json()) as unknown };
    } catch {
      throw new Error("invalid-json");
    }
  }

  private async repository(
    owner: string,
    name: string,
  ): Promise<z.output<typeof repositorySchema>> {
    return repositorySchema.parse(
      (
        await this.request(
          `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        )
      ).value,
    );
  }

  private async graphql(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const value = (
      await this.request(`${api}/graphql`, { operationName, query, variables })
    ).value;
    const envelope = z
      .object({ errors: z.array(z.unknown()).optional() })
      .passthrough()
      .parse(value);
    if (envelope.errors?.length) throw new Error("invalid-graphql-response");
    return value;
  }

  private async pages<T>(
    url: string,
    schema: z.ZodType<T>,
    onPage?: (values: T[]) => void,
  ): Promise<T[]> {
    const result: T[] = [];
    const seen = new Set<string>();
    for (let page = 0; url; page++) {
      if (page >= MAX_PAGES || seen.has(url)) throw new Error("page-limit");
      seen.add(url);
      const { response, value } = await this.request(url);
      const values = z.array(schema).parse(value);
      result.push(...values);
      onPage?.(values);
      url = nextLink(response) ?? "";
    }
    return result;
  }

  async readSelection(selection: GitHubSelection): Promise<SelectionSnapshot> {
    const issues: IssueSnapshot[] = [];
    try {
      if (selection.kind === "repository") {
        const repository = await this.repository(
          selection.owner,
          selection.name,
        );
        if (repository.node_id !== selection.repositoryId)
          throw new Error("repository-mismatch");
        await this.pages(
          `${api}/repos/${encodeURIComponent(selection.owner)}/${encodeURIComponent(selection.name)}/issues?state=all&per_page=100`,
          issueSchema,
          (values) => {
            for (const value of values) {
              if (
                value.repository_url.toLowerCase() !==
                `${api}/repos/${repository.full_name}`.toLowerCase()
              )
                throw new Error("repository-mismatch");
              if (value.pull_request === undefined)
                issues.push(issueFromRest(value, repository));
            }
          },
        );
      } else if (selection.kind === "search") {
        let url = `${api}/search/issues?q=${encodeURIComponent(selection.query)}&per_page=100`;
        const seen = new Set<string>();
        let count = 0;
        for (let page = 0; url; page++) {
          if (page >= MAX_PAGES || seen.has(url)) throw new Error("page-limit");
          seen.add(url);
          const { response, value } = await this.request(url);
          const result = searchSchema.parse(value);
          if (result.incomplete_results || result.total_count > 1000)
            throw new Error("search-window");
          count += result.items.length;
          for (const item of result.items) {
            if (item.pull_request !== undefined) continue;
            const match =
              /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(
                item.repository_url,
              );
            if (!match?.[1] || !match[2])
              throw new Error("invalid-repository-reference");
            const repository = await this.repository(match[1], match[2]);
            issues.push(issueFromRest(item, repository));
          }
          url = nextLink(response) ?? "";
          if (!url && count !== result.total_count)
            throw new Error("invalid-search-count");
        }
      } else {
        return this.readProject(selection);
      }
      const unique = new Map(issues.map((issue) => [issue.nodeId, issue]));
      return { complete: true, issues: [...unique.values()], reason: null };
    } catch (error) {
      return { complete: false, issues, reason: safeReason(error) };
    }
  }

  async previewSelection(
    selection: GitHubSelection,
  ): Promise<SelectionSnapshot> {
    return this.readSelection(selection);
  }

  async readIssueStatus(reference: IssueReference): Promise<IssueStatus> {
    try {
      const [owner, name, extra] = reference.repositoryName.split("/");
      if (!owner || !name || extra)
        throw new Error("invalid-repository-reference");
      const repository = await this.repository(owner, name);
      if (
        repository.node_id !== reference.repositoryId ||
        repository.full_name.toLowerCase() !==
          reference.repositoryName.toLowerCase()
      )
        throw new Error("repository-mismatch");
      const issue = issueSchema.parse(
        (
          await this.request(
            `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${reference.number}`,
          )
        ).value,
      );
      if (
        issue.node_id !== reference.nodeId ||
        issue.number !== reference.number ||
        issue.pull_request !== undefined ||
        issue.repository_url.toLowerCase() !==
          `${api}/repos/${repository.full_name}`.toLowerCase()
      )
        throw new Error("invalid-issue-identity");
      return { status: issue.state };
    } catch (error) {
      return { status: "unknown", reason: safeReason(error) };
    }
  }

  async readBlockers(reference: IssueReference): Promise<BlockerSnapshot> {
    const blockers: IssueSnapshot[] = [];
    try {
      const [owner, name, extra] = reference.repositoryName.split("/");
      if (!owner || !name || extra)
        throw new Error("invalid-repository-reference");
      const values = await this.pages(
        `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${reference.number}/dependencies/blocked_by?per_page=100`,
        issueSchema,
      );
      for (const issue of values) {
        if (issue.pull_request !== undefined)
          throw new Error("invalid-blocker-type");
        const match =
          /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(
            issue.repository_url,
          );
        if (!match?.[1] || !match[2])
          throw new Error("invalid-repository-reference");
        const repository = await this.repository(match[1], match[2]);
        const candidate = issueFromRest(issue, repository);
        const status = await this.readIssueStatus(candidate);
        if (status.status === "unknown")
          throw new Error("invalid-blocker-status");
        blockers.push({ ...candidate, state: status.status });
      }
      return {
        complete: true,
        blockers: [
          ...new Map(
            blockers.map((blocker) => [blocker.nodeId, blocker]),
          ).values(),
        ],
        reason: null,
      };
    } catch (error) {
      return { complete: false, blockers, reason: safeReason(error) };
    }
  }

  private async readProject(
    selection: Extract<GitHubSelection, { kind: "project" }>,
  ): Promise<SelectionSnapshot> {
    const issues: IssueSnapshot[] = [];
    try {
      let itemCursor: string | null = null;
      const seenItems = new Set<string>();
      const fieldDefinitions: z.output<typeof fieldDefinitionSchema>[] = [];
      let firstFields:
        | z.output<typeof fieldDefinitionConnectionSchema>
        | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = projectPageSchema.parse(
          await this.graphql("EnsembleProjectPage", projectPageQuery, {
            id: selection.projectNodeId,
            query: selection.filter,
            after: itemCursor,
          }),
        );
        if (result.data.node.id !== selection.projectNodeId)
          throw new Error("invalid-project-identity");
        firstFields ??= result.data.node.fields;
        fieldDefinitions.push(...result.data.node.fields.nodes);
        for (const item of result.data.node.items.nodes) {
          if (item.content?.__typename !== "Issue") continue;
          const content = projectIssueSchema.parse(item.content);
          if (content.labels.pageInfo.hasNextPage)
            throw new Error("invalid-label-pagination");
          const values = [...item.fieldValues.nodes];
          if (
            item.fieldValues.pageInfo.hasNextPage &&
            !item.fieldValues.pageInfo.endCursor
          )
            throw new Error("invalid-pagination");
          let valueCursor = item.fieldValues.pageInfo.endCursor;
          const seenValues = new Set<string>();
          for (
            let nested = 0;
            item.fieldValues.pageInfo.hasNextPage && valueCursor;
            nested++
          ) {
            if (nested >= MAX_PAGES || seenValues.has(valueCursor))
              throw new Error("page-limit");
            seenValues.add(valueCursor);
            const extra = projectValuePageSchema.parse(
              await this.graphql(
                "EnsembleProjectFieldValues",
                projectValuesQuery,
                { id: item.id, after: valueCursor },
              ),
            );
            if (extra.data.node.id !== item.id)
              throw new Error("invalid-project-item-identity");
            values.push(...extra.data.node.fieldValues.nodes);
            if (!extra.data.node.fieldValues.pageInfo.hasNextPage) break;
            valueCursor = extra.data.node.fieldValues.pageInfo.endCursor;
            if (!valueCursor) throw new Error("invalid-pagination");
          }
          const projectFields = values
            .filter(
              (value) =>
                value.__typename === "ProjectV2ItemFieldSingleSelectValue",
            )
            .map((value) => {
              if (!value.optionId || !value.field?.id)
                throw new Error("invalid-project-field-value");
              return {
                projectNodeId: selection.projectNodeId,
                fieldNodeId: value.field.id,
                optionNodeId: value.optionId,
              };
            });
          issues.push({
            providerInstance: "github.com",
            nodeId: content.id,
            repositoryId: content.repository.id,
            repositoryName: content.repository.nameWithOwner,
            number: content.number,
            title: content.title,
            body: content.body ?? "",
            state: content.state.toLowerCase() as "open" | "closed",
            labels: content.labels.nodes.map((label) => label.name),
            projectFields,
          });
        }
        if (!result.data.node.items.pageInfo.hasNextPage) break;
        itemCursor = result.data.node.items.pageInfo.endCursor;
        if (!itemCursor || seenItems.has(itemCursor))
          throw new Error("invalid-pagination");
        seenItems.add(itemCursor);
        if (page === MAX_PAGES - 1) throw new Error("page-limit");
      }
      if (!firstFields) throw new Error("invalid-project-fields");
      if (firstFields.pageInfo.hasNextPage && !firstFields.pageInfo.endCursor)
        throw new Error("invalid-pagination");
      let fieldCursor = firstFields.pageInfo.endCursor;
      const seenFields = new Set<string>();
      for (
        let page = 0;
        firstFields.pageInfo.hasNextPage && fieldCursor;
        page++
      ) {
        if (page >= MAX_PAGES || seenFields.has(fieldCursor))
          throw new Error("page-limit");
        seenFields.add(fieldCursor);
        const extra = projectFieldPageSchema.parse(
          await this.graphql("EnsembleProjectFields", projectFieldsQuery, {
            id: selection.projectNodeId,
            after: fieldCursor,
          }),
        );
        if (extra.data.node.id !== selection.projectNodeId)
          throw new Error("invalid-project-identity");
        fieldDefinitions.push(...extra.data.node.fields.nodes);
        if (!extra.data.node.fields.pageInfo.hasNextPage) break;
        fieldCursor = extra.data.node.fields.pageInfo.endCursor;
        if (!fieldCursor) throw new Error("invalid-pagination");
      }
      const singleSelect = new Map(
        fieldDefinitions
          .filter(
            (field) =>
              field.__typename === "ProjectV2SingleSelectField" && field.id,
          )
          .map((field) => [
            field.id ?? "",
            new Set(field.options?.map((option) => option.id) ?? []),
          ]),
      );
      for (const issue of issues)
        for (const field of issue.projectFields)
          if (!singleSelect.get(field.fieldNodeId)?.has(field.optionNodeId))
            throw new Error("invalid-project-field-definition");
      return {
        complete: true,
        issues: [
          ...new Map(issues.map((issue) => [issue.nodeId, issue])).values(),
        ],
        reason: null,
      };
    } catch (error) {
      return { complete: false, issues, reason: safeReason(error) };
    }
  }
}
