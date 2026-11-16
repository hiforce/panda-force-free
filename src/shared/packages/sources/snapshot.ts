import { contentSha256 } from "../digest.js";
import { SourceError, sourceLimits, type SourceLimits, type PackageSourceFile } from "./contracts.js";
import { sourceInventory, type PackageSourceInventory } from "./inventory.js";
import { sourceOrigin } from "./origin.js";
import { capturePackageSource, gitBlobDigest, type PackageSourceOrigin, type PackageSourceReader } from "./reader.js";
import { ImmutableSourceTree } from "./tree.js";

export interface RegularSourceSnapshotDescriptor {
  readonly schema: "panda.package-source/v1";
  readonly origin: Readonly<PackageSourceOrigin>;
  readonly inventory: PackageSourceInventory;
  readonly files: ImmutableSourceTree["files"];
  readonly treeDigest: string;
  readonly archiveBytes: number;
}
export interface LinkedSourceSnapshotDescriptor extends Omit<RegularSourceSnapshotDescriptor, "schema"> {
  readonly schema: "panda.package-source/v2";
  readonly links: {
    readonly inventory: readonly PackageSourceFile[];
    readonly files: ImmutableSourceTree["files"];
    readonly treeDigest: string;
  };
}
export type SourceSnapshotDescriptor = RegularSourceSnapshotDescriptor | LinkedSourceSnapshotDescriptor;

/** Original provenance, full inventory and selected bytes survive independently of network credentials. */
export class CapturedPackageSource {
  readonly descriptor: Readonly<SourceSnapshotDescriptor>;
  #archive: Uint8Array | undefined;
  private constructor(
    readonly tree: ImmutableSourceTree,
    descriptor: SourceSnapshotDescriptor,
    archive: Uint8Array | undefined,
    readonly digest: string,
    readonly links?: ImmutableSourceTree,
  ) {
    this.descriptor = Object.freeze(descriptor);
    this.#archive = archive;
    Object.freeze(this);
  }
  /** Raw link targets retain their own identity and never enter the regular resource tree. */
  static async createLinked(
    origin: unknown,
    inventory: PackageSourceInventory,
    tree: ImmutableSourceTree,
    linkInventory: readonly PackageSourceFile[],
    links: ImmutableSourceTree,
    archive?: Uint8Array,
    options?: SourceLimits,
  ): Promise<CapturedPackageSource> {
    const limits = sourceLimits(options),
      metadata = sourceInventory({ files: linkInventory, unavailable: [] }, limits).files,
      regular = await CapturedPackageSource.create(origin, inventory, tree, archive, limits);
    if (!(links instanceof ImmutableSourceTree)) throw new SourceError("invalidSource");
    if (tree.files.length + links.files.length > limits.files || tree.byteLength + links.byteLength > limits.totalBytes)
      throw new SourceError("sourceTooLarge");
    const expected = regular.descriptor.inventory.unavailable.filter((entry) => entry.reason === "symlink");
    if (JSON.stringify(metadata.map((entry) => entry.path)) !== JSON.stringify(expected.map((entry) => entry.path)))
      throw new SourceError("invalidSource");
    // Reuse original content verification without interpreting the link bytes as filesystem paths.
    await CapturedPackageSource.create(
      regular.descriptor.origin,
      { files: metadata, unavailable: [] },
      links,
      regular.readArchive(),
      limits,
    );
    const descriptor: LinkedSourceSnapshotDescriptor = {
      ...regular.descriptor,
      schema: "panda.package-source/v2",
      links: Object.freeze({ inventory: metadata, files: links.files, treeDigest: links.digest }),
    };
    return new CapturedPackageSource(
      tree,
      descriptor,
      regular.readArchive(),
      await contentSha256(JSON.stringify(descriptor)),
      links,
    );
  }
  static async create(
    originValue: unknown,
    inventoryValue: PackageSourceInventory,
    tree: ImmutableSourceTree,
    archiveValue?: Uint8Array,
    options?: SourceLimits,
  ): Promise<CapturedPackageSource> {
    const limits = sourceLimits(options),
      origin = sourceOrigin(originValue),
      inventory = sourceInventory(inventoryValue, limits);
    if (!(tree instanceof ImmutableSourceTree)) throw new SourceError("invalidSource");
    if (tree.files.length > limits.files || tree.byteLength > limits.totalBytes)
      throw new SourceError("sourceTooLarge");
    if (origin.kind === "zip-upload" ? !(archiveValue instanceof Uint8Array) : archiveValue !== undefined)
      throw new SourceError("invalidSource");
    if (archiveValue && archiveValue.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
    const archive = archiveValue && new Uint8Array(archiveValue),
      upstream = new Map(inventory.files.map((file) => [file.path, file]));
    for (const file of tree.files) {
      if (file.bytes > limits.fileBytes) throw new SourceError("sourceTooLarge");
      const original = upstream.get(file.path);
      if (!original || original.bytes !== file.bytes) throw new SourceError("sourceChanged");
      const digest =
        original.integrity.algorithm === "sha256" ? file.sha256 : await gitBlobDigest(tree.read(file.path));
      if (digest !== original.integrity.value) throw new SourceError("sourceChanged");
    }
    if (origin.kind === "zip-upload" && (await contentSha256(archive!)) !== origin.archiveSha256)
      throw new SourceError("sourceChanged");
    const descriptor: SourceSnapshotDescriptor = {
      schema: "panda.package-source/v1",
      origin,
      inventory,
      files: tree.files,
      treeDigest: tree.digest,
      archiveBytes: archive?.byteLength ?? 0,
    };
    return new CapturedPackageSource(tree, descriptor, archive, await contentSha256(JSON.stringify(descriptor)));
  }
  readArchive(): Uint8Array | undefined {
    return this.#archive && new Uint8Array(this.#archive);
  }
}

export async function captureSourceSnapshot(
  reader: PackageSourceReader,
  selected?: readonly string[],
  archiveValue?: Uint8Array,
  options?: SourceLimits,
  signal?: AbortSignal,
): Promise<CapturedPackageSource> {
  const limits = sourceLimits(options),
    origin = sourceOrigin(reader.origin),
    inventory = sourceInventory(reader, limits);
  if (archiveValue && archiveValue.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  const archive = archiveValue && new Uint8Array(archiveValue),
    tree = await capturePackageSource(
      { ...inventory, origin, read: reader.read.bind(reader) },
      selected,
      limits,
      signal,
    ),
    snapshot = await CapturedPackageSource.create(origin, inventory, tree, archive, limits);
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  return snapshot;
}
