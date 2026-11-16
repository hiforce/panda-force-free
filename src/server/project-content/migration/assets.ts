import sharp from "sharp";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DocumentAsset } from "../../../shared/documents/contracts.js";
import { PROJECT_ASSET_BYTES } from "../asset-file.js";
import { ProjectContentError } from "../errors.js";
import { readContentFile } from "../working-files.js";

/** One validated administrator-provided directory is pinned for the duration of an import. */
export async function openLegacyAssets(path: string) {
  if (!isAbsolute(path)) throw new ProjectContentError("invalidFile");
  const canonical = await realpath(path),
    initial = await lstat(path);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new ProjectContentError("unowned");
  const verify = async () => {
    const current = await lstat(path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      (await realpath(path)) !== canonical
    )
      throw new ProjectContentError("unowned");
  };
  return {
    directory: canonical,
    verify,
    async read(asset: DocumentAsset): Promise<Buffer> {
      await verify();
      const bytes = await readContentFile(join(canonical, asset.digest), PROJECT_ASSET_BYTES);
      if (!bytes || bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.digest)
        throw new ProjectContentError("invalidFile");
      try {
        const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "error" }),
          info = await image.metadata(),
          formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
        if (
          !info.format ||
          formats[info.format] !== asset.mime ||
          info.width !== asset.width ||
          info.height !== asset.height ||
          (info.pages ?? 1) > 1
        )
          throw new ProjectContentError("invalidFile");
        await image.stats();
      } catch {
        throw new ProjectContentError("invalidFile");
      }
      await verify();
      return bytes;
    },
  };
}
