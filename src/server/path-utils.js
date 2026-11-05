import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/** True when `path` equals `root` or lives underneath it (both must be canonical). */
export const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Canonicalize allowed roots, dropping roots that do not exist. */
export function canonicalRoots(roots) {
  const result = [];
  for (const root of roots || []) {
    try {
      const canonical = realpathSync(resolve(root));
      if (!result.includes(canonical)) result.push(canonical);
    } catch {
      /* Ignore unavailable roots. */
    }
  }
  return result;
}

/** Clamp a caller-supplied page size: non-numeric or zero falls back, then bounded to [min, max]. */
export function clampLimit(value, { fallback, max, min = 1 }) {
  return Math.max(min, Math.min(Number(value) || fallback, max));
}

export function defaultBrowseRoots(home = homedir()) {
  return [resolve(home)];
}

export function resolveSafeRegularFile(root, relativePath) {
  try {
    const canonicalRoot = realpathSync(root);
    const candidate = resolve(root, relativePath);
    if (!inside(candidate, resolve(root))) return null;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    const canonicalFile = realpathSync(candidate);
    if (!inside(canonicalFile, canonicalRoot) || !statSync(canonicalFile).isFile()) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}
