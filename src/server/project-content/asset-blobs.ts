import { createHash, randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DocumentAsset } from "../../shared/documents/contracts.js";
import type { OwnedAssetDirectory } from "./asset-directory.js";
import { PROJECT_ASSET_BYTES, decodeAssetRecord } from "./asset-file.js";
import { ProjectContentError } from "./errors.js";
import { fileDigest, fileInteger } from "./codec-values.js";
import { isMissingFile, readContentFile, syncContentDirectory } from "./working-files.js";

/** Content-addressed binary files remain outside the project's Git; publication of a blob never overwrites existing bytes. */
export class ProjectAssetBlobs {
  constructor(
    readonly owned: OwnedAssetDirectory,
    private readonly maximumBytes = PROJECT_ASSET_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024)
      throw new ProjectContentError("invalidFile");
  }

  async read(digest: string, size: number): Promise<Buffer> {
    fileDigest(digest);
    fileInteger(size, 1);
    if (size > this.maximumBytes) throw new ProjectContentError("invalidFile");
    await this.owned.verify();
    const bytes = await readContentFile(join(this.owned.blobs, digest), this.maximumBytes);
    if (bytes === null || bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new ProjectContentError("invalidFile");
    await this.owned.verify();
    return bytes;
  }
  async put(digest: string, input: Uint8Array): Promise<void> {
    fileDigest(digest);
    if (!input.byteLength || input.byteLength > this.maximumBytes) throw new ProjectContentError("invalidFile");
    const bytes = Buffer.from(input);
    if (
      !bytes.length ||
      bytes.length > this.maximumBytes ||
      createHash("sha256").update(bytes).digest("hex") !== digest
    )
      throw new ProjectContentError("invalidFile");
    await this.owned.verify();
    const temporary = join(this.owned.blobs, ".panda-blob-" + randomUUID()),
      destination = join(this.owned.blobs, digest),
      file = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      closed = true;
      await this.owned.verify();
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.read(digest, bytes.length);
      await syncContentDirectory(this.owned.blobs);
    } finally {
      if (!closed) await file.close();
      await unlink(temporary).catch((error) => {
        if (!isMissingFile(error)) throw error;
      });
      await syncContentDirectory(this.owned.blobs);
    }
  }
  /** Legacy source roots are read-only. All bytes are verified before entering the owned target. */
  async copyLegacy(sourceRoot: string, input: DocumentAsset): Promise<void> {
    if (!isAbsolute(sourceRoot)) throw new ProjectContentError("invalidFile");
    const asset = decodeAssetRecord(input),
      bytes = await readContentFile(join(sourceRoot, asset.digest), PROJECT_ASSET_BYTES);
    if (
      bytes === null ||
      bytes.length !== asset.size ||
      createHash("sha256").update(bytes).digest("hex") !== asset.digest
    )
      throw new ProjectContentError("invalidFile");
    await this.put(asset.digest, bytes);
  }
}
