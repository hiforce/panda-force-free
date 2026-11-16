import { contentSha256 } from "../digest.js";
import { SourceError, sourceLimits, type SourceFile, type SourceLimits, type SourceResource } from "./contracts.js";
import { sourcePath, SourcePaths } from "./paths.js";

/** Owned source bytes are independent of archive layout and transport metadata. */
export class ImmutableSourceTree {
  readonly files: readonly SourceFile[];
  readonly byteLength: number;
  readonly digest: string;
  #resources: ReadonlyMap<string, Uint8Array>;
  private constructor(resources: ReadonlyMap<string, Uint8Array>, files: readonly SourceFile[], digest: string) {
    this.#resources = resources;
    this.files = Object.freeze(files.map((file) => Object.freeze({ ...file })));
    this.byteLength = files.reduce((size, file) => size + file.bytes, 0);
    this.digest = digest;
    Object.freeze(this);
  }
  static async create(input: Iterable<SourceResource>, options?: SourceLimits): Promise<ImmutableSourceTree> {
    const limits = sourceLimits(options),
      paths = new SourcePaths(limits.entries),
      resources = new Map<string, Uint8Array>();
    let total = 0;
    // Capture all caller-owned bytes and limits before the first asynchronous digest.
    for (const resource of input) {
      if (!resource || !(resource.bytes instanceof Uint8Array)) throw new SourceError("invalidSource");
      const path = paths.add(resource.path);
      total += resource.bytes.byteLength;
      if (resources.size >= limits.files || resource.bytes.byteLength > limits.fileBytes || total > limits.totalBytes)
        throw new SourceError("sourceTooLarge");
      resources.set(path, new Uint8Array(resource.bytes));
    }
    const files: SourceFile[] = [];
    for (const path of [...resources.keys()].sort()) {
      const bytes = resources.get(path)!;
      files.push({ path, bytes: bytes.byteLength, sha256: await contentSha256(bytes) });
    }
    return new ImmutableSourceTree(resources, files, await contentSha256(JSON.stringify({ schema: 1, files })));
  }
  has(path: string): boolean {
    return this.#resources.has(sourcePath(path));
  }
  read(path: string): Uint8Array {
    const bytes = this.#resources.get(sourcePath(path));
    if (!bytes) throw new SourceError("sourceUnavailable");
    return new Uint8Array(bytes);
  }
  text(path: string, maxBytes = 256 * 1024): string {
    const bytes = this.#resources.get(sourcePath(path));
    if (!bytes) throw new SourceError("sourceUnavailable");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength > maxBytes)
      throw new SourceError("sourceTooLarge");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SourceError("invalidSource");
    }
  }
}
