import { SourceError, sourceLimits, type SourceLimits } from "./contracts.js";
import { sourceInventory } from "./inventory.js";
import { capturePackageSource, type PackageSourceReader } from "./reader.js";
import { sourceOrigin } from "./origin.js";
import { CapturedPackageSource, captureSourceSnapshot } from "./snapshot.js";
import { ImmutableSourceTree } from "./tree.js";

/** Version two captures link blobs as opaque resources; resolution belongs to a selected consumer root. */
export async function captureLinkedSourceSnapshot(
  reader: PackageSourceReader,
  selected?: readonly string[],
  archiveValue?: Uint8Array,
  options?: SourceLimits,
  signal?: AbortSignal,
): Promise<CapturedPackageSource> {
  if (!reader.links?.length) return captureSourceSnapshot(reader, selected, archiveValue, options, signal);
  const limits = sourceLimits(options),
    origin = sourceOrigin(reader.origin),
    inventory = sourceInventory(reader, limits),
    links = sourceInventory({ files: reader.links, unavailable: [] }, limits).files,
    linkPaths = new Set(links.map((file) => file.path));
  if (
    JSON.stringify([...linkPaths]) !==
    JSON.stringify(inventory.unavailable.filter((entry) => entry.reason === "symlink").map((entry) => entry.path))
  )
    throw new SourceError("invalidSource");
  if (archiveValue && archiveValue.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  const archive = archiveValue && new Uint8Array(archiveValue),
    captured = await capturePackageSource(
      {
        origin,
        files: [...inventory.files, ...links],
        unavailable: inventory.unavailable.filter((entry) => entry.reason !== "symlink"),
        read: reader.read.bind(reader),
      },
      selected,
      limits,
      signal,
    ),
    resources = captured.files.map((file) => ({ path: file.path, bytes: captured.read(file.path) })),
    tree = await ImmutableSourceTree.create(
      resources.filter((file) => !linkPaths.has(file.path)),
      limits,
    ),
    rawLinks = await ImmutableSourceTree.create(
      resources.filter((file) => linkPaths.has(file.path)),
      limits,
    ),
    snapshot = await CapturedPackageSource.createLinked(origin, inventory, tree, links, rawLinks, archive, limits);
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  return snapshot;
}
