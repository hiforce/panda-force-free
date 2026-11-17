import { createHash } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import { readPackageFile } from "../../packages/file-bytes.js";
import { storeDocumentBlob } from "../blob-store.js";
import { DocumentError } from "../errors.js";
import { MAX_ASSET_BYTES } from "../image-decoder.js";

/** These paths come only from application configuration; a transfer can select an owned digest, never a host path. */
export class SQLDocumentOwnershipImages {
  private anchor: { path: string; dev: number; ino: number } | null = null;
  constructor(private readonly root: string) {}
  private async directory(create = false) {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root),
      path = await realpath(this.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (this.anchor !== null &&
        (this.anchor.path !== path || this.anchor.dev !== info.dev || this.anchor.ino !== info.ino))
    )
      throw new DocumentError("sourceUnavailable", 503);
    this.anchor = { path, dev: info.dev, ino: info.ino };
    return path;
  }
  private digest(asset: DocumentAsset) {
    if (
      !/^[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > MAX_ASSET_BYTES
    )
      throw new DocumentError("invalidImage");
    return asset.digest;
  }
  async read(asset: DocumentAsset) {
    const bytes = await readPackageFile(join(await this.directory(), this.digest(asset)), asset.size);
    if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.digest)
      throw new DocumentError("sourceUnavailable", 503);
    return bytes;
  }
  async write(asset: DocumentAsset, bytes: Uint8Array) {
    const digest = this.digest(asset),
      root = await this.directory(true);
    if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new DocumentError("sourceUnavailable", 503);
    try {
      const current = await lstat(join(root, digest));
      if (!current.isFile() || current.isSymbolicLink()) throw new DocumentError("sourceUnavailable", 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await storeDocumentBlob(root, digest, Buffer.from(bytes));
    await this.read(asset);
  }
}
