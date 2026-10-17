import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `metaUrl` is the script node was started with. Compares real paths so that running
 * through a symlink or junction still counts (a plain URL comparison fails open there: the guard
 * is false, main() never runs and the check silently "passes").
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
