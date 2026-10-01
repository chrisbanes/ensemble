import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../src/core/domain.js";
import { GitHubSourceStore } from "../src/core/github-source.js";
import { Store } from "../src/core/store.js";
import type { IssueSnapshot } from "../src/standalone/github-source.js";

const selected: IssueSnapshot = {
  providerInstance: "github.com",
  nodeId: "I_1",
  repositoryId: "R_1",
  repositoryName: "org/repo",
  number: 1,
  title: "Imported",
  body: "Ship",
  state: "open",
  labels: ["ready"],
  projectFields: [],
};
const blocker: IssueSnapshot = {
  ...selected,
  nodeId: "B_7",
  repositoryId: "R_2",
  repositoryName: "outside/repo",
  number: 7,
  title: "Outside blocker",
  labels: [],
};

test("initial and later incomplete native blocker reads hold imported admission", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-github-dependencies-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  const domain = new DomainStore(db);
  const sources = new GitHubSourceStore(db);
  const projectId = randomUUID();
  const profileId = randomUUID();
  try {
    new Store(db).ensureHost("test");
    domain.migrate();
    sources.migrate();
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
      name: "Alpha",
      leadProfileId: profileId,
    });
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: "env:TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
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
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [selected],
      reason: null,
    });
    const taskId = String(sources.issue("I_1")?.taskId);
    assert.ok(
      domain.admission(taskId).reasons.includes("imported-blockers-unknown"),
    );
    sources.reconcileBlockers("I_1", {
      complete: true,
      blockers: [],
      reason: null,
    });
    assert.equal(domain.admission(taskId).eligible, true);
    const beforeReconfigureVersion = Number(domain.task(taskId).version);
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      credentialRef: "env:TEST_GITHUB",
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
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
    assert.ok(domain.admission(taskId).reasons.includes("source-unknown"));
    assert.ok(Number(domain.task(taskId).version) > beforeReconfigureVersion);
    domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      selectionId: "repo",
      expectedVersion: 3,
    });
    assert.ok(domain.admission(taskId).reasons.includes("source-unknown"));
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [selected],
      reason: null,
    });
    assert.equal(domain.admission(taskId).eligible, true);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...selected, body: "Ship revised scope" }],
      reason: null,
    });
    assert.ok(
      domain.admission(taskId).reasons.includes("source-review-required"),
    );
    const digest = String(
      (
        db
          .prepare(
            "SELECT observedDigest FROM github_source_reviews WHERE nodeId = 'I_1'",
          )
          .get() as { observedDigest: string }
      ).observedDigest,
    );
    const review = {
      type: "source.review" as const,
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      observedDigest: digest,
      decision: "accept-revised-scope" as const,
    };
    assert.throws(
      () =>
        domain.execute({
          ...review,
          actor: "operator",
          key: randomUUID(),
          decision: "resume-source-hold",
        }),
      /text review/i,
    );
    assert.throws(
      () => domain.execute({ ...review, actor: "agent", key: randomUUID() }),
      /operator/i,
    );
    assert.throws(
      () =>
        domain.execute({
          ...review,
          actor: "operator",
          key: randomUUID(),
          observedDigest: "0".repeat(64),
        }),
      /stale/i,
    );
    const reviewKey = randomUUID();
    const accepted = domain.execute({
      ...review,
      actor: "operator",
      key: reviewKey,
    });
    assert.deepEqual(
      domain.execute({ ...review, actor: "operator", key: reviewKey }),
      accepted,
    );
    assert.equal(domain.task(taskId).outcome, "Ship revised scope");
    assert.equal(domain.admission(taskId).eligible, true);
    assert.throws(
      () => domain.execute({ ...review, actor: "operator", key: randomUUID() }),
      /version/i,
    );
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...selected, body: "Ship revised scope", labels: [] }],
      reason: null,
    });
    assert.ok(domain.admission(taskId).reasons.includes("task-unready"));
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...selected, body: "Ship revised scope" }],
      reason: null,
    });
    assert.ok(domain.admission(taskId).reasons.includes("source-hold"));
    const resumedVersion = Number(domain.task(taskId).version);
    assert.throws(
      () =>
        domain.execute({
          type: "source.review",
          actor: "agent",
          key: randomUUID(),
          projectId,
          taskId,
          expectedVersion: resumedVersion,
          observedDigest: digest,
          decision: "resume-source-hold",
        }),
      /operator/i,
    );
    domain.execute({
      type: "source.review",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: resumedVersion,
      observedDigest: digest,
      decision: "resume-source-hold",
    });
    assert.equal(domain.admission(taskId).eligible, true);
    const beforePartialVersion = Number(domain.task(taskId).version);
    sources.reconcileSelection(projectId, "repo", {
      complete: false,
      issues: [],
      reason: "http-403",
    });
    assert.ok(domain.admission(taskId).reasons.includes("source-unknown"));
    assert.ok(Number(domain.task(taskId).version) > beforePartialVersion);
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [{ ...selected, body: "Ship revised scope" }],
      reason: null,
    });
    sources.reconcileBlockers("I_1", {
      complete: true,
      blockers: [],
      reason: null,
    });
    assert.equal(domain.admission(taskId).eligible, true);
    sources.reconcileBlockers("I_1", {
      complete: true,
      blockers: [blocker],
      reason: null,
    });
    assert.ok(
      domain.admission(taskId).reasons.includes("imported-blockers-blocked"),
    );
    assert.equal(sources.issue("B_7"), undefined);
    sources.reconcileBlockers("I_1", {
      complete: true,
      blockers: [{ ...blocker, state: "closed" }],
      reason: null,
    });
    assert.equal(domain.admission(taskId).eligible, true);
    sources.reconcileBlockers("I_1", {
      complete: false,
      blockers: [],
      reason: "http-403",
    });
    assert.ok(
      domain.admission(taskId).reasons.includes("imported-blockers-unknown"),
    );
    const version = Number(domain.task(taskId).version);
    assert.throws(
      () =>
        domain.execute({
          type: "imported-blockers.set",
          actor: "operator",
          key: randomUUID(),
          projectId,
          taskId,
          expectedVersion: version,
          state: "clear",
        }),
      /provider-owned/i,
    );
    const localId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      title: "Local dependent",
      outcome: "Wait for issue",
      ready: true,
    });
    domain.execute({
      type: "dependency.add",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: localId,
      blockerTaskId: taskId,
      expectedVersion: 1,
    });
    sources.reconcileSelection(projectId, "repo", {
      complete: true,
      issues: [],
      reason: null,
    });
    assert.ok(domain.admission(localId).reasons.includes("local-dependency"));
    sources.recordIssueStatus("I_1", { status: "closed" });
    assert.equal(domain.admission(localId).eligible, true);
    sources.invalidateProviderObservations();
    assert.ok(domain.admission(localId).reasons.includes("local-dependency"));
    sources.recordIssueStatus("I_1", { status: "closed" });
    assert.equal(domain.admission(localId).eligible, true);
    sources.recordIssueStatus("I_1", { status: "open" });
    assert.ok(domain.admission(localId).reasons.includes("local-dependency"));
    sources.recordIssueStatus("I_1", { status: "unknown", reason: "http-403" });
    assert.ok(domain.admission(localId).reasons.includes("local-dependency"));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
