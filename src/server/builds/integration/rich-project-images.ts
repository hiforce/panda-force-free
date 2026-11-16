import { createHash } from "node:crypto";
import sharp from "sharp";
import type { DocumentRevision } from "../../../shared/documents/contracts.js";
import { richBodyImageIds, richImageId } from "../../../shared/documents/rich-body.js";
import { safeBuildPath } from "../../../shared/builds/files.js";
import type { BuildDocumentAssets } from "./document-ports.js";
import { SiteBuildError } from "../errors.js";

/** Target-specific derivatives belong to the frozen build; source blobs and revisions remain untouched. */
export async function* richProjectImages(
  documentId: string,
  revision: DocumentRevision,
  cover: unknown,
  assets: BuildDocumentAssets,
) {
  if (!revision.body) return;
  const ids = new Set(richBodyImageIds(revision.body));
  let coverId: string | undefined;
  if (typeof cover === "string" && cover.startsWith("/api/document-assets/")) {
    try {
      coverId = richImageId(cover);
    } catch {
      throw new SiteBuildError("unsupportedImageReference");
    }
    ids.add(coverId);
  }
  for (const id of ids) {
    const image = await assets.content(id);
    if (image.asset.documentId !== documentId) throw new SiteBuildError("assetUnavailable", 404);
    let path: string;
    try {
      path = safeBuildPath(
        `assets/documents/${documentId}/${id}/${image.asset.name.replace(/\.(?:png|jpe?g|webp)$/i, "")}.webp`,
      );
    } catch {
      throw new SiteBuildError("unsupportedImageReference");
    }
    let bytes: Buffer;
    try {
      bytes =
        image.asset.mime === "image/webp"
          ? image.bytes
          : await sharp(image.bytes, { limitInputPixels: 16_000_000, failOn: "error" })
              .webp({ quality: 88 })
              .toBuffer();
    } catch {
      throw new SiteBuildError("assetUnavailable", 404);
    }
    if (bytes.length > 8 * 1024 * 1024) throw new SiteBuildError("snapshotTooLarge", 413);
    yield {
      id,
      cover: id === coverId,
      url: "/" + path.split("/").map(encodeURIComponent).join("/"),
      file: {
        path,
        data: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        publish: true,
      },
    };
  }
}
