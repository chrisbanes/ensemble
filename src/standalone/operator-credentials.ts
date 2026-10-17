import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { type Database, transaction } from "../core/store.js";
import {
  OPERATOR_CREDENTIAL_TOKEN_PATTERN as TOKEN_PATTERN,
  operatorCredentialIssueRequestSchema,
  type OperatorCredential,
} from "../operator/contracts.js";

export type OperatorCredentialScope = OperatorCredential["scope"];
export type VerifiedOperatorCredential = Pick<
  OperatorCredential,
  "id" | "name" | "scope" | "createdAt" | "expiresAt"
>;

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_USED_INTERVAL_MS = 60_000;

const rowSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    scope: z.enum(["read", "read-write"]),
    verifier: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    lastUsedAt: z.number().int().nullable(),
    revokedAt: z.number().int().nullable(),
    replacesId: z.uuid().nullable(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function metadata(row: Row, now: number): OperatorCredential {
  const { verifier: _verifier, ...rest } = row;
  return {
    ...rest,
    state:
      row.revokedAt !== null
        ? "revoked"
        : row.expiresAt <= now
          ? "expired"
          : "active",
  };
}

export class OperatorCredentialError extends Error {
  constructor(readonly code: "not-found" | "conflict") {
    super(code);
  }
}

/** Operator CLI credentials; persists only a SHA-256 verifier of each token secret. */
export class OperatorCredentialStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_cli_credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('read','read-write')),
        verifier TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        lastUsedAt INTEGER,
        revokedAt INTEGER,
        replacesId TEXT
      );
      CREATE TABLE IF NOT EXISTS service_installation (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        installationId TEXT NOT NULL
      );
      INSERT OR IGNORE INTO service_installation(singleton, installationId)
        VALUES (1, '${randomUUID()}');
    `);
  }

  installationId(): string {
    const row = this.db
      .prepare("SELECT installationId FROM service_installation")
      .get();
    return z.object({ installationId: z.uuid() }).parse(row).installationId;
  }

  issue(input: unknown, now = Date.now()) {
    const request = operatorCredentialIssueRequestSchema.parse(input);
    return this.insert(
      request.name,
      request.scope,
      request.expiresInDays ?? 90,
      null,
      now,
    );
  }

  list(now = Date.now()): OperatorCredential[] {
    return this.db
      .prepare("SELECT * FROM operator_cli_credentials ORDER BY createdAt, id")
      .all()
      .map((row) => metadata(rowSchema.parse({ ...(row as object) }), now));
  }

  /** Issues a replacement with the same name and scope; the old credential stays active. */
  rotate(id: string, expiresInDays = 90, now = Date.now()) {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) throw new OperatorCredentialError("not-found");
      if (metadata(row, now).state !== "active")
        throw new OperatorCredentialError("conflict");
      return this.insert(row.name, row.scope, expiresInDays, row.id, now);
    });
  }

  /** Irreversible: recovery is to issue or rotate a replacement. */
  revoke(id: string, now = Date.now()): OperatorCredential {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) throw new OperatorCredentialError("not-found");
      if (row.revokedAt === null)
        this.db
          .prepare(
            "UPDATE operator_cli_credentials SET revokedAt = ? WHERE id = ?",
          )
          .run(now, id);
      return metadata(this.row(id) as Row, now);
    });
  }

  /** Uniformly returns undefined for malformed, unknown, wrong, expired or revoked tokens. */
  verify(
    token: string,
    now = Date.now(),
  ): VerifiedOperatorCredential | undefined {
    const match = TOKEN_PATTERN.exec(token);
    const row = match ? this.row(match[1] ?? "") : undefined;
    const expected = Buffer.from(row?.verifier ?? "0".repeat(64), "hex");
    const valid =
      timingSafeEqual(digest(match?.[2] ?? ""), expected) &&
      row !== undefined &&
      metadata(row, now).state === "active";
    if (!valid || !row) return undefined;
    if (
      row.lastUsedAt === null ||
      now - row.lastUsedAt >= LAST_USED_INTERVAL_MS
    )
      this.db
        .prepare(
          "UPDATE operator_cli_credentials SET lastUsedAt = ? WHERE id = ?",
        )
        .run(now, row.id);
    const { id, name, scope, createdAt, expiresAt } = row;
    return { id, name, scope, createdAt, expiresAt };
  }

  private row(id: string): Row | undefined {
    const row = this.db
      .prepare("SELECT * FROM operator_cli_credentials WHERE id = ?")
      .get(id);
    return row ? rowSchema.parse({ ...row }) : undefined;
  }

  private insert(
    name: string,
    scope: OperatorCredentialScope,
    expiresInDays: number,
    replacesId: string | null,
    now: number,
  ) {
    z.number().int().min(1).max(90).parse(expiresInDays);
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO operator_cli_credentials (id, name, scope, verifier, createdAt, expiresAt, lastUsedAt, revokedAt, replacesId) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
      )
      .run(
        id,
        name,
        scope,
        digest(secret).toString("hex"),
        now,
        now + expiresInDays * DAY_MS,
        replacesId,
      );
    return {
      credential: metadata(this.row(id) as Row, now),
      token: `ens_${id}_${secret}`,
    };
  }
}

export type OperatorRouteAuthority = "read" | "write" | "session-only";

/** Server-side authority of each operator JSON API route; undefined fails closed. */
export function operatorRouteAuthority(
  method: string | undefined,
  path: string,
): OperatorRouteAuthority | undefined {
  const sessionOnly =
    [
      "/api/operator/session",
      "/api/operator/login",
      "/api/operator/logout",
      "/api/operator/setup/folders",
      "/api/operator/setup/verify-checkout",
      "/api/operator/setup/home",
      "/api/operator/credentials",
    ].includes(path) ||
    /^\/api\/operator\/credentials\/[^/]+\/(?:rotate|revoke)$/.test(path) ||
    /^\/api\/operator\/tasks\/[^/]+\/(?:review-draft|local-reviews(?:\/[^/]+)?)$/.test(
      path,
    ) ||
    /^\/api\/operator\/(?:projects|profiles)\/[^/]+\/private-values$/.test(
      path,
    );
  if (sessionOnly) return "session-only";
  // Browser push controls: the operator's own browser session, never a CLI credential.
  if (method === "GET" && path === "/api/operator/notifications")
    return "session-only";
  if (
    method === "POST" &&
    /^\/api\/operator\/notifications\/subscriptions(?:\/[^/]+\/(?:revoke|test))?$/.test(
      path,
    )
  )
    return "session-only";
  if (method === "POST")
    return path === "/api/operator/commands" ||
      path === "/api/operator/source-refresh"
      ? "write"
      : undefined;
  if (method !== "GET") return undefined;
  // Comparison reads compute and persist snapshots.
  if (/^\/api\/operator\/tasks\/[^/]+\/comparisons$/.test(path)) return "write";
  return path === "/api/operator/cli" ||
    [
      "/api/operator/runtime",
      "/api/operator/workspace",
      "/api/operator/task-list",
      "/api/operator/inbox",
      "/api/operator/search",
      "/api/operator/source-observations",
      "/api/operator/discovery",
      "/api/operator/claude-token",
      "/api/operator/readiness",
      "/api/operator/readiness/claude-token",
      "/api/operator/discovery/repositories",
      "/api/operator/discovery/branches",
      "/api/operator/discovery/projects",
      "/api/operator/discovery/project-fields",
      "/api/operator/operations",
      "/api/operator/executions",
    ].includes(path) ||
    /^\/api\/operator\/executions\/[^/]+(?:\/(?:inputs|events))?$/.test(path) ||
    /^\/api\/operator\/(?:projects|profiles)\/[^/]+\/configuration$/.test(
      path,
    ) ||
    /^\/api\/operator\/(?:projects|tasks)\/[^/]+$/.test(path) ||
    /^\/api\/operator\/tasks\/[^/]+\/(?:review|files|preview|results|messages|artifacts\/[^/]+)$/.test(
      path,
    ) ||
    /^\/api\/operator\/tasks\/[^/]+\/results\/[^/]+\/evidence(?:\/[^/]+)?$/.test(
      path,
    ) ||
    /^\/api\/operator\/tasks\/[^/]+\/(?:review-anchors|questions)\/[^/]+$/.test(
      path,
    ) ||
    /^\/api\/operator\/projects\/[^/]+\/composer-options$/.test(path) ||
    /^\/api\/operator\/assignments\/[^/]+(?:\/(?:history|recovery|recovery-options|instructions))?$/.test(
      path,
    ) ||
    /^\/api\/operator\/(?:projects|profiles)\/[^/]+\/(?:instructions|impact)$/.test(
      path,
    )
    ? "read"
    : undefined;
}

/** Marks runtime children as managed assignments and drops operator CLI selection. */
export function managedAssignmentEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env))
    if (key !== "ENSEMBLE_CONNECTION" && !key.startsWith("ENSEMBLE_CLI_"))
      result[key] = value;
  result.ENSEMBLE_MANAGED_ASSIGNMENT = "1";
  return result;
}
