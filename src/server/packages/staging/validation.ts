import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type { SourceStageRequest } from "../../../shared/packages/stages/contracts.js";
import type { SourceEntryPolicy } from "../../../shared/packages/sources/contracts.js";

/** The acquired source must match the reserved intent and exact selection before it can own disk bytes. */
export function validateStagedSource(
  request: SourceStageRequest,
  source: CapturedPackageSource,
  entryPolicy: SourceEntryPolicy = "regular-only/v1",
): void {
  if (source.links && entryPolicy !== "logical-links/v2") throw new SourceError("unsupportedSourceEntry");
  const wanted = request.source,
    origin = source.descriptor.origin;
  if (wanted.kind !== origin.kind) throw new SourceError("sourceChanged");
  if (wanted.kind === "zip-upload" && origin.kind === "zip-upload") {
    if (
      wanted.sha256 !== origin.archiveSha256 ||
      wanted.name !== origin.name ||
      wanted.bytes !== source.descriptor.archiveBytes
    )
      throw new SourceError("sourceChanged");
  } else if (wanted.kind === "github" && origin.kind === "github") {
    if (
      wanted.repository.toLowerCase() !== origin.repository.toLowerCase() ||
      wanted.root !== origin.root ||
      (wanted.repositoryId !== null && wanted.repositoryId !== origin.repositoryId) ||
      (wanted.ref !== null &&
        (wanted.ref !== origin.requestedRef || (/^[a-f0-9]{40}$/.test(wanted.ref) && wanted.ref !== origin.commit)))
    )
      throw new SourceError("sourceChanged");
  }
  if (
    request.selected === null &&
    source.descriptor.inventory.unavailable.some(
      (entry) => entry.reason !== "symlink" || !source.links?.has(entry.path),
    )
  )
    throw new SourceError("unsupportedSourceEntry");
  const selected =
    request.selected ??
    [
      ...source.descriptor.inventory.files.map((file) => file.path),
      ...source.descriptor.inventory.unavailable
        .filter((entry) => entry.reason === "symlink")
        .map((entry) => entry.path),
    ].sort();
  if (
    JSON.stringify(selected) !==
    JSON.stringify([...source.tree.files, ...(source.links?.files ?? [])].map((file) => file.path).sort())
  )
    throw new SourceError("sourceChanged");
}
