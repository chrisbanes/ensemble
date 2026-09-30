import { realpathSync } from "node:fs";
import { tmpdir as operatingSystemTmpdir } from "node:os";

/** Return the physical temp root; macOS commonly exposes /var as a symlink. */
export function tmpdir(): string {
  return realpathSync(operatingSystemTmpdir());
}
