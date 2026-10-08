import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/core/store.js";
import { SqliteWorkspaceComparisonStore } from "../src/standalone/comparison-store.js";
import {
  compareRepository,
  compareWorkspaceTurnObservations,
  observeWorkspaceTurn,
  type WorkspaceComparisonSideContent,
  type WorkspaceComparisonSnapshot,
  workspaceComparisonLimits,
} from "../src/standalone/workspace-comparison.js";
import type { WorkspaceInspectionCurrent } from "../src/standalone/workspace-inspection.js";
import {
  SqliteWorkspaceBindingStore,
  type TaskWorkspaceBinding,
  WorkspaceManager,
} from "../src/standalone/workspaces.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ensemble-comparison-"));
  const db = new DatabaseSync(join(root, "standalone.sqlite"));
  new Store(db).ensureHost("workspace-comparison-test");
  const manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    join(root, "task-workspaces"),
  );
  const source = join(root, "source-repository");
  mkdirSync(source, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", source]);
  git(source, "config", "user.name", "Workspace Comparison Test");
  git(source, "config", "user.email", "workspace-comparison@example.invalid");
  writeFileSync(join(source, ".gitignore"), "*.log\n");
  writeFileSync(
    join(source, "README.md"),
    "first line\nkeep line\nlast line\n",
  );
  writeFileSync(join(source, "staged.md"), "staged before\n");
  writeFileSync(join(source, "unstaged.md"), "unstaged before\n");
  writeFileSync(join(source, "delete.md"), "delete this\n");
  writeFileSync(
    join(source, "rename-old.md"),
    "rename line 1\nrename line 2\nrename line 3\nrename line 4\n",
  );
  writeFileSync(
    join(source, "rename-same-old.md"),
    "same rename line 1\nsame rename line 2\nsame rename line 3\n",
  );
  writeFileSync(join(source, "committed.md"), "committed before\n");
  writeFileSync(
    join(source, "bom.md"),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("baseline BOM\n"),
    ]),
  );
  writeFileSync(join(source, "binary.bin"), Buffer.from([0, 1, 255, 12]));
  writeFileSync(join(source, "picture.png"), "not a real png\n");
  writeFileSync(join(source, ".env"), "DUMMY_SENSITIVE_BEFORE\n");
  writeFileSync(join(source, "control.txt"), "DUMMY_CONTROL_BEFORE\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "initial workspace");
  const binding = await manager.provision("comparison-task", [
    { repositoryId: "owner/repository", path: source },
  ]);
  const repository = binding.repositories[0];
  assert.ok(repository);
  const current = async (): Promise<WorkspaceInspectionCurrent> => ({
    taskId: binding.taskId,
    taskVersion: 1,
    visibility: "workspace-comparison-test",
    binding,
    controlPaths: [join(repository.workspacePath, "control.txt")],
  });
  return {
    root,
    db,
    source,
    binding,
    repository,
    current,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function entry(
  snapshot: WorkspaceComparisonSnapshot,
  path: string,
  changeSet?: "branch" | "staged" | "unstaged",
) {
  return snapshot.entries.find(
    (item) =>
      item.path === path &&
      (changeSet === undefined || item.changeSet === changeSet),
  );
}

function executable(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

test("comparison Git reads disable configured filesystem monitors", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  writeFileSync(join(repo, "staged.md"), "staged after\n");
  git(repo, "add", "staged.md");
  writeFileSync(join(repo, "unstaged.md"), "unstaged after\n");
  writeFileSync(join(repo, "untracked.md"), "untracked after\n");

  const marker = join(f.root, "fsmonitor-invoked");
  const monitor = executable(
    f.root,
    "fsmonitor-hook",
    `#!/bin/sh\nprintf x >> "$FS_MONITOR_MARKER"\nprintf 'token\\000'\n`,
  );
  git(repo, "config", "core.fsmonitor", monitor);
  const previousMarker = process.env.FS_MONITOR_MARKER;
  process.env.FS_MONITOR_MARKER = marker;
  let comparison: WorkspaceComparisonSnapshot;
  try {
    comparison = await compareRepository(
      {
        taskId: f.binding.taskId,
        repositoryId: f.repository.repositoryId,
        target: "uncommitted",
        changeSet: "all",
      },
      f.current,
    );
  } finally {
    if (previousMarker === undefined) delete process.env.FS_MONITOR_MARKER;
    else process.env.FS_MONITOR_MARKER = previousMarker;
  }

  assert.equal(comparison.state, "available");
  assert.ok(entry(comparison, "staged.md", "staged"));
  assert.ok(entry(comparison, "unstaged.md", "unstaged"));
  assert.ok(entry(comparison, "untracked.md", "unstaged"));
  assert.equal(existsSync(marker), false, "configured fsmonitor hook ran");
});

test("working-tree comparisons disable configured clean and process filters", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  writeFileSync(
    join(repo, ".gitattributes"),
    "clean.txt filter=cleanprobe\nprocess.txt filter=processprobe\n",
  );
  writeFileSync(join(repo, "clean.txt"), "clean before\n");
  writeFileSync(join(repo, "process.txt"), "process before\n");
  git(repo, "add", ".gitattributes", "clean.txt", "process.txt");
  git(repo, "commit", "--quiet", "-m", "add filter fixture files");

  const marker = join(f.root, "filter-invoked");
  const clean = executable(
    f.root,
    "filter-clean-hook",
    `#!/bin/sh\nprintf C >> "$ENSEMBLE_FILTER_MARKER"\ncat\n`,
  );
  const processHook = executable(
    f.root,
    "filter-process-hook",
    `#!/bin/sh\nprintf P >> "$ENSEMBLE_FILTER_MARKER"\nexit 0\n`,
  );
  git(repo, "config", "filter.cleanprobe.clean", clean);
  git(repo, "config", "filter.cleanprobe.required", "true");
  git(repo, "config", "filter.processprobe.process", processHook);
  git(repo, "config", "filter.processprobe.required", "true");
  writeFileSync(join(repo, "clean.txt"), "clean after\n");
  writeFileSync(join(repo, "process.txt"), "process after\n");

  const previousMarker = process.env.ENSEMBLE_FILTER_MARKER;
  process.env.ENSEMBLE_FILTER_MARKER = marker;
  let comparison: WorkspaceComparisonSnapshot;
  try {
    const diff = [
      "-C",
      repo,
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      "--find-renames=50%",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ];
    const cleanControl = spawnSync("git", [...diff, "clean.txt"], {
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(cleanControl.status, 0, cleanControl.stderr);
    assert.equal(
      existsSync(marker),
      true,
      "clean positive control did not run",
    );
    assert.equal(
      readFileSync(marker, "utf8").includes("C"),
      true,
      "clean hook was not exercised",
    );
    unlinkSync(marker);

    const processControl = spawnSync("git", [...diff, "process.txt"], {
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(processControl.error, undefined);
    assert.equal(
      existsSync(marker),
      true,
      "process positive control did not run",
    );
    assert.equal(
      readFileSync(marker, "utf8").includes("P"),
      true,
      "process hook was not exercised",
    );
    unlinkSync(marker);

    comparison = await compareRepository(
      {
        taskId: f.binding.taskId,
        repositoryId: f.repository.repositoryId,
        target: "uncommitted",
        changeSet: "unstaged",
      },
      f.current,
    );
  } finally {
    if (previousMarker === undefined) delete process.env.ENSEMBLE_FILTER_MARKER;
    else process.env.ENSEMBLE_FILTER_MARKER = previousMarker;
  }

  assert.equal(comparison.state, "available");
  assert.ok(entry(comparison, "clean.txt", "unstaged"));
  assert.ok(entry(comparison, "process.txt", "unstaged"));
  assert.equal(
    existsSync(marker),
    false,
    "comparison invoked a configured filter",
  );
});

test("comparison ignores an inherited alternate index and reads the bound index", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  writeFileSync(join(repo, "staged.md"), "staged after\n");
  git(repo, "add", "staged.md");

  const actualIndexPath = git(repo, "rev-parse", "--git-path", "index");
  const actualIndexBefore = readFileSync(actualIndexPath);
  const alternateIndexPath = join(f.root, "alternate.index");
  execFileSync("git", ["-C", repo, "read-tree", "HEAD"], {
    env: { ...process.env, GIT_INDEX_FILE: alternateIndexPath },
  });
  const alternateIndexBefore = readFileSync(alternateIndexPath);
  const previousIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternateIndexPath;
  let comparison: WorkspaceComparisonSnapshot;
  try {
    comparison = await compareRepository(
      {
        taskId: f.binding.taskId,
        repositoryId: f.repository.repositoryId,
        target: "uncommitted",
        changeSet: "all",
      },
      f.current,
    );
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  }

  assert.equal(comparison.state, "available");
  const staged = entry(comparison, "staged.md", "staged");
  assert.ok(staged, "comparison must use the repository's bound index");
  assert.equal(staged.right?.sha256, digest("staged after\n"));
  assert.equal(readFileSync(actualIndexPath).equals(actualIndexBefore), true);
  assert.equal(
    readFileSync(alternateIndexPath).equals(alternateIndexBefore),
    true,
  );
});

test("comparison refuses a missing promisor object without invoking a remote helper", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  const helperDirectory = join(f.root, "promisor-helpers");
  mkdirSync(helperDirectory);
  executable(
    helperDirectory,
    "git-remote-marker",
    `#!/bin/sh\nprintf x >> "$PROMISOR_HELPER_MARKER"\nexit 1\n`,
  );

  git(repo, "config", "extensions.partialClone", "origin");
  git(repo, "config", "remote.origin.promisor", "true");
  git(repo, "config", "remote.origin.url", `marker::${f.root}`);
  git(repo, "config", "protocol.marker.allow", "always");
  const missingObject = execFileSync(
    "git",
    ["-C", repo, "hash-object", "--stdin"],
    {
      input: "promisor fixture object is deliberately absent\n",
      encoding: "utf8",
    },
  ).trim();
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "update-index",
      "--cacheinfo",
      `100644,${missingObject},README.md`,
    ],
    {
      env: {
        ...process.env,
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_LAZY_FETCH: "1",
      },
    },
  );

  const marker = join(f.root, "promisor-helper-invoked");
  const helperPath = [helperDirectory, process.env.PATH ?? ""].join(delimiter);
  const probe = spawnSync(
    "git",
    ["-C", repo, "cat-file", "-s", missingObject],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: helperPath,
        PROMISOR_HELPER_MARKER: marker,
      },
    },
  );
  assert.notEqual(probe.status, 0);
  assert.equal(existsSync(marker), true, "positive control did not run helper");
  unlinkSync(marker);

  const previousPath = process.env.PATH;
  const previousMarker = process.env.PROMISOR_HELPER_MARKER;
  process.env.PATH = helperPath;
  process.env.PROMISOR_HELPER_MARKER = marker;
  let comparison: WorkspaceComparisonSnapshot;
  try {
    comparison = await compareRepository(
      {
        taskId: f.binding.taskId,
        repositoryId: f.repository.repositoryId,
        target: "uncommitted",
        changeSet: "staged",
      },
      f.current,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.PROMISOR_HELPER_MARKER;
    else process.env.PROMISOR_HELPER_MARKER = previousMarker;
  }

  assert.equal(comparison.state, "gap");
  assert.equal(existsSync(marker), false, "comparison invoked remote helper");
});

test("comparison reads original object bytes when replacement refs exist", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  const originalBytes = Buffer.from("first line\nkeep line\nlast line\n");
  const originalObject = git(repo, "rev-parse", "HEAD:README.md");
  const replacementObject = execFileSync(
    "git",
    ["-C", repo, "hash-object", "-w", "--stdin"],
    { input: "replacement ref content\n", encoding: "utf8" },
  ).trim();
  git(repo, "replace", originalObject, replacementObject);
  writeFileSync(
    join(repo, "README.md"),
    "first line\nchanged line\nlast line\n",
  );

  const comparison = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "unstaged",
    },
    f.current,
  );

  assert.equal(comparison.state, "available");
  const readme = entry(comparison, "README.md", "unstaged");
  assert.ok(readme);
  assert.equal(readme.left?.sha256, digest(originalBytes));
  assert.notEqual(readme.left?.sha256, digest("replacement ref content\n"));
});

test("CRLF-to-LF edits preserve line endings, content hashes, anchors, and EOF markers", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  git(repo, "config", "core.autocrlf", "false");
  const leftBytes = Buffer.from("stable\nchanged\r\nEOF-no-newline");
  const rightBytes = Buffer.from("stable\nchanged\nEOF-no-newline");
  writeFileSync(join(repo, "line-ending.md"), leftBytes);
  git(repo, "add", "line-ending.md");
  git(repo, "commit", "--quiet", "-m", "add CRLF comparison fixture");
  writeFileSync(join(repo, "line-ending.md"), rightBytes);

  const comparison = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "unstaged",
    },
    f.current,
  );

  assert.equal(comparison.state, "available");
  const changed = entry(comparison, "line-ending.md", "unstaged");
  assert.ok(changed);
  assert.equal(changed.left?.sha256, digest(leftBytes));
  assert.equal(changed.right?.sha256, digest(rightBytes));
  const hunk = changed.hunks[0];
  assert.ok(hunk);
  assert.equal(hunk.patch.includes("-changed\r\n+changed\n"), true);
  assert.equal(
    hunk.patch.includes(" EOF-no-newline\n\\ No newline at end of file\n"),
    true,
  );
  assert.deepEqual(
    [hunk.leftAnchor?.startLine, hunk.leftAnchor?.endLine],
    [2, 2],
  );
  assert.deepEqual(
    [hunk.rightAnchor?.startLine, hunk.rightAnchor?.endLine],
    [2, 2],
  );
  assert.equal(hunk.leftAnchor?.contentSha256, digest(leftBytes));
  assert.equal(hunk.rightAnchor?.contentSha256, digest(rightBytes));
  assert.equal(changed.diff?.includes("-changed\r\n+changed\n"), true);
});

test("Branch compares each repository to an explicit merge base and exposes exact text and rename anchors", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  const initial = f.repository.commit;
  assert.ok(initial);

  git(repo, "mv", "rename-old.md", "rename-new.md");
  git(repo, "mv", "rename-same-old.md", "rename-same-new.md");
  writeFileSync(
    join(repo, "rename-new.md"),
    "rename line 1\nrenamed line two\nrename line 3\nrename line 4\n",
  );
  writeFileSync(join(repo, "committed.md"), "committed after branch\n");
  writeFileSync(
    join(repo, "bom.md"),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("working BOM\n"),
    ]),
  );
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "committed changes");
  writeFileSync(
    join(repo, "README.md"),
    "first line\nchanged line\nlast line\n",
  );
  writeFileSync(join(repo, "staged.md"), "staged after\n");
  git(repo, "add", "staged.md");
  writeFileSync(join(repo, "unstaged.md"), "unstaged after\n");
  unlinkSync(join(repo, "delete.md"));
  writeFileSync(join(repo, "new-file.md"), "new file\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 2, 255, 13]));
  writeFileSync(join(repo, "picture.png"), "unsupported image bytes\n");
  writeFileSync(join(repo, ".env"), "DUMMY_SENSITIVE_AFTER\n");
  writeFileSync(join(repo, "control.txt"), "DUMMY_CONTROL_AFTER\n");
  writeFileSync(join(repo, "ignored.log"), "DUMMY_IGNORED_AFTER\n");
  const indexPath = git(repo, "rev-parse", "--git-path", "index");
  const indexBefore = readFileSync(indexPath);
  const headBefore = git(repo, "rev-parse", "HEAD");
  const opened: string[] = [];
  const exportedSides = new Map<
    number,
    Partial<Record<"left" | "right", string>>
  >();

  const comparison = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "branch",
      baseBranch: "main",
    },
    f.current,
    {
      afterWorkingFileOpen: async (path) => {
        opened.push(path);
      },
      captureSideContent: (entryIndex, side, text) => {
        const current = exportedSides.get(entryIndex) ?? {};
        current[side] = text;
        exportedSides.set(entryIndex, current);
      },
    },
  );

  assert.equal(comparison.state, "available");
  assert.deepEqual(comparison.baseline, {
    kind: "merge-base",
    branch: "main",
    commit: initial,
  });
  assert.ok(comparison.observedAt > 0);
  assert.equal(comparison.truncated, false);
  assert.equal(readFileSync(indexPath).equals(indexBefore), true);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);

  const readme = entry(comparison, "README.md");
  assert.ok(readme);
  assert.equal(readme.state, "text");
  assert.equal(
    readme.left?.sha256,
    digest("first line\nkeep line\nlast line\n"),
  );
  assert.equal(
    readme.right?.sha256,
    digest("first line\nchanged line\nlast line\n"),
  );
  assert.match(readme.diff ?? "", /-keep line/);
  assert.match(readme.diff ?? "", /\+changed line/);
  const readmeHunk = readme.hunks[0];
  assert.ok(readmeHunk?.leftAnchor);
  assert.ok(readmeHunk.rightAnchor);
  assert.deepEqual(
    [readmeHunk.leftAnchor.startLine, readmeHunk.leftAnchor.endLine],
    [2, 2],
  );
  assert.equal(readmeHunk.leftAnchor.contentSha256, readme.left.sha256);
  assert.equal(readmeHunk.rightAnchor.contentSha256, readme.right?.sha256);
  assert.equal(readmeHunk.leftAnchor.comparisonId, comparison.comparisonId);

  const bom = entry(comparison, "bom.md");
  assert.ok(bom);
  const bomIndex = comparison.entries.indexOf(bom);
  const bomSides = exportedSides.get(bomIndex);
  assert.equal(
    bom?.left?.sha256,
    digest(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("baseline BOM\n"),
      ]),
    ),
  );
  assert.equal(
    bom?.right?.sha256,
    digest(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("working BOM\n"),
      ]),
    ),
  );
  assert.equal(
    digest(Buffer.from(bomSides?.left ?? "", "utf8")),
    bom?.left?.sha256,
  );
  assert.equal(
    digest(Buffer.from(bomSides?.right ?? "", "utf8")),
    bom?.right?.sha256,
  );

  const renamed = entry(comparison, "rename-new.md");
  assert.ok(renamed);
  assert.equal(renamed.change, "renamed");
  assert.equal(renamed.previousPath, "rename-old.md");
  assert.equal(renamed.hunks[0]?.leftAnchor?.path, "rename-old.md");
  assert.equal(renamed.hunks[0]?.rightAnchor?.path, "rename-new.md");
  const sameContentRename = entry(comparison, "rename-same-new.md");
  assert.ok(sameContentRename);
  assert.equal(sameContentRename.change, "renamed");
  assert.equal(sameContentRename.previousPath, "rename-same-old.md");
  assert.deepEqual(sameContentRename.hunks, []);

  const exportedSideContent = [...exportedSides].map(
    ([entryIndex, content]) => ({
      entryIndex,
      ...(content.left === undefined ? {} : { leftText: content.left }),
      ...(content.right === undefined ? {} : { rightText: content.right }),
    }),
  );
  const comparisonStore = new SqliteWorkspaceComparisonStore(f.db);
  comparisonStore.replaceCurrentComparison(comparison, exportedSideContent);
  const storedRename = comparisonStore.comparisonById(
    comparison.taskId,
    comparison.comparisonId,
  );
  assert.ok(storedRename);
  assert.equal(
    storedRename.comparison.entries.find((item) => item.path === "delete.md")
      ?.hunks[0]?.leftAnchor?.path,
    "delete.md",
  );

  const invalidRenamePath = structuredClone(comparison);
  const invalidLeft = invalidRenamePath.entries.find(
    (item) => item.path === "rename-new.md",
  )?.hunks[0]?.leftAnchor;
  assert.ok(invalidLeft);
  invalidLeft.path = "rename-new.md";
  assert.throws(
    () =>
      comparisonStore.replaceCurrentComparison(
        invalidRenamePath,
        exportedSideContent,
      ),
    /comparison-anchor-content-mismatch/,
  );

  const invalidAnchorSide = structuredClone(comparison);
  const invalidRight = invalidAnchorSide.entries.find(
    (item) => item.path === "rename-new.md",
  )?.hunks[0]?.rightAnchor;
  assert.ok(invalidRight);
  invalidRight.side = "left";
  assert.throws(
    () =>
      comparisonStore.replaceCurrentComparison(
        invalidAnchorSide,
        exportedSideContent,
      ),
    /comparison-anchor-content-mismatch/,
  );

  const deleted = entry(comparison, "delete.md");
  assert.equal(deleted?.change, "deleted");
  assert.ok(deleted?.hunks[0]?.leftAnchor);
  assert.equal(deleted?.hunks[0]?.rightAnchor, undefined);
  assert.equal(entry(comparison, "new-file.md")?.change, "added");
  assert.equal(entry(comparison, "binary.bin")?.state, "binary");
  assert.equal(entry(comparison, "picture.png")?.state, "unsupported");
  assert.equal(entry(comparison, "ignored.log"), undefined);
  assert.equal(entry(comparison, ".env"), undefined);
  assert.equal(entry(comparison, "control.txt"), undefined);
  assert.equal(
    opened.some((path) => path.endsWith("/.env")),
    false,
  );
  assert.equal(
    opened.some((path) => path.endsWith("/control.txt")),
    false,
  );
  const serialized = JSON.stringify(comparison);
  for (const value of [
    ".env",
    "control.txt",
    "ignored.log",
    "DUMMY_SENSITIVE_AFTER",
    "DUMMY_CONTROL_AFTER",
    "DUMMY_IGNORED_AFTER",
    f.repository.workspacePath,
  ])
    assert.equal(serialized.includes(value), false, value);
});

test("Uncommitted staged and unstaged filters use the index and working tree without mutation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  writeFileSync(join(repo, "staged.md"), "staged after\n");
  git(repo, "add", "staged.md");
  writeFileSync(join(repo, "unstaged.md"), "unstaged after\n");
  unlinkSync(join(repo, "delete.md"));
  writeFileSync(join(repo, "untracked.md"), "untracked content\n");
  const indexPath = git(repo, "rev-parse", "--git-path", "index");
  const indexBefore = readFileSync(indexPath);
  const headBefore = git(repo, "rev-parse", "HEAD");
  const stagedBefore = git(repo, "diff", "--cached", "--raw", "--no-abbrev");
  const unstagedBefore = git(repo, "diff", "--raw", "--no-abbrev");

  const staged = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "staged",
    },
    f.current,
  );
  assert.equal(staged.state, "available");
  assert.deepEqual(staged.baseline, {
    kind: "head",
    commit: f.repository.commit,
  });
  assert.ok(entry(staged, "staged.md", "staged"));
  assert.equal(entry(staged, "unstaged.md"), undefined);
  assert.equal(entry(staged, "untracked.md"), undefined);

  const unstaged = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "unstaged",
    },
    f.current,
  );
  assert.equal(unstaged.state, "available");
  assert.equal(entry(unstaged, "staged.md"), undefined);
  assert.ok(entry(unstaged, "unstaged.md", "unstaged"));
  assert.ok(entry(unstaged, "delete.md", "unstaged"));
  assert.ok(entry(unstaged, "untracked.md", "unstaged"));

  const all = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "all",
    },
    f.current,
  );
  assert.equal(all.state, "available");
  assert.ok(entry(all, "staged.md", "staged"));
  assert.ok(entry(all, "unstaged.md", "unstaged"));
  assert.equal(readFileSync(indexPath).equals(indexBefore), true);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(
    git(repo, "diff", "--cached", "--raw", "--no-abbrev"),
    stagedBefore,
  );
  assert.equal(git(repo, "diff", "--raw", "--no-abbrev"), unstagedBefore);
});

test("Branch requires explicit local base selection and reports missing merge bases", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const request = {
    taskId: f.binding.taskId,
    repositoryId: f.repository.repositoryId,
    target: "branch" as const,
  };
  const missingSelection = await compareRepository(request, f.current);
  assert.equal(missingSelection.state, "unavailable");
  assert.equal(missingSelection.reason, "base-branch-required");
  assert.deepEqual(missingSelection.availableBaseBranches, ["main"]);

  const missingBranch = await compareRepository(
    { ...request, baseBranch: "not-present" },
    f.current,
  );
  assert.equal(missingBranch.state, "unavailable");
  assert.equal(missingBranch.reason, "base-branch-unavailable");

  const repo = f.repository.workspacePath;
  const emptyTree = execFileSync("git", ["-C", repo, "mktree"], {
    input: Buffer.alloc(0),
    encoding: "utf8",
  }).trim();
  const disconnected = execFileSync(
    "git",
    ["-C", repo, "commit-tree", emptyTree, "-m", "disconnected"],
    { encoding: "utf8" },
  ).trim();
  git(repo, "update-ref", "refs/heads/disconnected", disconnected);
  git(repo, "checkout", "--detach", disconnected);
  const noMergeBase = await compareRepository(
    { ...request, baseBranch: "main" },
    f.current,
  );
  assert.equal(noMergeBase.state, "unavailable");
  assert.equal(noMergeBase.reason, "no-merge-base");
  assert.equal(noMergeBase.entries.length, 0);
});

test("file mutation during a no-follow read becomes a gap and changing index is detected", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  writeFileSync(join(repo, "unstaged.md"), "first observation\n");
  let changedFile = false;
  const changingFile = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "unstaged",
    },
    f.current,
    {
      afterWorkingFileOpen: async (path) => {
        if (changedFile || !path.endsWith("/unstaged.md")) return;
        changedFile = true;
        writeFileSync(join(repo, "unstaged.md"), "changed during read\n");
      },
    },
  );
  assert.equal(changingFile.state, "gap");
  assert.ok(changingFile.entries.some((item) => item.state === "gap"));
  assert.equal(changingFile.reason, "workspace-changed");

  let reads = 0;
  const changingIndex = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "all",
    },
    f.current,
    {
      afterGitRead: async () => {
        reads++;
        if (reads === 3) {
          writeFileSync(join(repo, "staged.md"), "indexed during comparison\n");
          git(repo, "add", "staged.md");
        }
      },
    },
  );
  assert.equal(changingIndex.state, "gap");
  assert.equal(changingIndex.reason, "workspace-changed");
});

test("comparison root replacement during a Git read invalidates the captured root identity", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repositoryRoot = f.repository.workspacePath;
  let replaced = false;
  const result = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
    },
    f.current,
    {
      afterGitRead: async () => {
        if (replaced) return;
        replaced = true;
        renameSync(repositoryRoot, `${repositoryRoot}-old`);
        mkdirSync(repositoryRoot);
        writeFileSync(
          join(repositoryRoot, "replacement.md"),
          "replacement root",
        );
      },
    },
  );
  assert.equal(replaced, true);
  assert.equal(result.state, "gap");
  assert.equal(result.reason, "workspace-changed");
  assert.deepEqual(result.entries, []);
});

test("comparison bounds reject child timeout, Git output overflow and excessive candidate sets", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const timeoutGit = executable(
    f.root,
    "slow-git",
    `#!${process.execPath}\nsetTimeout(() => {}, 2000);\n`,
  );
  const startedAt = Date.now();
  const timedOut = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
    },
    f.current,
    { gitExecutable: timeoutGit, timeoutMs: 150, gitTimeoutMs: 20 },
  );
  assert.equal(timedOut.state, "gap");
  assert.equal(timedOut.reason, "time-limit");
  assert.ok(Date.now() - startedAt < 1000);

  const outputGit = executable(
    f.root,
    "large-output-git",
    `#!${process.execPath}\nprocess.stdout.write("x".repeat(${workspaceComparisonLimits.maxGitOutputBytes + 1}));\n`,
  );
  const overflow = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
    },
    f.current,
    { gitExecutable: outputGit, timeoutMs: 1500, gitTimeoutMs: 1000 },
  );
  assert.equal(overflow.state, "gap");
  assert.equal(overflow.reason, "output-limit");

  const candidateGit = executable(
    f.root,
    "candidate-git",
    `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a.includes("for-each-ref"))process.stdout.write("main\\n");\nelse if(a.includes("rev-parse"))process.stdout.write("${"a".repeat(40)}\\n");\nelse if(a.includes("--others")){for(let i=0;i<${workspaceComparisonLimits.maxEntriesScanned + 1};i++)process.stdout.write("new-"+i+"\\0");}\n`,
  );
  const tooMany = await compareRepository(
    {
      taskId: f.binding.taskId,
      repositoryId: f.repository.repositoryId,
      target: "uncommitted",
      changeSet: "unstaged",
    },
    f.current,
    { gitExecutable: candidateGit, timeoutMs: 3000 },
  );
  assert.equal(tooMany.state, "gap");
  assert.equal(tooMany.reason, "output-limit");
});

test("final identity rechecks preserve their bounded Git timeout reason", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const finalChecks = ["HEAD^{commit}", "refs/heads/main^{commit}"];

  for (const [index, finalArgument] of finalChecks.entries()) {
    const counter = join(f.root, `final-check-${index}.count`);
    const delayedGit = executable(
      f.root,
      `delayed-final-check-${index}.mjs`,
      `#!${process.execPath}\n` +
        `import { readFileSync, writeFileSync } from "node:fs";\n` +
        `import { spawnSync } from "node:child_process";\n` +
        `const args = process.argv.slice(2);\n` +
        `if (args.at(-1) === ${JSON.stringify(finalArgument)}) {\n` +
        `  let count = 0;\n` +
        `  try { count = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) || 0; } catch {}\n` +
        `  writeFileSync(${JSON.stringify(counter)}, String(count + 1));\n` +
        `  if (count + 1 === 2) await new Promise((resolve) => setTimeout(resolve, 1500));\n` +
        `}\n` +
        `const child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\n` +
        `process.exitCode = child.status ?? 1;\n`,
    );
    const result = await compareRepository(
      {
        taskId: f.binding.taskId,
        repositoryId: f.repository.repositoryId,
        target: "branch",
        baseBranch: "main",
      },
      f.current,
      { gitExecutable: delayedGit, timeoutMs: 5000, gitTimeoutMs: 500 },
    );
    assert.equal(result.state, "gap", finalArgument);
    assert.equal(result.reason, "time-limit", finalArgument);
    assert.equal(result.baseline?.branch, "main", finalArgument);
  }
});

test("turn observations retain exact BOM bytes and emit bound immutable side anchors", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const repo = f.repository.workspacePath;
  const beforeBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("baseline BOM\n"),
  ]);
  const afterBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("turn changed BOM\n"),
  ]);
  const before = await observeWorkspaceTurn(f.binding.taskId, f.current);
  writeFileSync(join(repo, "bom.md"), afterBytes);
  const after = await observeWorkspaceTurn(f.binding.taskId, f.current);
  const sides = new Map<number, WorkspaceComparisonSideContent>();
  const identity = {
    taskId: f.binding.taskId,
    taskVersion: 1,
    workId: "assignment-turn-bom",
    workRevision: 1,
    requestSequence: 1,
    assignmentId: "assignment-bom",
    assignmentVersion: 1,
    instructionsRevision: 1,
    profileRevision: 1,
    profileId: "profile-bom",
    threadId: "thread-bom",
    turnId: "turn-bom",
  };
  const comparison = compareWorkspaceTurnObservations(
    identity,
    "41890634-614d-4bd3-bdab-2fd34aef8c27",
    Date.now() - 1,
    before,
    after,
    "completed",
    (entryIndex, side, text) => {
      const item = sides.get(entryIndex) ?? { entryIndex };
      if (side === "left") item.leftText = text;
      else item.rightText = text;
      sides.set(entryIndex, item);
    },
  );
  const bom = comparison.entries.find((item) => item.path === "bom.md");
  assert.ok(bom?.left?.sha256);
  assert.ok(bom.right?.sha256);
  assert.equal(bom.left.sha256, digest(beforeBytes));
  assert.equal(bom.right.sha256, digest(afterBytes));
  const entryIndex = comparison.entries.indexOf(bom);
  const captured = sides.get(entryIndex);
  assert.equal(
    digest(Buffer.from(captured?.leftText ?? "", "utf8")),
    bom.left.sha256,
  );
  assert.equal(
    digest(Buffer.from(captured?.rightText ?? "", "utf8")),
    bom.right.sha256,
  );
  assert.equal(bom.hunks[0]?.leftAnchor?.workId, identity.workId);
  assert.equal(bom.hunks[0]?.leftAnchor?.threadId, identity.threadId);
  assert.equal(bom.hunks[0]?.leftAnchor?.turnId, identity.turnId);
});

test("turn observations report changing, oversized and over-deadline files as gaps", async (t) => {
  const changing = await fixture();
  t.after(() => changing.close());
  let mutated = false;
  const changingObservation = await observeWorkspaceTurn(
    changing.binding.taskId,
    changing.current,
    {
      afterWorkingFileOpen: async (path) => {
        if (
          !mutated &&
          path === join(changing.repository.workspacePath, "README.md")
        ) {
          mutated = true;
          writeFileSync(path, "changed while observing\n");
        }
      },
    },
  );
  assert.equal(mutated, true);
  assert.equal(changingObservation.state, "gap");
  assert.equal(changingObservation.reason, "workspace-changed");
  const changed = changingObservation.files.find(
    (file) =>
      file.repositoryId === changing.repository.repositoryId &&
      file.path === "README.md",
  );
  assert.equal(changed?.state, "gap");
  assert.equal(changed?.text, undefined);

  const oversized = await fixture();
  t.after(() => oversized.close());
  writeFileSync(
    join(oversized.repository.workspacePath, "too-large.txt"),
    Buffer.alloc(workspaceComparisonLimits.maxFileBytes + 1, 0x61),
  );
  const oversizedObservation = await observeWorkspaceTurn(
    oversized.binding.taskId,
    oversized.current,
  );
  assert.equal(oversizedObservation.state, "gap");
  assert.equal(oversizedObservation.reason, "output-limit");
  const tooLarge = oversizedObservation.files.find(
    (file) => file.path === "too-large.txt",
  );
  assert.equal(tooLarge?.state, "gap");
  assert.equal(tooLarge?.reason, "too-large");
  assert.equal(tooLarge?.text, undefined);

  const timed = await fixture();
  t.after(() => timed.close());
  const timedObservation = await observeWorkspaceTurn(
    timed.binding.taskId,
    async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return timed.current();
    },
    { timeoutMs: 1 },
  );
  assert.equal(timedObservation.state, "gap");
  assert.equal(timedObservation.reason, "time-limit");
  assert.equal(timedObservation.truncated, true);
});
