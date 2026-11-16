import { constants } from "node:fs";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { VariantContent, VariantContents } from "./variant-content.js";
import { encodeVariantContent } from "./variant-content.js";
import { PublicationError } from "./errors.js";

export const VARIANT_FILE_LIMIT = 32 * 1024 * 1024;
/** Generated immutable text lives in files outside project Git. SQLite stores references and review state only. */
export class PublicationVariantFiles implements VariantContents {
  constructor(private readonly root: string) {}
  private path(digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new PublicationError("invalidInput");
    return join(this.root, digest + ".json");
  }
  private async directory(create: boolean) {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PublicationError("unavailable", 503);
  }
  private async sync() {
    const dir = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async put(content: VariantContent) {
    const bytes = Buffer.from(encodeVariantContent(content));
    if (bytes.length > VARIANT_FILE_LIMIT) throw new PublicationError("exportTooLarge", 413);
    const digest = createHash("sha256").update(bytes).digest("hex"),
      path = this.path(digest);
    await this.directory(true);
    const temporary = join(this.root, ".variant-" + randomUUID()),
      handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.read(digest);
      }
      await this.sync();
    } finally {
      await unlink(temporary);
    }
    return digest;
  }
  async read(digest: string): Promise<VariantContent> {
    const path = this.path(digest);
    try {
      await this.directory(false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > VARIANT_FILE_LIMIT) throw new PublicationError("unavailable", 503);
        const chunks: Buffer[] = [];
        let length = 0;
        while (length <= VARIANT_FILE_LIMIT) {
          const chunk = Buffer.allocUnsafe(Math.min(65536, VARIANT_FILE_LIMIT - length + 1)),
            result = await handle.read(chunk);
          if (!result.bytesRead) break;
          length += result.bytesRead;
          if (length > VARIANT_FILE_LIMIT) throw new PublicationError("unavailable", 503);
          chunks.push(chunk.subarray(0, result.bytesRead));
        }
        bytes = Buffer.concat(chunks, length);
      } finally {
        await handle.close();
      }
      if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new PublicationError("unavailable", 503);
      const split = bytes.indexOf(10);
      if (split < 0) throw new PublicationError("unavailable", 503);
      return {
        variant: JSON.parse(bytes.subarray(0, split).toString("utf8")),
        ir: JSON.parse(bytes.subarray(split + 1).toString("utf8")),
      };
    } catch (error) {
      if (error instanceof PublicationError) throw error;
      throw new PublicationError("unavailable", 503);
    }
  }
}
