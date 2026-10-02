import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTestEvidenceDirectory,
  writeTestEvidence,
} from "./fixtures/browser-diagnostics.js";
import { tmpdir } from "./temp.js";

test("test evidence refuses a twenty-fifth file without modifying its owned directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-evidence-files-"));
  try {
    const directory = await createTestEvidenceDirectory(
      "limits",
      "synthetic file-count fixture",
      root,
    );
    for (let i = 0; i < 24; i++)
      await writeTestEvidence(
        directory,
        `screen-${i}.png`,
        Buffer.from("synthetic test-owned image"),
      );
    await assert.rejects(
      writeTestEvidence(
        directory,
        "extra.png",
        Buffer.from("extra synthetic image"),
      ),
      /file count limit/,
    );
    assert.equal((await readdir(directory)).length, 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence writes reject traversal unowned names and symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-evidence-paths-"));
  try {
    const directory = await createTestEvidenceDirectory(
      "limits",
      "synthetic path fixture",
      root,
    );
    await assert.rejects(
      writeTestEvidence(
        directory,
        "../escape.png",
        Buffer.from("synthetic escape"),
      ),
      /invalid evidence filename/,
    );
    await assert.rejects(access(join(directory, "..", "escape.png")));
    await assert.rejects(
      writeTestEvidence(directory, "auth.json", "SYNTHETIC_PRIVATE_MARKER"),
      /invalid evidence filename/,
    );
    const target = join(root, "owned-private-fixture");
    await writeFile(target, "SYNTHETIC_PRIVATE_MARKER");
    await symlink(target, join(directory, "manifest.json"));
    await assert.rejects(
      writeTestEvidence(directory, "manifest.json", "replacement"),
      /unowned evidence file/,
    );
    assert.equal(await readFile(target, "utf8"), "SYNTHETIC_PRIVATE_MARKER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence metadata PNG and directory byte bounds reject excess data before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ensemble-evidence-bytes-"));
  try {
    const directory = await createTestEvidenceDirectory(
      "limits",
      "synthetic byte-limit fixture",
      root,
    );
    await writeTestEvidence(
      directory,
      "manifest.json",
      "original synthetic metadata",
    );
    await assert.rejects(
      writeTestEvidence(directory, "manifest.json", "x".repeat(65537)),
      /file byte limit/,
    );
    assert.equal(
      await readFile(join(directory, "manifest.json"), "utf8"),
      "original synthetic metadata",
    );
    await assert.rejects(
      writeTestEvidence(
        directory,
        "oversized.png",
        Buffer.alloc(2 * 1024 * 1024 + 1),
      ),
      /file byte limit/,
    );
    for (let i = 0; i < 3; i++)
      await writeTestEvidence(
        directory,
        `large-${i}.png`,
        Buffer.alloc(2 * 1024 * 1024),
      );
    await assert.rejects(
      writeTestEvidence(directory, "last.png", Buffer.alloc(2 * 1024 * 1024)),
      /directory byte limit/,
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      "large-0.png",
      "large-1.png",
      "large-2.png",
      "manifest.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
