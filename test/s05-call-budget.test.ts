import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type {
  RoutingChoiceClient,
  RoutingChoiceRequest,
  RoutingChoiceResponse,
} from "../src/standalone/routing.js";
import {
  SqliteLiveCallBudget,
  increaseLiveCallBudget,
  withLiveCallBudget,
} from "./s05/live-call-budget.js";
import { tmpdir } from "./temp.js";

function createLegacyBudget(path: string, reserved: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE s05_live_call_budget (id INTEGER PRIMARY KEY CHECK (id = 1), ceiling INTEGER NOT NULL CHECK (ceiling BETWEEN 1 AND 4), reserved INTEGER NOT NULL CHECK (reserved BETWEEN 0 AND ceiling));",
    );
    database
      .prepare(
        "INSERT INTO s05_live_call_budget (id, ceiling, reserved) VALUES (1, 4, ?)",
      )
      .run(reserved);
  } finally {
    database.close();
  }
}

function insertUnrelatedTable(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "CREATE TABLE unrelated_controller_data (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO unrelated_controller_data (name, value) VALUES (?, ?)",
      )
      .run("preserve-me", "unrelated ledger content");
  } finally {
    database.close();
  }
}

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

test("controller can explicitly expand a legacy fully reserved budget and reopen it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-expand-"));
  const path = join(root, "ledger.sqlite");
  createLegacyBudget(path, 4);
  insertUnrelatedTable(path);
  let budget: SqliteLiveCallBudget | undefined;
  let calls = 0;
  const failingProvider: RoutingChoiceClient = {
    async choose() {
      calls++;
      assert.equal(budget?.reservedCalls(), 5);
      throw new Error("provider fixture failure");
    },
  };
  try {
    increaseLiveCallBudget(path, 4, 4, 10);
    budget = new SqliteLiveCallBudget(path, 10);
    assert.equal(budget.reservedCalls(), 4);
    budget.close();
    budget = undefined;

    increaseLiveCallBudget(path, 10, 4, 20);
    budget = new SqliteLiveCallBudget(path, 20);
    assert.equal(budget.reservedCalls(), 4);
    await assert.rejects(
      withLiveCallBudget(failingProvider, budget).choose(
        request,
        new AbortController().signal,
      ),
      /provider fixture failure/,
    );
    assert.equal(budget.reservedCalls(), 5);
    while (budget.reservedCalls() < 20) budget.reserve();
    assert.throws(
      () => budget?.reserve(),
      /Live provider-call budget exhausted/,
    );
    assert.equal(calls, 1);
    budget.close();
    budget = undefined;

    const database = new DatabaseSync(path);
    try {
      assert.deepEqual(
        Object.assign(
          {},
          database
            .prepare(
              "SELECT name, value FROM unrelated_controller_data WHERE name = ?",
            )
            .get("preserve-me"),
        ),
        { name: "preserve-me", value: "unrelated ledger content" },
      );
    } finally {
      database.close();
    }

    budget = new SqliteLiveCallBudget(path, 20);
    assert.equal(budget.reservedCalls(), 20);
  } finally {
    budget?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary budget construction cannot change an existing ceiling", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-fixed-"));
  const path = join(root, "ledger.sqlite");
  let budget: SqliteLiveCallBudget | undefined;
  try {
    budget = new SqliteLiveCallBudget(path, 4);
    budget.reserve();
    budget.close();
    budget = undefined;

    assert.throws(
      () => new SqliteLiveCallBudget(path, 20),
      /Live provider-call ceiling cannot be changed/,
    );
    budget = new SqliteLiveCallBudget(path, 4);
    assert.equal(budget.reservedCalls(), 1);
  } finally {
    budget?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new twenty-call ledger must pass through explicit controller expansion", () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-s05-call-budget-explicit-create-"),
  );
  const path = join(root, "ledger.sqlite");
  try {
    assert.throws(
      () => new SqliteLiveCallBudget(path, 20),
      /must be expanded explicitly/,
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing SQLite file needs an exact expanded budget row", () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-s05-call-budget-existing-create-"),
  );
  const emptyPath = join(root, "empty.sqlite");
  const unrelatedPath = join(root, "unrelated.sqlite");
  for (const path of [emptyPath, unrelatedPath]) {
    const database = new DatabaseSync(path);
    database.close();
  }
  const unrelated = new DatabaseSync(unrelatedPath);
  try {
    unrelated.exec(
      "CREATE TABLE unrelated_controller_data (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    unrelated
      .prepare(
        "INSERT INTO unrelated_controller_data (name, value) VALUES (?, ?)",
      )
      .run("preserve-me", "unrelated ledger content");
  } finally {
    unrelated.close();
  }

  let unexpected: SqliteLiveCallBudget | undefined;
  try {
    assert.throws(() => {
      unexpected = new SqliteLiveCallBudget(emptyPath, 20);
    });
    assert.throws(() => {
      unexpected = new SqliteLiveCallBudget(unrelatedPath, 20);
    });

    for (const path of [emptyPath, unrelatedPath]) {
      const database = new DatabaseSync(path);
      try {
        assert.equal(
          database
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 's05_live_call_budget'",
            )
            .get(),
          undefined,
        );
      } finally {
        database.close();
      }
    }
    const preserved = new DatabaseSync(unrelatedPath);
    try {
      assert.deepEqual(
        Object.assign(
          {},
          preserved
            .prepare(
              "SELECT name, value FROM unrelated_controller_data WHERE name = ?",
            )
            .get("preserve-me"),
        ),
        { name: "preserve-me", value: "unrelated ledger content" },
      );
    } finally {
      preserved.close();
    }
  } finally {
    unexpected?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget expansion refuses stale snapshots and invalid ceilings without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-guards-"));
  const path = join(root, "ledger.sqlite");
  const missingPath = join(root, "missing.sqlite");
  createLegacyBudget(path, 2);
  try {
    assert.throws(
      () => increaseLiveCallBudget(path, 3, 2, 20),
      /snapshot changed/,
    );
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 1, 20),
      /snapshot changed/,
    );
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 4),
      /must exceed the current ceiling/,
    );
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 21),
      /not exceed 20/,
    );
    assert.throws(
      () => increaseLiveCallBudget(path, 4.5, 2, 20),
      /Expected call-budget ceiling is invalid/,
    );
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2.5, 20),
      /Expected call-budget reservation count is invalid/,
    );
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 20.5),
      /not exceed 20/,
    );
    assert.throws(
      () => increaseLiveCallBudget(missingPath, 4, 0, 20),
      /Existing call-budget ledger is required/,
    );
    assert.equal(existsSync(missingPath), false);

    const database = new DatabaseSync(path);
    try {
      assert.deepEqual(
        database
          .prepare("SELECT id, ceiling, reserved FROM s05_live_call_budget")
          .all()
          .map((row) => ({ ...row })),
        [{ id: 1, ceiling: 4, reserved: 2 }],
      );
    } finally {
      database.close();
    }
    const unchanged = new SqliteLiveCallBudget(path, 4);
    try {
      assert.equal(unchanged.reservedCalls(), 2);
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget expansion rejects extra rows and preserves the original ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-rows-"));
  const path = join(root, "ledger.sqlite");
  createLegacyBudget(path, 2);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .prepare(
        "INSERT INTO s05_live_call_budget (id, ceiling, reserved) VALUES (2, 4, 0)",
      )
      .run();
  } finally {
    database.close();
  }
  try {
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 20),
      /snapshot changed or is unsupported/,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(
        unchanged
          .prepare(
            "SELECT id, ceiling, reserved FROM s05_live_call_budget ORDER BY id",
          )
          .all()
          .map((row) => ({ ...row })),
        [
          { id: 1, ceiling: 4, reserved: 2 },
          { id: 2, ceiling: 4, reserved: 0 },
        ],
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget expansion refuses a legacy ledger referenced by another table", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-fk-"));
  const path = join(root, "ledger.sqlite");
  createLegacyBudget(path, 2);
  const database = new DatabaseSync(path);
  try {
    database.exec(
      'CREATE TABLE "unrelated""reference" (budget_id INTEGER REFERENCES S05_LIVE_CALL_BUDGET(id))',
    );
  } finally {
    database.close();
  }

  try {
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 20),
      /referenced by another table/,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(
        unchanged
          .prepare("SELECT id, ceiling, reserved FROM s05_live_call_budget")
          .all()
          .map((row) => ({ ...row })),
        [{ id: 1, ceiling: 4, reserved: 2 }],
      );
      unchanged
        .prepare('INSERT INTO "unrelated""reference" (budget_id) VALUES (1)')
        .run();
      assert.deepEqual(unchanged.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget expansion refuses ledgers containing views or triggers", () => {
  for (const dependency of ["view", "trigger"] as const) {
    const root = mkdtempSync(
      join(tmpdir(), `ensemble-s05-call-budget-${dependency}-`),
    );
    const path = join(root, "ledger.sqlite");
    createLegacyBudget(path, 2);
    insertUnrelatedTable(path);
    const database = new DatabaseSync(path);
    let originalSchema: unknown;
    try {
      originalSchema = Object.assign(
        {},
        database
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 's05_live_call_budget'",
          )
          .get(),
      );
      if (dependency === "view")
        database.exec(
          "CREATE VIEW unrelated_ledger_view AS SELECT value FROM unrelated_controller_data",
        );
      else
        database.exec(
          "CREATE TRIGGER unrelated_ledger_trigger AFTER UPDATE ON unrelated_controller_data BEGIN SELECT 1; END",
        );
    } finally {
      database.close();
    }

    try {
      assert.throws(
        () => increaseLiveCallBudget(path, 4, 2, 20),
        /views or triggers/,
      );
      const unchanged = new DatabaseSync(path);
      try {
        assert.deepEqual(
          Object.assign(
            {},
            unchanged
              .prepare(
                "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 's05_live_call_budget'",
              )
              .get(),
          ),
          originalSchema,
        );
        assert.deepEqual(
          unchanged
            .prepare("SELECT id, ceiling, reserved FROM s05_live_call_budget")
            .all()
            .map((row) => ({ ...row })),
          [{ id: 1, ceiling: 4, reserved: 2 }],
        );
        assert.deepEqual(
          Object.assign(
            {},
            unchanged
              .prepare(
                "SELECT name, value FROM unrelated_controller_data WHERE name = ?",
              )
              .get("preserve-me"),
          ),
          { name: "preserve-me", value: "unrelated ledger content" },
        );
      } finally {
        unchanged.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("budget expansion rejects an unexpected table shape without discarding it", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-s05-call-budget-shape-"));
  const path = join(root, "ledger.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "CREATE TABLE s05_live_call_budget (id INTEGER PRIMARY KEY CHECK (id = 1), ceiling INTEGER NOT NULL CHECK (ceiling BETWEEN 1 AND 4), reserved INTEGER NOT NULL CHECK (reserved BETWEEN 0 AND ceiling), note TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO s05_live_call_budget (id, ceiling, reserved, note) VALUES (1, 4, 2, ?)",
      )
      .run("keep unexpected shape intact");
  } finally {
    database.close();
  }
  try {
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 20),
      /Call-budget schema is unsupported/,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(
        Object.assign(
          {},
          unchanged
            .prepare(
              "SELECT id, ceiling, reserved, note FROM s05_live_call_budget",
            )
            .get(),
        ),
        {
          id: 1,
          ceiling: 4,
          reserved: 2,
          note: "keep unexpected shape intact",
        },
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed legacy rebuild rolls back and preserves unrelated tables", () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-s05-call-budget-rollback-"),
  );
  const path = join(root, "ledger.sqlite");
  createLegacyBudget(path, 2);
  insertUnrelatedTable(path);
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "CREATE TABLE s05_live_call_budget_expansion (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO s05_live_call_budget_expansion (id, marker) VALUES (?, ?)",
      )
      .run(1, "preserve-collision");
  } finally {
    database.close();
  }

  try {
    assert.throws(
      () => increaseLiveCallBudget(path, 4, 2, 20),
      /already exists/,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(
        unchanged
          .prepare("SELECT id, ceiling, reserved FROM s05_live_call_budget")
          .all()
          .map((row) => ({ ...row })),
        [{ id: 1, ceiling: 4, reserved: 2 }],
      );
      assert.deepEqual(
        Object.assign(
          {},
          unchanged
            .prepare("SELECT name, value FROM unrelated_controller_data")
            .get(),
        ),
        { name: "preserve-me", value: "unrelated ledger content" },
      );
      assert.deepEqual(
        Object.assign(
          {},
          unchanged
            .prepare("SELECT id, marker FROM s05_live_call_budget_expansion")
            .get(),
        ),
        { id: 1, marker: "preserve-collision" },
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
