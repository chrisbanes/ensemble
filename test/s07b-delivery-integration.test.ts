import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "node:test";
import {
  createReleaseDeliveryFixture,
  until,
  scriptedDeliveryProvider,
} from "./fixtures/s07b-delivery.js";

for (const mode of ["reviewable-pr", "through-merge"] as const) {
  test(`assembled ${mode} uses production HTTP parsing, own closure, terminal completion and durable reopen`, async () => {
    const f = await createReleaseDeliveryFixture(mode);
    try {
      await f.register();
      const premature = await f.call("ensemble_request_completion", {
        reviewedResultIds: [],
      });
      assert.equal(premature.success, false, premature.text);
      assert.equal(f.service.domain().task(f.taskId).state, "open");
      const operationId = randomUUID();
      f.scripted.state.check = "failure";
      const failed = await f.merge(operationId);
      assert.equal(failed.success, false, failed.text);
      assert.equal(f.scripted.state.writes, 0);
      f.scripted.state.check = "success";
      if (mode === "reviewable-pr") {
        assert.equal((await f.merge()).success, false);
        await f.terminal(1);
        await f.service.settleHandback(f.settlement());
      } else {
        const merged = await f.merge();
        assert.equal(merged.success, true, merged.text);
        assert.equal(f.scripted.state.writes, 1);
        assert.equal(
          f.service.githubSources().issue("I1")?.observedState,
          "closed",
        );
        assert.equal(f.service.githubSources().memberships("I1").length, 0);
        assert.equal(
          f.service.domain().admission(f.taskId, true).eligible,
          true,
        );
        assert.equal(f.service.domain().task(f.taskId).state, "open");
        await f.terminal(1);
      }
      await f.waitTurn(2);
      const completion = await f.call(
        "ensemble_request_completion",
        { reviewedResultIds: [] },
        2,
      );
      assert.equal(completion.success, true, completion.text);
      assert.equal(f.service.domain().task(f.taskId).state, "open");
      await f.terminal(2);
      await until(
        () => f.service.domain().task(f.taskId).state === "done",
        "eligible Done",
      );
      const binding = f.service.delivery().delivery(f.taskId);
      assert.ok(binding);
      const persisted = f.readDb(
        (db) =>
          db
            .prepare(
              "SELECT recordJson FROM delivery_pr_bindings WHERE taskId=?",
            )
            .get(f.taskId) as { recordJson: string },
      );
      assert.deepEqual(JSON.parse(persisted.recordJson), binding);
      const receipts = f.readDb(
        (db) =>
          db
            .prepare("SELECT COUNT(*) AS n FROM delivery_settlement_receipts")
            .get() as { n: number },
      );
      assert.equal(receipts.n, mode === "reviewable-pr" ? 1 : 0);
      const effects = f.scripted.state.writes;
      await f.reopen();
      assert.equal(f.service.domain().task(f.taskId).state, "done");
      assert.deepEqual(
        f.service.delivery().delivery(f.taskId)?.settlement,
        binding.settlement,
      );
      assert.equal(
        f.service.delivery().delivery(f.taskId)?.observationDigest,
        binding.observationDigest,
      );
      await f.service.coordinationView().refreshDelivery(f.taskId);
      assert.equal(f.scripted.state.writes, effects);
      assert.equal(f.runtime.turns, 0);
    } finally {
      await f.close();
      assert.equal(existsSync(f.directory), false);
    }
  });
}

test("connected feedback is literal and deduplicated; changed settlement, outage and task Stop remain conservative across restart", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    await f.register();
    await f.terminal(1);
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 3,
      paused: true,
    });
    const before = f.service.coordinationView().readTask(f.taskId);
    f.scripted.state.feedback = true;
    await f.service.coordinationView().refreshDelivery(f.taskId);
    const feedback = f.service.delivery().delivery(f.taskId)
      ?.observation.feedback;
    assert.equal(feedback?.[0]?.nodeId, "C1");
    assert.equal(feedback?.[0]?.body, "Repair literal feedback C1");
    const observed = f.service.coordinationView().readTask(f.taskId);
    await f.service.coordinationView().refreshDelivery(f.taskId);
    const repeated = f.service.coordinationView().readTask(f.taskId);
    assert.deepEqual(repeated.messages, observed.messages);
    assert.deepEqual(repeated.requests, observed.requests);
    assert.equal(
      repeated.delivery?.binding?.revision,
      observed.delivery?.binding?.revision,
    );
    assert.equal(f.runtime.turns, 1);
    assert.notDeepEqual(observed, before);
    await until(
      () =>
        f.service
          .turnRequests()
          .some((r) => r.state === "queued" && r.workId.includes(":inbox:")),
      "queued feedback capture",
    );
    const oldWork = f.service
      .turnRequests()
      .find(
        (r) => r.state === "queued" && r.workId.includes(":inbox:"),
      )!.workId;
    const oldCapture = f.readDb((db) =>
      db
        .prepare("SELECT recordJson FROM task_review_contexts WHERE workId=?")
        .get(oldWork),
    );
    await f.reopen();
    assert.equal(f.runtime.turns, 0);
    await f.reopen();
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.deepEqual(
      f.readDb((db) =>
        db
          .prepare("SELECT recordJson FROM task_review_contexts WHERE workId=?")
          .get(oldWork),
      ),
      oldCapture,
    );
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      2,
    );
    assert.equal(f.runtime.turns, 0);
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
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.equal(f.runtime.turns, 1);
    await f.terminal(1);
    await f.service.settleHandback(f.settlement());
    const stale = f.settlement();
    f.scripted.state.head = "3".repeat(40);
    await assert.rejects(() => f.service.settleHandback(stale), /changed/);
    assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
    f.scripted.state.outage = true;
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.ok(f.service.delivery().delivery(f.taskId)?.readError);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    await f.service.stopTask(f.taskId);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "Stop settles turns",
    );
    await f.reopen();
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM task_writer_holds WHERE taskId=?",
              )
              .get(f.taskId) as { n: number }
          ).n,
      ),
      1,
    );
    assert.equal(f.scripted.state.writes, 0);
    assert.equal(f.runtime.turns, 0);
  } finally {
    await f.close();
  }
});

test("unknown merge effect is held and same-operation replay never repeats the write across restart", async () => {
  const f = await createReleaseDeliveryFixture("through-merge");
  try {
    await f.register();
    f.scripted.state.unknownEffect = true;
    const operationId = randomUUID();
    const result = await f.merge(operationId);
    assert.equal(result.success, false, result.text);
    assert.equal(f.scripted.state.writes, 1);
    assert.equal((await f.merge(operationId)).success, false);
    assert.equal(f.scripted.state.writes, 1);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    await f.service.stopTask(f.taskId);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "uncertain Stop",
    );
    await f.reopen();
    await f.service.coordinationView().refreshDelivery(f.taskId);
    assert.equal(f.scripted.state.writes, 1);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.runtime.turns, 0);
    assert.ok(
      f.service
        .delivery()
        .actions(f.taskId)
        .some((a) => a.state === "uncertain"),
    );
  } finally {
    await f.close();
  }
});

test("scripted provider refuses unknown endpoints instead of forwarding fetch", async () => {
  const f = scriptedDeliveryProvider();
  await assert.rejects(
    () =>
      f.provider.inspectPr(
        {
          repositoryId: "R1",
          prNumber: 99,
          expectedPrNodeId: "P99",
          expectedHeadSha: f.state.head,
        },
        {
          version: 1,
          mode: "reviewable-pr",
          credentialRef: null,
          grants: [],
          requiredChecks: [],
        },
      ),
    /Unhandled scripted endpoint/,
  );
  assert.equal(f.state.writes, 0);
});

async function pausedFeedback(
  f: Awaited<ReturnType<typeof createReleaseDeliveryFixture>>,
) {
  await f.register();
  await f.terminal(1);
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: 3,
    paused: true,
  });
  f.scripted.state.feedback = true;
  await f.service.refreshGitHub();
  await until(
    () =>
      f.service
        .list()
        .some((i) => i.workId.includes(":inbox:") && i.state === "ready"),
    "never-admitted inbox intent",
  );
  return f.service
    .turnRequests()
    .find((r) => r.state === "queued" && r.workId.includes(":inbox:"))!;
}

test("startup waits for complete provider/source revalidation before superseding paused inbox work", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    const queued = await pausedFeedback(f);
    let release!: () => void;
    f.scripted.state.sourceWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reads = f.scripted.state.sourceReads;
    const reopening = f.reopen();
    await until(
      () => f.scripted.state.sourceReads > reads,
      "delayed startup source read",
    );
    assert.equal(f.runtime.turns, 0);
    assert.equal(
      f.service.turnRequests().find((r) => r.workId === queued.workId)?.state,
      "queued",
    );
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      0,
    );
    release();
    await reopening;
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
  } finally {
    await f.close();
  }
});

for (const fault of [
  "source",
  "permission",
  "held",
  "admitted",
  "Stop",
  "effect",
  "absent anchor",
  "cancelled then reopened",
] as const) {
  test(`startup never revives inbox work after ${fault} changes`, async () => {
    const f = await createReleaseDeliveryFixture();
    try {
      const queued = await pausedFeedback(f);
      if (fault === "cancelled then reopened")
        for (const state of ["cancelled", "open"] as const)
          f.service.domain().execute({
            type: "task.configure",
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            taskId: f.taskId,
            expectedVersion: Number(f.service.domain().task(f.taskId).version),
            state,
          });
      if (fault === "source")
        f.scripted.state.sourceBody = "Changed outcome requiring review";
      if (fault === "permission")
        f.service.domain().execute({
          type: "delivery.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: f.projectId,
          expectedVersion: 2,
          mode: "reviewable-pr",
          credentialRef: null,
          grants: [],
          requiredChecks: [],
        });
      if (fault === "absent anchor")
        f.seedPersistedState((db) =>
          db
            .prepare("DELETE FROM inbox_request_anchors WHERE workId=?")
            .run(queued.workId),
        );
      if (fault === "Stop") await f.service.stopTask(f.taskId);
      if (fault === "held")
        f.seedPersistedState((db) =>
          db
            .prepare(
              "UPDATE execution_intents SET state='held',reason='Independent uncertain execution' WHERE workId=?",
            )
            .run(queued.workId),
        );
      if (fault === "admitted")
        f.seedPersistedState((db) =>
          db
            .prepare(
              "UPDATE execution_intents SET threadId='known-admission' WHERE workId=?",
            )
            .run(queued.workId),
        );
      if (fault === "effect")
        f.seedPersistedState((db) =>
          db
            .prepare(
              "INSERT INTO execution_pending_effects VALUES (?,'fixture-effect','pending','uncertain')",
            )
            .run(queued.workId),
        );
      await f.reopen();
      assert.equal(f.runtime.turns, 0);
      assert.equal(
        f.readDb(
          (db) =>
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM inbox_request_supersessions",
                )
                .get() as { n: number }
            ).n,
        ),
        0,
      );
      assert.equal(f.service.domain().task(f.taskId).state, "open");
    } finally {
      await f.close();
    }
  });
}

test("lost merge response becomes confirmed only after fresh readback and never replays the write", async () => {
  const f = await createReleaseDeliveryFixture("through-merge");
  try {
    await f.register();
    f.scripted.state.lostResponse = true;
    const result = await f.merge();
    assert.equal(result.success, false);
    assert.equal(f.scripted.state.writes, 1);
    await f.service.stopTask(f.taskId);
    await until(
      () => !f.service.list().some((i) => i.state === "running"),
      "lost-response stop",
    );
    await f.reopen();
    assert.ok(
      f.service
        .delivery()
        .actions(f.taskId)
        .some((a) => a.state === "confirmed-success"),
    );
    assert.equal(f.scripted.state.writes, 1);
    assert.equal(f.service.domain().task(f.taskId).state, "open");
    assert.equal(f.runtime.turns, 0);
  } finally {
    await f.close();
  }
});

test("assembled active child and successful worker terminal cannot independently complete the parent", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    await f.register();
    const worker = randomUUID(),
      assignmentId = randomUUID();
    const d = f.service.domain();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId: worker,
      name: "Worker",
      instructions: "Worker",
      capabilities: "work",
    });
    d.execute({
      type: "routing.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      credentialRef: null,
      candidateProfileIds: [worker],
    });
    d.execute({
      type: "assignment.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: f.taskId,
      assignmentId,
      profileId: worker,
      brief: "Bound child responsibility",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    assert.equal(
      (
        await f.call(
          "ensemble_request_completion",
          { reviewedResultIds: [] },
          1,
        )
      ).success,
      false,
    );
    await f.terminal(1);
    await f.waitTurn(2);
    assert.equal(
      (
        await f.call(
          "ensemble_request_completion",
          { reviewedResultIds: [] },
          2,
        )
      ).success,
      false,
    );
    const result = await f.call(
      "ensemble_report_result",
      { summary: "Worker successful result" },
      2,
    );
    assert.equal(result.success, true, result.text);
    await f.terminal(2);
    assert.equal(d.task(f.taskId).state, "open");
    assert.equal(f.scripted.state.writes, 0);
  } finally {
    await f.close();
  }
});

test("startup supersession rolls back the entire request and batch change after persistence failure", async () => {
  const f = await createReleaseDeliveryFixture();
  try {
    const queued = await pausedFeedback(f);
    const count = f.service.turnRequests().length;
    f.seedPersistedState((db) =>
      db.exec(
        "CREATE TRIGGER fixture_abort_supersession BEFORE INSERT ON inbox_request_supersessions BEGIN SELECT RAISE(ABORT, 'fixture transaction failure'); END",
      ),
    );
    await assert.rejects(() => f.reopen(), /fixture transaction failure/);
    assert.equal(f.runtime.turns, 0);
    f.readDb((db) => {
      assert.equal(
        (
          db.prepare("SELECT COUNT(*) AS n FROM turn_requests").get() as {
            n: number;
          }
        ).n,
        count,
      );
      assert.equal(
        (
          db
            .prepare("SELECT state FROM turn_requests WHERE workId=?")
            .get(queued.workId) as { state: string }
        ).state,
        "held",
      );
      assert.equal(
        (
          db
            .prepare("SELECT state FROM execution_intents WHERE workId=?")
            .get(queued.workId) as { state: string }
        ).state,
        "held",
      );
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
            .get() as { n: number }
        ).n,
        0,
      );
      assert.ok(
        db
          .prepare(
            "SELECT 1 FROM coordination_delivery_batches WHERE deliveryWorkId=? AND state='queued'",
          )
          .get(queued.workId),
      );
    });
    f.seedPersistedState((db) =>
      db.exec("DROP TRIGGER fixture_abort_supersession"),
    );
    await f.service.start();
    assert.equal(f.runtime.turns, 0);
    assert.equal(f.service.turnRequests().length, count);
    assert.equal(
      f.readDb(
        (db) =>
          (
            db
              .prepare("SELECT COUNT(*) AS n FROM inbox_request_supersessions")
              .get() as { n: number }
          ).n,
      ),
      0,
    );
  } finally {
    await f.close();
  }
});

for (const control of ["Ready off/on", "dependency add/remove"] as const) {
  test(`startup preserves local task invalidation after ${control}`, async () => {
    const f = await createReleaseDeliveryFixture("reviewable-pr", {}, true);
    try {
      await f.register();
      await f.terminal(1);
      const d = f.service.domain();
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: f.projectId,
        expectedVersion: 3,
        paused: true,
      });
      const assignment = d.assignments(f.taskId)[0]!;
      await f.service.coordinationView().postOperatorMessage({
        key: randomUUID(),
        taskId: f.taskId,
        recipientAssignmentId: String(assignment.id),
        expectedAssignmentVersion: Number(assignment.version),
        message: "Literal local feedback C1",
      });
      await f.service.refreshGitHub();
      await until(
        () =>
          f.service
            .turnRequests()
            .some((r) => r.state === "queued" && r.workId.includes(":inbox:")),
        "local queued inbox",
      );
      if (control === "Ready off/on") {
        for (const ready of [false, true])
          d.execute({
            type: "task.configure",
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            taskId: f.taskId,
            expectedVersion: Number(d.task(f.taskId).version),
            ready,
          });
      } else {
        const blockerTaskId = randomUUID();
        d.execute({
          type: "task.create",
          actor: "operator",
          key: randomUUID(),
          projectId: f.projectId,
          taskId: blockerTaskId,
          title: "Blocker",
          outcome: "Blocked",
          ready: false,
        });
        for (const type of ["dependency.add", "dependency.remove"] as const)
          d.execute({
            type,
            actor: "operator",
            key: randomUUID(),
            projectId: f.projectId,
            taskId: f.taskId,
            blockerTaskId,
            expectedVersion: Number(d.task(f.taskId).version),
          });
      }
      await f.reopen();
      assert.equal(f.runtime.turns, 0);
      assert.equal(
        f.readDb(
          (db) =>
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM inbox_request_supersessions",
                )
                .get() as { n: number }
            ).n,
        ),
        0,
      );
      assert.equal(f.service.domain().task(f.taskId).state, "open");
    } finally {
      await f.close();
    }
  });
}
