import { SourceError, sourceLimits, type SourceLimits, type SourceResource } from "./contracts.js";
import { ImmutableSourceTree } from "./tree.js";
import { sourcePath, SourcePaths } from "./paths.js";
import { contentSha256 } from "../digest.js";
import { sourceInventory } from "./inventory.js";

import type { PackageSourceOrigin, PackageSourceFile } from "./contracts.js";
export type { PackageSourceOrigin, PackageSourceFile } from "./contracts.js";
export interface PackageSourceReader {
  readonly origin: PackageSourceOrigin;
  readonly files: readonly PackageSourceFile[];
  readonly unavailable: readonly { readonly path: string; readonly reason: "symlink" | "gitlink" }[];
  readonly links?: readonly PackageSourceFile[];
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export async function gitBlobDigest(bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`),
    input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  const digest = await crypto.subtle.digest("SHA-1", input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Validate and detach the complete selection before a provider performs content IO. */
export function selectSourceFiles(
  reader: PackageSourceReader,
  selection?: readonly string[],
  options?: SourceLimits,
): readonly PackageSourceFile[] {
  const limits = sourceLimits(options),
    paths = new SourcePaths(limits.entries),
    files = new Map<string, PackageSourceFile>();
  const inventory = sourceInventory(reader, limits);
  for (const file of inventory.files) files.set(file.path, file);
  if (!selection && inventory.unavailable.length) throw new SourceError("unsupportedSourceEntry");
  const selected = (selection ? [...selection] : [...files.keys()]).map((path) => paths.add(path)).sort();
  if (selected.length > limits.files) throw new SourceError("sourceTooLarge");
  let total = 0;
  for (const path of selected) {
    const file = files.get(path);
    if (!file) throw new SourceError("sourceUnavailable");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new SourceError("invalidSource");
    total += file.bytes;
    if (file.bytes > limits.fileBytes || total > limits.totalBytes) throw new SourceError("sourceTooLarge");
  }
  return Object.freeze(selected.map((path) => files.get(path)!));
}

/** Selection and inventory are frozen before IO; captured bytes must match the declared source identity. */
export async function capturePackageSource(
  reader: PackageSourceReader,
  selection?: readonly string[],
  options?: SourceLimits,
  signal?: AbortSignal,
): Promise<ImmutableSourceTree> {
  const limits = sourceLimits(options),
    selected = selectSourceFiles(reader, selection, limits),
    resources: SourceResource[] = [];
  for (const file of selected) {
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    const path = file.path,
      value = await reader.read(sourcePath(path), signal);
    if (!(value instanceof Uint8Array) || value.byteLength !== file.bytes) throw new SourceError("sourceChanged");
    const bytes = new Uint8Array(value),
      digest = file.integrity.algorithm === "sha256" ? await contentSha256(bytes) : await gitBlobDigest(bytes);
    if (digest !== file.integrity.value) throw new SourceError("sourceChanged");
    resources.push({ path, bytes });
  }
  const captured = await ImmutableSourceTree.create(resources, limits);
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  return captured;
}
