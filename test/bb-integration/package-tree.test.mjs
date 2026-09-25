import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hashPackageTree } from "./package-tree.mjs";

async function writePackageTree(root, reverseOrder) {
  await mkdir(path.join(root, "dist"), { recursive: true });
  const files = [
    ["package.json", Buffer.from('{"version":"1.0.0"}')],
    ["dist/index.js", Buffer.from([0x41, 0x00, 0x42])],
    ["dist/empty-directory/.keep", Buffer.from("")],
  ];
  if (reverseOrder) files.reverse();
  for (const [relativePath, contents] of files) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }
}

test("package tree digest is order-independent and detects file and entry changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ensemble-package-hash-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  try {
    await writePackageTree(first, false);
    await writePackageTree(second, true);

    const expectedDigest = await hashPackageTree(first);
    assert.match(expectedDigest, /^[a-f0-9]{64}$/u);
    assert.equal(await hashPackageTree(second), expectedDigest);

    await writeFile(path.join(second, "dist/index.js"), Buffer.from("changed"));
    assert.notEqual(await hashPackageTree(second), expectedDigest);

    await writeFile(path.join(second, "unexpected-empty-marker"), "extra");
    assert.notEqual(await hashPackageTree(second), expectedDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package tree digest rejects symlinks and non-directory roots", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX package symlink creation is required for this probe");
    return;
  }
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ensemble-package-symlink-"),
  );
  const packageDirectory = path.join(root, "package");
  try {
    await mkdir(packageDirectory);
    await writeFile(path.join(root, "target.txt"), "target");
    await symlink(
      path.join(root, "target.txt"),
      path.join(packageDirectory, "link.txt"),
    );
    await assert.rejects(hashPackageTree(packageDirectory), /symbolic link/u);
    await assert.rejects(
      hashPackageTree(path.join(packageDirectory, "link.txt")),
      /real directory/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
