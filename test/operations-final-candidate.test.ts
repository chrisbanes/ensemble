import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { StandaloneService } from "../src/standalone/service.js";
import { OperatorFixtureRuntime } from "./fixtures/operator-web.js";
import {
  createReleaseDeliveryFixture,
  until,
} from "./fixtures/s07b-delivery.js";
import {
  FixtureLifecycle,
  fixtureStepCompleted,
  throwFixtureCleanup,
} from "./fixtures/fixture-lifecycle.js";
import type { RoutingChoiceClient } from "../src/standalone/routing.js";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function readDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      (
        db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        }
      ).integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const rows = Object.fromEntries(
      tables.map((name) => [
        name,
        db
          .prepare(`SELECT * FROM ${quote(name)}`)
          .all()
          .map((row) =>
            JSON.stringify(row, (_key, value) =>
              typeof value === "bigint" ? `${value}n` : value,
            ),
          )
          .sort(),
      ]),
    );
    return {
      schemaHash: hash(JSON.stringify(schema)),
      rows,
      digest: hash(JSON.stringify(rows)),
    };
  } finally {
    db.close();
  }
}
function operation(command: string, ...args: string[]) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [resolve("dist/src/standalone/operations-cli.js"), command, ...args],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: dirname(process.execPath) },
      },
    ),
  );
}

test("final candidate CLI snapshot preserves whole schema and immutable history while restored startup reconciles before one separate admission", async () => {
  const routing: RoutingChoiceClient = {
    async choose(request) {
      return {
        choice: "lead_review",
        model: request.requestedModel,
        confidence: 1,
        probabilities: Object.fromEntries(
          request.choices.map((choice) => [
            choice,
            choice === "lead_review" ? 1 : 0,
          ]),
        ),
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  const f = await createReleaseDeliveryFixture(
    "reviewable-pr",
    {},
    false,
    routing,
  );
  let restored: StandaloneService | undefined;
  let releaseStartup: (() => void) | undefined;
  let starting: Promise<void> | undefined;
  let primaryFailure: unknown;
  const restoredData = join(f.directory, "restored"),
    snapshot = join(f.directory, "snapshot");
  try {
    const d = f.service.domain();
    d.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        { action: "issue.comment", repositoryId: "R1", mode: "allow" },
        { action: "pr.merge", repositoryId: "R1", mode: "allow" },
      ],
      requiredChecks: [{ name: "build", appId: 17 }],
    });
    await f.register();
    f.runtime.emitHistory(1, "Synthetic exact bound conversation history");
    const confirmedId = randomUUID();
    assert.equal(
      (
        await f.call("ensemble_external_action", {
          operationId: confirmedId,
          action: {
            kind: "issue.comment",
            target: { repositoryId: "R1", nodeId: "I1", number: 1 },
            body: "Confirmed synthetic comment",
          },
        })
      ).success,
      true,
    );
    assert.equal((await f.merge()).success, false);
    assert.equal(f.scripted.state.commentWrites, 1);
    assert.equal(f.scripted.state.writes, 0);
    const workspace = await f.service.taskWorkspace(f.taskId);
    assert.ok(workspace);
    const sentinel = join(workspace.path, "retained-sentinel");
    writeFileSync(sentinel, "old managed root must remain untouched\n");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(join(workspace.path, "evidence.png"), image);
    assert.equal(
      (
        await f.call("ensemble_ask_question", {
          question: "Preserve exact question and answer?",
        })
      ).success,
      true,
    );
    const question = f.service.coordinationView().readTask(f.taskId)
      .questions[0]!;
    const material = { scope: "synthetic fixture", identity: "approval1" };
    assert.equal(
      (
        await f.call("ensemble_request_approval", {
          action: "fixture.exact",
          target: "fixture-target",
          material,
        })
      ).success,
      true,
    );
    await f.service.coordinationView().answerQuestion({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: "Preserved exact answer",
    });
    const approval = f.service.coordinationView().readTask(f.taskId)
      .approvals[0]!;
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: approval.interactionId,
      expectedRevision: approval.revision,
      decision: "approved",
      action: "fixture.exact",
      target: "fixture-target",
      material,
    });
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 3,
      paused: true,
    });
    await f.terminal(1);
    await f.service.refreshGitHub();
    await until(
      () =>
        f.service
          .turnRequests()
          .some((r) => r.state === "queued" && r.workId.includes(":inbox:")),
      "paused final inbox",
    );
    await f.reopen();
    assert.equal(f.runtime.turns, 0);
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      1,
    );
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 4,
      paused: false,
    });
    await f.service.refreshGitHub();
    await f.waitTurn(1);
    await f.terminal(1);
    await f.service.settleHandback(f.settlement());
    await f.waitTurn(2);
    await f.terminal(2);
    await f.waitTurn(3);
    const complete = await f.call(
      "ensemble_request_completion",
      { reviewedResultIds: [] },
      3,
    );
    assert.equal(complete.success, true, complete.text);
    await f.terminal(3);
    await until(
      () => f.service.domain().task(f.taskId).state === "done",
      "primary Done",
    ).catch((error) => {
      console.error(
        JSON.stringify({
          task: f.service.domain().task(f.taskId),
          assignments: f.service.domain().assignments(f.taskId),
          requests: f.service.turnRequests(),
          intents: f.service.list(),
          hold: f.service.taskHold(f.taskId),
          coordination: f.service.coordinationView().readTask(f.taskId),
        }),
      );
      throw error;
    });

    const domain = f.service.domain(),
      resultTask = randomUUID(),
      pendingTask = randomUUID(),
      candidate = randomUUID();
    domain.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: candidate,
      name: "Candidate",
      instructions: "fixture",
      capabilities: "fixture",
    });
    domain.execute({
      type: "routing.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Lead review fixture",
      credentialRef: "env:SYNTHETIC_ROUTING",
      candidateProfileIds: [candidate],
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: resultTask,
      title: "Uncertain snapshot task",
      outcome: "Keep independent effect and Stop holds",
      ready: false,
    });
    const resultWorkspace = await f.service.provisionTask(resultTask);
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: resultTask,
      expectedVersion: 1,
      ready: true,
    });
    await f.waitTurn(4);
    writeFileSync(join(resultWorkspace.path, "evidence.png"), image);
    const result = await f.call(
      "ensemble_report_result",
      {
        summary: "Preserved result metadata",
        review: {
          artifacts: [
            {
              artifactId: randomUUID(),
              label: "Retained image",
              role: "evidence",
              revision: 1,
              availability: "available",
              file: {
                relativePath: "evidence.png",
                sha256: hash(image),
                mime: "image/png",
                size: image.length,
              },
            },
          ],
          validations: [
            {
              label: "Synthetic check",
              outcome: "passed",
              scope: "One bounded check",
              provenance: "Agent supplied assertion",
            },
          ],
        },
      },
      4,
    );
    assert.equal(result.success, true, result.text);
    await f.terminal(4);
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: pendingTask,
      title: "Uncertain snapshot task",
      outcome: "Keep independent effect and Stop holds",
      ready: false,
    });
    const pendingWorkspace = await f.service.provisionTask(pendingTask);
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: pendingTask,
      expectedVersion: 1,
      ready: true,
    });
    await f.waitTurn(5);
    f.scripted.state.unknownComment = true;
    const uncertainId = randomUUID();
    assert.equal(
      (
        await f.call(
          "ensemble_external_action",
          {
            operationId: uncertainId,
            action: {
              kind: "issue.comment",
              target: { repositoryId: "R1", nodeId: "I1", number: 1 },
              body: "Unknown synthetic effect",
            },
          },
          5,
        )
      ).success,
      false,
    );
    assert.equal(f.scripted.state.commentWrites, 2);
    assert.equal(f.service.delivery().action(uncertainId)?.state, "uncertain");
    await f.service.stopTask(pendingTask);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "stopped uncertain work",
    );
    // Nested destinations are created through ordinary domain commands and remain paused.
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 5,
      paused: true,
    });
    const parent = domain.assignments(pendingTask)[0]!;
    const child = randomUUID();
    domain.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: pendingTask,
      assignmentId: child,
      profileId: candidate,
      brief: "Nested child",
      requesterAssignmentId: String(parent.id),
      resultDestination: `assignment:${parent.id}`,
    });
    domain.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: pendingTask,
      assignmentId: randomUUID(),
      profileId: candidate,
      brief: "Nested grandchild",
      requesterAssignmentId: child,
      resultDestination: `assignment:${child}`,
    });
    const blocker = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: blocker,
      title: "Dependency blocker",
      outcome: "Remain blocked",
      ready: false,
    });
    domain.execute({
      type: "dependency.add",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: resultTask,
      blockerTaskId: blocker,
      expectedVersion: Number(domain.task(resultTask).version),
    });
    const admissionTask = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: admissionTask,
      title: "Separate eligible task",
      outcome: "Exactly one post-reconciliation admission",
      ready: true,
    });
    await f.service.stopTask(admissionTask);
    const sourceRows = readDatabase(
      join(f.directory, "data", "standalone.sqlite"),
    );
    const protectedTables = [
      "coordination_results",
      "task_review_results",
      "task_review_artifact_ids",
      "coordination_receipts",
      "coordination_completion_requests",
      "delivery_settlement_receipts",
      "task_review_contexts",
      "inbox_request_supersessions",
      "conversation_history_items",
    ];
    for (const table of protectedTables)
      assert.ok(
        sourceRows.rows[table]?.length,
        `${table} has real public-seam records`,
      );
    assert.ok(sourceRows.rows.routing_operations?.length);
    const interactions = f.service.coordinationView().readTask(f.taskId);
    assert.ok(
      interactions.questions.some(
        (q) =>
          q.status === "answered" && q.response === "Preserved exact answer",
      ),
    );
    assert.ok(
      interactions.approvals.some(
        (a) => a.status === "approved" && a.materialHash,
      ),
    );
    for (const table of [
      "local_dependencies",
      "coordination_interactions",
      "coordination_operator_receipts",
      "task_writer_admissions",
      "execution_capacity_reservations",
      "task_writer_holds",
      "execution_stop_targets",
    ])
      assert.ok(
        sourceRows.rows[table]?.length,
        `${table} is populated before snapshot`,
      );
    const actionRows = Object.values(f.service.delivery().actions());
    assert.ok(actionRows.some((a) => a.state === "confirmed-success"));
    assert.ok(actionRows.some((a) => a.state === "denied"));
    assert.ok(actionRows.some((a) => a.state === "uncertain"));
    await f.service.stop();
    const before = readDatabase(join(f.directory, "data", "standalone.sqlite"));
    // Draining pending preparation may append contexts; existing captures cannot change.
    for (const table of protectedTables) {
      for (const row of sourceRows.rows[table]!)
        assert.ok(
          before.rows[table]!.includes(row),
          `${table} retains the exact pre-stop row`,
        );
    }
    for (const row of before.rows.task_review_contexts!.filter(
      (row) => !sourceRows.rows.task_review_contexts!.includes(row),
    )) {
      const outer = JSON.parse(row);
      const capture = JSON.parse(outer.recordJson);
      assert.equal(capture.supplier, "service:work-preparation");
      assert.ok(capture.workId);
      assert.ok(
        before.rows
          .domain_assignments!.map((row) => JSON.parse(row))
          .some(
            (a) => a.id === capture.assignmentId && a.taskId === capture.taskId,
          ),
      );
    }
    const backup = operation("backup", join(f.directory, "data"), snapshot);
    assert.equal(backup.ok, true);
    assert.deepEqual(operation("verify", snapshot).manifest, backup.manifest);
    assert.deepEqual(
      operation("restore", snapshot, restoredData).manifest,
      backup.manifest,
    );
    assert.deepEqual(readdirSync(snapshot).sort(), [
      "manifest.json",
      "standalone.sqlite",
    ]);
    assert.equal(existsSync(join(restoredData, "auth.json")), false);
    const restoredBefore = readDatabase(
      join(restoredData, "standalone.sqlite"),
    );
    assert.equal(restoredBefore.schemaHash, before.schemaHash);
    assert.equal(restoredBefore.digest, before.digest);
    assert.deepEqual(restoredBefore.rows, before.rows);
    const runtime = new OperatorFixtureRuntime();
    let release!: () => void,
      entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
      releaseStartup = resolve;
    });
    const accesses: string[] = [];
    // Source reconciliation is delayed and later unavailable; scheduler must remain absent.
    restored = new StandaloneService(restoredData, () => runtime, undefined, {
      power: { enabled: false },
      routingClient: routing,
      delivery: { providerFactory: () => f.scripted.provider },
      github: {
        readerFactory: () => ({
          async readSelection() {
            entered = true;
            await gate;
            throw Error("Synthetic source unavailable");
          },
          async readBlockers() {
            return { complete: false, blockers: [], reason: "unavailable" };
          },
          async readIssueStatus() {
            return { status: "unknown" };
          },
        }),
      },
      workspaceManager: { beforePathAccess: (path) => accesses.push(path) },
    });
    starting = restored.start();
    await until(() => entered, "delayed restored source");
    assert.equal(runtime.turns, 0);
    assert.equal(accesses.includes(workspace.path), false);
    assert.equal(accesses.includes(pendingWorkspace.path), false);
    release();
    await starting;
    assert.equal(runtime.turns, 0);
    assert.equal(restored.domain().task(f.taskId).state, "done");
    assert.equal(restored.taskHold(pendingTask), "Task stopped");
    assert.equal(restored.delivery().action(uncertainId)?.state, "uncertain");
    assert.equal(f.scripted.state.commentWrites, 2);
    assert.equal(f.scripted.state.writes, 0);
    assert.equal((await restored.taskWorkspace(pendingTask))?.state, "held");
    assert.match(
      (await restored.taskWorkspace(pendingTask))?.reason ?? "",
      /Stored workspace path does not match its identity/,
    );
    assert.equal(
      readFileSync(sentinel, "utf8"),
      "old managed root must remain untouched\n",
    );
    assert.equal(
      readFileSync(join(workspace.path, "evidence.png")).equals(image),
      true,
    );
    const after = readDatabase(join(restoredData, "standalone.sqlite"));
    for (const table of protectedTables)
      assert.deepEqual(after.rows[table], before.rows[table]);
    assert.equal(runtime.turns, 0);
    assert.deepEqual(
      after.rows.routing_operations,
      before.rows.routing_operations,
    );
    f.scripted.state.comments.push({
      node_id: "EXACT_RECONCILED_COMMENT",
      user: { node_id: "U1" },
      body: `Unknown synthetic effect\n\n<!-- ensemble-operation:${uncertainId} -->`,
    });
    await restored.refreshGitHub();
    assert.equal(
      restored.delivery().action(uncertainId)?.state,
      "confirmed-success",
    );
    assert.equal(
      restored.delivery().action(confirmedId)?.state,
      "confirmed-success",
    );
    assert.equal(restored.taskHold(pendingTask), "Task stopped");
    assert.equal((await restored.taskWorkspace(pendingTask))?.state, "held");
    assert.equal(f.scripted.state.commentWrites, 2);
    assert.equal(runtime.turns, 0);
    // A new repository-free task has no old-root binding; current independent controls still apply.
    await restored.provisionTask(admissionTask);
    restored.domain().execute({
      type: "routing.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      enabled: false,
      guidance: "Disabled after restore",
      candidateProfileIds: [],
    });
    restored.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 6,
      paused: false,
    });
    assert.equal(runtime.turns, 0);
    await restored.resumeTask(admissionTask);
    await until(() => runtime.turns === 1, "one separate admitted task");
    assert.equal(f.scripted.state.commentWrites, 2);
    assert.equal(restored.taskHold(pendingTask), "Task stopped");
    const waiting = await runtime.callTool({
      callId: randomUUID(),
      threadId: "fixture-thread",
      turnId: "fixture-turn-1",
      tool: "ensemble_ask_question",
      arguments: { question: "Retain one admitted request without replay?" },
    });
    assert.equal(waiting.success, true, waiting.text);
    runtime.complete(1);
    await until(
      () => !restored!.list().some((i) => i.state === "running"),
      "settled separate turn",
    );
    await restored.stop();
    const runtime2 = new OperatorFixtureRuntime();
    restored = new StandaloneService(restoredData, () => runtime2, undefined, {
      power: { enabled: false },
      routingClient: null,
      delivery: { providerFactory: () => f.scripted.provider },
    });
    await restored.start();
    assert.equal(runtime2.turns, 0);
    assert.equal(f.scripted.state.commentWrites, 2);
    assert.equal(
      restored.delivery().action(uncertainId)?.state,
      "confirmed-success",
    );
    console.log(
      `S08b final schema ${backup.manifest.schemaFingerprint} logical ${backup.manifest.logicalContentSha256}; ${Object.keys(before.rows).length} tables preserved; immutable ${protectedTables.length} tables; source/effects held; one separate admission`,
    );
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    releaseStartup?.();
    const cleanup = new FixtureLifecycle({ cleanupTimeoutMs: 10000 });
    const deadline = performance.now() + 10000;
    const steps = [];
    const drained = await cleanup.attempt(
      "settle owned restored startup",
      "cleanup",
      async () => {
        await starting;
      },
      5000,
    );
    steps.push(drained);
    if (fixtureStepCompleted(drained)) {
      const stopped = await cleanup.attempt(
        "stop owned restored service",
        "cleanup",
        async () => {
          await restored?.stop();
        },
        Math.max(1, deadline - performance.now()),
      );
      steps.push(stopped);
      if (fixtureStepCompleted(stopped)) {
        steps.push(
          await cleanup.attempt(
            "close source fixture and remove owned root",
            "cleanup",
            async () => {
              await f.close();
              assert.equal(existsSync(f.directory), false);
            },
            Math.max(1, deadline - performance.now()),
          ),
        );
      }
    }
    throwFixtureCleanup(steps, primaryFailure);
  }
});
