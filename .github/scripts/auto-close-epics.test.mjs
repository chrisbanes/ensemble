import assert from "node:assert/strict";
import test from "node:test";

import {
  GhClient,
  canAutoCloseEpic,
  closeEligibleAncestors,
} from "./auto-close-epics.mjs";

function eligibleIssue(overrides = {}) {
  return {
    number: 462,
    state: "open",
    repository: { full_name: "chrisbanes/ensemble" },
    labels: [
      { name: "epic", node_id: "LA_kwDORzdwYM8AAAACuWX7NA" },
      {
        name: "auto-close-epic",
        node_id: "LA_kwDORzdwYM8AAAACu3F6Tg",
      },
    ],
    sub_issues_summary: { total: 3, completed: 3 },
    issue_dependencies_summary: { blocked_by: 0 },
    ...overrides,
  };
}

test("closes an opted-in epic when every child is closed and no blocker is open", () => {
  assert.equal(canAutoCloseEpic(eligibleIssue()), true);
});

test("fails closed when GitHub omits completion metadata", () => {
  const issue = eligibleIssue({
    sub_issues_summary: undefined,
    issue_dependencies_summary: undefined,
  });

  assert.equal(canAutoCloseEpic(issue), false);
});

test("does not transfer closure authority to recreated labels", () => {
  const issue = eligibleIssue({
    labels: [
      { name: "epic", node_id: "new-epic" },
      { name: "auto-close-epic", node_id: "new-auto-close-epic" },
    ],
  });

  assert.equal(canAutoCloseEpic(issue), false);
});

for (const [name, override] of [
  [
    "the opt-in label is absent",
    { labels: [{ name: "epic", node_id: "LA_kwDORzdwYM8AAAACuWX7NA" }] },
  ],
  ["the epic has no children", { sub_issues_summary: { total: 0, completed: 0 } }],
  ["a child remains open", { sub_issues_summary: { total: 3, completed: 2 } }],
  ["a blocker remains open", { issue_dependencies_summary: { blocked_by: 1 } }],
]) {
  test(`does not close when ${name}`, () => {
    assert.equal(canAutoCloseEpic(eligibleIssue(override)), false);
  });
}

test("closes an eligible parent after its final child closes", async () => {
  const closed = [];
  const client = {
    async getParent({ number }) {
      return number === 465
        ? eligibleIssue({ sub_issues_summary: { total: 4, completed: 4 } })
        : null;
    },
    async closeIssue(issue) {
      closed.push(issue.number);
    },
  };

  await closeEligibleAncestors({
    repository: "chrisbanes/ensemble",
    issueNumber: 465,
    client,
    logger: { info() {}, warn() {} },
  });

  assert.deepEqual(closed, [462]);
});

test("reads the native parent identity from GitHub CLI", async () => {
  const calls = [];
  const client = new GhClient((args) => {
    calls.push(args);
    return JSON.stringify(eligibleIssue());
  });

  const parent = await client.getParent({
    repository: "chrisbanes/ensemble",
    number: 465,
  });

  assert.deepEqual(parent, eligibleIssue());
  assert.deepEqual(calls, [
    ["api", "repos/chrisbanes/ensemble/issues/465/parent"],
  ]);
});

test("treats GitHub's no-parent response as a root issue", async () => {
  const client = new GhClient(() => {
    const error = new Error("HTTP 404");
    error.stdout = '{"message":"No parent issue found","status":"404"}';
    throw error;
  });

  assert.equal(
    await client.getParent({
      repository: "chrisbanes/ensemble",
      number: 462,
    }),
    null,
  );
});

test("does not hide unrelated GitHub 404 failures", async () => {
  const error = new Error("HTTP 404");
  error.stdout = '{"message":"Not Found","status":"404"}';
  const client = new GhClient(() => {
    throw error;
  });

  await assert.rejects(
    client.getParent({ repository: "chrisbanes/ensemble", number: 999 }),
    error,
  );
});

test("leaves a cross-repository parent open", async () => {
  const closed = [];
  const warnings = [];
  const client = {
    async getParent() {
      return eligibleIssue({ repository: { full_name: "chrisbanes/other" } });
    },
    async closeIssue(issue) {
      closed.push(issue.number);
    },
  };

  await closeEligibleAncestors({
    repository: "chrisbanes/ensemble",
    issueNumber: 465,
    client,
    logger: { info() {}, warn(message) { warnings.push(message); } },
  });

  assert.deepEqual(closed, []);
  assert.deepEqual(warnings, [
    "Skipping cross-repository parent chrisbanes/other#462",
  ]);
});

test("closes an eligible epic through GitHub CLI", async () => {
  const calls = [];
  const client = new GhClient((args) => {
    calls.push(args);
    return "";
  });
  const reference = { repository: "chrisbanes/ensemble", number: 304 };

  await client.closeIssue(reference);

  assert.deepEqual(calls[0].slice(0, 8), [
    "issue",
    "close",
    "304",
    "--repo",
    "chrisbanes/ensemble",
    "--reason",
    "completed",
    "--comment",
  ]);
  assert.match(calls[0][8], /all native sub-issues are closed/i);
});
