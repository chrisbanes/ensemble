import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubHttpSourceReader } from "../src/standalone/github-source.js";

const issue = (number: number, node_id = `I_${number}`) => ({
  node_id,
  number,
  title: `Issue ${number}`,
  body: "Outcome",
  state: "open",
  repository_url: "https://api.github.com/repos/org/repo",
  labels: [{ name: "ready" }],
});

test("repository selection follows every page, excludes PRs, and reports page failure as incomplete", async () => {
  const requests: string[] = [];
  let failSecond = false;
  const reader = new GitHubHttpSourceReader("fixture-token", async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/org/repo")
      return new Response(
        JSON.stringify({ node_id: "R_1", full_name: "org/repo" }),
        { status: 200 },
      );
    if (url.includes("page=2")) {
      return new Response(
        failSecond ? "denied" : JSON.stringify([issue(2), issue(2)]),
        {
          status: failSecond ? 403 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify([
        issue(1),
        {
          ...issue(3),
          pull_request: {
            url: "https://api.github.com/repos/org/repo/pulls/3",
          },
        },
      ]),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://api.github.com/repos/org/repo/issues?state=all&per_page=100&page=2>; rel="next"',
        },
      },
    );
  });
  const selection = {
    id: "repo",
    kind: "repository" as const,
    repositoryId: "R_1",
    owner: "org",
    name: "repo",
  };
  const complete = await reader.readSelection(selection);
  assert.equal(complete.complete, true);
  assert.deepEqual(
    complete.issues.map((entry) => entry.nodeId),
    ["I_1", "I_2"],
  );
  assert.equal(requests.length, 3);
  failSecond = true;
  const partial = await reader.readSelection(selection);
  assert.equal(partial.complete, false);
  assert.deepEqual(
    partial.issues.map((entry) => entry.nodeId),
    ["I_1"],
  );
  assert.doesNotMatch(partial.reason ?? "", /fixture-token/);
});

test("repository selection does not accept an issue claiming another repository", async () => {
  const reader = new GitHubHttpSourceReader("fixture-token", async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/org/repo")
      return new Response(
        JSON.stringify({ node_id: "R_1", full_name: "org/repo" }),
      );
    return new Response(
      JSON.stringify([
        {
          ...issue(4),
          repository_url: "https://api.github.com/repos/other/repo",
        },
      ]),
    );
  });
  const snapshot = await reader.readSelection({
    id: "repo",
    kind: "repository",
    repositoryId: "R_1",
    owner: "org",
    name: "repo",
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.issues.length, 0);
});

test("native blocker pages include outside-selection issue status and exact-reference mismatch is unknown", async () => {
  let secondPageFails = false;
  let statusRepositoryMismatch = false;
  const methods: string[] = [];
  const reader = new GitHubHttpSourceReader(
    "fixture-token",
    async (input, init) => {
      const url = String(input);
      methods.push(init?.method ?? "GET");
      if (url === "https://api.github.com/repos/other/repo")
        return new Response(
          JSON.stringify({ node_id: "R_2", full_name: "other/repo" }),
        );
      if (url === "https://api.github.com/repos/other/repo/issues/7")
        return new Response(
          JSON.stringify({
            ...issue(7, "B_7"),
            repository_url: statusRepositoryMismatch
              ? "https://api.github.com/repos/wrong/repo"
              : "https://api.github.com/repos/other/repo",
            state: "closed",
          }),
        );
      if (url.includes("page=2"))
        return new Response(secondPageFails ? "denied" : "[]", {
          status: secondPageFails ? 403 : 200,
        });
      if (url.includes("/dependencies/blocked_by"))
        return new Response(
          JSON.stringify([
            {
              ...issue(7, "B_7"),
              repository_url: "https://api.github.com/repos/other/repo",
            },
          ]),
          { headers: { link: `<${url}&page=2>; rel="next"` } },
        );
      throw new Error("Unexpected fixture URL");
    },
  );
  const reference = {
    nodeId: "I_1",
    repositoryId: "R_1",
    repositoryName: "org/repo",
    number: 1,
  };
  const complete = await reader.readBlockers(reference);
  assert.equal(complete.complete, true);
  assert.deepEqual(
    complete.blockers.map((entry) => [
      entry.nodeId,
      entry.repositoryId,
      entry.state,
    ]),
    [["B_7", "R_2", "closed"]],
  );
  assert.deepEqual(new Set(methods), new Set(["GET"]));
  secondPageFails = true;
  const partial = await reader.readBlockers(reference);
  assert.equal(partial.complete, false);
  const mismatch = await reader.readIssueStatus({
    nodeId: "B_wrong",
    repositoryId: "R_2",
    repositoryName: "other/repo",
    number: 7,
  });
  assert.equal(mismatch.status, "unknown");
  statusRepositoryMismatch = true;
  const wrongRepository = await reader.readIssueStatus({
    nodeId: "B_7",
    repositoryId: "R_2",
    repositoryName: "other/repo",
    number: 7,
  });
  assert.equal(wrongRepository.status, "unknown");
});

test("Project filter is passed unchanged and nested field/definition pages must finish", async () => {
  const calls: Array<{
    operationName: string;
    variables: Record<string, unknown>;
  }> = [];
  let failNested = false;
  let missingNestedCursor = false;
  const pageInfo = (next: string | null) => ({
    hasNextPage: next !== null,
    endCursor: next,
  });
  const reader = new GitHubHttpSourceReader(
    "fixture-token",
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        operationName: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);
      if (body.operationName === "EnsembleProjectPage") {
        return new Response(
          JSON.stringify({
            data: {
              node: {
                id: "P_1",
                items: {
                  nodes: [
                    {
                      id: "PVTI_1",
                      content: {
                        __typename: "Issue",
                        id: "I_1",
                        number: 1,
                        title: "Issue 1",
                        body: "Outcome",
                        state: "OPEN",
                        repository: { id: "R_1", nameWithOwner: "org/repo" },
                        labels: {
                          nodes: [{ name: "ready" }],
                          pageInfo: pageInfo(null),
                        },
                      },
                      fieldValues: {
                        nodes: [],
                        pageInfo: missingNestedCursor
                          ? { hasNextPage: true, endCursor: null }
                          : pageInfo("fields-2"),
                      },
                    },
                    {
                      id: "PVTI_draft",
                      content: { __typename: "DraftIssue" },
                      fieldValues: { nodes: [], pageInfo: pageInfo(null) },
                    },
                  ],
                  pageInfo: pageInfo(null),
                },
                fields: {
                  nodes: [
                    {
                      __typename: "ProjectV2SingleSelectField",
                      id: "F_1",
                      options: [{ id: "O_1", name: "Ready" }],
                    },
                  ],
                  pageInfo: pageInfo("definitions-2"),
                },
              },
            },
          }),
        );
      }
      if (body.operationName === "EnsembleProjectFieldValues") {
        if (failNested)
          return new Response(
            JSON.stringify({ errors: [{ message: "denied" }] }),
          );
        return new Response(
          JSON.stringify({
            data: {
              node: {
                id: "PVTI_1",
                fieldValues: {
                  nodes: [
                    {
                      __typename: "ProjectV2ItemFieldSingleSelectValue",
                      optionId: "O_1",
                      field: { id: "F_1" },
                    },
                  ],
                  pageInfo: pageInfo(null),
                },
              },
            },
          }),
        );
      }
      if (body.operationName === "EnsembleProjectFields")
        return new Response(
          JSON.stringify({
            data: {
              node: {
                id: "P_1",
                fields: { nodes: [], pageInfo: pageInfo(null) },
              },
            },
          }),
        );
      throw new Error("Unexpected operation");
    },
  );
  const selection = {
    id: "project",
    kind: "project" as const,
    projectNodeId: "P_1",
    filter: "status:ready",
  };
  const complete = await reader.readSelection(selection);
  assert.equal(complete.complete, true);
  assert.deepEqual(
    complete.issues.map((entry) => [entry.nodeId, entry.projectFields]),
    [
      [
        "I_1",
        [{ projectNodeId: "P_1", fieldNodeId: "F_1", optionNodeId: "O_1" }],
      ],
    ],
  );
  assert.equal(calls[0]?.variables.query, "status:ready");
  assert.deepEqual(
    calls.map((call) => call.operationName),
    [
      "EnsembleProjectPage",
      "EnsembleProjectFieldValues",
      "EnsembleProjectFields",
    ],
  );
  failNested = true;
  const incomplete = await reader.readSelection(selection);
  assert.equal(incomplete.complete, false);
  failNested = false;
  missingNestedCursor = true;
  const cursorless = await reader.readSelection(selection);
  assert.equal(cursorless.complete, false);
});

test("search deduplicates complete pages and rejects truncation, incomplete results, rate limits and missing credentials", async () => {
  let mode: "complete" | "cap" | "incomplete" | "rate" = "complete";
  const reader = new GitHubHttpSourceReader("fixture-token", async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/org/repo")
      return new Response(
        JSON.stringify({ node_id: "R_1", full_name: "org/repo" }),
      );
    if (mode === "rate") return new Response("rate limit", { status: 429 });
    const second = url.includes("page=2");
    const items = second
      ? [issue(1)]
      : [
          issue(1),
          {
            ...issue(2),
            pull_request: {
              url: "https://api.github.com/repos/org/repo/pulls/2",
            },
          },
        ];
    return new Response(
      JSON.stringify({
        total_count: mode === "cap" ? 1001 : 3,
        incomplete_results: mode === "incomplete",
        items,
      }),
      {
        headers: second ? {} : { link: `<${url}&page=2>; rel="next"` },
      },
    );
  });
  const selection = {
    id: "search",
    kind: "search" as const,
    query: "repo:org/repo label:ready",
  };
  const complete = await reader.readSelection(selection);
  assert.equal(complete.complete, true);
  assert.deepEqual(
    complete.issues.map((entry) => entry.nodeId),
    ["I_1"],
  );
  for (mode of ["cap", "incomplete", "rate"] as const) {
    const result = await reader.readSelection(selection);
    assert.equal(result.complete, false, mode);
    assert.doesNotMatch(result.reason ?? "", /fixture-token/);
  }
  const missing = await new GitHubHttpSourceReader(undefined, async () => {
    throw new Error("fetch must not run");
  }).readSelection(selection);
  assert.equal(missing.complete, false);
  assert.equal(missing.reason, "missing-credential");
});

const repoSelection = {
  id: "repo",
  kind: "repository" as const,
  repositoryId: "R_1",
  owner: "org",
  name: "repo",
};
const limitedReader = (response: () => Response) =>
  new GitHubHttpSourceReader("fixture-token", async () => response());

test("403 with an exhausted limit or 429 with retry-after reports a rate-limited incomplete read that names when to resume", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 120;
  const exhausted = await limitedReader(
    () =>
      new Response("limit", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      }),
  ).readSelection(repoSelection);
  assert.equal(exhausted.complete, false);
  assert.equal(exhausted.reason, "rate-limited");
  assert.equal(
    exhausted.complete === false ? exhausted.resumeAt : undefined,
    reset * 1000,
  );

  const before = Date.now();
  const retry = await limitedReader(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
  ).readSelection(repoSelection);
  const after = Date.now();
  assert.equal(retry.reason, "rate-limited");
  const resumeAt = retry.complete === false ? (retry.resumeAt ?? 0) : 0;
  assert.ok(resumeAt >= before + 30_000 && resumeAt <= after + 30_000);

  const both = await limitedReader(
    () =>
      new Response("limit", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "4000",
          "retry-after": "30",
        },
      }),
  ).readSelection(repoSelection);
  assert.ok(
    (both.complete === false ? (both.resumeAt ?? 0) : 0) >= Date.now() + 29_000,
  );
});

test("a rate-limit pause from external headers is capped at one hour", async () => {
  const before = Date.now();
  const result = await limitedReader(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "999999999" },
      }),
  ).readSelection(repoSelection);
  const after = Date.now();
  assert.equal(result.reason, "rate-limited");
  const resumeAt = result.complete === false ? (result.resumeAt ?? 0) : 0;
  assert.ok(resumeAt >= before + 3_600_000 && resumeAt <= after + 3_600_000);
});

test("a 403 without rate-limit headers stays an http failure", async () => {
  const denied = await limitedReader(
    () => new Response("denied", { status: 403 }),
  ).readSelection(repoSelection);
  assert.equal(denied.complete, false);
  assert.equal(denied.reason, "http-403");
  assert.equal("resumeAt" in denied, false);
  const remaining = await limitedReader(
    () =>
      new Response("denied", {
        status: 403,
        headers: { "x-ratelimit-remaining": "42" },
      }),
  ).readSelection(repoSelection);
  assert.equal(remaining.reason, "http-403");
});

test("empty, negative or past rate-limit deadlines fall back to one minute", async () => {
  for (const headers of [
    { "retry-after": "" },
    { "retry-after": "-5" },
    { "retry-after": "0" },
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" },
  ]) {
    const before = Date.now();
    const result = await limitedReader(
      () => new Response("limited", { status: 429, headers }),
    ).readSelection(repoSelection);
    const after = Date.now();
    const label = JSON.stringify(headers);
    assert.equal(result.reason, "rate-limited", label);
    assert.ok(result.resumeAt !== undefined, label);
    assert.ok(result.resumeAt >= before + 60_000, label);
    assert.ok(result.resumeAt <= after + 60_000, label);
  }
});

test("a 429 without rate-limit headers pauses for GitHub's one-minute minimum", async () => {
  const before = Date.now();
  const result = await limitedReader(
    () => new Response("too many requests", { status: 429 }),
  ).readSelection(repoSelection);
  const after = Date.now();
  assert.equal(result.complete, false);
  assert.equal(result.reason, "rate-limited");
  assert.ok(result.resumeAt !== undefined);
  assert.ok(result.resumeAt >= before + 60_000);
  assert.ok(result.resumeAt <= after + 60_000);
});

test("a rate limit while checking a blocker is reported as rate-limited, not as an invalid blocker", async () => {
  const reader = new GitHubHttpSourceReader("fixture-token", async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/org/repo")
      return new Response(
        JSON.stringify({ node_id: "R_1", full_name: "org/repo" }),
      );
    if (url.includes("/dependencies/blocked_by"))
      return new Response(JSON.stringify([issue(7, "B_7")]));
    return new Response("slow down", {
      status: 429,
      headers: { "retry-after": "30" },
    });
  });
  const result = await reader.readBlockers({
    nodeId: "I_1",
    repositoryId: "R_1",
    repositoryName: "org/repo",
    number: 1,
  });
  assert.equal(result.complete, false);
  assert.equal(result.reason, "rate-limited");
  assert.ok((result.resumeAt ?? 0) > Date.now());
});

test("search items sharing a repository look the repository up once", async () => {
  const requests: string[] = [];
  const reader = new GitHubHttpSourceReader("fixture-token", async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/org/repo")
      return new Response(
        JSON.stringify({ node_id: "R_1", full_name: "org/repo" }),
      );
    return new Response(
      JSON.stringify({
        total_count: 3,
        incomplete_results: false,
        items: [issue(1), issue(2), issue(3)],
      }),
    );
  });
  const snapshot = await reader.readSelection({
    id: "search",
    kind: "search",
    query: "repo:org/repo",
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.issues.length, 3);
  assert.equal(
    requests.filter((url) => url === "https://api.github.com/repos/org/repo")
      .length,
    1,
  );
});

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });

function redirectingReader(
  routes: Record<string, () => Response>,
  calls: Array<{
    url: string;
    method?: string;
    redirect?: RequestRedirect;
  }> = [],
) {
  const reader = new GitHubHttpSourceReader(
    "fixture-token",
    async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      });
      const route = routes[url];
      if (!route) throw new Error(`unexpected request ${url}`);
      return route();
    },
  );
  return { reader, calls };
}

const repositoryBody = () =>
  new Response(JSON.stringify({ node_id: "R_1", full_name: "org/repo" }));
const emptyIssues = () => new Response("[]");
const issuesUrl =
  "https://api.github.com/repos/org/repo/issues?state=all&per_page=100";

test("a GET follows up to three same-origin redirects and a fourth fails", async () => {
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const routes = {
    "https://api.github.com/repos/org/repo": () =>
      redirect(301, "/repositories/1"),
    "https://api.github.com/repositories/1": () =>
      redirect(302, "https://api.github.com/repositories/2"),
    "https://api.github.com/repositories/2": () =>
      redirect(307, "/repositories/3"),
    "https://api.github.com/repositories/3": repositoryBody,
    [issuesUrl]: emptyIssues,
  };
  const followed = await redirectingReader(routes, calls).reader.readSelection(
    repoSelection,
  );
  assert.equal(followed.complete, true);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.github.com/repos/org/repo",
      "https://api.github.com/repositories/1",
      "https://api.github.com/repositories/2",
      "https://api.github.com/repositories/3",
      issuesUrl,
    ],
  );
  assert.ok(calls.every((call) => call.redirect === "manual"));

  const tooMany = await redirectingReader({
    ...routes,
    "https://api.github.com/repositories/3": () =>
      redirect(301, "/repositories/4"),
    "https://api.github.com/repositories/4": repositoryBody,
  }).reader.readSelection(repoSelection);
  assert.equal(tooMany.complete, false);
  assert.equal(tooMany.reason, "invalid-provider-origin");
});

test("a GET refuses a redirect away from the API origin without sending the credential there", async () => {
  for (const location of [
    "https://evil.example/repos/org/repo",
    "http://api.github.com/repos/org/repo",
    "https://api.github.com.evil.example/repos/org/repo",
  ]) {
    const { reader, calls } = redirectingReader({
      "https://api.github.com/repos/org/repo": () => redirect(302, location),
    });
    const result = await reader.readSelection(repoSelection);
    assert.equal(result.complete, false, location);
    assert.equal(result.reason, "invalid-provider-origin", location);
    assert.equal(calls.length, 1, location);
  }
});

test("a redirect without a Location is an error, not an empty success", async () => {
  const { reader } = redirectingReader({
    "https://api.github.com/repos/org/repo": () =>
      new Response(null, { status: 301 }),
  });
  const result = await reader.readSelection(repoSelection);
  assert.equal(result.complete, false);
  assert.equal(result.reason, "invalid-provider-origin");
});

test("a POST refuses redirects instead of replaying the body", async () => {
  const { reader, calls } = redirectingReader({
    "https://api.github.com/graphql": () =>
      redirect(307, "https://api.github.com/graphql"),
  });
  const result = await reader.readSelection({
    id: "project",
    kind: "project",
    projectNodeId: "P_1",
    filter: "status:ready",
  });
  assert.equal(result.complete, false);
  assert.deepEqual(calls, [
    {
      url: "https://api.github.com/graphql",
      method: "POST",
      redirect: "error",
    },
  ]);
});
