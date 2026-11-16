import { SourceError, sourceLimits, type SourceLimits } from "./contracts.js";
import { SourcePaths } from "./paths.js";
import type { PackageSourceFile } from "./contracts.js";

export interface PackageSourceInventory {
  readonly files: readonly PackageSourceFile[];
  readonly unavailable: readonly { readonly path: string; readonly reason: "symlink" | "gitlink" }[];
}

/** Provider inventories remain explicit even when only some regular files are captured. */
export function sourceInventory(value: PackageSourceInventory, options?: SourceLimits): PackageSourceInventory {
  const limits = sourceLimits(options),
    paths = new SourcePaths(limits.entries);
  if (!value || !Array.isArray(value.files) || !Array.isArray(value.unavailable))
    throw new SourceError("invalidSource");
  if (value.files.length + value.unavailable.length > limits.entries) throw new SourceError("sourceTooLarge");
  const files = value.files.map((file) => {
    if (
      !file ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !file.integrity ||
      typeof file.integrity.value !== "string" ||
      !["sha256", "git-blob-sha1"].includes(file.integrity.algorithm) ||
      !(file.integrity.algorithm === "sha256" ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/).test(file.integrity.value)
    )
      throw new SourceError("invalidSource");
    return Object.freeze({
      path: paths.add(file.path),
      bytes: file.bytes,
      integrity: Object.freeze({ algorithm: file.integrity.algorithm, value: file.integrity.value }),
    });
  });
  const unavailable = value.unavailable.map((entry) => {
    if (!entry || !["symlink", "gitlink"].includes(entry.reason)) throw new SourceError("invalidSource");
    return Object.freeze({ path: paths.add(entry.path), reason: entry.reason });
  });
  return Object.freeze({
    files: Object.freeze(files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
    unavailable: Object.freeze(unavailable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  });
}
