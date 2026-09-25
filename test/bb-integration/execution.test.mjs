import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  bbCli,
  fixtureGit,
  restartBb,
  rpc,
  waitFor,
  withFixture,
} from "./harness.mjs";

const fixturePluginId = "ensemble-t1-fixture";

async function createProject(instance) {
  const machine = (await bbCli(instance, "machine", "list")).find(
    (candidate) => candidate.status === "connected",
  );
  assert(machine, "The isolated BB host is not connected");
  const projectRoot = path.join(instance.root, "t2-git-project");
  await mkdir(projectRoot);
  await writeFile(
    path.join(projectRoot, "README.md"),
    "T2 disposable project\n",
  );
  await fixtureGit(instance, ["init", "-b", "main", projectRoot]);
  await fixtureGit(instance, [
    "-C",
    projectRoot,
    "-c",
    "user.name=T2 Fixture",
    "-c",
    "user.email=t2-fixture@example.invalid",
    "add",
    "README.md",
  ]);
  await fixtureGit(instance, [
    "-C",
    projectRoot,
    "-c",
    "user.name=T2 Fixture",
    "-c",
    "user.email=t2-fixture@example.invalid",
    "commit",
    "-m",
    "T2 disposable project",
  ]);
  const project = await bbCli(
    instance,
    "project",
    "create",
    "--name",
    "T2 disposable project",
    "--root",
    projectRoot,
    "--machine",
    machine.id,
  );
  return { project, machine };
}

async function execution(instance, operation, args = {}) {
  return rpc(instance, "execution.run", { operation, args });
}

async function providerTrace(instance) {
  const content = await readFile(
    instance.env.SCRIPTED_ECHO_RECORD_PATH,
    "utf8",
  );
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function holdScheduledMessageForDay() {
  return Date.now() + 24 * 60 * 60 * 1_000;
}

test("public execution settings, lifecycle, interactions, retry, and environment identity are observable", async () => {
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

    const marker = "T2 exact prompt marker";
    const configured = await execution(instance, "spawn", {
      projectId: project.id,
      providerId: "ensemble-scripted",
      model: "fixture-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      pluginMetadata: { t2_marker: "metadata-readback" },
      prompt: marker,
      environment: {
        type: "host",
        hostId: machine.id,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    });
    assert.equal(typeof configured.id, "string");
    const configuredThread = await waitFor(async () => {
      const thread = await execution(instance, "get", {
        threadId: configured.id,
      });
      return thread.status === "idle" ? thread : false;
    }, "configured public thread completion");
    assert.equal(configuredThread.providerId, "ensemble-scripted");
    assert.equal(configuredThread.projectId, project.id);
    assert.equal(typeof configuredThread.environmentId, "string");
    const metadata = await execution(instance, "metadata", {
      threadId: configured.id,
    });
    assert.equal(metadata.t2_marker, "metadata-readback");
    const environment = await execution(instance, "environment", {
      environmentId: configuredThread.environmentId,
    });
    assert.equal(environment.id, configuredThread.environmentId);
    assert.equal(environment.projectId, project.id);
    const traceForConfiguredThread = (await providerTrace(instance)).filter(
      (entry) =>
        entry.method === "turn/start" &&
        entry.params.threadId === configured.id,
    );
    assert(
      traceForConfiguredThread.length === 1,
      "expected one provider turn/start for the configured thread",
    );
    const [configuredRequest] = traceForConfiguredThread;
    assert.equal(configuredRequest.params.input[0].text, marker);
    assert.equal(configuredRequest.params.options.model, "fixture-model");
    assert.equal(configuredRequest.params.options.reasoningLevel, "medium");
    assert.equal(configuredRequest.params.options.serviceTier, "default");
    assert.equal(
      configuredRequest.params.options.permissionMode,
      "accept-edits",
    );
    instance.runtimeManifest.checks.executionSpawn = {
      threadId: configured.id,
      environmentId: configuredThread.environmentId,
      environment,
      metadata,
      providerTrace: traceForConfiguredThread,
    };

    let unsupportedProviderError;
    let unsupportedProviderAttempt;
    try {
      unsupportedProviderAttempt = await execution(instance, "spawn", {
        projectId: project.id,
        providerId: "t2-unregistered-provider",
        model: "fixture-model",
        reasoningLevel: "medium",
        serviceTier: "default",
        permissionMode: "accept-edits",
        prompt: "T2 unsupported provider must be rejected",
        environment: {
          type: "reuse",
          environmentId: configuredThread.environmentId,
        },
      });
    } catch (error) {
      unsupportedProviderError = String(error);
    }
    if (unsupportedProviderError !== undefined) {
      assert.match(
        unsupportedProviderError,
        /provider|unsupported|unknown/iu,
        "BB must report an unregistered provider choice as unsupported",
      );
      instance.runtimeManifest.checks.executionUnsupportedChoice = {
        requestedProviderId: "t2-unregistered-provider",
        rejectedAtSpawn: true,
        error: unsupportedProviderError,
      };
    } else {
      assert.equal(
        unsupportedProviderAttempt.providerId,
        "t2-unregistered-provider",
      );
      const rejectedThread = await waitFor(
        async () => {
          const thread = await execution(instance, "get", {
            threadId: unsupportedProviderAttempt.id,
          });
          return thread.status === "error" ? thread : false;
        },
        "unregistered provider rejection",
        20_000,
      );
      const rejectionEvents = await execution(instance, "events", {
        threadId: unsupportedProviderAttempt.id,
      });
      const rejection = rejectionEvents.find(
        (event) => event.name === "thread.failed",
      );
      assert(
        rejection,
        "BB accepted an unregistered provider without reporting failure",
      );
      assert.equal(rejectedThread.status, "error");
      assert.equal(rejection.data.thread.status, "error");
      const unsupportedProviderTrace = (await providerTrace(instance)).filter(
        (entry) =>
          entry.method === "turn/start" &&
          entry.params.threadId === unsupportedProviderAttempt.id,
      );
      assert.equal(
        unsupportedProviderTrace.length,
        0,
        "BB must not dispatch the unregistered provider to the scripted bridge",
      );
      instance.runtimeManifest.checks.executionUnsupportedChoice = {
        requestedProviderId: "t2-unregistered-provider",
        acceptedAtSpawn: true,
        rejectedDuringProvisioning: true,
        status: rejectedThread.status,
        error: rejection.data.error,
        reasonSpecificity: "generic",
        threadFailedEvent: rejection.data,
        providerTrace: unsupportedProviderTrace,
      };
    }

    const second = await execution(instance, "spawn", {
      projectId: project.id,
      providerId: "ensemble-scripted",
      model: "fixture-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      prompt: "T2 shared environment second thread",
      environment: {
        type: "reuse",
        environmentId: configuredThread.environmentId,
      },
    });
    const secondThread = await waitFor(async () => {
      const thread = await execution(instance, "get", { threadId: second.id });
      return thread.status === "idle" ? thread : false;
    }, "second thread completion in shared environment");
    assert.equal(secondThread.environmentId, configuredThread.environmentId);

    const questionThread = await execution(instance, "spawn", {
      projectId: project.id,
      providerId: "ensemble-scripted",
      model: "fixture-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      prompt: "ask_user",
      environment: {
        type: "reuse",
        environmentId: configuredThread.environmentId,
      },
    });
    const pending = await waitFor(async () => {
      const interactions = await execution(instance, "interactions", {
        threadId: questionThread.id,
      });
      return interactions.length === 1 ? interactions[0] : false;
    }, "public ask_user interaction");
    assert.equal(pending.payload.kind, "user_question");
    const answered = await execution(instance, "answer", {
      threadId: questionThread.id,
      interactionId: pending.id,
      resolution: {
        kind: "user_answer",
        answers: {
          [pending.payload.questions[0].id]: { selected: ["staging"] },
        },
      },
    });
    assert.equal(typeof answered.id, "string");
    assert.equal(answered.resolution?.kind, "user_answer");
    const resumed = await waitFor(async () => {
      const thread = await execution(instance, "get", {
        threadId: questionThread.id,
      });
      return thread.status === "idle" ? thread : false;
    }, "question answered and provider resumed");
    assert.equal(resumed.status, "idle");
    const answeredOutput = await execution(instance, "output", {
      threadId: questionThread.id,
    });
    assert.match(answeredOutput.output ?? "", /Question answered: staging/u);
    const unresolvedInteractions = await execution(instance, "interactions", {
      threadId: questionThread.id,
    });
    assert.equal(
      unresolvedInteractions.length,
      0,
      "resolved question must no longer be pending",
    );
    const questionEvents = await execution(instance, "events", {
      threadId: questionThread.id,
    });
    const pendingEvent = questionEvents.find(
      (event) => event.name === "interaction.pending",
    );
    assert.equal(pendingEvent?.data.interaction.id, pending.id);

    const queueText = "T2 queued message dispatch marker";
    const queuedDispatch = await execution(instance, "send", {
      threadId: configured.id,
      mode: "auto",
      sendAt: holdScheduledMessageForDay(),
      input: [{ type: "text", text: queueText }],
    });
    assert.equal(queuedDispatch.delivery, "queued");
    const queuedId = queuedDispatch.queuedMessage.id;
    await waitFor(async () => {
      const events = await execution(instance, "events", {
        threadId: configured.id,
      });
      return events.some(
        (event) =>
          event.name === "message.queued" && event.data.entry.id === queuedId,
      );
    }, "message.queued event");
    const queuedRead = await execution(instance, "queue-list", {
      threadId: configured.id,
    });
    assert(queuedRead.some((entry) => entry.id === queuedId));
    const dispatched = await execution(instance, "queue-send", {
      threadId: configured.id,
      queuedMessageId: queuedId,
      mode: "auto",
    });
    assert.equal(dispatched.delivery, "sent");
    await waitFor(async () => {
      const events = await execution(instance, "events", {
        threadId: configured.id,
      });
      return events.some(
        (event) =>
          event.name === "message.dispatched" &&
          event.data.entry.id === queuedId,
      );
    }, "message.dispatched event");
    const queueResultThread = await waitFor(async () => {
      const thread = await execution(instance, "get", {
        threadId: configured.id,
      });
      const trace = (await providerTrace(instance)).filter(
        (entry) =>
          entry.method === "turn/start" &&
          entry.params.threadId === configured.id,
      );
      return thread.status === "idle" &&
        trace.some((entry) => entry.params.input[0].text === queueText)
        ? thread
        : false;
    }, "queued prompt delivered to provider");
    assert.equal(queueResultThread.status, "idle");
    assert(
      !(
        await execution(instance, "queue-list", { threadId: configured.id })
      ).some((entry) => entry.id === queuedId),
    );

    const cancelledDispatch = await execution(instance, "send", {
      threadId: configured.id,
      mode: "auto",
      sendAt: holdScheduledMessageForDay(),
      input: [{ type: "text", text: "T2 queued message cancellation marker" }],
    });
    assert.equal(cancelledDispatch.delivery, "queued");
    const cancelledId = cancelledDispatch.queuedMessage.id;
    await waitFor(async () => {
      const events = await execution(instance, "events", {
        threadId: configured.id,
      });
      return events.some(
        (event) =>
          event.name === "message.queued" &&
          event.data.entry.id === cancelledId,
      );
    }, "second message.queued event");
    await execution(instance, "queue-delete", {
      threadId: configured.id,
      queuedMessageId: cancelledId,
    });
    await waitFor(async () => {
      const events = await execution(instance, "events", {
        threadId: configured.id,
      });
      return events.some(
        (event) =>
          event.name === "message.cancelled" &&
          event.data.entry.id === cancelledId,
      );
    }, "message.cancelled event");
    assert(
      !(
        await execution(instance, "queue-list", { threadId: configured.id })
      ).some((entry) => entry.id === cancelledId),
    );

    const failing = await execution(instance, "spawn", {
      projectId: project.id,
      providerId: "ensemble-scripted",
      model: "fixture-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
      prompt: "T2 retry once marker",
      sendAt: holdScheduledMessageForDay(),
      environment: {
        type: "reuse",
        environmentId: configuredThread.environmentId,
      },
    });
    const heldFailureQueue = await execution(instance, "queue-list", {
      threadId: failing.id,
    });
    const heldFailureEntry = heldFailureQueue.find(
      (entry) => entry.content[0]?.text === "T2 retry once marker",
    );
    assert(
      heldFailureEntry,
      "first failure turn must remain held before release",
    );
    assert.equal(heldFailureEntry.waitingOn.kind, "time");
    assert.equal(
      (await providerTrace(instance)).filter(
        (entry) =>
          entry.method === "turn/start" && entry.params.threadId === failing.id,
      ).length,
      0,
      "the held failure turn must not reach the provider before it is armed",
    );
    await execution(instance, "arm-retry-failure", { threadId: failing.id });
    const releasedFailure = await execution(instance, "queue-send", {
      threadId: failing.id,
      queuedMessageId: heldFailureEntry.id,
      mode: "auto",
    });
    assert.equal(releasedFailure.delivery, "sent");
    await waitFor(
      async () => {
        const thread = await execution(instance, "get", {
          threadId: failing.id,
        });
        return thread.status === "error" ? thread : false;
      },
      "scripted failed turn",
      30_000,
    );
    const failedEvents = await waitFor(async () => {
      const events = await execution(instance, "events", {
        threadId: failing.id,
      });
      return events.some((event) => event.name === "thread.failed") &&
        events.some((event) => event.name === "turn.failed")
        ? events
        : false;
    }, "public thread.failed and turn.failed events");
    const failure = failedEvents.find((event) => event.name === "turn.failed");
    const threadFailed = failedEvents.find(
      (event) => event.name === "thread.failed",
    );
    assert(failure, "missing public turn.failed observation");
    assert.equal(threadFailed?.data.thread.status, "error");
    assert.equal(
      (await execution(instance, "get", { threadId: failing.id })).status,
      "error",
    );
    assert.equal(failure.data.attemptNumber, 1);
    await execution(instance, "disarm-retry-failure", { threadId: failing.id });
    const retry = await execution(instance, "retry", {
      threadId: failing.id,
      turnRequestId: failure.data.requestId,
      reason: "T2 explicit retry",
    });
    assert.equal(retry.delivery, "sent");
    assert.equal(retry.turnRequestId, failure.data.requestId);
    assert.equal(retry.attempt, 2);
    const retried = await waitFor(async () => {
      const thread = await execution(instance, "get", { threadId: failing.id });
      return thread.status === "idle" ? thread : false;
    }, "explicit retry completion");
    assert.equal(retried.status, "idle");
    const retryTrace = (await providerTrace(instance)).filter(
      (entry) =>
        entry.method === "turn/start" && entry.params.threadId === failing.id,
    );
    assert(
      retryTrace.length >= 2,
      "provider trace does not show the failed attempt and retry",
    );
    assert.equal(retryTrace.length, 2);
    assert.equal(retryTrace[0].params.clientRequestId, failure.data.requestId);
    assert.notEqual(
      retryTrace[1].params.clientRequestId,
      retryTrace[0].params.clientRequestId,
    );
    assert.equal(
      retryTrace[0].params.options.providerOptions.scripted.failMethods[0]
        .message,
      "T2 scripted first-attempt failure",
    );
    assert.equal(
      retryTrace[1].params.options.providerOptions.scripted.failMethods,
      undefined,
    );
    instance.runtimeManifest.checks.executionRetry = {
      threadId: failing.id,
      failedTurnRequestId: failure.data.requestId,
      failureAttempt: failure.data.attemptNumber,
      failureEvent: failure.data,
      threadFailedEvent: threadFailed.data,
      retry,
      providerTrace: retryTrace,
    };

    await restartBb(instance);
    for (const threadId of [
      configured.id,
      second.id,
      questionThread.id,
      failing.id,
    ]) {
      const thread = await execution(instance, "get", { threadId });
      assert.equal(typeof thread.environmentId, "string");
      assert.equal(thread.status, "idle");
    }
    const environmentAfterRestart = await execution(instance, "environment", {
      environmentId: configuredThread.environmentId,
    });
    assert.equal(environmentAfterRestart.id, configuredThread.environmentId);
    assert.equal(
      (await execution(instance, "metadata", { threadId: configured.id }))
        .t2_marker,
      "metadata-readback",
    );
    assert.equal(
      (await execution(instance, "get", { threadId: configured.id }))
        .environmentId,
      (await execution(instance, "get", { threadId: second.id })).environmentId,
    );
    const allEvents = await execution(instance, "events", {
      threadId: configured.id,
    });
    for (const name of [
      "thread.created",
      "thread.active",
      "thread.idle",
      "message.queued",
      "message.dispatched",
      "message.cancelled",
    ]) {
      assert(
        allEvents.some((event) => event.name === name),
        `missing ${name} event`,
      );
    }
    const createdEvent = allEvents.find(
      (event) => event.name === "thread.created",
    );
    const activeEvent = allEvents.find(
      (event) => event.name === "thread.active",
    );
    const idleEvent = allEvents.find((event) => event.name === "thread.idle");
    assert.equal(createdEvent?.data.thread.id, configured.id);
    assert.equal(createdEvent?.data.thread.status, "pending");
    assert.equal(activeEvent?.data.thread.status, "active");
    assert.equal(idleEvent?.data.thread.status, "idle");
    assert.equal(
      allEvents.find((event) => event.name === "message.queued")?.data.entry.id,
      queuedId,
    );
    assert.equal(
      allEvents.find((event) => event.name === "message.dispatched")?.data.entry
        .id,
      queuedId,
    );
    assert.equal(
      allEvents.find((event) => event.name === "message.cancelled")?.data.entry
        .id,
      cancelledId,
    );
    const interactions = await execution(instance, "events", {
      threadId: questionThread.id,
    });
    assert(interactions.some((event) => event.name === "interaction.pending"));
    instance.runtimeManifest.checks.executionLifecycle = allEvents;
    instance.runtimeManifest.checks.executionInteraction = interactions;
    instance.runtimeManifest.checks.executionInteractionAnswer = {
      threadId: questionThread.id,
      interactionId: pending.id,
      answerKind: answered.resolution.kind,
      resumedStatus: resumed.status,
      output: answeredOutput.output,
      unresolvedInteractionCount: unresolvedInteractions.length,
      pendingEventId: pendingEvent?.data.interaction.id,
    };
    instance.runtimeManifest.checks.sharedEnvironmentAfterRestart = {
      environmentId: configuredThread.environmentId,
      environmentAfterRestart,
      threadIds: [configured.id, second.id],
    };
  });
});
