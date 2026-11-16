import { SourceError, sourceLimits, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import type { PackageSourceInventory } from "../../../shared/packages/sources/inventory.js";
import type { PackageSourceFile } from "../../../shared/packages/sources/contracts.js";
import type { PackageContentCodec } from "../content-store.js";

const MAGIC = new TextEncoder().encode("PFSRC01\n"),
  HEADER_BYTES = 12,
  INDEX_BYTES = 12 * 1024 * 1024;

/** A bounded index describes contiguous raw payloads; source bodies never become base64 JSON. */
export class CapturedSourceCodec implements PackageContentCodec<CapturedPackageSource> {
  readonly extension = ".source" as const;
  readonly maxBytes: number;
  private limits: SourceLimits;
  constructor(options?: SourceLimits) {
    this.limits = sourceLimits(options);
    this.maxBytes = HEADER_BYTES + INDEX_BYTES + this.limits.totalBytes + this.limits.archiveBytes;
  }
  digest(value: CapturedPackageSource): string {
    return value.digest;
  }
  async encode(value: CapturedPackageSource): Promise<Uint8Array> {
    const index = new TextEncoder().encode(JSON.stringify(value.descriptor)),
      archive = value.readArchive();
    if (index.byteLength > INDEX_BYTES) throw new SourceError("sourceTooLarge");
    const length =
      HEADER_BYTES +
      index.byteLength +
      value.tree.byteLength +
      (value.links?.byteLength ?? 0) +
      (archive?.byteLength ?? 0);
    if (length > this.maxBytes) throw new SourceError("sourceTooLarge");
    const output = new Uint8Array(length);
    output.set(MAGIC);
    new DataView(output.buffer).setUint32(8, index.byteLength, false);
    output.set(index, HEADER_BYTES);
    let offset = HEADER_BYTES + index.byteLength;
    for (const file of value.tree.files) {
      output.set(value.tree.read(file.path), offset);
      offset += file.bytes;
    }
    for (const file of value.links?.files ?? []) {
      output.set(value.links!.read(file.path), offset);
      offset += file.bytes;
    }
    if (archive) output.set(archive, offset);
    return output;
  }
  async decode(input: Uint8Array): Promise<CapturedPackageSource> {
    if (!(input instanceof Uint8Array) || input.byteLength > this.maxBytes) throw new SourceError("sourceTooLarge");
    const bytes = new Uint8Array(input);
    if (bytes.length < HEADER_BYTES || MAGIC.some((byte, index) => bytes[index] !== byte))
      throw new SourceError("invalidSource");
    const length = new DataView(bytes.buffer).getUint32(8, false);
    if (length > INDEX_BYTES || length > bytes.length - HEADER_BYTES) throw new SourceError("invalidSource");
    let index: Record<string, unknown>;
    try {
      index = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length)),
      );
    } catch {
      throw new SourceError("invalidSource");
    }
    if (
      !index ||
      typeof index !== "object" ||
      Array.isArray(index) ||
      !["panda.package-source/v1", "panda.package-source/v2"].includes(String(index.schema)) ||
      !Array.isArray(index.files) ||
      index.files.length > this.limits.files ||
      !Number.isSafeInteger(index.archiveBytes) ||
      Number(index.archiveBytes) < 0 ||
      Number(index.archiveBytes) > this.limits.archiveBytes
    )
      throw new SourceError("invalidSource");
    let offset = HEADER_BYTES + length,
      total = 0;
    const resources = (files: unknown) => {
      if (!Array.isArray(files) || files.length > this.limits.files) throw new SourceError("invalidSource");
      return files.map((file: unknown) => {
        if (!file || typeof file !== "object" || Array.isArray(file)) throw new SourceError("invalidSource");
        const entry = file as Record<string, unknown>;
        if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) throw new SourceError("invalidSource");
        const size = Number(entry.bytes);
        total += size;
        if (size > this.limits.fileBytes || total > this.limits.totalBytes) throw new SourceError("sourceTooLarge");
        if (size > bytes.length - offset) throw new SourceError("invalidSource");
        const value = { path: entry.path as string, bytes: bytes.subarray(offset, offset + size) };
        offset += size;
        return value;
      });
    };
    const tree = await ImmutableSourceTree.create(resources(index.files), this.limits);
    let linkInventory: readonly PackageSourceFile[] | undefined, links: ImmutableSourceTree | undefined;
    if (index.schema === "panda.package-source/v2") {
      if (!index.links || typeof index.links !== "object" || Array.isArray(index.links))
        throw new SourceError("invalidSource");
      const raw = index.links as Record<string, unknown>;
      linkInventory = raw.inventory as readonly PackageSourceFile[];
      links = await ImmutableSourceTree.create(resources(raw.files), this.limits);
      if (tree.files.length + links.files.length > this.limits.files) throw new SourceError("sourceTooLarge");
    }
    if (bytes.length - offset !== index.archiveBytes) throw new SourceError("invalidSource");
    const archive =
        index.origin && typeof index.origin === "object" && "kind" in index.origin && index.origin.kind === "zip-upload"
          ? bytes.subarray(offset)
          : undefined,
      captured = links
        ? await CapturedPackageSource.createLinked(
            index.origin,
            index.inventory as PackageSourceInventory,
            tree,
            linkInventory!,
            links,
            archive,
            this.limits,
          )
        : await CapturedPackageSource.create(
            index.origin,
            index.inventory as PackageSourceInventory,
            tree,
            archive,
            this.limits,
          );
    if (JSON.stringify(captured.descriptor) !== JSON.stringify(index)) throw new SourceError("sourceChanged");
    return captured;
  }
}
