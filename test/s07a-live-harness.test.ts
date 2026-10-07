import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import {
  FixtureGuard,
  fixtureManifestSchema,
  qualificationDisposition,
  qualificationTaskIdle,
} from "./s07a/fixture.js";

const manifest = () => ({
  version: 1,
  provider: "github.com",
  account: { nodeId: "U1", login: "chrisbanes" },
  repository: {
    nodeId: "R1",
    fullName: "chrisbanes/ensemble-s07a-fixture",
    private: true,
    defaultBranch: "qualification",
  },
  project: { nodeId: "P1", fieldNodeId: "F1", progressOptionId: "O1" },
  credentialRef: "env:S07A_GITHUB_TOKEN",
  progressLabel: "s07a-progress",
  readinessLabel: "s07a-ready",
  requiredCheck: "s07a-ci",
  fixtureOperations: ["status", "feedback"],
  runtimeTurnLimit: 12,
  actions: [
    "issue.comment",
    "issue.labels",
    "project.field",
    "issue.edit",
    "pr.edit",
    "pr.ready",
    "pr.create",
    "pr.merge",
    "issue.close",
  ],
  journeys: [
    {
      mode: "reviewable-pr",
      serviceProjectId: randomUUID(),
      profileId: randomUUID(),
      issue: { nodeId: "I1", number: 1, itemNodeId: "ITEM1" },
      pr: {
        nodeId: "PR3",
        number: 3,
        baseRef: "qualification",
        headRef: "handback",
        headSha: "1".repeat(40),
      },
    },
    {
      mode: "through-merge",
      serviceProjectId: randomUUID(),
      profileId: randomUUID(),
      issue: { nodeId: "I2", number: 2, itemNodeId: "ITEM2" },
      pr: {
        nodeId: "PR4",
        number: 4,
        baseRef: "qualification",
        headRef: "merge",
        headSha: "2".repeat(40),
      },
    },
  ],
});
function fixture(isPrivate = true) {
  const source = manifest();
  source.repository.private = isPrivate;
  const raw = JSON.stringify(source),
    m = fixtureManifestSchema.parse(JSON.parse(raw));
  const grant = {
    version: 1,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    accountNodeId: m.account.nodeId,
    repositoryNodeId: m.repository.nodeId,
    repositoryVisibility: isPrivate
      ? ("private" as const)
      : ("public" as const),
    projectNodeId: m.project.nodeId,
    credentialRef: m.credentialRef,
    actions: m.actions,
    fixtureOperations: m.fixtureOperations,
    runtimeTurnLimit: 12,
    expiresAt: "2099-01-01T00:00:00Z",
    cleanup: {
      closeRecordedIssues: true,
      closeRecordedPrs: true,
      deleteRecordedHeads: false,
    },
  };
  return { raw, m, grant };
}

test("live guard rejects absent/changed grant and unexpected resources before provider or runtime effects", () => {
  const f = fixture();
  assert.throws(() => new FixtureGuard(f.raw, undefined), /grant/);
  assert.throws(() => new FixtureGuard(`${f.raw} `, f.grant), /manifest/);
  const g = new FixtureGuard(f.raw, f.grant);
  assert.throws(() =>
    g.assertRequest(
      "https://attacker.example/repos/chrisbanes/ensemble-s07a-fixture/pulls/4/merge",
      {
        method: "PUT",
        body: JSON.stringify({ sha: "2".repeat(40), merge_method: "squash" }),
      },
    ),
  );
  assert.throws(() =>
    g.assertRequest(
      "https://api.github.com/repos/chrisbanes/production/issues/1",
      { method: "PATCH", body: "{}" },
    ),
  );
  assert.throws(() =>
    g.assertRequest(
      "https://api.github.com/repos/chrisbanes/ensemble-s07a-fixture/pulls/3/merge",
      {
        method: "PUT",
        body: JSON.stringify({ sha: "1".repeat(40), merge_method: "squash" }),
      },
    ),
  );
  assert.throws(() =>
    g.assertRequest(
      "https://api.github.com/repos/chrisbanes/ensemble-s07a-fixture/statuses/" +
        "3".repeat(40),
      {
        method: "POST",
        body: JSON.stringify({ context: "s07a-ci", state: "success" }),
      },
    ),
  );
  assert.throws(() =>
    g.assertRequest("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({
        query:
          'mutation DeleteRepository {deleteRepository(input:{repositoryId:"R1"}){clientMutationId}}',
        variables: {},
      }),
    }),
  );
  for (let i = 0; i < 12; i++) g.beginRuntimeTurn();
  assert.throws(() => g.beginRuntimeTurn(), /turn limit/);
  assert.throws(() => g.assertCredentialReference("env:OTHER"));
  assert.throws(() => g.assertDefaultBranch("main"));
  assert.equal(
    qualificationDisposition({
      handback: "unproved",
      throughMerge: "passed",
      cleanup: "passed",
    }),
    "unproved",
  );
  assert.equal(
    qualificationDisposition({
      handback: "passed",
      throughMerge: "failed",
      cleanup: "passed",
    }),
    "failed",
  );
});
test("fixture visibility must be explicitly granted before any effect", () => {
  const f = fixture();
  const { repositoryVisibility: _visibility, ...missing } = f.grant;
  assert.throws(() => new FixtureGuard(f.raw, missing), /visibility/i);
  assert.throws(
    () =>
      new FixtureGuard(f.raw, {
        ...f.grant,
        repositoryVisibility: "public",
      }),
    /manifest/,
  );
  const publicFixture = fixture(false);
  assert.throws(
    () =>
      new FixtureGuard(publicFixture.raw, {
        ...publicFixture.grant,
        repositoryVisibility: "private",
      }),
    /manifest/,
  );
  for (const current of [f, publicFixture]) {
    const guard = new FixtureGuard(current.raw, current.grant);
    guard.assertRepositoryVisibility(current.m.repository.private);
    assert.throws(
      () => guard.assertRepositoryVisibility(!current.m.repository.private),
      /visibility/,
    );
    assert.throws(() => guard.assertRepositoryVisibility(undefined));
    guard.assertRequest(
      `https://api.github.com/repos/${current.m.repository.fullName}/statuses/${"2".repeat(40)}`,
      {
        method: "POST",
        body: JSON.stringify({ context: "s07a-ci", state: "failure" }),
      },
    );
    assert.throws(() =>
      guard.assertRequest(
        `https://api.github.com/repos/${current.m.repository.fullName}/statuses/${"2".repeat(40)}`,
        {
          method: "POST",
          body: JSON.stringify({ context: "unrequired-ci", state: "success" }),
        },
      ),
    );
  }
});
test("live guard permits only exact recorded progress, status, merge and separately granted cleanup", () => {
  const f = fixture(),
    g = new FixtureGuard(f.raw, f.grant),
    root = `https://api.github.com/repos/${f.m.repository.fullName}`;
  g.assertRequest(`${root}/issues/1/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "Progress" }),
  });
  g.assertRequest(`${root}/statuses/${"2".repeat(40)}`, {
    method: "POST",
    body: JSON.stringify({ context: "s07a-ci", state: "failure" }),
  });
  g.assertRequest(`${root}/pulls/4/merge`, {
    method: "PUT",
    body: JSON.stringify({ sha: "2".repeat(40), merge_method: "squash" }),
  });
  assert.throws(() =>
    g.assertRequest(`${root}/git/refs/heads/merge`, { method: "DELETE" }),
  );
  g.assertRequest(
    `${root}/issues/1`,
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
    true,
  );
  assert.throws(() =>
    g.assertRequest(
      `${root}/issues/999`,
      { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
      true,
    ),
  );
});

import { spawnSync } from "node:child_process";
test("live waiting checkpoint joins requests to executions and rejects unfinished work", () => {
  const requests = [{ taskId: "task", workId: "work", state: "completed" }];
  assert.equal(
    qualificationTaskIdle("task", requests, [
      { workId: "work", state: "completed" },
    ]),
    true,
  );
  for (const state of [
    "ready",
    "capacity-waiting",
    "submitting",
    "running",
    "held",
    "resolved-failed",
    "reconciled",
  ]) {
    assert.equal(
      qualificationTaskIdle("task", requests, [{ workId: "work", state }]),
      false,
    );
  }
  for (const state of ["queued", "active", "held"]) {
    assert.equal(
      qualificationTaskIdle(
        "task",
        [{ ...requests[0]!, state }],
        [{ workId: "work", state: "completed" }],
      ),
      false,
    );
  }
  assert.equal(qualificationTaskIdle("task", requests, []), false);
  assert.equal(qualificationTaskIdle("task", [], []), false);
  assert.equal(
    qualificationTaskIdle("task", requests, [
      { workId: "other", state: "completed" },
    ]),
    false,
  );
});
test("live entry point refuses missing authority before credential lookup or Codex start", () => {
  const result = spawnSync(process.execPath, ["test/s07a/live-delivery.mjs"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing execution/);
  assert.doesNotMatch(result.stderr, /Named fixture credential|codex.*ENOENT/);
});
