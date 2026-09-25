import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

function compareRelativePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hashField(hash, bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function readRegularFile(fullPath, relativePath) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const file = await open(fullPath, constants.O_RDONLY | noFollow);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error(`Unexpected non-file package entry: ${relativePath}`);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function hashPackageTree(packageDirectory) {
  const rootStats = await lstat(packageDirectory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Installed package root must be a real directory");
  }

  const entries = [];
  async function collect(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareRelativePaths(left.name, right.name));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const fullPath = path.join(directory, child.name);
      const stats = await lstat(fullPath);
      if (stats.isSymbolicLink() || child.isSymbolicLink()) {
        throw new Error(
          `Unexpected symbolic link in package tree: ${relativePath}`,
        );
      }
      if (stats.isDirectory()) {
        entries.push({ kind: "D", relativePath, fullPath });
        await collect(fullPath, relativePath);
      } else if (stats.isFile()) {
        entries.push({ kind: "F", relativePath, fullPath });
      } else {
        throw new Error(`Unexpected package entry type: ${relativePath}`);
      }
    }
  }

  await collect(packageDirectory, "");
  entries.sort((left, right) =>
    compareRelativePaths(left.relativePath, right.relativePath),
  );

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind);
    hashField(hash, Buffer.from(entry.relativePath, "utf8"));
    const contents =
      entry.kind === "F"
        ? await readRegularFile(entry.fullPath, entry.relativePath)
        : Buffer.alloc(0);
    hashField(hash, contents);
  }
  return hash.digest("hex");
}
