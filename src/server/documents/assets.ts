import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DocumentImageDecoder } from "./image-decoder.js";
import { storeDocumentBlob } from "./blob-store.js";
import type { DocumentAssetRepository } from "./asset-repository.js";
import { DocumentError } from "./errors.js";
export { MAX_ASSET_BYTES } from "./image-decoder.js";

/** Validates local image bytes and stores immutable blobs; never fetches remote URLs. */
export class DocumentAssets {
  private readonly decoder = new DocumentImageDecoder();
  constructor(
    readonly repository: DocumentAssetRepository,
    private root: string,
    private requireDocument: (id: string) => unknown,
  ) {}
  list(documentId: string) {
    this.requireDocument(documentId);
    return this.repository.list(documentId);
  }
  metadata(id: string) {
    const asset = this.repository.get(id);
    this.requireDocument(asset.documentId);
    return asset;
  }
  async upload(documentId: string, name: string, bytes: Buffer) {
    this.requireDocument(documentId);
    const staged = await this.stage(name, bytes);
    this.requireDocument(documentId);
    return this.repository.create({ ...staged, id: randomUUID(), documentId, alt: "", createdAt: Date.now() });
  }
  /** Staging writes immutable blobs only; the caller commits ownership and revision bindings atomically. */
  async stage(name: string, bytes: Buffer) {
    const { bytes: validated, ...record } = await this.decoder.decode(name, bytes);
    await storeDocumentBlob(this.root, record.digest, validated);
    // Files are content-addressed; an interrupted database write only leaves an unreferenced blob.
    return record;
  }

  async content(id: string) {
    const asset = this.repository.get(id);
    this.requireDocument(asset.documentId);
    const bytes = await readFile(join(this.root, asset.digest));
    if (createHash("sha256").update(bytes).digest("hex") !== asset.digest)
      throw new DocumentError("sourceUnavailable", 503);
    return { asset, bytes };
  }
}
