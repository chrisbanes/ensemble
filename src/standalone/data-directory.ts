import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve, sep } from "node:path";

export const STANDALONE_MARKER_NAME = ".ensemble-standalone";
export const STANDALONE_MARKER_CONTENTS = "ensemble-standalone-v1\n";
export const STANDALONE_OWNER_NAME = ".ensemble-owner.sqlite";

/**
 * Require a lexical absolute directory path whose existing components are all
 * real directories. `any` is reserved for a service data root that may need
 * recursive creation; operation targets may only omit their final component.
 */
export function assertCanonicalDirectoryPath(
  input: string,
  label: string,
  missing: "none" | "leaf" | "any" = "none",
): string {
  if (!isAbsolute(input)) throw new Error(`${label} path must be absolute`);
  if (resolve(input) !== input)
    throw new Error(`${label} path must be lexically canonical`);

  const components = input.slice(sep.length).split(sep).filter(Boolean);
  let current: string = sep;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let state: ReturnType<typeof lstatSync>;
    try {
      state = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (
        missing === "any" ||
        (missing === "leaf" && index === components.length - 1)
      )
        return input;
      throw new Error(`${label} parent must be a real directory`, {
        cause: error,
      });
    }
    if (state.isSymbolicLink() || !state.isDirectory())
      throw new Error(
        `${label} path contains a symlink or non-directory ancestor`,
      );
  }
  return input;
}

export type StandaloneDataDirectoryOptions = {
  createFreshMarker?: boolean;
  markerWriter?: (path: string, flag: "wx" | "w") => void;
  requireExistingOwner?: boolean;
};

const defaultMarkerWriter = (path: string, flag: "wx" | "w") =>
  writeFileSync(path, STANDALONE_MARKER_CONTENTS, { flag, mode: 0o600 });

/** Only the empty owner file can identify an interrupted first start. */
export function standaloneMarkerReady(directory: string): boolean {
  const entries = readdirSync(directory);
  const mark = join(directory, STANDALONE_MARKER_NAME);
  const hasMarker = entries.includes(STANDALONE_MARKER_NAME);
  if (hasMarker) {
    const state = lstatSync(mark);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error("Data directory marker must be a regular file");
    const contents = readFileSync(mark, "utf8");
    if (contents === STANDALONE_MARKER_CONTENTS) return true;
    if (!STANDALONE_MARKER_CONTENTS.startsWith(contents))
      throw new Error("Data directory marker mismatch");
  }
  const expected = [
    STANDALONE_OWNER_NAME,
    `${STANDALONE_OWNER_NAME}-journal`,
    ...(hasMarker ? [STANDALONE_MARKER_NAME] : []),
  ];
  if (entries.length === 0) return false;
  if (
    !entries.includes(STANDALONE_OWNER_NAME) ||
    !entries.every((entry) => expected.includes(entry))
  )
    throw new Error("Unmarked data directory must be empty");
  const owner = lstatSync(join(directory, STANDALONE_OWNER_NAME));
  if (!owner.isFile() || owner.isSymbolicLink() || owner.size !== 0)
    throw new Error("Interrupted owner file is not a fresh installation");
  if (entries.includes(`${STANDALONE_OWNER_NAME}-journal`)) {
    const journal = lstatSync(
      join(directory, `${STANDALONE_OWNER_NAME}-journal`),
    );
    if (!journal.isFile() || journal.isSymbolicLink())
      throw new Error("Interrupted owner journal is not a regular file");
  }
  return false;
}

/** A marked standalone directory held under SQLite's exclusive owner lock. */
export class StandaloneDataDirectory {
  readonly root: string;
  readonly databasePath: string;
  readonly workspacePath: string;

  private constructor(
    root: string,
    private readonly owner: DatabaseSync,
  ) {
    this.root = root;
    this.databasePath = join(root, "standalone.sqlite");
    this.workspacePath = join(root, "workspaces");
  }

  static openExclusive(
    dataDir: string,
    options: StandaloneDataDirectoryOptions = {},
  ): StandaloneDataDirectory {
    const directory = assertCanonicalDirectoryPath(
      dataDir,
      "Data directory",
      options.createFreshMarker === false ? "none" : "any",
    );
    if (existsSync(directory)) {
      const state = lstatSync(directory);
      if (state.isSymbolicLink() || !state.isDirectory())
        throw new Error("Data directory must be a real directory");
    } else {
      if (options.createFreshMarker === false)
        throw new Error("Data directory is not a marked standalone directory");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    assertCanonicalDirectoryPath(directory, "Data directory");
    const canonical = realpathSync(directory);
    if (canonical !== directory)
      throw new Error("Data directory path must be lexically canonical");
    const markerIsReady = standaloneMarkerReady(canonical);
    if (options.createFreshMarker === false && !markerIsReady)
      throw new Error("Data directory is not a marked standalone directory");
    const ownerPath = join(canonical, STANDALONE_OWNER_NAME);
    let ownerInfo: ReturnType<typeof lstatSync> | undefined;
    try {
      ownerInfo = lstatSync(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (options.requireExistingOwner)
        throw new Error(
          "Data directory owner file is required for offline operations",
          {
            cause: error,
          },
        );
    }
    if (ownerInfo && (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()))
      throw new Error(
        "Service ownership file must be a regular non-symlink file",
      );
    const owner = new DatabaseSync(ownerPath, { timeout: 0 });
    try {
      try {
        owner.exec("BEGIN IMMEDIATE");
      } catch (error) {
        throw new Error("Data directory is already owned", { cause: error });
      }

      if (!markerIsReady) {
        if (options.createFreshMarker === false)
          throw new Error(
            "Data directory is not a marked standalone directory",
          );
        const markerPath = join(canonical, STANDALONE_MARKER_NAME);
        (options.markerWriter ?? defaultMarkerWriter)(
          markerPath,
          existsSync(markerPath) ? "w" : "wx",
        );
        if (!standaloneMarkerReady(canonical))
          throw new Error("Data directory marker write incomplete");
      }

      const databasePath = join(canonical, "standalone.sqlite");
      if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink())
        throw new Error("Standalone database must not be a symlink");
      return new StandaloneDataDirectory(canonical, owner);
    } catch (error) {
      owner.close();
      throw error;
    }
  }

  close(): void {
    this.owner.close();
  }
}
