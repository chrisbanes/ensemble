import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { tmpdir } from "./temp.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import { StandaloneDataDirectory } from "../src/standalone/data-directory.js";
import { StandaloneService } from "../src/standalone/service.js";
import type {
  RecoveryReceipt,
  RuntimeProcessIdentity,
  TerminationVerifier,
} from "../src/standalone/recovery-types.js";
import type { RoutingChoiceClient } from "../src/standalone/routing.js";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../src/standalone/operations.js";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string, relativePath: string): void => {
    const info = lstatSync(path);
    const type = info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other";
    hash.update(
      `${relativePath}\0${type}\0${info.mode & 0o777}\0${info.size}\n`,
    );
    if (info.isSymbolicLink()) {
      hash.update(readlinkSync(path));
    } else if (info.isFile()) {
      hash.update(readFileSync(path));
    } else if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort())
        visit(join(path, entry), `${relativePath}/${entry}`);
    }
  };
  visit(root, ".");
  return hash.digest("hex");
}

function createLargeMarkedSource(data: string): void {
  const owner = StandaloneDataDirectory.openExclusive(data);
  const db = new DatabaseSync(owner.databasePath);
  try {
    db.exec(
      "PRAGMA user_version = 6; CREATE TABLE payloads (id INTEGER PRIMARY KEY, value BLOB NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO payloads (id, value) VALUES (?, ?)");
    const payload = Buffer.alloc(4096, 0x5a);
    for (let id = 0; id < 500; id++) insert.run(id, payload);
  } finally {
    db.close();
    owner.close();
  }
}

function copySnapshot(source: string, target: string): void {
  mkdirSync(target, { mode: 0o700 });
  for (const name of readdirSync(source))
    copyFileSync(join(source, name), join(target, name));
}

function runOperations(...args: string[]) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "operations CLI test must run from npm");
  return spawnSync(
    process.execPath,
    [npmCli, "run", "operations", "--", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        npm_config_loglevel: "silent",
      },
    },
  );
}

function cliJson(stdout: string): Record<string, unknown> {
  const result = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);
  assert.ok(result);
  return JSON.parse(result) as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("operations fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

class OperationsJourneyRuntime implements Runtime {
  readonly process: RuntimeProcessIdentity = {
    processId: `operations-fixture-${randomUUID()}`,
    processStartedAt: new Date().toISOString(),
    bootId: `operations-fixture-boot-${randomUUID()}`,
  };
  threads = 0;
  turns = 0;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  constructor(private readonly askOnFirstTurn = false) {}

  async start() {}

  async stop() {
    this.finishAll("failed");
  }

  async startThread() {
    return `thread-${++this.threads}`;
  }

  async resumeThread() {}

  async startTurn() {
    const turnId = `turn-${++this.turns}`;
    this.outcomes.set(turnId, deferred());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(threadId: string, turnId: string) {
    if (this.askOnFirstTurn && turnId === "turn-1") {
      assert.ok(
        this.toolCall,
        "service registered a coordination tool handler",
      );
      const result = await this.toolCall({
        threadId,
        turnId,
        callId: "operations-fixture-question",
        tool: "ensemble_ask_question",
        arguments: { question: "Which recovery behavior should be verified?" },
      });
      assert.equal(result.success, true, result.text);
    }
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  processIdentity() {
    return this.process;
  }

  async inspectExecution() {
    return {
      kind: "no-proof" as const,
      reason: "Disposable process is offline",
    };
  }

  finish(turnId: string, status: "completed" | "failed") {
    this.outcomes.get(turnId)?.resolve(status);
  }

  finishAll(status: "completed" | "failed") {
    for (const outcome of this.outcomes.values()) outcome.resolve(status);
  }
}

function domainCommand(
  service: StandaloneService,
  body: Record<string, unknown>,
) {
  return service.domain().execute({ key: randomUUID(), ...body } as never);
}

async function stopAfterSchedulerDrain(
  service: StandaloneService,
): Promise<void> {
  const scheduler = (
    service as unknown as {
      scheduler: { stop(): void; draining?: Promise<void> } | undefined;
    }
  ).scheduler;
  scheduler?.stop();
  await scheduler?.draining?.catch(() => {});
  await service.stop();
}

test("SQLite snapshot verifies and restores typed logical content with WAL activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-snapshot-roundtrip-"));
  const data = join(root, "data");
  const snapshot = join(root, "snapshots", "snapshot-one");
  const restored = join(root, "restored-data");
  mkdirSync(join(root, "snapshots"));
  let owner: StandaloneDataDirectory | undefined;
  let source: DatabaseSync | undefined;
  let restoredDatabase: DatabaseSync | undefined;
  try {
    owner = StandaloneDataDirectory.openExclusive(data);
    source = new DatabaseSync(owner.databasePath);
    source.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    source.exec("PRAGMA user_version = 6;");
    source.exec(`
      CREATE TABLE "quoted table" (
        id INTEGER PRIMARY KEY,
        "odd""column" TEXT,
        real_value REAL,
        blob_value BLOB,
        nullable_value TEXT,
        large_integer INTEGER
      );
      CREATE TABLE no_primary_key (value TEXT);
      CREATE TABLE composite_key (
        category TEXT NOT NULL,
        item INTEGER NOT NULL,
        payload TEXT,
        PRIMARY KEY (category, item)
      ) WITHOUT ROWID;
    `);
    source
      .prepare('INSERT INTO "quoted table" VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        1,
        "text value",
        1.25,
        Buffer.from([0, 1, 127, 255]),
        null,
        9_223_372_036_854_775_807n,
      );
    source.exec(`
      INSERT INTO no_primary_key (value) VALUES ('second'), ('first');
      INSERT INTO composite_key VALUES ('z', 2, 'later'), ('a', 1, 'earlier');
    `);
    owner.close();
    owner = undefined;

    const sourceBytes = readFileSync(join(data, "standalone.sqlite"));
    const walPath = join(data, "standalone.sqlite-wal");
    assert.equal(existsSync(walPath), true);
    const walBytes = readFileSync(walPath);

    const manifest = await createSnapshot(data, snapshot);
    assert.deepEqual(readdirSync(snapshot).sort(), [
      "manifest.json",
      "standalone.sqlite",
    ]);
    assert.equal(manifest.format, "ensemble-sqlite-snapshot-v1");
    assert.equal(manifest.sourceMarker, "ensemble-standalone-v1\n");
    assert.equal(manifest.nodeVersion, process.version);
    assert.equal(manifest.schemaVersion, 6);
    assert.match(manifest.schemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(
      manifest.databaseSize,
      readFileSync(join(snapshot, "standalone.sqlite")).byteLength,
    );
    assert.match(manifest.databaseSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.logicalContentSha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(snapshot).mode & 0o777, 0o700);
    assert.equal(statSync(join(snapshot, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(
      statSync(join(snapshot, "standalone.sqlite")).mode & 0o777,
      0o600,
    );
    assert.equal(
      digest(readFileSync(join(data, "standalone.sqlite"))),
      digest(sourceBytes),
    );
    assert.equal(digest(readFileSync(walPath)), digest(walBytes));

    const verified = await verifySnapshot(snapshot);
    assert.equal(verified.databaseSha256, manifest.databaseSha256);
    assert.equal(verified.logicalContentSha256, manifest.logicalContentSha256);
    assert.equal(verified.schemaFingerprint, manifest.schemaFingerprint);

    const restoredManifest = await restoreSnapshot(snapshot, restored);
    assert.equal(
      restoredManifest.logicalContentSha256,
      manifest.logicalContentSha256,
    );
    assert.equal(
      readFileSync(join(restored, "standalone.sqlite")).equals(
        readFileSync(join(snapshot, "standalone.sqlite")),
      ),
      true,
    );
    assert.equal(
      readFileSync(join(restored, ".ensemble-standalone"), "utf8"),
      "ensemble-standalone-v1\n",
    );

    restoredDatabase = new DatabaseSync(join(restored, "standalone.sqlite"), {
      readOnly: true,
    });
    const rowStatement = restoredDatabase.prepare(
      'SELECT * FROM "quoted table" WHERE id = 1',
    );
    rowStatement.setReadBigInts(true);
    const row = rowStatement.get();
    assert.equal(row?.['odd"column'], "text value");
    assert.equal(row?.real_value, 1.25);
    assert.deepEqual(
      Array.from(row?.blob_value as Uint8Array),
      [0, 1, 127, 255],
    );
    assert.equal(row?.nullable_value, null);
    assert.equal(row?.large_integer, 9_223_372_036_854_775_807n);
  } finally {
    restoredDatabase?.close();
    source?.close();
    owner?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted backup and restore operations leave uncommitted paths and preserve the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-snapshot-interruptions-"));
  const data = join(root, "data");
  const backupProgress = join(root, "backup-progress");
  const backupCommit = join(root, "backup-commit");
  const snapshot = join(root, "complete-snapshot");
  const restoreVerification = join(root, "restore-verification");
  const restoreCommit = join(root, "restore-commit");
  createLargeMarkedSource(data);
  const sourcePath = join(data, "standalone.sqlite");
  const sourceBefore = readFileSync(sourcePath);
  let unavailableRuntimeStarted = false;
  try {
    await assert.rejects(
      createSnapshot(data, backupProgress, {
        fault(stage) {
          if (stage === "before-backup-completion")
            throw new Error("injected backup progress failure");
        },
      }),
      /injected backup progress failure/,
    );
    assert.equal(readdirSync(backupProgress).includes("manifest.json"), false);
    await assert.rejects(verifySnapshot(backupProgress), /incomplete/);

    await assert.rejects(
      createSnapshot(data, backupCommit, {
        fault(stage) {
          if (stage === "before-snapshot-commit")
            throw new Error("injected snapshot commit failure");
        },
      }),
      /injected snapshot commit failure/,
    );
    assert.equal(readdirSync(backupCommit).includes("manifest.json"), false);
    await assert.rejects(verifySnapshot(backupCommit), /incomplete/);

    await createSnapshot(data, snapshot);
    for (const [destination, stage] of [
      [restoreVerification, "before-restored-database-verification"],
      [restoreCommit, "before-restore-commit"],
    ] as const) {
      await assert.rejects(
        restoreSnapshot(snapshot, destination, {
          fault(current) {
            if (current === stage) throw new Error(`injected ${stage} failure`);
          },
        }),
        new RegExp(`injected ${stage} failure`),
      );
      assert.equal(
        existsSync(join(destination, ".ensemble-restore-incomplete")),
        true,
      );
      assert.equal(
        existsSync(join(destination, ".ensemble-standalone")),
        false,
      );
      await assert.rejects(verifySnapshot(destination), /incomplete/);
      const service = new StandaloneService(destination, () => {
        unavailableRuntimeStarted = true;
        throw new Error("runtime must not start for an incomplete restore");
      });
      await assert.rejects(
        service.start(),
        /Unmarked data directory must be empty/,
      );
    }

    assert.equal(readFileSync(sourcePath).equals(sourceBefore), true);
    assert.equal(unavailableRuntimeStarted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot verification rejects malformed, mismatched, unsupported, and linked entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-snapshot-invalid-"));
  const data = join(root, "data");
  const snapshot = join(root, "valid-snapshot");
  createLargeMarkedSource(data);
  try {
    await createSnapshot(data, snapshot);

    const malformed = join(root, "malformed");
    copySnapshot(snapshot, malformed);
    writeFileSync(join(malformed, "manifest.json"), "not json\n");
    await assert.rejects(verifySnapshot(malformed), /manifest is invalid/);

    const futureFormat = join(root, "future-format");
    copySnapshot(snapshot, futureFormat);
    const formatManifest = JSON.parse(
      readFileSync(join(futureFormat, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    formatManifest.format = "ensemble-sqlite-snapshot-v2";
    writeFileSync(
      join(futureFormat, "manifest.json"),
      `${JSON.stringify(formatManifest)}\n`,
    );
    await assert.rejects(verifySnapshot(futureFormat));

    const futureSchema = join(root, "future-schema");
    copySnapshot(snapshot, futureSchema);
    const schemaManifest = JSON.parse(
      readFileSync(join(futureSchema, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    schemaManifest.schemaVersion = 7;
    writeFileSync(
      join(futureSchema, "manifest.json"),
      `${JSON.stringify(schemaManifest)}\n`,
    );
    await assert.rejects(verifySnapshot(futureSchema));

    const missingManifest = join(root, "missing-manifest");
    copySnapshot(snapshot, missingManifest);
    unlinkSync(join(missingManifest, "manifest.json"));
    await assert.rejects(verifySnapshot(missingManifest), /incomplete/);

    const unexpectedEntry = join(root, "unexpected-entry");
    copySnapshot(snapshot, unexpectedEntry);
    writeFileSync(join(unexpectedEntry, "extra"), "no\n");
    await assert.rejects(verifySnapshot(unexpectedEntry), /unexpected files/);

    const linkedDatabase = join(root, "linked-database");
    copySnapshot(snapshot, linkedDatabase);
    unlinkSync(join(linkedDatabase, "standalone.sqlite"));
    symlinkSync(
      join(snapshot, "standalone.sqlite"),
      join(linkedDatabase, "standalone.sqlite"),
    );
    await assert.rejects(verifySnapshot(linkedDatabase), /regular file/);

    const badDigest = join(root, "bad-digest");
    copySnapshot(snapshot, badDigest);
    const database = new DatabaseSync(join(badDigest, "standalone.sqlite"));
    database.exec(
      "UPDATE payloads SET value = zeroblob(length(value)) WHERE id = 0",
    );
    database.close();
    await assert.rejects(verifySnapshot(badDigest), /digest does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service, snapshot, and restore paths reject symlinked ancestors", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-operation-ancestor-link-")),
  );
  const realAncestor = join(root, "real-ancestor");
  const realSource = join(realAncestor, "real-child");
  const realSnapshotParent = join(realAncestor, "snapshots");
  const alias = join(root, "ancestor-link");
  const sourceAlias = join(alias, "real-child");
  const snapshot = join(realSnapshotParent, "snapshot");
  const snapshotTargetAlias = join(alias, "snapshots", "through-link");
  const restoreTargetAlias = join(alias, "restored-child");
  const canonicalRestoreTarget = join(root, "restored-canonical");
  const nonCanonicalSource = `${realAncestor}/unused/../real-child`;
  const nonCanonicalSnapshotTarget = `${root}/unused/../noncanonical-snapshot`;
  mkdirSync(realSnapshotParent, { recursive: true });
  const bootstrap = new StandaloneService(
    realSource,
    () => new OperationsJourneyRuntime(),
  );
  await bootstrap.start();
  await stopAfterSchedulerDrain(bootstrap);
  symlinkSync(realAncestor, alias, "dir");
  await createSnapshot(realSource, snapshot);

  const service = new StandaloneService(sourceAlias, () => {
    throw new Error("runtime must not start for a linked source ancestor");
  });
  try {
    await assert.rejects(service.start(), /ancestor|real directory|canonical/i);
    await assert.rejects(
      new StandaloneService(nonCanonicalSource, () => {
        throw new Error("runtime must not start for a noncanonical source");
      }).start(),
      /lexically canonical/i,
    );
    await assert.rejects(
      createSnapshot(sourceAlias, join(root, "source-alias-snapshot")),
      /ancestor|real directory|canonical/i,
    );
    await assert.rejects(
      createSnapshot(realSource, snapshotTargetAlias),
      /ancestor|real directory|canonical/i,
    );
    await assert.rejects(
      createSnapshot(realSource, nonCanonicalSnapshotTarget),
      /lexically canonical/i,
    );
    await assert.rejects(
      verifySnapshot(join(alias, "snapshots", "snapshot")),
      /ancestor|real directory|canonical/i,
    );
    await assert.rejects(
      restoreSnapshot(snapshot, restoreTargetAlias),
      /ancestor|real directory|canonical/i,
    );
    await assert.rejects(
      restoreSnapshot(
        join(alias, "snapshots", "snapshot"),
        canonicalRestoreTarget,
      ),
      /ancestor|real directory|canonical/i,
    );
    assert.equal(existsSync(join(realAncestor, "restored-child")), false);
    assert.equal(
      existsSync(join(realAncestor, "snapshots", "through-link")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restored offline backups preserve the full source tree and share service ownership", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-restored-backup-owner-")),
  );
  const source = join(root, "source");
  const originalSnapshot = join(root, "original-snapshot");
  const restored = join(root, "restored-never-started");
  const successfulBackup = join(root, "successful-backup");
  const failedBackup = join(root, "failed-backup");
  const backupOwnedSnapshot = join(root, "backup-owned-snapshot");
  const serviceFirstRestored = join(root, "service-first-restored");
  const serviceSource = join(root, "service-source");
  const serviceSourceSnapshot = join(root, "service-source-snapshot");
  const serviceOwnedSnapshot = join(root, "service-owned-snapshot");
  const ownerlessLegacy = join(root, "ownerless-legacy-restore");
  let service: StandaloneService | undefined;
  try {
    createLargeMarkedSource(source);
    await createSnapshot(source, originalSnapshot);
    await restoreSnapshot(originalSnapshot, restored);
    const ownerPath = join(restored, ".ensemble-owner.sqlite");
    assert.equal(existsSync(ownerPath), true);
    assert.equal(statSync(ownerPath).size, 0);
    const restoredBefore = treeDigest(restored);

    await createSnapshot(restored, successfulBackup);
    assert.equal(treeDigest(restored), restoredBefore);

    await assert.rejects(
      createSnapshot(restored, failedBackup, {
        fault(stage) {
          if (stage === "before-snapshot-commit")
            throw new Error("injected restored-source backup failure");
        },
      }),
      /injected restored-source backup failure/,
    );
    assert.equal(treeDigest(restored), restoredBefore);

    mkdirSync(ownerlessLegacy, { mode: 0o700 });
    for (const name of readdirSync(restored)) {
      if (name !== ".ensemble-owner.sqlite")
        copyFileSync(join(restored, name), join(ownerlessLegacy, name));
    }
    const ownerlessBefore = treeDigest(ownerlessLegacy);
    const ownerlessSnapshot = join(root, "ownerless-backup");
    await assert.rejects(
      createSnapshot(ownerlessLegacy, ownerlessSnapshot),
      /owner file is required/i,
    );
    assert.equal(treeDigest(ownerlessLegacy), ownerlessBefore);
    assert.equal(existsSync(ownerlessSnapshot), false);

    service = new StandaloneService(
      restored,
      () => new OperationsJourneyRuntime(),
    );
    const backupWhileStarting = createSnapshot(restored, backupOwnedSnapshot);
    await assert.rejects(service.start(), /already owned/);
    await backupWhileStarting;
    assert.equal(treeDigest(restored), restoredBefore);

    const serviceSourceService = new StandaloneService(
      serviceSource,
      () => new OperationsJourneyRuntime(),
    );
    await serviceSourceService.start();
    await stopAfterSchedulerDrain(serviceSourceService);
    await createSnapshot(serviceSource, serviceSourceSnapshot);
    await restoreSnapshot(serviceSourceSnapshot, serviceFirstRestored);
    service = new StandaloneService(
      serviceFirstRestored,
      () => new OperationsJourneyRuntime(),
    );
    const starting = service.start();
    await assert.rejects(
      createSnapshot(serviceFirstRestored, serviceOwnedSnapshot),
      /already owned/,
    );
    await starting;
    const serviceOwnerPath = join(
      serviceFirstRestored,
      ".ensemble-owner.sqlite",
    );
    const serviceOwnerBytes = readFileSync(serviceOwnerPath);
    await stopAfterSchedulerDrain(service);
    service = undefined;
    assert.equal(
      readFileSync(serviceOwnerPath).equals(serviceOwnerBytes),
      true,
    );
  } finally {
    if (service) await stopAfterSchedulerDrain(service).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive source ownership and exact destination reservations preserve existing paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-snapshot-exclusivity-"));
  const sourceOne = join(root, "source-one");
  const sourceTwo = join(root, "source-two");
  const snapshot = join(root, "snapshot");
  const existingSnapshot = join(root, "existing-snapshot");
  const restored = join(root, "restored");
  const existingRestore = join(root, "existing-restore");
  createLargeMarkedSource(sourceOne);
  createLargeMarkedSource(sourceTwo);
  let owner: StandaloneDataDirectory | undefined;
  try {
    owner = StandaloneDataDirectory.openExclusive(sourceOne, {
      createFreshMarker: false,
    });
    await assert.rejects(createSnapshot(sourceOne, snapshot), /already owned/);
    owner.close();
    owner = undefined;

    const contenders = await Promise.allSettled([
      createSnapshot(sourceOne, snapshot),
      createSnapshot(sourceTwo, snapshot),
    ]);
    assert.equal(
      contenders.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      contenders.filter((result) => result.status === "rejected").length,
      1,
    );
    await verifySnapshot(snapshot);

    const restoreContenders = await Promise.allSettled([
      restoreSnapshot(snapshot, restored),
      restoreSnapshot(snapshot, restored),
    ]);
    assert.equal(
      restoreContenders.filter((result) => result.status === "fulfilled")
        .length,
      1,
    );
    assert.equal(
      restoreContenders.filter((result) => result.status === "rejected").length,
      1,
    );
    await StandaloneDataDirectory.openExclusive(restored, {
      createFreshMarker: false,
    }).close();

    mkdirSync(existingSnapshot);
    writeFileSync(join(existingSnapshot, "keep"), "snapshot intact");
    await assert.rejects(createSnapshot(sourceOne, existingSnapshot));
    assert.equal(
      readFileSync(join(existingSnapshot, "keep"), "utf8"),
      "snapshot intact",
    );

    mkdirSync(existingRestore);
    writeFileSync(join(existingRestore, "keep"), "restore intact");
    await assert.rejects(restoreSnapshot(snapshot, existingRestore));
    assert.equal(
      readFileSync(join(existingRestore, "keep"), "utf8"),
      "restore intact",
    );
  } finally {
    owner?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operations npm commands are strict, secret-safe, and do not start the service", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-cli-secret-marker-"));
  const source = join(root, "source");
  const snapshot = join(root, "snapshot");
  const restored = join(root, "restored");
  createLargeMarkedSource(source);
  try {
    const backup = runOperations("backup", source, snapshot);
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(backup.signal, null);
    assert.equal(cliJson(backup.stdout).operation, "backup");

    const verify = runOperations("verify", snapshot);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(cliJson(verify.stdout).operation, "verify");

    const restore = runOperations("restore", snapshot, restored);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(cliJson(restore.stdout).operation, "restore");
    assert.equal(existsSync(join(restored, ".ensemble-standalone")), true);
    assert.equal(existsSync(join(restored, ".ensemble-owner.sqlite")), true);
    assert.equal(statSync(join(restored, ".ensemble-owner.sqlite")).size, 0);

    const preserved = join(root, "existing-destination");
    mkdirSync(preserved);
    writeFileSync(join(preserved, "keep"), "existing bytes\n");
    const refusal = runOperations("restore", snapshot, preserved);
    assert.equal(refusal.status, 1);
    assert.deepEqual(cliJson(refusal.stderr), {
      ok: false,
      error: "operation failed",
    });
    assert.equal(
      readFileSync(join(preserved, "keep"), "utf8"),
      "existing bytes\n",
    );

    const invalid = runOperations("verify", join(root, "missing-snapshot"));
    assert.equal(invalid.status, 1);
    assert.deepEqual(cliJson(invalid.stderr), {
      ok: false,
      error: "operation failed",
    });

    const wrongArity = runOperations("restore", snapshot);
    assert.equal(wrongArity.status, 2);
    assert.match(wrongArity.stderr, /Usage:/);
    assert.equal(wrongArity.stdout.includes(root), false);
    for (const [index, result] of [
      backup,
      verify,
      restore,
      refusal,
      invalid,
      wrongArity,
    ].entries()) {
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(
        output.includes(root),
        false,
        `operations subprocess ${index} echoed a path: ${output.replaceAll(root, "<fixture-root>")}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restored public state reconciles exact execution evidence before one eligible admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-restore-journey-"));
  const sourceData = join(root, "source-install", "data");
  const destinationData = join(root, "restored-install", "data");
  const externalWorkspace = join(root, "external-disposable-workspace");
  const snapshot = join(root, "snapshot");
  mkdirSync(dirname(sourceData), { recursive: true });
  mkdirSync(dirname(destinationData), { recursive: true });
  mkdirSync(externalWorkspace);
  writeFileSync(join(externalWorkspace, "keep.txt"), "external workspace\n");
  const externalBytes = readFileSync(join(externalWorkspace, "keep.txt"));
  const sourceRuntime = new OperationsJourneyRuntime(true);
  const candidateProfileId = randomUUID();
  const leadProfileId = randomUUID();
  const projectId = randomUUID();
  const routedTaskId = randomUUID();
  const admissionTaskId = randomUUID();
  let routedAssignmentId = "";
  const directWorkId = `direct:${randomUUID()}`;
  const routingClient: RoutingChoiceClient = {
    async choose(request) {
      const probabilities = Object.fromEntries(
        request.choices.map((choice) => [
          choice,
          choice === "lead_review" ? 1 : 0,
        ]),
      );
      return {
        choice: "lead_review",
        model: request.requestedModel,
        confidence: 1,
        probabilities,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  let sourceService: StandaloneService | undefined = new StandaloneService(
    sourceData,
    () => sourceRuntime,
    undefined,
    {
      power: { enabled: false },
      routingClient,
      supervisor: { observationMs: 1 },
    },
  );
  let restoredService: StandaloneService | undefined;
  try {
    await sourceService.start();
    domainCommand(sourceService, {
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Recovery lead",
      instructions: "Coordinate recovery evidence.",
      capabilities: "coordination",
    });
    domainCommand(sourceService, {
      type: "profile.create",
      actor: "operator",
      profileId: candidateProfileId,
      name: "Recovery candidate",
      instructions: "Perform bounded work.",
      capabilities: "implementation",
    });
    domainCommand(sourceService, {
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Snapshot journey",
      leadProfileId,
    });
    domainCommand(sourceService, {
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    await sourceService.configureCapacity({
      key: randomUUID(),
      globalLimit: 5,
    });
    domainCommand(sourceService, {
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "Route to the lead for review.",
      credentialRef: "env:OPERATIONS_JOURNEY_ROUTING",
      candidateProfileIds: [candidateProfileId],
    });
    domainCommand(sourceService, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId: routedTaskId,
      title: "Routed task",
      outcome: "Retain the route disposition and question.",
      ready: false,
    });
    const sourceBinding = await sourceService.provisionTask(routedTaskId);
    assert.equal(sourceBinding.state, "ready");
    const managedSentinel = join(
      sourceBinding.path,
      "source-root-sentinel.txt",
    );
    writeFileSync(managedSentinel, "do not touch after restore\n");
    const managedBytes = readFileSync(managedSentinel);
    domainCommand(sourceService, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId: routedTaskId,
      expectedVersion: 1,
      ready: true,
    });
    await waitUntil(() => sourceRuntime.turns === 1);
    await waitUntil(
      () =>
        sourceService?.coordinationView().readTask(routedTaskId).questions
          .length === 1,
    );
    const routedAssignment = sourceService
      .domain()
      .assignments(routedTaskId)
      .find((item) => item.profileId === leadProfileId);
    assert.ok(routedAssignment);
    routedAssignmentId = String(routedAssignment.id);
    await sourceService.coordinationView().postOperatorMessage({
      taskId: routedTaskId,
      key: randomUUID(),
      recipientAssignmentId: routedAssignmentId,
      expectedAssignmentVersion: Number(routedAssignment.version),
      message: "Preserve this operator message in the snapshot.",
    });
    sourceRuntime.finish("turn-1", "failed");
    await waitUntil(
      () =>
        sourceService
          ?.list()
          .some(
            (item) =>
              item.workId === `assignment:${routedAssignmentId}:initial` &&
              item.state === "held",
          ) === true,
    );
    await sourceService.stopTask(routedTaskId);

    const direct = sourceService.submit(
      directWorkId,
      "Reconcile this exact external-workspace execution.",
      externalWorkspace,
    );
    void direct.catch(() => {});
    await waitUntil(() => sourceRuntime.turns === 2);
    sourceRuntime.finish("turn-2", "failed");
    await waitUntil(
      () =>
        sourceService
          ?.list()
          .some(
            (item) => item.workId === directWorkId && item.state === "held",
          ) === true,
    );

    domainCommand(sourceService, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId: admissionTaskId,
      title: "Post-recovery admission",
      outcome: "Start only after Stop is cleared.",
      ready: false,
    });
    domainCommand(sourceService, {
      type: "assignment.create",
      actor: "operator",
      projectId,
      taskId: admissionTaskId,
      assignmentId: randomUUID(),
      profileId: candidateProfileId,
      brief: "Run after the recovery gates are cleared.",
      resultDestination: "lead:task",
      requesterAssignmentId: null,
    });
    domainCommand(sourceService, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId: admissionTaskId,
      expectedVersion: 1,
      ready: true,
    });
    await sourceService.stopTask(admissionTaskId);
    assert.equal(sourceService.taskHold(routedTaskId), "Task stopped");
    assert.equal(sourceService.taskHold(admissionTaskId), "Task stopped");

    await stopAfterSchedulerDrain(sourceService);
    sourceService = undefined;
    const stoppedSourceDb = new DatabaseSync(
      join(sourceData, "standalone.sqlite"),
    );
    try {
      stoppedSourceDb
        .prepare(
          "UPDATE task_workspace_bindings SET state = 'held', reason = ? WHERE taskId = ?",
        )
        .run(
          "An unrelated persisted hold must not bypass identity validation",
          routedTaskId,
        );
    } finally {
      stoppedSourceDb.close();
    }
    assert.equal(runOperations("backup", sourceData, snapshot).status, 0);
    assert.equal(runOperations("verify", snapshot).status, 0);
    assert.equal(runOperations("restore", snapshot, destinationData).status, 0);

    const restoredRuntime = new OperationsJourneyRuntime();
    const restoredPathAccesses: string[] = [];
    const terminationVerifier: TerminationVerifier = {
      async verify(identity) {
        return {
          kind: "verified",
          processIdentity: identity,
          verifiedAt: new Date().toISOString(),
          method: "mac-pid-absent-same-boot",
        };
      },
    };
    restoredService = new StandaloneService(
      destinationData,
      () => restoredRuntime,
      undefined,
      {
        power: { enabled: false },
        routingClient: null,
        supervisor: { observationMs: 1 },
        terminationVerifier,
        workspaceManager: {
          beforePathAccess: (path) => restoredPathAccesses.push(path),
        },
      },
    );
    await restoredService.start();
    assert.equal(restoredRuntime.turns, 0);
    assert.equal(restoredPathAccesses.includes(sourceBinding.path), false);
    assert.equal(
      restoredPathAccesses.includes(realpathSync(externalWorkspace)),
      true,
    );
    assert.equal(restoredService.domain().profiles().length, 2);
    assert.equal(restoredService.domain().projects().length, 1);
    assert.equal(restoredService.domain().task(routedTaskId).id, routedTaskId);
    assert.equal(
      restoredService.domain().task(admissionTaskId).id,
      admissionTaskId,
    );
    assert.equal(
      restoredService.domain().assignment(routedAssignmentId).resultDestination,
      "lead",
    );
    assert.equal(restoredService.taskHold(routedTaskId), "Task stopped");
    assert.equal(restoredService.taskHold(admissionTaskId), "Task stopped");

    const restoredTask = restoredService
      .coordinationView()
      .readTask(routedTaskId);
    assert.equal(restoredTask.questions.length, 1);
    assert.equal(
      restoredTask.messages.some((item) =>
        item.text?.includes("Preserve this operator message"),
      ),
      true,
    );
    assert.equal(restoredTask.routing.dispositions.length, 1);
    assert.match(
      restoredTask.routing.dispositions[0]?.disposition ?? "",
      /^lead-review:/,
    );

    const restoredBinding = await restoredService.taskWorkspace(routedTaskId);
    assert.equal(restoredBinding?.state, "held");
    assert.match(
      restoredBinding?.reason ?? "",
      /Stored workspace path does not match its identity/,
    );
    assert.equal(readFileSync(managedSentinel).equals(managedBytes), true);
    assert.equal(
      readFileSync(join(externalWorkspace, "keep.txt")).equals(externalBytes),
      true,
    );

    const directView = restoredService
      .recoveryView()
      .find((item) => item.workId === directWorkId);
    const routedWorkId = `assignment:${routedAssignmentId}:initial`;
    const routedView = restoredService
      .recoveryView()
      .find((item) => item.workId === routedWorkId);
    assert.ok(directView?.intent.threadId && directView.intent.turnId);
    assert.ok(routedView?.intent.threadId && routedView.intent.turnId);
    assert.ok(directView.processIdentity);
    assert.equal(directView.intent.state, "held");
    assert.equal(routedView.intent.state, "held");
    const receipt: RecoveryReceipt = {
      workId: directView.workId,
      workRevision: directView.generation.workRevision,
      requestSequence: directView.generation.requestSequence,
      threadId: directView.intent.threadId,
      turnId: directView.intent.turnId,
      processIdentity: directView.processIdentity,
      termination: { kind: "process-exit" },
      effects: "settled",
      workspace: "preserved",
    };
    await assert.rejects(
      restoredService.resolveHeldExecution({
        ...receipt,
        turnId: "stale-turn",
      }),
      /identity/i,
    );
    const resolved = await restoredService.resolveHeldExecution(receipt);
    assert.equal(resolved.state, "reconciled");
    const afterReceipt = restoredService
      .recoveryView()
      .find((item) => item.workId === directWorkId);
    assert.equal(afterReceipt?.holds.writer, false);
    assert.equal(afterReceipt?.holds.capacity, false);
    assert.equal(
      restoredService
        .recoveryView()
        .find((item) => item.workId === routedWorkId)?.holds.capacity,
      true,
    );
    assert.equal(restoredService.taskHold(routedTaskId), "Task stopped");
    assert.equal(restoredService.taskHold(admissionTaskId), "Task stopped");

    await restoredService.resumeTask(routedTaskId);
    assert.equal(restoredService.taskHold(routedTaskId), undefined);
    assert.equal(
      (await restoredService.taskWorkspace(routedTaskId))?.state,
      "held",
    );
    assert.equal(restoredRuntime.turns, 0);

    await restoredService.provisionTask(admissionTaskId);
    await waitUntil(
      async () =>
        (await restoredService?.taskWorkspace(admissionTaskId))?.state ===
        "ready",
    );
    assert.equal(restoredService.taskHold(admissionTaskId), "Task stopped");
    assert.equal(restoredRuntime.turns, 0);
    await restoredService.resumeTask(admissionTaskId);
    await waitUntil(() => restoredRuntime.turns === 1);
    assert.equal(restoredRuntime.turns, 1);
    restoredRuntime.finish("turn-1", "completed");
    const admissionService = restoredService;
    await waitUntil(() =>
      admissionService
        .list()
        .some(
          (item) =>
            item.workId ===
              `assignment:${admissionService.domain().assignments(admissionTaskId)[0]?.id}:initial` &&
            item.state === "completed",
        ),
    );
    const completedAssignment = admissionService
      .domain()
      .assignments(admissionTaskId)[0];
    assert.ok(completedAssignment);
    const completedWorkId = `assignment:${completedAssignment.id}:initial`;
    await stopAfterSchedulerDrain(restoredService);
    const reopenedRuntime = new OperationsJourneyRuntime();
    restoredService = new StandaloneService(
      destinationData,
      () => reopenedRuntime,
      undefined,
      {
        power: { enabled: false },
        routingClient: null,
        supervisor: { observationMs: 1 },
      },
    );
    await restoredService.start();
    assert.equal(reopenedRuntime.turns, 0);
    assert.equal(
      restoredService.list().find((item) => item.workId === completedWorkId)
        ?.state,
      "completed",
    );
  } finally {
    sourceRuntime.finishAll("failed");
    if (restoredService)
      await stopAfterSchedulerDrain(restoredService).catch(() => {});
    if (sourceService)
      await stopAfterSchedulerDrain(sourceService).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
