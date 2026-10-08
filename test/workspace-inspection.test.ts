import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  appendFile,
  link as hardLink,
  mkdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Store } from "../src/core/store.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
  type TaskWorkspaceBinding,
} from "../src/standalone/workspaces.js";
import {
  inspectionLimits,
  listWorkspaceDirectory,
  previewWorkspaceFile,
  type WorkspaceInspectionCurrent,
  type WorkspaceInspectionRequest,
} from "../src/standalone/workspace-inspection.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-inspection-"));
  const db = new DatabaseSync(join(directory, "standalone.sqlite"));
  new Store(db).ensureHost("workspace-inspection-test");
  const manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    join(directory, "task-workspaces"),
  );
  return {
    directory,
    manager,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function sourceRepository(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.name",
    "Workspace Inspection Test",
  ]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "workspace-inspection@example.invalid",
  ]);
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  writeFileSync(join(path, "README.md"), `${name}\n`);
  execFileSync("git", ["-C", path, "add", ".gitignore", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "initial"]);
  return path;
}

function currentFor(
  binding: TaskWorkspaceBinding,
  controlPaths: readonly string[] = [],
): () => Promise<WorkspaceInspectionCurrent> {
  return async () => ({
    taskId: binding.taskId,
    taskVersion: 1,
    visibility: "inspection-test-binding",
    binding,
    controlPaths,
  });
}

function request(
  binding: TaskWorkspaceBinding,
  options: Partial<Omit<WorkspaceInspectionRequest, "taskId">> = {},
): WorkspaceInspectionRequest {
  return {
    taskId: binding.taskId,
    scope: { kind: "workspace" },
    path: [],
    showIgnored: false,
    ...options,
  };
}

async function aliasesResolveToSameEntry(first: string, second: string) {
  try {
    const [firstStat, secondStat] = await Promise.all([
      stat(first),
      stat(second),
    ]);
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
  } catch {
    return false;
  }
}

test("repository-free listing excludes private paths, bounds results, and keeps symlinks inert", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const taskId = "repository-free-task";
  const binding = await f.manager.provision(taskId);
  assert.equal(binding.state, "ready");
  await mkdir(join(binding.path, "notes"));
  await mkdir(join(binding.path, "notes", ".ssh"));
  await writeFile(join(binding.path, "notes", "readme.md"), "safe note");
  await writeFile(join(binding.path, ".env"), "private-env-value");
  await writeFile(join(binding.path, ".env.local"), "private-local-value");
  await writeFile(join(binding.path, ".git"), "private-control-file");
  await writeFile(join(binding.path, "server.pem"), "private-key-value");
  await writeFile(
    join(binding.path, "notes", ".ssh", "id_rsa"),
    "private-ssh-value",
  );
  const controlPath = join(binding.path, "operator.auth");
  await writeFile(controlPath, "private-control-value");
  const sibling = join(f.directory, "sibling-secret.txt");
  await writeFile(sibling, "sibling-secret-value");
  await symlink(sibling, join(binding.path, "sibling-link"));
  await mkdir(join(binding.path, "node_modules"));
  await writeFile(
    join(binding.path, "node_modules", "ignored.txt"),
    "ignored clutter",
  );

  const current = currentFor(binding, [controlPath]);
  const listing = await listWorkspaceDirectory(request(binding), current);
  assert.equal(listing.state, "ready");
  assert.equal(listing.workspaceId, binding.workspaceId);
  assert.equal(listing.taskId, taskId);
  assert.ok(listing.observedAt > 0);
  assert.equal(listing.truncated, false);
  const serialized = JSON.stringify(listing);
  for (const privateValue of [
    ".env",
    ".env.local",
    ".git",
    "server.pem",
    ".ssh",
    "operator.auth",
    "private-env-value",
    "private-local-value",
    "private-control-file",
    "private-key-value",
    "private-ssh-value",
    "private-control-value",
    "sibling-secret.txt",
    "sibling-secret-value",
  ])
    assert.equal(serialized.includes(privateValue), false, privateValue);
  assert.equal(
    listing.entries.some((entry) => entry.kind === "symlink"),
    true,
  );

  for (let index = 0; index < inspectionLimits.maxEntriesReturned + 20; index++)
    await writeFile(
      join(binding.path, `output-${index}.txt`),
      `output ${index}`,
    );
  const bounded = await listWorkspaceDirectory(request(binding), current);
  assert.equal(bounded.entries.length, inspectionLimits.maxEntriesReturned);
  assert.equal(bounded.truncated, true);

  const privateRead = await listWorkspaceDirectory(
    request(binding, { path: ["notes", ".ssh", "id_rsa"] }),
    current,
  );
  assert.equal(privateRead.state, "excluded");
  assert.deepEqual(privateRead.entries, []);
  assert.deepEqual(privateRead.path, []);
  const controlRead = await listWorkspaceDirectory(
    request(binding, { path: ["operator.auth"] }),
    current,
  );
  assert.equal(controlRead.state, "excluded");
  const clutterHidden = await listWorkspaceDirectory(
    request(binding, { path: ["node_modules"] }),
    current,
  );
  assert.equal(clutterHidden.state, "ignored");
  const clutterShown = await listWorkspaceDirectory(
    request(binding, { path: ["node_modules"], showIgnored: true }),
    current,
  );
  assert.equal(clutterShown.state, "ready");
  assert.equal(
    clutterShown.entries.find((entry) => entry.kind !== "repository")?.name,
    "ignored.txt",
  );
  await assert.rejects(
    listWorkspaceDirectory(
      request(binding, { path: Array.from({ length: 33 }, () => "part") }),
      current,
    ),
  );
  await assert.rejects(
    listWorkspaceDirectory(
      request(binding, {
        path: ["a".repeat(inspectionLimits.maxPathBytes + 1)],
      }),
      current,
    ),
  );
});

test("configured control paths follow filesystem case and Unicode aliases", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const source = sourceRepository(f.directory, "control-alias-source");
  const binding = await f.manager.provision("control-path-aliases", [
    { repositoryId: "repo", path: source },
  ]);
  const repository = binding.repositories[0]!;
  const workspaceFile = join(binding.path, "operatorauth.txt");
  const workspaceFileAlias = join(binding.path, "OperatorAuth.txt");
  const workspaceDirectory = join(binding.path, "cafe\u0301-auth");
  const workspaceDirectoryAlias = join(binding.path, "caf\u00e9-auth");
  const repositoryFile = join(repository.workspacePath, "operatorauth.txt");
  const repositoryFileAlias = join(
    repository.workspacePath,
    "OperatorAuth.txt",
  );
  const repositoryDirectory = join(repository.workspacePath, "cafe\u0301-auth");
  const repositoryDirectoryAlias = join(
    repository.workspacePath,
    "caf\u00e9-auth",
  );
  await writeFile(workspaceFile, "DUMMY_PRIVATE_VALUE workspace file");
  await mkdir(workspaceDirectory);
  await writeFile(
    join(workspaceDirectory, "private.txt"),
    "DUMMY_PRIVATE_VALUE workspace directory",
  );
  await writeFile(repositoryFile, "DUMMY_PRIVATE_VALUE repository file");
  await mkdir(repositoryDirectory);
  await writeFile(
    join(repositoryDirectory, "private.txt"),
    "DUMMY_PRIVATE_VALUE repository directory",
  );

  const workspaceFileIsAlias = await aliasesResolveToSameEntry(
    workspaceFile,
    workspaceFileAlias,
  );
  const workspaceDirectoryIsAlias = await aliasesResolveToSameEntry(
    workspaceDirectory,
    workspaceDirectoryAlias,
  );
  const repositoryFileIsAlias = await aliasesResolveToSameEntry(
    repositoryFile,
    repositoryFileAlias,
  );
  const repositoryDirectoryIsAlias = await aliasesResolveToSameEntry(
    repositoryDirectory,
    repositoryDirectoryAlias,
  );
  t.diagnostic(
    `filesystem control-path aliases ${JSON.stringify({
      caseFile: workspaceFileIsAlias,
      unicodeDirectory: workspaceDirectoryIsAlias,
      repositoryCaseFile: repositoryFileIsAlias,
      repositoryUnicodeDirectory: repositoryDirectoryIsAlias,
    })}`,
  );
  const current = currentFor(binding, [
    workspaceFileAlias,
    workspaceDirectoryAlias,
    repositoryFileAlias,
    repositoryDirectoryAlias,
  ]);

  const workspaceListing = await listWorkspaceDirectory(
    request(binding, { showIgnored: true }),
    current,
  );
  assert.equal(
    workspaceListing.entries.some(
      (entry) =>
        entry.kind !== "repository" && entry.name === "operatorauth.txt",
    ),
    !workspaceFileIsAlias,
  );
  assert.equal(
    workspaceListing.entries.some(
      (entry) =>
        entry.kind !== "repository" && entry.name === "cafe\u0301-auth",
    ),
    !workspaceDirectoryIsAlias,
  );
  for (const [path, isAlias] of [
    [["operatorauth.txt"], workspaceFileIsAlias],
    [["cafe\u0301-auth", "private.txt"], workspaceDirectoryIsAlias],
  ] as const) {
    const preview = await previewWorkspaceFile(
      request(binding, { path, showIgnored: true }),
      current,
    );
    assert.equal(preview.state, isAlias ? "excluded" : "ready");
    assert.equal(preview.preview?.kind === "text", !isAlias);
    if (isAlias) assert.deepEqual(preview.path, []);
    else assert.ok(preview.preview?.kind === "text");
  }

  const repositoryScope = {
    kind: "repository" as const,
    repositoryId: repository.repositoryId,
  };
  const repositoryListing = await listWorkspaceDirectory(
    request(binding, { scope: repositoryScope, showIgnored: true }),
    current,
  );
  assert.equal(
    repositoryListing.entries.some(
      (entry) =>
        entry.kind !== "repository" && entry.name === "operatorauth.txt",
    ),
    !repositoryFileIsAlias,
  );
  assert.equal(
    repositoryListing.entries.some(
      (entry) =>
        entry.kind !== "repository" && entry.name === "cafe\u0301-auth",
    ),
    !repositoryDirectoryIsAlias,
  );
  for (const [path, isAlias] of [
    [["operatorauth.txt"], repositoryFileIsAlias],
    [["cafe\u0301-auth", "private.txt"], repositoryDirectoryIsAlias],
  ] as const) {
    const preview = await previewWorkspaceFile(
      request(binding, { scope: repositoryScope, path, showIgnored: true }),
      current,
    );
    assert.equal(preview.state, isAlias ? "excluded" : "ready");
    assert.equal(preview.preview?.kind === "text", !isAlias);
    if (isAlias) assert.deepEqual(preview.path, []);
    else assert.ok(preview.preview?.kind === "text");
  }
});

test("multi-repository listing exposes only synthetic identities and exact repository scope", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const first = sourceRepository(f.directory, "source-one");
  const second = sourceRepository(f.directory, "source-two");
  const taskId = "two-repositories";
  const binding = await f.manager.provision(taskId, [
    { repositoryId: "owner/one", path: first },
    { repositoryId: "owner/two", path: second },
  ]);
  assert.equal(binding.state, "ready");
  const current = currentFor(binding);
  const root = await listWorkspaceDirectory(request(binding), current);
  assert.equal(root.state, "ready");
  assert.deepEqual(
    root.entries
      .filter((entry) => entry.kind === "repository")
      .map((entry) => entry.repositoryId)
      .sort(),
    ["owner/one", "owner/two"],
  );
  assert.equal(JSON.stringify(root).includes("repo-1"), false);
  assert.equal(JSON.stringify(root).includes("repo-2"), false);
  for (const repositoryPath of ["repo-1", "repo-2"]) {
    const denied = await listWorkspaceDirectory(
      request(binding, { path: [repositoryPath] }),
      current,
    );
    assert.equal(denied.state, "conflict");
    assert.deepEqual(denied.entries, []);
  }
  await writeFile(
    join(binding.repositories[0]!.workspacePath, "ignored.log"),
    "ignored content",
  );
  const repositoryScope = request(binding, {
    scope: { kind: "repository", repositoryId: "owner/one" },
  });
  const hidden = await listWorkspaceDirectory(repositoryScope, current);
  assert.equal(hidden.state, "ready");
  assert.equal(hidden.ignoreStatus, "known");
  assert.equal(
    hidden.entries.some(
      (entry) => entry.kind !== "repository" && entry.name === "ignored.log",
    ),
    false,
  );
  const shown = await listWorkspaceDirectory(
    { ...repositoryScope, showIgnored: true },
    current,
  );
  assert.equal(shown.state, "ready");
  const ignored = shown.entries.find(
    (entry) => entry.kind !== "repository" && entry.name === "ignored.log",
  );
  assert.ok(ignored);
  assert.equal(ignored.ignored, true);
  assert.equal(
    shown.entries.some(
      (entry) => entry.kind !== "repository" && entry.name === ".git",
    ),
    false,
  );

  const repository = binding.repositories[0]!;
  let replaced = false;
  const raced = await listWorkspaceDirectory(
    { ...repositoryScope, path: [] },
    current,
    {
      afterDirectoryOpen: async () => {
        if (replaced) return;
        replaced = true;
        await rename(
          repository.workspacePath,
          `${repository.workspacePath}-old`,
        );
        await mkdir(repository.workspacePath);
        await writeFile(
          join(repository.workspacePath, "replacement.txt"),
          "replacement",
        );
      },
    },
  );
  assert.equal(raced.state, "conflict");
  assert.deepEqual(raced.entries, []);
});

test("Git ignore failure and timeout return an incomplete listing with no uncertain entries", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const source = sourceRepository(f.directory, "source");
  const binding = await f.manager.provision("git-ignore-failure", [
    { repositoryId: "repo", path: source },
  ]);
  assert.equal(binding.state, "ready");
  await writeFile(
    join(binding.repositories[0]!.workspacePath, "uncertain.log"),
    "ignored",
  );
  const current = currentFor(binding);
  const failed = await listWorkspaceDirectory(
    request(binding, { scope: { kind: "repository", repositoryId: "repo" } }),
    current,
    { gitExecutable: "/bin/sh" },
  );
  assert.equal(failed.state, "unavailable");
  assert.equal(failed.ignoreStatus, "incomplete");
  assert.deepEqual(failed.entries, []);

  const stalledGit = join(f.directory, "stall-git");
  writeFileSync(
    stalledGit,
    `#!/bin/sh\nexec "${process.execPath}" -e 'process.stdin.resume(); setInterval(() => {}, 1000)'\n`,
    { mode: 0o755 },
  );
  const timedOut = await listWorkspaceDirectory(
    request(binding, {
      scope: { kind: "repository", repositoryId: "repo" },
      showIgnored: true,
    }),
    current,
    { gitExecutable: stalledGit, gitIgnoreTimeoutMs: 20 },
  );
  assert.equal(timedOut.state, "unavailable");
  assert.equal(timedOut.ignoreStatus, "incomplete");
  assert.deepEqual(timedOut.entries, []);
});

test("directory and parent replacement during enumeration discard the observation", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const binding = await f.manager.provision("replacement-race");
  const current = currentFor(binding);
  await mkdir(join(binding.path, "nested"));
  await writeFile(join(binding.path, "nested", "result.txt"), "original");
  let replaced = false;
  const replacedDirectory = await listWorkspaceDirectory(
    request(binding, { path: ["nested"] }),
    current,
    {
      afterDirectoryOpen: async () => {
        if (replaced) return;
        replaced = true;
        await rename(
          join(binding.path, "nested"),
          join(binding.path, "nested-old"),
        );
        await mkdir(join(binding.path, "nested"));
        await writeFile(
          join(binding.path, "nested", "replacement.txt"),
          "replacement",
        );
      },
    },
  );
  assert.equal(replacedDirectory.state, "conflict");
  assert.deepEqual(replacedDirectory.entries, []);

  let rootReplaced = false;
  const replacedRoot = await listWorkspaceDirectory(request(binding), current, {
    afterDirectoryOpen: async () => {
      if (rootReplaced) return;
      rootReplaced = true;
      await rename(binding.path, `${binding.path}-old`);
      await mkdir(binding.path);
      await writeFile(
        join(binding.path, "replacement.txt"),
        "replacement root",
      );
    },
  });
  assert.equal(replacedRoot.state, "conflict");
  assert.deepEqual(replacedRoot.entries, []);
  await rm(`${binding.path}-old`, { recursive: true, force: true });
});

test("missing and held workspace bindings return safe availability states", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const absent = await f.manager.provision("absent-binding");
  const withoutBinding = async (): Promise<WorkspaceInspectionCurrent> => ({
    taskId: absent.taskId,
    taskVersion: 1,
    visibility: "missing-binding",
    controlPaths: [],
  });
  assert.equal(
    (await listWorkspaceDirectory(request(absent), withoutBinding)).state,
    "missing",
  );
  const missingPrivate = await listWorkspaceDirectory(
    request(absent, { path: [".ENV"] }),
    withoutBinding,
  );
  assert.equal(missingPrivate.state, "excluded");
  assert.deepEqual(missingPrivate.path, []);
  const missingPrivatePreview = await previewWorkspaceFile(
    request(absent, { path: [".ENV"] }),
    withoutBinding,
  );
  assert.equal(missingPrivatePreview.state, "excluded");
  assert.deepEqual(missingPrivatePreview.path, []);
  assert.equal(missingPrivatePreview.metadata, undefined);

  const held = await f.manager.provision("held-binding");
  await rm(held.path, { recursive: true, force: true });
  const heldCurrent = async (): Promise<WorkspaceInspectionCurrent> => ({
    taskId: held.taskId,
    taskVersion: 1,
    visibility: "held-binding",
    binding: { ...held, state: "held" },
    controlPaths: [],
  });
  assert.equal(
    (await listWorkspaceDirectory(request(held), heldCurrent)).state,
    "held",
  );
  const heldPrivate = await listWorkspaceDirectory(
    request(held, { path: [".env"] }),
    heldCurrent,
  );
  assert.equal(heldPrivate.state, "excluded");
  assert.deepEqual(heldPrivate.path, []);
  const heldPrivatePreview = await previewWorkspaceFile(
    request(held, { path: [".env"] }),
    heldCurrent,
  );
  assert.equal(heldPrivatePreview.state, "excluded");
  assert.deepEqual(heldPrivatePreview.path, []);
  assert.equal(heldPrivatePreview.metadata, undefined);

  const heldControl = await f.manager.provision("held-control-path");
  const controlPath = join(heldControl.path, "operator.auth");
  await writeFile(controlPath, "DUMMY_PRIVATE_VALUE");
  const heldControlCurrent = async (): Promise<WorkspaceInspectionCurrent> => ({
    taskId: heldControl.taskId,
    taskVersion: 1,
    visibility: "held-control-path",
    binding: { ...heldControl, state: "held" },
    controlPaths: [controlPath],
  });
  const heldControlListing = await listWorkspaceDirectory(
    request(heldControl, { path: ["operator.auth"] }),
    heldControlCurrent,
  );
  assert.equal(heldControlListing.state, "excluded");
  assert.deepEqual(heldControlListing.path, []);
  const heldControlPreview = await previewWorkspaceFile(
    request(heldControl, { path: ["operator.auth"] }),
    heldControlCurrent,
  );
  assert.equal(heldControlPreview.state, "excluded");
  assert.deepEqual(heldControlPreview.path, []);
  assert.equal(heldControlPreview.metadata, undefined);

  const missingRoot = await f.manager.provision("missing-root");
  await rm(missingRoot.path, { recursive: true, force: true });
  assert.equal(
    (
      await listWorkspaceDirectory(
        request(missingRoot),
        currentFor(missingRoot),
      )
    ).state,
    "missing",
  );

  const archived = await f.manager.provision("archived-binding");
  await rm(archived.path, { recursive: true, force: true });
  const archivedCurrent = async (): Promise<WorkspaceInspectionCurrent> => ({
    taskId: archived.taskId,
    taskVersion: 1,
    visibility: "archived-binding",
    binding: { ...archived, state: "archived" },
    controlPaths: [],
  });
  assert.equal(
    (await listWorkspaceDirectory(request(archived), archivedCurrent)).state,
    "archived",
  );
});

function png(width: number, height: number) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gif(width: number, height: number) {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpeg(width: number, height: number) {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

function webp(width: number, height: number) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

test("bounded previews return inert UTF-8 or correctly typed raster and PDF data", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const binding = await f.manager.provision("preview-formats");
  const current = currentFor(binding);
  const html =
    "<!doctype html><script>document.body.textContent = 'source only'</script>";
  await writeFile(join(binding.path, "page.html"), html);
  const text = await previewWorkspaceFile(
    request(binding, { path: ["page.html"] }),
    current,
  );
  assert.equal(text.state, "ready");
  assert.equal(text.preview?.kind, "text");
  if (text.preview?.kind === "text") {
    assert.equal(text.preview.mime, "text/html; charset=utf-8");
    assert.equal(text.preview.text, html);
    assert.equal(
      text.preview.sha256,
      createHash("sha256").update(html).digest("hex"),
    );
    assert.equal(text.preview.size, Buffer.byteLength(html));
  }

  const formats = [
    ["image.png", png(3, 2), "image/png", 3, 2],
    ["image.gif", gif(4, 5), "image/gif", 4, 5],
    ["image.jpeg", jpeg(6, 7), "image/jpeg", 6, 7],
    ["image.webp", webp(8, 9), "image/webp", 8, 9],
  ] as const;
  for (const [name, bytes, mime, width, height] of formats) {
    await writeFile(join(binding.path, name), bytes);
    const preview = await previewWorkspaceFile(
      request(binding, { path: [name] }),
      current,
    );
    assert.equal(preview.state, "ready", name);
    assert.equal(preview.preview?.kind, "base64", name);
    if (preview.preview?.kind === "base64") {
      assert.equal(preview.preview.mime, mime, name);
      assert.equal(preview.preview.data, bytes.toString("base64"), name);
      assert.equal(preview.preview.width, width, name);
      assert.equal(preview.preview.height, height, name);
      assert.equal(
        preview.preview.sha256,
        createHash("sha256").update(bytes).digest("hex"),
        name,
      );
    }
  }

  const pdf = Buffer.from(
    "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n",
  );
  await writeFile(join(binding.path, "document.pdf"), pdf);
  const pdfPreview = await previewWorkspaceFile(
    request(binding, { path: ["document.pdf"] }),
    current,
  );
  assert.equal(pdfPreview.state, "ready");
  assert.equal(pdfPreview.preview?.kind, "base64");
  if (pdfPreview.preview?.kind === "base64") {
    assert.equal(pdfPreview.preview.mime, "application/pdf");
    assert.equal(pdfPreview.preview.data, pdf.toString("base64"));
    assert.equal(
      pdfPreview.preview.maxDisplayedPages,
      inspectionLimits.maxPdfDisplayedPages,
    );
  }
  assert.equal(JSON.stringify(pdfPreview).includes("file://"), false);
});

test("unsupported, binary, oversized, private, symlink and hard-link previews never return bytes", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const binding = await f.manager.provision("preview-limits");
  const current = currentFor(binding);
  await writeFile(
    join(binding.path, "script.svg"),
    "<svg><script>alert(1)</script></svg>",
  );
  await writeFile(join(binding.path, "binary.bin"), Buffer.from([0, 255, 1]));
  await writeFile(
    join(binding.path, "large.txt"),
    Buffer.alloc(inspectionLimits.maxTextBytes + 1, 97),
  );
  await writeFile(join(binding.path, "large.png"), png(1, 1));
  await truncate(
    join(binding.path, "large.png"),
    inspectionLimits.maxImageOrPdfBytes + 1,
  );
  await writeFile(join(binding.path, "large-dimensions.png"), png(5000, 5000));
  await writeFile(join(binding.path, ".env"), "private-preview-content");
  const normal = join(binding.path, "normal.txt");
  await writeFile(normal, "hard-linked-content");
  await hardLink(normal, join(binding.path, "hard-link.txt"));
  await symlink(normal, join(binding.path, "linked.txt"));
  await writeFile(join(binding.path, "mismatched.png"), "not a PNG");

  const unsupported = await previewWorkspaceFile(
    request(binding, { path: ["script.svg"] }),
    current,
  );
  assert.equal(unsupported.state, "metadata-only");
  assert.equal(unsupported.metadata?.reason, "unsupported-format");
  assert.equal(unsupported.preview, undefined);
  const binary = await previewWorkspaceFile(
    request(binding, { path: ["binary.bin"] }),
    current,
  );
  assert.equal(binary.state, "metadata-only");
  assert.equal(binary.metadata?.reason, "binary-content");
  assert.equal(binary.preview, undefined);
  const largeText = await previewWorkspaceFile(
    request(binding, { path: ["large.txt"] }),
    current,
  );
  assert.equal(largeText.state, "metadata-only");
  assert.equal(largeText.metadata?.reason, "too-large");
  assert.equal(largeText.preview, undefined);
  const largeImage = await previewWorkspaceFile(
    request(binding, { path: ["large.png"] }),
    current,
  );
  assert.equal(largeImage.state, "metadata-only");
  assert.equal(largeImage.metadata?.reason, "too-large");
  assert.equal(largeImage.preview, undefined);
  const dimensions = await previewWorkspaceFile(
    request(binding, { path: ["large-dimensions.png"] }),
    current,
  );
  assert.equal(dimensions.state, "metadata-only");
  assert.equal(dimensions.metadata?.reason, "image-dimensions-exceed-limit");
  assert.equal(dimensions.preview, undefined);
  const privateFile = await previewWorkspaceFile(
    request(binding, { path: [".env"] }),
    current,
  );
  assert.equal(privateFile.state, "excluded");
  assert.equal(privateFile.preview, undefined);
  assert.deepEqual(privateFile.path, []);
  const hardLinkPreview = await previewWorkspaceFile(
    request(binding, { path: ["hard-link.txt"] }),
    current,
  );
  assert.equal(hardLinkPreview.state, "unavailable");
  assert.equal(hardLinkPreview.metadata?.reason, "multiple-links");
  assert.equal(hardLinkPreview.preview, undefined);
  const linked = await previewWorkspaceFile(
    request(binding, { path: ["linked.txt"] }),
    current,
  );
  assert.equal(linked.state, "unavailable");
  assert.equal(linked.preview, undefined);
  const mismatch = await previewWorkspaceFile(
    request(binding, { path: ["mismatched.png"] }),
    current,
  );
  assert.equal(mismatch.state, "metadata-only");
  assert.equal(mismatch.metadata?.reason, "invalid-content");
  assert.equal(mismatch.preview, undefined);
});

test("file replacement and binding changes after no-follow open discard preview bytes", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const binding = await f.manager.provision("preview-race");
  const path = join(binding.path, "changing.md");
  await writeFile(path, "original secret-shaped text");
  const current = currentFor(binding);
  let replaced = false;
  const changedFile = await previewWorkspaceFile(
    request(binding, { path: ["changing.md"] }),
    current,
    {
      afterFileOpen: async () => {
        if (replaced) return;
        replaced = true;
        await rename(path, `${path}-old`);
        await writeFile(path, "replacement secret-shaped text");
      },
    },
  );
  assert.equal(changedFile.state, "conflict");
  assert.equal(changedFile.preview, undefined);
  assert.equal(JSON.stringify(changedFile).includes("secret-shaped"), false);

  let version = 1;
  const changedBinding = async (): Promise<WorkspaceInspectionCurrent> => ({
    taskId: binding.taskId,
    taskVersion: version,
    visibility: "preview-binding-change",
    binding,
    controlPaths: [],
  });
  const changed = await previewWorkspaceFile(
    request(binding, { path: ["changing.md-old"] }),
    changedBinding,
    {
      afterFileOpen: async () => {
        version++;
      },
    },
  );
  assert.equal(changed.state, "conflict");
  assert.equal(changed.preview, undefined);
});

test("parent and root replacement, truncation, and late hard links discard preview bytes", async (t) => {
  const f = fixture();
  t.after(() => f.close());

  const parentBinding = await f.manager.provision("preview-parent-replacement");
  const parent = join(parentBinding.path, "nested");
  await mkdir(parent);
  const parentFile = join(parent, "parent.md");
  await writeFile(parentFile, "DUMMY_PRIVATE_VALUE parent replacement");
  let parentReplaced = false;
  const parentResult = await previewWorkspaceFile(
    request(parentBinding, { path: ["nested", "parent.md"] }),
    currentFor(parentBinding),
    {
      afterFileOpen: async () => {
        if (parentReplaced) return;
        parentReplaced = true;
        await rename(parent, `${parent}-old`);
        await mkdir(parent);
        await writeFile(join(parent, "replacement.md"), "replacement");
      },
    },
  );
  assert.equal(parentResult.state, "conflict");
  assert.equal(parentResult.preview, undefined);
  assert.ok(!JSON.stringify(parentResult).includes("DUMMY_PRIVATE_VALUE"));

  const rootBinding = await f.manager.provision("preview-root-replacement");
  const rootFile = join(rootBinding.path, "root.md");
  await writeFile(rootFile, "DUMMY_PRIVATE_VALUE root replacement");
  let rootReplaced = false;
  const rootResult = await previewWorkspaceFile(
    request(rootBinding, { path: ["root.md"] }),
    currentFor(rootBinding),
    {
      afterFileOpen: async () => {
        if (rootReplaced) return;
        rootReplaced = true;
        await rename(rootBinding.path, `${rootBinding.path}-old`);
        await mkdir(rootBinding.path);
        await writeFile(
          join(rootBinding.path, "replacement.md"),
          "replacement",
        );
      },
    },
  );
  assert.equal(rootResult.state, "conflict");
  assert.equal(rootResult.preview, undefined);
  assert.ok(!JSON.stringify(rootResult).includes("DUMMY_PRIVATE_VALUE"));

  const truncatedBinding = await f.manager.provision("preview-truncation");
  const truncatedPath = join(truncatedBinding.path, "truncated.md");
  await writeFile(truncatedPath, "DUMMY_PRIVATE_VALUE before truncation");
  let truncated = false;
  const truncatedResult = await previewWorkspaceFile(
    request(truncatedBinding, { path: ["truncated.md"] }),
    currentFor(truncatedBinding),
    {
      afterFileOpen: async () => {
        if (truncated) return;
        truncated = true;
        await truncate(truncatedPath, 0);
      },
    },
  );
  assert.equal(truncatedResult.state, "conflict");
  assert.equal(truncatedResult.preview, undefined);
  assert.ok(!JSON.stringify(truncatedResult).includes("DUMMY_PRIVATE_VALUE"));

  const grownBinding = await f.manager.provision("preview-growth");
  const grownPath = join(grownBinding.path, "grown.md");
  await writeFile(grownPath, "DUMMY_PRIVATE_VALUE before growth");
  let grown = false;
  const grownResult = await previewWorkspaceFile(
    request(grownBinding, { path: ["grown.md"] }),
    currentFor(grownBinding),
    {
      afterFileOpen: async () => {
        if (grown) return;
        grown = true;
        await appendFile(grownPath, " after growth");
      },
    },
  );
  assert.equal(grownResult.state, "conflict");
  assert.equal(grownResult.preview, undefined);
  assert.ok(!JSON.stringify(grownResult).includes("DUMMY_PRIVATE_VALUE"));

  const linkedBinding = await f.manager.provision("preview-late-hardlink");
  const linkedPath = join(linkedBinding.path, "linked.md");
  await writeFile(linkedPath, "DUMMY_PRIVATE_VALUE before hard link");
  let linked = false;
  const linkedResult = await previewWorkspaceFile(
    request(linkedBinding, { path: ["linked.md"] }),
    currentFor(linkedBinding),
    {
      afterFileOpen: async () => {
        if (linked) return;
        linked = true;
        await hardLink(linkedPath, join(linkedBinding.path, "late-link.md"));
      },
    },
  );
  assert.equal(linkedResult.state, "conflict");
  assert.equal(linkedResult.preview, undefined);
  assert.ok(!JSON.stringify(linkedResult).includes("DUMMY_PRIVATE_VALUE"));
});
