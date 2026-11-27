import sharp from "sharp";
import {
  memoryMaterialPreview,
  type MemoryMaterialHit,
  type MemoryMaterialLocation,
} from "../../shared/project-memory/materials.js";
import type { HarnessVisualEvidence } from "../harness/ports.js";
import { attachmentImageType } from "../workspace/attachments.js";
import type { MemoryMaterialPreviews } from "./material-previews.js";
import type { MemoryMaterialStore } from "./materials.js";

export type MaterialRecallHit = MemoryMaterialHit & { id: string; version: string };
const maximumBytes = 768 * 1024;

async function visual(
  bytes: Buffer,
  location: MemoryMaterialLocation | undefined,
): Promise<HarnessVisualEvidence | undefined> {
  // Only decode raster inputs accepted by the normal attachment path.
  if (!attachmentImageType(bytes)) return;
  const input = sharp(bytes, { limitInputPixels: 32_000_000, failOn: "error" });
  const metadata = await input.metadata();
  const { width, height } = metadata.autoOrient;
  if (!width || !height) return;
  input.autoOrient();
  if (location?.kind === "image") {
    const left = Math.min(width - 1, Math.round(location.x * width));
    const top = Math.min(height - 1, Math.round(location.y * height));
    input.extract({
      left,
      top,
      width: Math.min(width - left, Math.max(1, Math.round((location.x + location.width) * width) - left)),
      height: Math.min(height - top, Math.max(1, Math.round((location.y + location.height) * height) - top)),
    });
  }
  input.resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true });
  const png = await input.clone().png().toBuffer();
  if (png.byteLength <= maximumBytes) return { mimeType: "image/png", base64: png.toString("base64") };
  const jpeg = await input.flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
  if (jpeg.byteLength <= maximumBytes) return { mimeType: "image/jpeg", base64: jpeg.toString("base64") };
}

/** Short-lived visual evidence is created from the exact authorized original, without exposing its storage path. */
export class MemoryMaterialVisuals {
  private active = 0;
  constructor(
    private readonly store: Pick<MemoryMaterialStore, "read">,
    private readonly previews: MemoryMaterialPreviews,
  ) {}

  async prepare(
    owner: string,
    project: string,
    hits: readonly MaterialRecallHit[],
    verify: (hit: MaterialRecallHit) => Promise<{ checksum: string }>,
  ) {
    const results = new Map<string, { version: string; image: HarnessVisualEvidence }>();
    const signal = AbortSignal.timeout(5000);
    for (const hit of hits) {
      if (this.active >= 3 || signal.aborted || results.size >= 2) break;
      const { location, material, file, packageId } = hit;
      const format = memoryMaterialPreview(material.kind, file.name).kind;
      const pageKind = format === "pdf" ? "page" : "slide";
      const page =
        (format === "slides" || format === "pdf") && location?.kind === pageKind ? location.number : undefined;
      if (format !== "image" && page === undefined) continue;
      this.active++;
      try {
        const { checksum } = await verify(hit);
        const read = () => this.store.read(owner, project, checksum, file.digest, file.size);
        const bytes = page
          ? (
              await this.previews.readPage(
                {
                  identity: ["package", owner, project, packageId, material.id, file.digest],
                  kind: material.kind,
                  file,
                  read,
                  verify: () => verify(hit),
                },
                page,
                pageKind,
                signal,
              )
            ).bytes
          : await read();
        signal.throwIfAborted();
        const image = await visual(Buffer.from(bytes), location);
        signal.throwIfAborted();
        if (image) {
          if ((await verify(hit)).checksum !== checksum) continue;
          results.set(hit.id, { version: hit.version, image });
        }
      } catch {
        // Unavailable, withdrawn or unsupported visuals leave normal text recall available.
      } finally {
        this.active--;
      }
    }
    return results;
  }
}
