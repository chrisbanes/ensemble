import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { APIError } from "@typesafe-ai/sdk";
import { DomainStore } from "../src/core/domain.js";
import { Store } from "../src/core/store.js";
import {
  RoutingAttemptStore,
  RoutingCoordinator,
  RoutingFailure,
  type RoutingChoiceClient,
  type RoutingChoiceRequest,
  type RoutingChoiceResponse,
  type RoutingSnapshot,
} from "../src/standalone/routing.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const profileA = "30000000-0000-4000-8000-000000000001";
const profileB = "30000000-0000-4000-8000-000000000002";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new RoutingAttemptStore(db);
  store.migrate();
  return { db, store, close: () => db.close() };
}

function snapshot(overrides: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  return {
    projectId,
    taskId,
    taskVersion: 7,
    guidanceRevision: 3,
    brief: "Ship a stable parser.",
    findings: "Existing parsing uses strict schema checks.",
    guidance: "Prefer Kotlin and API maintenance experience.",
    candidates: [
      {
        profileId: profileA,
        name: "Parser Maintainer",
        capabilities: "Kotlin, parser compatibility",
        profileRevision: 4,
      },
      {
        profileId: profileB,
        name: "Generalist",
        capabilities: "TypeScript, testing",
        profileRevision: 2,
      },
    ],
    ...overrides,
  };
}

function selected(
  profileId: string,
  model = "jev-1.13.0",
): RoutingChoiceResponse {
  return {
    choice: profileId,
    model,
    confidence: 0.87,
    probabilities: { [profileA]: 0.87, [profileB]: 0.08, lead_review: 0.05 },
    usage: { inputTokens: 121, outputTokens: 23 },
  };
}

test("routing inference operations coexist with domain routing dispositions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("test");
    new DomainStore(db).migrate();
    const routing = new RoutingAttemptStore(db);
    routing.migrate();

    const operation = routing.ensureOperation(snapshot());

    assert.equal(operation.operationId.length > 0, true);
    assert.ok(
      (
        db.prepare("PRAGMA table_info(routing_operations)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "id"),
    );
    assert.ok(
      (
        db.prepare("PRAGMA table_info(routing_attempt_operations)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "operationId"),
    );
  } finally {
    db.close();
  }
});

class FakeClient implements RoutingChoiceClient {
  readonly requests: RoutingChoiceRequest[] = [];
  constructor(
    private readonly outcomes: Array<
      RoutingChoiceResponse | Error | (() => Promise<RoutingChoiceResponse>)
    >,
  ) {}

  async choose(
    request: RoutingChoiceRequest,
    _signal: AbortSignal,
  ): Promise<RoutingChoiceResponse> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error("No fake routing response remains");
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "function") return outcome();
    return outcome;
  }
}

test("routing payload is limited to the captured brief, findings, guidance and candidates", async () => {
  const f = fixture();
  try {
    const client = new FakeClient([selected(profileA, "jev-1.13.0")]);
    const coordinator = new RoutingCoordinator(f.store, client);
    const result = await coordinator.route(snapshot());
    assert.equal(result.kind, "assigned");
    if (result.kind !== "assigned") return;
    assert.equal(result.profileId, profileA);
    assert.equal(result.requestedModel, "jev-1.13.0");
    assert.equal(result.returnedModel, "jev-1.13.0");
    assert.equal(result.confidence, 0.87);
    assert.equal(result.usage.inputTokens, 121);
    const request = client.requests[0];
    assert.ok(request);
    assert.deepEqual(Object.keys(request.state).sort(), [
      "brief",
      "candidates",
      "findings",
      "guidance",
    ]);
    assert.deepEqual(request.choices, [profileA, profileB, "lead_review"]);
    assert.deepEqual(
      request.state.candidates.map((candidate) => candidate.profileId),
      [profileA, profileB],
    );
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(
      serialized,
      /credential|token|workspace|transcript|secret/i,
    );
    const record = f.store.operation(projectId, taskId, 7);
    assert.ok(record);
    assert.equal(record.status, "assigned");
    assert.equal(record.attemptsUsed, 1);
    assert.equal(
      f.store.attempts(record.operationId)[0]?.returnedModel,
      "jev-1.13.0",
    );
  } finally {
    f.close();
  }
});

test("lead_review and invalid choices produce a single structured fallback", async () => {
  const f = fixture();
  try {
    const leadReview = new RoutingCoordinator(
      f.store,
      new FakeClient([selected("lead_review")]),
    );
    const first = await leadReview.route(snapshot());
    assert.equal(first.kind, "lead-review");
    if (first.kind === "lead-review") assert.equal(first.reason, "lead-review");
  } finally {
    f.close();
  }

  for (const choice of ["unlisted-profile", ""]) {
    const g = fixture();
    try {
      const coordinator = new RoutingCoordinator(
        g.store,
        new FakeClient([selected(choice)]),
      );
      const result = await coordinator.route(snapshot());
      assert.equal(result.kind, "lead-review");
      const operation = g.store.operation(projectId, taskId, 7);
      assert.equal(operation?.attemptsUsed, 1);
      assert.ok(operation);
      assert.equal(g.store.attempts(operation.operationId).length, 1);
    } finally {
      g.close();
    }
  }
});

test("only an explicit transient failure retries within the two-attempt budget", async () => {
  const f = fixture();
  try {
    const sleeps: number[] = [];
    const client = new FakeClient([
      new RoutingFailure("server overloaded", "transient"),
      selected(profileB),
    ]);
    const coordinator = new RoutingCoordinator(f.store, client, {
      retryBaseMs: 25,
      retryMaxMs: 100,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    const result = await coordinator.route(snapshot());
    assert.equal(result.kind, "assigned");
    if (result.kind === "assigned") assert.equal(result.profileId, profileB);
    assert.equal(client.requests.length, 2);
    assert.deepEqual(sleeps, [25]);
    const record = f.store.operation(projectId, taskId, 7);
    assert.equal(record?.attemptsUsed, 2);
    assert.ok(record);
    assert.deepEqual(
      f.store.attempts(record.operationId).map((item) => item.attempt),
      [1, 2],
    );
    assert.equal(
      f.store.attempts(record.operationId)[0]?.failureClass,
      "transient",
    );
  } finally {
    f.close();
  }

  const g = fixture();
  try {
    const client = new FakeClient([
      new RoutingFailure("invalid request", "permanent"),
      selected(profileA),
    ]);
    const coordinator = new RoutingCoordinator(g.store, client);
    const result = await coordinator.route(snapshot());
    assert.equal(result.kind, "lead-review");
    assert.equal(client.requests.length, 1);
    assert.equal(g.store.operation(projectId, taskId, 7)?.attemptsUsed, 1);
  } finally {
    g.close();
  }
});

test("empty context and candidate sets fall back without inference", async () => {
  const f = fixture();
  try {
    const client = new FakeClient([]);
    const coordinator = new RoutingCoordinator(f.store, client);
    const noCandidates = await coordinator.route(snapshot({ candidates: [] }));
    assert.equal(noCandidates.kind, "lead-review");
    assert.equal(client.requests.length, 0);
    const missingBrief = await coordinator.route(
      snapshot({
        taskVersion: 8,
        brief: "  ",
      }),
    );
    assert.equal(missingBrief.kind, "lead-review");
    assert.equal(client.requests.length, 0);
  } finally {
    f.close();
  }
});

test("a persisted in-flight first attempt resumes within the remaining budget", async () => {
  const f = fixture();
  try {
    const input = snapshot();
    const operation = f.store.ensureOperation(input);
    const prior = f.store.startAttempt(operation.operationId);
    assert.equal(prior.attempt, 1);
    const client = new FakeClient([selected(profileA)]);
    const coordinator = new RoutingCoordinator(f.store, client);
    const result = await coordinator.route(input);
    assert.equal(result.kind, "assigned");
    assert.equal(client.requests.length, 1);
    const attempts = f.store.attempts(operation.operationId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(attempts[0]?.failureClass, "transient");
    assert.equal(attempts[1]?.status, "succeeded");
  } finally {
    f.close();
  }
});

test("an interrupted second attempt exhausts the persisted budget without a third call", async () => {
  const f = fixture();
  try {
    const operation = f.store.ensureOperation(snapshot());
    const first = f.store.startAttempt(operation.operationId);
    f.store.failAttempt(
      operation.operationId,
      first.attempt,
      "transient",
      "connection-failure",
    );
    const second = f.store.startAttempt(operation.operationId);
    assert.equal(second.attempt, 2);

    const client = new FakeClient([]);
    const coordinator = new RoutingCoordinator(f.store, client);
    const result = await coordinator.route(snapshot());
    assert.equal(result.kind, "lead-review");
    if (result.kind === "lead-review")
      assert.equal(result.reason, "transient-exhausted");
    assert.equal(client.requests.length, 0);
    assert.deepEqual(
      f.store.attempts(operation.operationId).map((attempt) => attempt.status),
      ["failed", "failed"],
    );
    assert.equal(f.store.operation(projectId, taskId, 7)?.currentAttempt, null);
  } finally {
    f.close();
  }
});

test("concurrent coordinators sharing a store make one inference request", async () => {
  const f = fixture();
  try {
    let release!: (response: RoutingChoiceResponse) => void;
    const client = new FakeClient([
      () =>
        new Promise<RoutingChoiceResponse>((resolve) => {
          release = resolve;
        }),
    ]);
    const firstCoordinator = new RoutingCoordinator(f.store, client);
    const secondCoordinator = new RoutingCoordinator(f.store, client);
    const first = firstCoordinator.route(snapshot());
    const second = secondCoordinator.route(snapshot());
    assert.equal(client.requests.length, 1);
    release(selected(profileB));
    assert.deepEqual(await first, await second);
    assert.equal(client.requests.length, 1);
  } finally {
    f.close();
  }
});

test("late responses from an abandoned attempt cannot replace the active result", async () => {
  const f = fixture();
  try {
    let releaseFirst!: (response: RoutingChoiceResponse) => void;
    const client = new FakeClient([
      () =>
        new Promise<RoutingChoiceResponse>((resolve) => {
          releaseFirst = resolve;
        }),
      selected(profileB),
    ]);
    const coordinator = new RoutingCoordinator(f.store, client, {
      timeoutMs: 5,
      retryBaseMs: 0,
    });
    const result = await coordinator.route(snapshot());
    assert.equal(result.kind, "assigned");
    if (result.kind === "assigned") assert.equal(result.profileId, profileB);
    releaseFirst(selected(profileA));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const operation = f.store.operation(projectId, taskId, 7);
    assert.equal(operation?.status, "assigned");
    assert.equal(operation?.outcome?.kind, "assigned");
    if (operation?.outcome?.kind === "assigned")
      assert.equal(operation.outcome.profileId, profileB);
  } finally {
    f.close();
  }
});

test("completed operations replay and changed captured context conflicts", async () => {
  const f = fixture();
  try {
    const client = new FakeClient([selected(profileA)]);
    const coordinator = new RoutingCoordinator(f.store, client);
    const first = await coordinator.route(snapshot());
    const replay = await coordinator.route(snapshot());
    assert.deepEqual(replay, first);
    assert.equal(client.requests.length, 1);
    await assert.rejects(
      coordinator.route(snapshot({ brief: "Changed brief." })),
      /conflict/,
    );
  } finally {
    f.close();
  }
});

test("stale disposition preserves the routing inference result without authorizing it", async () => {
  const f = fixture();
  try {
    const client = new FakeClient([selected(profileA)]);
    const coordinator = new RoutingCoordinator(f.store, client);
    const inferred = await coordinator.route(snapshot());
    assert.equal(inferred.kind, "assigned");

    const operation = f.store.operation(projectId, taskId, 7);
    assert.ok(operation);
    const stale = f.store.markStale(
      operation.operationId,
      "task-revision-changed",
    );

    assert.equal(stale.status, "stale");
    assert.equal(stale.staleReason, "task-revision-changed");
    assert.deepEqual(stale.outcome, inferred);
    await assert.rejects(coordinator.route(snapshot()), /stale/i);
    assert.equal(client.requests.length, 1);
  } finally {
    f.close();
  }
});

test("staling an in-flight route settles its attempt and rejects a late answer", async () => {
  const f = fixture();
  let release: ((response: RoutingChoiceResponse) => void) | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const client = new FakeClient([
      () =>
        new Promise<RoutingChoiceResponse>((resolve) => {
          release = resolve;
        }),
    ]);
    const coordinator = new RoutingCoordinator(f.store, client, {
      timeoutMs: 1000,
    });
    pending = coordinator.route(snapshot());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const operation = f.store.operation(projectId, taskId, 7);
    assert.ok(operation);

    const stale = f.store.markStale(
      operation.operationId,
      "candidate-set-changed",
    );
    assert.equal(stale.status, "stale");
    assert.equal(stale.outcome, null);
    assert.equal(stale.currentAttempt, null);
    assert.equal(f.store.attempts(operation.operationId)[0]?.status, "failed");
    assert.equal(
      f.store.attempts(operation.operationId)[0]?.failureCode,
      "stale-context",
    );

    release?.(selected(profileA));
    await assert.rejects(pending, /stale/i);
    assert.equal(f.store.operation(projectId, taskId, 7)?.status, "stale");
  } finally {
    release?.(selected(profileA));
    await pending?.catch(() => {});
    f.close();
  }
});

test("production adapter pins the model and disables SDK retries", async () => {
  const { TypeSafeRoutingChoiceClient } = await import(
    "../src/standalone/routing.js"
  );
  let request: unknown;
  let options: unknown;
  const fakeSdk = {
    systemOne(value: unknown, settings: unknown) {
      request = value;
      options = settings;
      return Promise.resolve({
        model: "jev-1.13.0",
        answers: {
          profile: {
            type: "choice",
            choice: profileA,
            confidence: 0.87,
            probabilities: {
              [profileA]: 0.87,
              [profileB]: 0.08,
              lead_review: 0.05,
            },
          },
        },
        usage: { input_tokens: 121, output_tokens: 23 },
      });
    },
  };
  const adapter = new TypeSafeRoutingChoiceClient("test-api-key", {
    createClient: () => fakeSdk as never,
  });
  const result = await adapter.choose(
    {
      requestedModel: "jev-1.13.0",
      state: {
        brief: "Ship a stable parser.",
        findings: "Existing parsing uses strict schema checks.",
        guidance: "Prefer Kotlin and API maintenance experience.",
        candidates: snapshot().candidates,
      },
      choices: [profileA, profileB, "lead_review"],
    },
    new AbortController().signal,
  );
  assert.equal(result.model, "jev-1.13.0");
  const serialized = JSON.stringify({ request, options });
  assert.match(serialized, /jev-1\.13\.0/);
  assert.match(serialized, /"maxRetries":0/);
  assert.doesNotMatch(serialized, /test-api-key/);
});

test("production adapter classifies retryable SDK responses without SDK retries", async () => {
  for (const [status, classification] of [
    [503, "transient"],
    [401, "permanent"],
  ] as const) {
    const adapter = new (
      await import("../src/standalone/routing.js")
    ).TypeSafeRoutingChoiceClient("test-api-key", {
      createClient: () =>
        ({
          systemOne: async () => {
            throw new APIError(status, {}, new Headers());
          },
        }) as never,
    });
    await assert.rejects(
      adapter.choose(
        {
          requestedModel: "jev-1.13.0",
          state: {
            brief: "Ship a stable parser.",
            findings: "Existing parsing uses strict schema checks.",
            guidance: "Prefer Kotlin and API maintenance experience.",
            candidates: snapshot().candidates,
          },
          choices: [profileA, profileB, "lead_review"],
        },
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof RoutingFailure &&
        error.classification === classification,
    );
  }
});
