import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import {
  STANDALONE_MARKER_CONTENTS,
  STANDALONE_MARKER_NAME,
  STANDALONE_OWNER_NAME,
  assertCanonicalDirectoryPath,
  StandaloneDataDirectory,
} from "./data-directory.js";
import { isWithin } from "./workspace-inspection.js";

const SNAPSHOT_FORMAT = "ensemble-sqlite-snapshot-v1";
const DATABASE_NAME = "standalone.sqlite";
const MANIFEST_NAME = "manifest.json";
const RESTORE_SENTINEL_NAME = ".ensemble-restore-incomplete";
const RESTORE_SENTINEL_CONTENTS = STANDALONE_MARKER_CONTENTS;
const MAX_SUPPORTED_SCHEMA_VERSION = 6;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

const snapshotManifestSchema = z
  .object({
    format: z.literal(SNAPSHOT_FORMAT),
    sourceMarker: z.literal(STANDALONE_MARKER_CONTENTS),
    nodeVersion: z.string().regex(/^v(?:2[4-9]|[3-9]\d|\d{3,})\.\d+\.\d+/),
    schemaVersion: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SUPPORTED_SCHEMA_VERSION),
    schemaFingerprint: z.string().regex(HEX_SHA256),
    databaseSize: z.number().int().nonnegative().safe(),
    databaseSha256: z.string().regex(HEX_SHA256),
    logicalContentSha256: z.string().regex(HEX_SHA256),
    createdAt: z.string().datetime(),
  })
  .strict();

export type SnapshotManifestV1 = z.infer<typeof snapshotManifestSchema>;

export type OperationsFaultStage =
  | "before-backup-completion"
  | "before-snapshot-commit"
  | "before-restored-database-verification"
  | "before-restore-commit";

/** Tests may fail only at durable-operation stage boundaries; the CLI never exposes this hook. */
export type OperationsOptions = {
  fault?: (stage: OperationsFaultStage) => void;
};

type DatabaseMetadata = {
  schemaVersion: number;
  schemaFingerprint: string;
  logicalContentSha256: string;
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function addHashField(
  hash: ReturnType<typeof createHash>,
  value: string | Uint8Array,
): void {
  const bytes =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function addSqlValue(
  hash: ReturnType<typeof createHash>,
  value: SQLOutputValue,
): void {
  if (value === null) {
    addHashField(hash, "null");
  } else if (typeof value === "bigint") {
    addHashField(hash, "integer");
    addHashField(hash, value.toString(10));
  } else if (typeof value === "number") {
    addHashField(hash, "real");
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    addHashField(hash, bytes);
  } else if (typeof value === "string") {
    addHashField(hash, "text");
    addHashField(hash, value);
  } else if (value instanceof Uint8Array) {
    addHashField(hash, "blob");
    addHashField(hash, value);
  } else {
    throw new Error("Database contains an unsupported SQLite value");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaFingerprint(db: DatabaseSync): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name`,
    )
    .all();
  return sha256(JSON.stringify(rows));
}

function logicalContentDigest(db: DatabaseSync): string {
  const hash = createHash("sha256");
  addHashField(hash, "ensemble.sqlite.logical-content.v1");
  const tables = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
  const tableList = db.prepare("PRAGMA table_list").all() as Array<{
    schema: string;
    name: string;
    wr: number;
  }>;

  for (const table of tables) {
    addHashField(hash, "table");
    addHashField(hash, table.name);
    addHashField(hash, table.sql ?? "");
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
      .all() as Array<{ name: string; pk: number; notnull: number }>;
    for (const column of columns) {
      addHashField(hash, "column");
      addHashField(hash, column.name);
    }

    const primaryKeys = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk);
    const aliases = new Set(columns.map((column) => column.name.toLowerCase()));
    const rowidAlias = ["rowid", "_rowid_", "oid"].find(
      (name) => !aliases.has(name),
    );
    const withoutRowid =
      tableList.find(
        (item) => item.schema === "main" && item.name === table.name,
      )?.wr === 1;

    if (primaryKeys.length === 0 && !rowidAlias)
      throw new Error("Database table has no deterministic row order");
    if (
      primaryKeys.length > 0 &&
      !withoutRowid &&
      !rowidAlias &&
      primaryKeys.some((column) => column.notnull === 0)
    )
      throw new Error("Database table has no deterministic row order");

    const order = primaryKeys.map((column) => quoteIdentifier(column.name));
    if (!withoutRowid && rowidAlias) order.push(quoteIdentifier(rowidAlias));
    if (primaryKeys.length === 0 && rowidAlias)
      order.unshift(quoteIdentifier(rowidAlias));
    const selectRowid = primaryKeys.length === 0 && Boolean(rowidAlias);
    const select = selectRowid
      ? `${quoteIdentifier(rowidAlias as string)}, *`
      : "*";
    const statement = db.prepare(
      `SELECT ${select} FROM ${quoteIdentifier(table.name)} ORDER BY ${order.join(", ")}`,
    );
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    for (const result of statement.iterate()) {
      const row = result as unknown as SQLOutputValue[];
      addHashField(hash, "row");
      for (const value of row) addSqlValue(hash, value);
    }
  }
  return hash.digest("hex");
}

function validateDatabase(db: DatabaseSync): DatabaseMetadata {
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<
    Record<string, string>
  >;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok")
    throw new Error("SQLite integrity check failed");

  const versionRow = db.prepare("PRAGMA user_version").get();
  const schemaVersion = versionRow?.user_version;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 0
  )
    throw new Error("Database schema version is invalid");
  if (schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION)
    throw new Error("Database schema is newer than supported");

  return {
    schemaVersion,
    schemaFingerprint: schemaFingerprint(db),
    logicalContentSha256: logicalContentDigest(db),
  };
}

function canonicalTargetPath(
  input: string,
  label: string,
  allowMissingLeaf = false,
): string {
  return assertCanonicalDirectoryPath(
    input,
    label,
    allowMissingLeaf ? "leaf" : "none",
  );
}

function assertDisjoint(left: string, right: string): void {
  if (isWithin(left, right) || isWithin(right, left))
    throw new Error("Operation paths must be separate");
}

function reserveDirectory(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  chmodSync(path, 0o700);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Reserved destination must be a real directory");
}

function requireRegularFile(path: string, label: string, mode?: number): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} must be a regular file`);
  if (mode !== undefined && (info.mode & 0o777) !== mode)
    throw new Error(`${label} has unexpected permissions`);
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function fileDigest(
  path: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

function openVerifiedDatabase(path: string): DatabaseSync {
  requireRegularFile(path, "Standalone database");
  if (lstatSync(path).size === 0)
    throw new Error("Standalone database is empty");
  return new DatabaseSync(path, { readOnly: true });
}

function finalizeSnapshotDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const result = db.prepare("PRAGMA journal_mode = DELETE").get();
    if (result?.journal_mode !== "delete")
      throw new Error("Snapshot database could not leave WAL mode");
  } finally {
    db.close();
  }
}

function createManifest(
  metadata: DatabaseMetadata,
  database: { size: number; sha256: string },
): SnapshotManifestV1 {
  return snapshotManifestSchema.parse({
    format: SNAPSHOT_FORMAT,
    sourceMarker: STANDALONE_MARKER_CONTENTS,
    nodeVersion: process.version,
    schemaVersion: metadata.schemaVersion,
    schemaFingerprint: metadata.schemaFingerprint,
    databaseSize: database.size,
    databaseSha256: database.sha256,
    logicalContentSha256: metadata.logicalContentSha256,
    createdAt: new Date().toISOString(),
  });
}

function readManifest(path: string): SnapshotManifestV1 {
  requireRegularFile(path, "Snapshot manifest", 0o600);
  if (lstatSync(path).size > 16_384)
    throw new Error("Snapshot manifest is too large");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Snapshot manifest is invalid");
  }
  return snapshotManifestSchema.parse(value);
}

function checkManifestAgainstDatabase(
  manifest: SnapshotManifestV1,
  metadata: DatabaseMetadata,
  database: { size: number; sha256: string },
): void {
  if (
    manifest.schemaVersion !== metadata.schemaVersion ||
    manifest.schemaFingerprint !== metadata.schemaFingerprint ||
    manifest.databaseSize !== database.size ||
    manifest.databaseSha256 !== database.sha256 ||
    manifest.logicalContentSha256 !== metadata.logicalContentSha256
  )
    throw new Error("Snapshot database does not match its manifest");
}

function validateSnapshotRoot(path: string): string {
  const canonical = canonicalTargetPath(path, "Snapshot");
  const info = lstatSync(canonical);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Snapshot must be a real directory");
  if ((info.mode & 0o777) !== 0o700)
    throw new Error("Snapshot directory has unexpected permissions");
  if (realpathSync(canonical) !== canonical)
    throw new Error("Snapshot directory path is not canonical");
  return canonical;
}

function verifySnapshotFiles(path: string): SnapshotManifestV1 {
  const entries = readdirSync(path).sort();
  if (
    entries.length !== 2 ||
    entries[0] !== MANIFEST_NAME ||
    entries[1] !== DATABASE_NAME
  )
    throw new Error("Snapshot is incomplete or contains unexpected files");
  const manifest = readManifest(join(path, MANIFEST_NAME));
  const databasePath = join(path, DATABASE_NAME);
  requireRegularFile(databasePath, "Snapshot database", 0o600);
  return manifest;
}

export async function createSnapshot(
  sourceDirectory: string,
  snapshotDirectory: string,
  options: OperationsOptions = {},
): Promise<SnapshotManifestV1> {
  const snapshotPath = canonicalTargetPath(snapshotDirectory, "Snapshot", true);
  let dataDirectory: StandaloneDataDirectory | undefined;
  let sourceDb: DatabaseSync | undefined;
  try {
    dataDirectory = StandaloneDataDirectory.openExclusive(sourceDirectory, {
      createFreshMarker: false,
      requireExistingOwner: true,
    });
    assertDisjoint(dataDirectory.root, snapshotPath);
    sourceDb = openVerifiedDatabase(dataDirectory.databasePath);
    const sourceMetadata = validateDatabase(sourceDb);
    reserveDirectory(snapshotPath);

    const snapshotDatabase = join(snapshotPath, DATABASE_NAME);
    let faultInjected = false;
    try {
      await backup(sourceDb, snapshotDatabase, {
        rate: options.fault ? 1 : undefined,
        progress: options.fault
          ? ({ remainingPages }) => {
              if (!faultInjected && remainingPages > 0) {
                faultInjected = true;
                options.fault?.("before-backup-completion");
              }
            }
          : undefined,
      });
    } catch (error) {
      if (options.fault && faultInjected) throw error;
      throw new Error("SQLite backup failed", { cause: error });
    }
    finalizeSnapshotDatabase(snapshotDatabase);
    chmodSync(snapshotDatabase, 0o600);
    fsyncPath(snapshotDatabase);
    const snapshotDb = openVerifiedDatabase(snapshotDatabase);
    let snapshotMetadata: DatabaseMetadata;
    try {
      snapshotMetadata = validateDatabase(snapshotDb);
    } finally {
      snapshotDb.close();
    }
    if (
      snapshotMetadata.schemaVersion !== sourceMetadata.schemaVersion ||
      snapshotMetadata.schemaFingerprint !== sourceMetadata.schemaFingerprint ||
      snapshotMetadata.logicalContentSha256 !==
        sourceMetadata.logicalContentSha256
    )
      throw new Error("SQLite backup does not match its source");

    options.fault?.("before-snapshot-commit");
    const file = await fileDigest(snapshotDatabase);
    const manifest = createManifest(snapshotMetadata, file);
    const manifestPath = join(snapshotPath, MANIFEST_NAME);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(manifestPath, 0o600);
    fsyncPath(manifestPath);
    fsyncPath(snapshotPath);
    return manifest;
  } finally {
    sourceDb?.close();
    dataDirectory?.close();
  }
}

export async function verifySnapshot(
  snapshotDirectory: string,
): Promise<SnapshotManifestV1> {
  const path = validateSnapshotRoot(snapshotDirectory);
  const manifest = verifySnapshotFiles(path);
  const databasePath = join(path, DATABASE_NAME);
  const file = await fileDigest(databasePath);
  if (
    file.size !== manifest.databaseSize ||
    file.sha256 !== manifest.databaseSha256
  )
    throw new Error("Snapshot database digest does not match its manifest");
  const db = openVerifiedDatabase(databasePath);
  try {
    const metadata = validateDatabase(db);
    checkManifestAgainstDatabase(manifest, metadata, file);
  } finally {
    db.close();
  }
  return manifest;
}

export async function restoreSnapshot(
  snapshotDirectory: string,
  destinationDirectory: string,
  options: OperationsOptions = {},
): Promise<SnapshotManifestV1> {
  const snapshotPath = canonicalTargetPath(snapshotDirectory, "Snapshot");
  const destinationPath = canonicalTargetPath(
    destinationDirectory,
    "Restore",
    true,
  );
  assertDisjoint(snapshotPath, destinationPath);
  reserveDirectory(destinationPath);

  const sentinelPath = join(destinationPath, RESTORE_SENTINEL_NAME);
  writeFileSync(sentinelPath, RESTORE_SENTINEL_CONTENTS, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(sentinelPath, 0o600);
  fsyncPath(sentinelPath);
  fsyncPath(destinationPath);

  const manifest = await verifySnapshot(snapshotPath);
  const sourceDatabase = join(snapshotPath, DATABASE_NAME);
  const destinationDatabase = join(destinationPath, DATABASE_NAME);
  copyFileSync(sourceDatabase, destinationDatabase, fsConstants.COPYFILE_EXCL);
  chmodSync(destinationDatabase, 0o600);
  fsyncPath(destinationDatabase);

  options.fault?.("before-restored-database-verification");
  const restoredDb = openVerifiedDatabase(destinationDatabase);
  try {
    const metadata = validateDatabase(restoredDb);
    const file = await fileDigest(destinationDatabase);
    checkManifestAgainstDatabase(manifest, metadata, file);
  } finally {
    restoredDb.close();
  }

  options.fault?.("before-restore-commit");
  const ownerPath = join(destinationPath, STANDALONE_OWNER_NAME);
  writeFileSync(ownerPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  chmodSync(ownerPath, 0o600);
  fsyncPath(ownerPath);
  fsyncPath(destinationPath);
  renameSync(sentinelPath, join(destinationPath, STANDALONE_MARKER_NAME));
  fsyncPath(destinationPath);
  return manifest;
}
