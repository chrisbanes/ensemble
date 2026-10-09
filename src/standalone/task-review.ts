import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ReviewMetadata } from "../core/task-review.js";
import { isWithin } from "./workspace-inspection.js";
export class ArtifactUnavailable extends Error {
  constructor(
    readonly reason: "unavailable" | "redacted" | "mismatch" | "unsupported",
  ) {
    super(reason);
  }
}
type Artifact = ReviewMetadata["artifacts"][number];
export interface PreviewBinding {
  artifact: Artifact;
  workspace: string;
  identity: string;
}
const same = (
  a: { ino: number; dev: number; size: number; mtimeMs: number },
  b: { ino: number; dev: number; size: number; mtimeMs: number },
) =>
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs;
/** No client pathname or remote fetch. Revalidate live task binding and recorded material after every async read. */
export async function previewRecordedArtifact(
  current: () => Promise<PreviewBinding | undefined>,
  afterOpen?: () => Promise<void>,
) {
  const initial = await current();
  if (!initial) throw new ArtifactUnavailable("unavailable");
  const { artifact, workspace } = initial;
  if (artifact.availability !== "available")
    throw new ArtifactUnavailable(
      artifact.availability === "redacted" ? "redacted" : "unavailable",
    );
  if (!artifact.file) throw new ArtifactUnavailable("unsupported");
  const root = await realpath(workspace),
    rootStat = await lstat(root),
    path = resolve(root, artifact.file.relativePath);
  if (
    path === root ||
    !isWithin(root, path) ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink()
  )
    throw new ArtifactUnavailable("unavailable");
  const canonical = await realpath(path);
  if (canonical !== path || !isWithin(root, canonical))
    throw new ArtifactUnavailable("unavailable");
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 5000000 ||
    before.size !== artifact.file.size
  )
    throw new ArtifactUnavailable("mismatch");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !same(before, opened))
      throw new ArtifactUnavailable("mismatch");
    if (afterOpen) await afterOpen();
    const midway = await current();
    if (
      !midway ||
      midway.identity !== initial.identity ||
      JSON.stringify(midway.artifact) !== JSON.stringify(artifact) ||
      midway.workspace !== workspace
    )
      throw new ArtifactUnavailable("mismatch");
    const buffer = Buffer.alloc(artifact.file.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const part = await handle.read(buffer, used, buffer.length - used, used);
      if (part.bytesRead === 0) break;
      used += part.bytesRead;
    }
    const bytes = buffer.subarray(0, used),
      finalStat = await handle.stat(),
      nameStat = await lstat(path),
      finalRoot = await lstat(root),
      finalCanonical = await realpath(path),
      finalBoundRoot = await realpath(workspace),
      final = await current();
    if (
      !final ||
      final.identity !== initial.identity ||
      JSON.stringify(final.artifact) !== JSON.stringify(artifact) ||
      final.workspace !== workspace ||
      !same(opened, finalStat) ||
      !same(opened, nameStat) ||
      nameStat.isSymbolicLink() ||
      finalRoot.ino !== rootStat.ino ||
      finalRoot.dev !== rootStat.dev ||
      finalCanonical !== canonical ||
      finalBoundRoot !== root ||
      bytes.length !== artifact.file.size ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.file.sha256
    )
      throw new ArtifactUnavailable("mismatch");
    const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (
      (artifact.file.mime === "image/png" && !png) ||
      (artifact.file.mime === "image/jpeg" && !jpeg)
    )
      throw new ArtifactUnavailable("unsupported");
    return { body: bytes, type: artifact.file.mime };
  } finally {
    await handle.close();
  }
}
