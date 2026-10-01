import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  type RoutingChoiceClient,
  RoutingFailure,
} from "../../src/standalone/routing.js";

export const MAX_LIVE_CALLS = 20;

const legacyMaximumAllowedCalls = 4;

/** Disposable live-harness ledger; reservations persist even when a call fails. */
export class SqliteLiveCallBudget {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    readonly ceiling: number,
  ) {
    if (!isAbsolute(path)) throw new Error("Call-budget path must be absolute");
    if (
      !Number.isSafeInteger(ceiling) ||
      ceiling < 1 ||
      ceiling > MAX_LIVE_CALLS
    )
      throw new Error(
        `Live provider-call ceiling must be between 1 and ${MAX_LIVE_CALLS}`,
      );
    if (ceiling > legacyMaximumAllowedCalls && !existsSync(path))
      throw new Error("New call-budget ledger must be expanded explicitly");

    this.db = new DatabaseSync(path);
    try {
      if (ceiling > legacyMaximumAllowedCalls) {
        const existing = this.row();
        if (existing.ceiling !== ceiling)
          throw new Error("Live provider-call ceiling cannot be changed");
      }
      this.db.exec(
        `PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS s05_live_call_budget (id INTEGER PRIMARY KEY CHECK (id = 1), ceiling INTEGER NOT NULL CHECK (ceiling BETWEEN 1 AND ${MAX_LIVE_CALLS}), reserved INTEGER NOT NULL CHECK (reserved BETWEEN 0 AND ceiling));`,
      );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO s05_live_call_budget (id, ceiling, reserved) VALUES (1, ?, 0)",
        )
        .run(ceiling);
      const existing = this.row();
      if (existing.ceiling !== ceiling)
        throw new Error("Live provider-call ceiling cannot be changed");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  reserve(): number {
    let reserved: number | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.row();
      if (current.reserved < current.ceiling) {
        const next = current.reserved + 1;
        const updated = this.db
          .prepare(
            "UPDATE s05_live_call_budget SET reserved = ? WHERE id = 1 AND reserved = ? AND reserved < ceiling",
          )
          .run(next, current.reserved);
        if (updated.changes !== 1)
          throw new Error("Live provider-call reservation was not unique");
        reserved = next;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the reservation failure.
      }
      throw error;
    }
    if (reserved === undefined)
      throw new RoutingFailure(
        "Live provider-call budget exhausted",
        "permanent",
        "live-call-budget-exhausted",
      );
    return reserved;
  }

  reservedCalls(): number {
    return this.row().reserved;
  }

  close(): void {
    this.db.close();
  }

  private row(): { ceiling: number; reserved: number } {
    const row = this.db
      .prepare(
        "SELECT ceiling, reserved FROM s05_live_call_budget WHERE id = 1",
      )
      .get() as { ceiling: number; reserved: number } | undefined;
    if (!row) throw new Error("Live provider-call ledger is unavailable");
    return row;
  }
}

/** Explicitly raise an existing controller-owned ledger after an exact readback. */
export function increaseLiveCallBudget(
  path: string,
  expectedCeiling: number,
  expectedReserved: number,
  newCeiling: number,
): void {
  if (!isAbsolute(path)) throw new Error("Call-budget path must be absolute");
  if (
    !Number.isSafeInteger(expectedCeiling) ||
    expectedCeiling < 1 ||
    expectedCeiling > MAX_LIVE_CALLS
  )
    throw new Error("Expected call-budget ceiling is invalid");
  if (
    !Number.isSafeInteger(expectedReserved) ||
    expectedReserved < 0 ||
    expectedReserved > expectedCeiling
  )
    throw new Error("Expected call-budget reservation count is invalid");
  if (
    !Number.isSafeInteger(newCeiling) ||
    newCeiling <= expectedCeiling ||
    newCeiling > MAX_LIVE_CALLS
  )
    throw new Error(
      `New call-budget ceiling must exceed the current ceiling and not exceed ${MAX_LIVE_CALLS}`,
    );
  if (!existsSync(path))
    throw new Error("Existing call-budget ledger is required");

  const database = new DatabaseSync(path);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;

    const schema = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 's05_live_call_budget'",
      )
      .get() as { sql: string | null } | undefined;
    const maximum = schemaMaximum(schema?.sql);
    const rows = database
      .prepare(
        "SELECT id, ceiling, reserved FROM s05_live_call_budget ORDER BY id",
      )
      .all() as { id: number; ceiling: number; reserved: number }[];
    const current = rows[0];
    if (
      rows.length !== 1 ||
      current?.id !== 1 ||
      current.ceiling !== expectedCeiling ||
      current.reserved !== expectedReserved
    )
      throw new Error("Call-budget snapshot changed or is unsupported");

    const unexpectedObjects = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE tbl_name = 's05_live_call_budget' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all();
    if (unexpectedObjects.length > 0)
      throw new Error("Call-budget schema is unsupported");

    if (newCeiling > maximum) {
      if (maximum !== legacyMaximumAllowedCalls)
        throw new Error("Call-budget schema cannot be expanded safely");
      const schemaDependency = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type IN ('view', 'trigger') LIMIT 1",
        )
        .get();
      if (schemaDependency)
        throw new Error(
          "Call-budget ledger with views or triggers cannot be expanded",
        );
      if (hasExternalForeignKeyReference(database))
        throw new Error("Call-budget table is referenced by another table");
      database.exec(
        "ALTER TABLE s05_live_call_budget RENAME TO s05_live_call_budget_legacy",
      );
      database.exec(
        `CREATE TABLE s05_live_call_budget_expansion (id INTEGER PRIMARY KEY CHECK (id = 1), ceiling INTEGER NOT NULL CHECK (ceiling BETWEEN 1 AND ${MAX_LIVE_CALLS}), reserved INTEGER NOT NULL CHECK (reserved BETWEEN 0 AND ceiling))`,
      );
      database
        .prepare(
          "INSERT INTO s05_live_call_budget_expansion (id, ceiling, reserved) SELECT id, ?, reserved FROM s05_live_call_budget_legacy",
        )
        .run(newCeiling);
      database.exec("DROP TABLE s05_live_call_budget_legacy");
      database.exec(
        "ALTER TABLE s05_live_call_budget_expansion RENAME TO s05_live_call_budget",
      );
    } else {
      const updated = database
        .prepare(
          "UPDATE s05_live_call_budget SET ceiling = ? WHERE id = 1 AND ceiling = ? AND reserved = ?",
        )
        .run(newCeiling, expectedCeiling, expectedReserved);
      if (updated.changes !== 1)
        throw new Error("Call-budget snapshot changed during expansion");
    }

    database.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original validation or migration failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function schemaMaximum(sql: string | null | undefined): number {
  if (typeof sql !== "string")
    throw new Error("Call-budget schema is unavailable");
  const normalized = sql.replace(/\s+/g, " ").trim();
  for (const maximum of [legacyMaximumAllowedCalls, MAX_LIVE_CALLS]) {
    const columns = `(id INTEGER PRIMARY KEY CHECK (id = 1), ceiling INTEGER NOT NULL CHECK (ceiling BETWEEN 1 AND ${maximum}), reserved INTEGER NOT NULL CHECK (reserved BETWEEN 0 AND ceiling))`;
    const expected = `CREATE TABLE s05_live_call_budget ${columns}`;
    const renamed = `CREATE TABLE "s05_live_call_budget" ${columns}`;
    if (normalized === expected || normalized === renamed) return maximum;
  }
  throw new Error("Call-budget schema is unsupported");
}

function hasExternalForeignKeyReference(database: DatabaseSync): boolean {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 's05_live_call_budget'",
    )
    .all() as { name: string }[];
  return tables.some(({ name }) => {
    const quoted = name.replaceAll('"', '""');
    const references = database
      .prepare(`PRAGMA foreign_key_list("${quoted}")`)
      .all() as { table: string }[];
    return references.some(
      (reference) => reference.table.toLowerCase() === "s05_live_call_budget",
    );
  });
}

/** Claim the durable cap before crossing the production provider boundary. */
export function withLiveCallBudget(
  client: RoutingChoiceClient,
  budget: SqliteLiveCallBudget,
): RoutingChoiceClient {
  return {
    async choose(request, signal) {
      budget.reserve();
      return client.choose(request, signal);
    },
  };
}
