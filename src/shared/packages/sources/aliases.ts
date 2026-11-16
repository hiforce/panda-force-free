import { contentSha256 } from "../digest.js";
import { SourceError, sourceLimits, type SourceLimits, type SourceResource } from "./contracts.js";
import { sourcePath, SourcePaths } from "./paths.js";
import type { CapturedPackageSource } from "./snapshot.js";
import { ImmutableSourceTree } from "./tree.js";

/** Relative alias targets are evaluated inside the chosen logical root, without host path operations. */
function targetAt(link: string, target: string): string {
  if (!target || new TextEncoder().encode(target).byteLength > 1024 || target.startsWith("/") || target.includes("\\"))
    throw new SourceError("invalidSourcePath");
  const parts = link.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (!parts.length) throw new SourceError("invalidSourcePath");
      parts.pop();
    } else {
      sourcePath(part);
      parts.push(part);
    }
  }
  return parts.length ? sourcePath(parts.join("/")) : "";
}

/** Produce bounded physical copies; original bytes and the effective resource projection keep distinct digests. */
export async function projectSourceAliases(
  source: CapturedPackageSource,
  root = "",
  options?: SourceLimits,
  signal?: AbortSignal,
) {
  const limits = sourceLimits(options),
    selectedRoot = root === "" ? "" : sourcePath(root),
    prefix = selectedRoot ? selectedRoot + "/" : "",
    nodes = new Map<string, "file" | "link" | "directory">([["", "directory"]]),
    directories = new Map<string, Set<string>>([["", new Set()]]),
    links = new Map<string, string>();
  function add(full: string, kind: "file" | "link") {
    if (!full.startsWith(prefix)) return;
    const path = full.slice(prefix.length),
      parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const current = parts.slice(0, i + 1).join("/"),
        parent = parts.slice(0, i).join("/");
      directories.get(parent)!.add(current);
      if (i < parts.length - 1 && !nodes.has(current)) {
        nodes.set(current, "directory");
        directories.set(current, new Set());
      }
    }
    nodes.set(path, kind);
    if (kind === "link") {
      const raw = source.links!.read(full);
      if (raw.byteLength > 1024) throw new SourceError("sourceTooLarge");
      let target: string;
      try {
        target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      } catch {
        throw new SourceError("invalidSource");
      }
      links.set(path, targetAt(path, target));
    }
  }
  for (const file of source.tree.files) add(file.path, "file");
  for (const file of source.links?.files ?? []) add(file.path, "link");
  for (const entry of source.descriptor.inventory.unavailable) {
    if (!entry.path.startsWith(prefix)) continue;
    if (entry.reason === "gitlink" || !nodes.has(entry.path.slice(prefix.length)))
      throw new SourceError("unsupportedSourceEntry");
  }
  if (!directories.get("")!.size) throw new SourceError("sourceUnavailable");
  const resources: SourceResource[] = [],
    paths = new SourcePaths(limits.entries),
    files = new Map(source.tree.files.map((file) => [file.path, file]));
  let total = 0;
  function resolve(path: string, active: readonly string[] = []): string {
    if (active.length > 64) throw new SourceError("sourceTooLarge");
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const candidate = parts.slice(0, i).join("/");
      if (nodes.get(candidate) !== "link") continue;
      if (active.includes(candidate)) throw new SourceError("invalidSource");
      const target = links.get(candidate)!,
        rest = parts.slice(i).join("/");
      return resolve(target + (target && rest ? "/" : "") + rest, [...active, candidate]);
    }
    if (!nodes.has(path)) throw new SourceError("sourceUnavailable");
    return path;
  }
  function expand(actual: string, output: string, ancestors: readonly string[]) {
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    const path = resolve(actual),
      kind = nodes.get(path);
    if (ancestors.length > 64) throw new SourceError("sourceTooLarge");
    if (kind === "directory") {
      if (ancestors.includes(path)) throw new SourceError("invalidSource");
      if (output) paths.add(output, true);
      for (const child of [...directories.get(path)!].sort())
        expand(child, (output ? output + "/" : "") + child.split("/").at(-1)!, [...ancestors, path]);
    } else {
      paths.add(output);
      const file = files.get(prefix + path);
      if (!file) throw new SourceError("sourceUnavailable");
      total += file.bytes;
      if (resources.length >= limits.files || file.bytes > limits.fileBytes || total > limits.totalBytes)
        throw new SourceError("sourceTooLarge");
      resources.push({ path: output, bytes: source.tree.read(file.path) });
    }
  }
  expand("", "", []);
  const tree = await ImmutableSourceTree.create(resources, limits),
    descriptor = Object.freeze({
      schema: "panda.source-alias-projection/v1" as const,
      sourceDigest: source.digest,
      root: selectedRoot,
      treeDigest: tree.digest,
    });
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  return Object.freeze({ tree, descriptor, digest: await contentSha256(JSON.stringify(descriptor)) });
}
