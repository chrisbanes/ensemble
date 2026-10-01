import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  RoutingChoiceClient,
  RoutingChoiceRequest,
  RoutingChoiceResponse,
} from "../src/standalone/routing.js";
import {
  SqliteLiveCallBudget,
  withLiveCallBudget,
} from "./s05/live-call-budget.js";
import { tmpdir } from "./temp.js";

const request: RoutingChoiceRequest = {
  requestedModel: "jev-1.13.0",
  state: { brief: "fixture", findings: "", guidance: "", candidates: [] },
  choices: ["lead_review"],
};

const response: RoutingChoiceResponse = {
  choice: "lead_review",
  model: "jev-1.13.0",
  confidence: 0.99,
  probabilities: { lead_review: 1 },
  usage: { inputTokens: 1, outputTokens: 1 },
};

test("live call budget is durable and reserves before invoking the client", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-"));
  const path = join(root, "ledger.sqlite");
  let budget = new SqliteLiveCallBudget(path, 4);
  let calls = 0;
  const provider: RoutingChoiceClient = {
    async choose() {
      calls++;
      assert.equal(budget.reservedCalls(), calls);
      return response;
    },
  };
  try {
    const bounded = withLiveCallBudget(provider, budget);
    await bounded.choose(request, new AbortController().signal);
    budget.close();
    budget = new SqliteLiveCallBudget(path, 4);
    await withLiveCallBudget(provider, budget).choose(
      request,
      new AbortController().signal,
    );
    assert.equal(budget.reservedCalls(), 2);
    assert.equal(calls, 2);
  } finally {
    budget.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed provider calls consume budget and a fifth call never reaches it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-"));
  const path = join(root, "ledger.sqlite");
  const budget = new SqliteLiveCallBudget(path, 4);
  let calls = 0;
  const provider: RoutingChoiceClient = {
    async choose() {
      calls++;
      if (calls === 1) throw new Error("provider fixture failure");
      return response;
    },
  };
  const bounded = withLiveCallBudget(provider, budget);
  try {
    await assert.rejects(bounded.choose(request, new AbortController().signal));
    for (let index = 1; index < 4; index++)
      await bounded.choose(request, new AbortController().signal);
    await assert.rejects(bounded.choose(request, new AbortController().signal));
    assert.equal(budget.reservedCalls(), 4);
    assert.equal(calls, 4);
  } finally {
    budget.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("competing wrappers cannot reserve more than the configured ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-"));
  const path = join(root, "ledger.sqlite");
  const first = new SqliteLiveCallBudget(path, 4);
  const second = new SqliteLiveCallBudget(path, 4);
  let calls = 0;
  const provider: RoutingChoiceClient = {
    async choose() {
      calls++;
      return response;
    },
  };
  try {
    const wrappers = [
      withLiveCallBudget(provider, first),
      withLiveCallBudget(provider, second),
    ];
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        wrappers[index % wrappers.length]?.choose(
          request,
          new AbortController().signal,
        ),
      ),
    );
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      4,
    );
    assert.equal(
      results.filter((item) => item.status === "rejected").length,
      2,
    );
    assert.equal(first.reservedCalls(), 4);
    assert.equal(calls, 4);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});
