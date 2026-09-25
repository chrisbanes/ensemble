import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { bbCli, restartBb, rpc, waitFor, withFixture } from "./harness.mjs";

const exec = promisify(execFile);
const fixturePluginId = "ensemble-t1-fixture";

async function createProject(instance) {
  const machine = (await bbCli(instance, "machine", "list")).find(
    (candidate) => candidate.status === "connected",
  );
  assert(machine, "The isolated BB host is not connected");
  const projectRoot = path.join(instance.root, "t3-git-project");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "README.md"), "T3 fixture\n");
  await exec("git", ["init", "-b", "main", projectRoot]);
  await exec("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=T3 Fixture",
    "-c",
    "user.email=t3-fixture@example.invalid",
    "add",
    "README.md",
  ]);
  await exec("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=T3 Fixture",
    "-c",
    "user.email=t3-fixture@example.invalid",
    "commit",
    "-m",
    "T3 disposable project",
  ]);
  const project = await bbCli(
    instance,
    "project",
    "create",
    "--name",
    "T3 disposable project",
    "--root",
    projectRoot,
    "--machine",
    machine.id,
  );
  return { project, machine };
}

async function loss(instance, operation, args = {}) {
  return rpc(instance, "loss.run", { operation, args });
}

function spawnRequest(project, machine, operationId, prompt) {
  return {
    operationId,
    projectId: project.id,
    hostId: machine.id,
    prompt,
    environment: {
      type: "host",
      hostId: machine.id,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    },
  };
}

async function waitForIdle(instance, threadId, label) {
  return waitFor(async () => {
    const thread = await loss(instance, "thread", { threadId });
    return thread.status === "idle" ? thread : false;
  }, label);
}

async function toolCount(instance) {
  return (await loss(instance, "tool-count")).toolCalls;
}

test("lost BB responses reconcile from persisted intent and public state without blind retries", async () => {
  await withFixture(async (instance) => {
    const installed = await bbCli(
      instance,
      "plugin",
      "install",
      `path:${instance.fixtureDirectory}`,
      "--yes",
    );
    assert.equal(installed.plugin.id, fixturePluginId);
    const { project, machine } = await createProject(instance);
    const operationId = "t3-spawn-drop-basic";
    const request = spawnRequest(
      project,
      machine,
      operationId,
      "call_tool:capability_ping",
    );

    await assert.rejects(
      loss(instance, "spawn", { ...request, dropCallerResponse: true }),
      /T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u,
    );
    const uncertain = await loss(instance, "intent", { operationId });
    assert.equal(uncertain.state, "uncertain");
    assert.equal(uncertain.responseDropped, true);
    assert.equal(uncertain.threadId, null);
    assert.equal(uncertain.spawnCalls, 1);

    const acceptedThread = await waitFor(async () => {
      const lookup = await loss(instance, "find-spawn-matches", {
        operationId,
      });
      const match = lookup.matches[0];
      if (lookup.matches.length !== 1 || match?.status !== "idle") return false;
      return match;
    }, "accepted spawn completion before BB restart");
    assert.equal((await loss(instance, "tool-count")).toolCalls, 1);

    await restartBb(instance);
    const recovered = await loss(instance, "reconcile-spawn", { operationId });
    assert.equal(recovered.state, "confirmed");
    assert.equal(recovered.matches.length, 1);
    assert.equal(recovered.spawnCalls, 1);
    const threadId = recovered.threadId;
    assert.equal(typeof threadId, "string");
    assert.equal(recovered.matches[0].threadId, threadId);
    const metadata = await loss(instance, "metadata", { threadId });
    assert.equal(metadata.t3_operation_id, operationId);
    const completed = await waitForIdle(
      instance,
      threadId,
      "single recovered scripted tool turn",
    );
    assert.equal(completed.status, "idle");
    assert.equal((await loss(instance, "tool-count")).toolCalls, 1);

    const replay = await loss(instance, "spawn", request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.noBlindRetry, true);
    assert.equal(replay.threadId, threadId);
    assert.equal(replay.spawnCalls, 1);
    const effects = await loss(instance, "effects", { operationId });
    assert.deepEqual(
      effects.map((effect) => effect.kind),
      ["spawn"],
    );

    const zeroRequest = spawnRequest(
      project,
      machine,
      "t3-spawn-zero-match",
      "T3 zero-match held request",
    );
    await assert.rejects(
      loss(instance, "spawn", {
        ...zeroRequest,
        dropBeforeAcceptance: true,
      }),
      /T3_RESPONSE_DROPPED_BEFORE_ACCEPTANCE/u,
    );
    const zeroUncertain = await loss(instance, "intent", {
      operationId: zeroRequest.operationId,
    });
    assert.equal(zeroUncertain.state, "uncertain");
    assert.equal(zeroUncertain.responseDropped, true);
    assert.equal(zeroUncertain.spawnCalls, 0);
    const multipleRequest = spawnRequest(
      project,
      machine,
      "t3-spawn-multiple-match",
      "T3 multiple-match held request",
    );
    await loss(instance, "prepare-spawn", multipleRequest);
    const seededDuplicates = await loss(instance, "inject-multiple-spawns", {
      operationId: multipleRequest.operationId,
      count: 2,
    });
    assert.equal(seededDuplicates.candidateThreadIds.length, 2);
    await restartBb(instance);

    const zeroMatch = await loss(instance, "reconcile-spawn", {
      operationId: zeroRequest.operationId,
    });
    assert.equal(zeroMatch.state, "held");
    assert.equal(zeroMatch.matches.length, 0);
    assert.match(zeroMatch.holdReason, /No matching thread/u);
    const zeroReplay = await loss(instance, "spawn", zeroRequest);
    assert.equal(zeroReplay.state, "held");
    assert.equal(zeroReplay.noBlindRetry, true);
    assert.equal(zeroReplay.spawnCalls, 0);
    assert.deepEqual(
      await loss(instance, "effects", {
        operationId: zeroRequest.operationId,
      }),
      [],
    );

    const multipleMatch = await loss(instance, "reconcile-spawn", {
      operationId: multipleRequest.operationId,
    });
    assert.equal(multipleMatch.state, "held");
    assert.equal(multipleMatch.matches.length, 2);
    assert.deepEqual(
      multipleMatch.matches.map((match) => match.threadId).sort(),
      [...seededDuplicates.candidateThreadIds].sort(),
    );
    assert.match(multipleMatch.holdReason, /Multiple matching threads/u);
    const multipleReplay = await loss(instance, "spawn", multipleRequest);
    assert.equal(multipleReplay.noBlindRetry, true);
    assert.equal(multipleReplay.spawnCalls, 2);
    assert.equal(multipleReplay.state, "held");

    let count = await toolCount(instance);
    const directOperationId = "t3-send-direct-drop";
    const directText = `T3 unique send marker ${directOperationId} call_tool:capability_ping`;
    const directRequest = {
      operationId: directOperationId,
      threadId,
      text: directText,
    };
    await assert.rejects(
      loss(instance, "send", { ...directRequest, dropCallerResponse: true }),
      /T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u,
    );
    const directUncertain = await loss(instance, "intent", {
      operationId: directOperationId,
    });
    assert.equal(directUncertain.state, "uncertain");
    assert.equal(directUncertain.messageId, null);
    await waitForIdle(instance, threadId, "direct lost-response turn idle");
    assert.equal(await toolCount(instance), count + 1);
    count += 1;
    const directEffectCount = count;
    await restartBb(instance);
    const directRecovered = await loss(instance, "reconcile-send", {
      operationId: directOperationId,
    });
    assert.equal(directRecovered.state, "confirmed");
    assert.equal(directRecovered.timelineMatches.length, 1);
    assert.equal(directRecovered.timelineMatches[0].text, directText);
    assert.equal(typeof directRecovered.messageId, "string");
    const directReplay = await loss(instance, "send", directRequest);
    assert.equal(directReplay.noBlindRetry, true);
    assert.equal(directReplay.sendCalls, 1);
    assert.equal(directReplay.messageId, directRecovered.messageId);
    assert.equal(directReplay.turnId, directRecovered.turnId);
    assert.equal(await toolCount(instance), count);

    const delayedOperationId = "t3-send-delayed-response";
    const delayedText = `T3 unique delayed marker ${delayedOperationId} call_tool:capability_ping`;
    const delayed = await loss(instance, "send", {
      operationId: delayedOperationId,
      threadId,
      text: delayedText,
      delayCallerResponse: true,
    });
    assert.equal(delayed.responseDelayed, true);
    await waitForIdle(instance, threadId, "delayed response turn idle");
    assert.equal(await toolCount(instance), count + 1);
    count += 1;
    const delayedEffectCount = count;
    const delayedReconciled = await loss(instance, "reconcile-send", {
      operationId: delayedOperationId,
    });
    assert.equal(delayedReconciled.state, "confirmed");
    const lateResult = await loss(instance, "release-delayed", {
      operationId: delayedOperationId,
    });
    assert.equal(lateResult.lateResponseIgnored, true);
    assert.equal(lateResult.state, "confirmed");
    assert.equal(lateResult.lateResponseCount, 1);
    assert.equal(lateResult.messageId, delayedReconciled.messageId);
    assert.equal(await toolCount(instance), count);

    const queuedOperationId = "t3-send-queued-drop";
    const queuedText = `T3 unique queued marker ${queuedOperationId} call_tool:capability_ping`;
    const queuedRequest = {
      operationId: queuedOperationId,
      threadId,
      text: queuedText,
      sendAt: Date.now() + 24 * 60 * 60 * 1_000,
    };
    await assert.rejects(
      loss(instance, "send", { ...queuedRequest, dropCallerResponse: true }),
      /T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u,
    );
    const queuedUncertain = await loss(instance, "intent", {
      operationId: queuedOperationId,
    });
    assert.equal(queuedUncertain.state, "uncertain");
    assert.equal(queuedUncertain.queuedMessageId, null);
    await restartBb(instance);
    const queuedRecovered = await loss(instance, "reconcile-send", {
      operationId: queuedOperationId,
    });
    assert.equal(queuedRecovered.state, "queued");
    assert.equal(typeof queuedRecovered.queuedMessageId, "string");
    assert.equal(queuedRecovered.queueMatches.length, 1);
    const queuedReplay = await loss(instance, "send", queuedRequest);
    assert.equal(queuedReplay.noBlindRetry, true);
    assert.equal(queuedReplay.sendCalls, 1);
    assert.equal(queuedReplay.queuedMessageId, queuedRecovered.queuedMessageId);
    assert.equal(await toolCount(instance), count);
    const publicQueue = await loss(instance, "queue-list", { threadId });
    assert(
      publicQueue.some((entry) => entry.id === queuedRecovered.queuedMessageId),
    );
    const released = await loss(instance, "release-queued", {
      operationId: queuedOperationId,
    });
    assert.equal(released.delivery, "sent");
    await waitForIdle(instance, threadId, "recovered queued send idle");
    assert.equal(await toolCount(instance), count + 1);
    count += 1;
    const queuedEffectCount = count;
    const queuedDispatched = await loss(instance, "reconcile-send", {
      operationId: queuedOperationId,
    });
    assert.equal(queuedDispatched.state, "confirmed");
    assert.equal(queuedDispatched.timelineMatches.length, 1);
    assert.equal(queuedDispatched.timelineMatches[0].text, queuedText);
    assert.equal(await toolCount(instance), count);

    const ambiguousOperationId = "t3-send-ambiguous-queue";
    const ambiguousText = `T3 unique ambiguous marker ${ambiguousOperationId}`;
    const ambiguousRequest = {
      operationId: ambiguousOperationId,
      threadId,
      text: ambiguousText,
      sendAt: Date.now() + 24 * 60 * 60 * 1_000,
    };
    await loss(instance, "prepare-send", ambiguousRequest);
    const duplicateQueue = await loss(
      instance,
      "inject-duplicate-queued-sends",
      ambiguousRequest,
    );
    assert.equal(duplicateQueue.queuedMessageIds.length, 2);
    await restartBb(instance);
    const ambiguous = await loss(instance, "reconcile-send", {
      operationId: ambiguousOperationId,
    });
    assert.equal(ambiguous.state, "held");
    assert.equal(ambiguous.queueMatches.length, 2);
    assert.match(ambiguous.holdReason, /Ambiguous public matches/u);
    const ambiguousReplay = await loss(instance, "send", ambiguousRequest);
    assert.equal(ambiguousReplay.noBlindRetry, true);
    assert.equal(ambiguousReplay.sendCalls, 2);
    assert.equal(await toolCount(instance), count);

    const staleOperationId = "t3-send-stale-generation";
    const staleText = `T3 unique stale marker ${staleOperationId} call_tool:capability_ping`;
    await assert.rejects(
      loss(instance, "send", {
        operationId: staleOperationId,
        threadId,
        text: staleText,
        sendAt: Date.now() + 24 * 60 * 60 * 1_000,
        dropCallerResponse: true,
      }),
      /T3_RESPONSE_DROPPED_AFTER_ACCEPTANCE/u,
    );
    await restartBb(instance);
    const staleQueued = await loss(instance, "reconcile-send", {
      operationId: staleOperationId,
    });
    assert.equal(staleQueued.state, "queued");
    const advanced = await loss(instance, "advance-generation", {
      operationId: staleOperationId,
      currentGeneration: 2,
    });
    assert.equal(advanced.generation, 1);
    assert.equal(advanced.currentGeneration, 2);
    const invalidated = await loss(instance, "release-queued", {
      operationId: staleOperationId,
    });
    assert.equal(invalidated.state, "invalidated");
    assert.equal(invalidated.invalidated, true);
    const queueAfterInvalidation = await loss(instance, "queue-list", {
      threadId,
    });
    assert(
      !queueAfterInvalidation.some(
        (entry) => entry.id === staleQueued.queuedMessageId,
      ),
    );
    assert.equal(await toolCount(instance), count);
    assert(
      (await loss(instance, "effects", { operationId: staleOperationId })).some(
        (effect) => effect.kind === "invalidate-stale-queue",
      ),
    );

    instance.runtimeManifest.checks.lostResponse = {
      acceptedSpawnRecovered: {
        operationId,
        threadId,
        preRestartPublicStatus: acceptedThread.status,
        metadata,
        providerToolEffects: 1,
        replayNoBlindRetry: true,
        reconciliationApi: recovered.publicLookup,
      },
      zeroSpawnMatchesHeld: {
        operationId: zeroRequest.operationId,
        requestLostBeforeAcceptance: zeroUncertain.responseDropped,
        state: zeroMatch.state,
        matches: zeroMatch.matches.length,
        spawnCallsAfterReplay: zeroReplay.spawnCalls,
      },
      multipleSpawnMatchesHeld: {
        operationId: multipleRequest.operationId,
        state: multipleMatch.state,
        matches: multipleMatch.matches.map((match) => match.threadId),
        spawnCallsAfterReplay: multipleReplay.spawnCalls,
      },
      directSendRecovered: {
        operationId: directOperationId,
        messageId: directRecovered.messageId,
        turnId: directRecovered.turnId,
        providerToolEffectCount: directEffectCount,
        providerToolEffectDelta: 1,
        sendCallsAfterReplay: directReplay.sendCalls,
      },
      delayedSendResponse: {
        operationId: delayedOperationId,
        messageId: delayedReconciled.messageId,
        lateResponseIgnored: lateResult.lateResponseIgnored,
        stateAfterLateResponse: lateResult.state,
        lateResponseCount: lateResult.lateResponseCount,
        providerToolEffectCount: delayedEffectCount,
        providerToolEffectDelta: 1,
      },
      queuedSendRecovered: {
        operationId: queuedOperationId,
        queuedMessageId: queuedRecovered.queuedMessageId,
        messageId: queuedDispatched.messageId,
        turnId: queuedDispatched.turnId,
        sendCallsAfterReplay: queuedReplay.sendCalls,
        providerToolEffectCount: queuedEffectCount,
        providerToolEffectDelta: 1,
      },
      ambiguousQueueHeld: {
        operationId: ambiguousOperationId,
        queuedMessageIds: ambiguous.queueMatches.map((entry) => entry.id),
        state: ambiguous.state,
        sendCallsAfterReplay: ambiguousReplay.sendCalls,
      },
      staleGenerationInvalidated: {
        operationId: staleOperationId,
        queuedMessageId: staleQueued.queuedMessageId,
        state: invalidated.state,
        publicQueueRowDeleted: invalidated.invalidated,
        providerToolEffectsAfterInvalidation: count,
      },
      idempotencyBoundary:
        "Recovery uses unique fixture metadata or exact text markers, public BB reads, and persistent Ensemble fixture intents. BB provides no caller-supplied operation idempotency key; these bounded proofs do not establish general idempotency or resolve a delayed accepted call that has not become publicly visible.",
    };
  });
});
