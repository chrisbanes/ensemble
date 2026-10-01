import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type RoutingChoiceClient,
  RoutingFailure,
} from "../../src/standalone/routing.js";

const maximumAllowedCalls = 4;

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
      ceiling > maximumAllowedCalls
    )
      throw new Error("Live provider-call ceiling must be between 1 and 4");

    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS s05_live_call_budget (id INTEGER PRIMARY KEY CHECK (id = 1), ceiling INTEGER NOT NULL CHECK (ceiling BETWEEN 1 AND 4), reserved INTEGER NOT NULL CHECK (reserved BETWEEN 0 AND ceiling));",
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
