import { SourceError } from "./contracts.js";
import { githubRef, githubRepository } from "./github.js";
import { sourcePath } from "./paths.js";
import type { PackageSourceOrigin } from "./reader.js";

export function sourceOrigin(value: unknown): Readonly<PackageSourceOrigin> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SourceError("invalidSource");
  const input = value as Record<string, unknown>;
  if (input.kind === "zip-upload") {
    if (
      Object.keys(input).sort().join(",") !== "archiveSha256,kind,name" ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 160 ||
      /[\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(input.name) ||
      typeof input.archiveSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.archiveSha256)
    )
      throw new SourceError("invalidSource");
    return Object.freeze({ kind: "zip-upload", name: input.name, archiveSha256: input.archiveSha256 });
  }
  if (
    input.kind !== "github" ||
    Object.keys(input).sort().join(",") !== "commit,kind,repository,repositoryId,requestedRef,root,tree" ||
    !Number.isSafeInteger(input.repositoryId) ||
    Number(input.repositoryId) <= 0 ||
    typeof input.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.commit) ||
    typeof input.tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.tree)
  )
    throw new SourceError("invalidSource");
  return Object.freeze({
    kind: "github",
    repository: githubRepository(input.repository).url,
    repositoryId: Number(input.repositoryId),
    requestedRef: githubRef(input.requestedRef),
    commit: input.commit,
    tree: input.tree,
    root: input.root === "" ? "" : sourcePath(input.root),
  });
}
