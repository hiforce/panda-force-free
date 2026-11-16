import { mkdir, rename, rm, writeFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  TEMPLATE_PREVIEW_RENDERER,
  TEMPLATE_PREVIEW_VIEWS,
  type TemplatePreviewJob,
  type TemplatePreviewRaster,
} from "../../shared/template-previews/contracts.js";
import type { TemplatePreviewImageStore } from "./ports.js";
import { TemplatePreviewError } from "./errors.js";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class FileTemplatePreviewImages implements TemplatePreviewImageStore {
  constructor(private readonly root: string) {}
  private directory(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new TemplatePreviewError("invalidInput");
    return join(this.root, id);
  }
  async write(id: string, raster: TemplatePreviewRaster) {
    if (
      raster.schema !== 1 ||
      raster.renderer !== TEMPLATE_PREVIEW_RENDERER ||
      Object.keys(raster.images).sort().join(",") !== "article,home,mobile"
    )
      throw new TemplatePreviewError("unavailable");
    const directory = this.directory(id),
      images: TemplatePreviewJob["images"] = {};
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const view of TEMPLATE_PREVIEW_VIEWS) {
      const image = raster.images[view],
        width = view === "mobile" ? 390 : 1440,
        height = view === "mobile" ? 844 : 960;
      if (
        image.width !== width ||
        image.height !== height ||
        image.png.length > 8 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image.png)
      )
        throw new TemplatePreviewError("unavailable");
      const input = Buffer.from(image.png, "base64"),
        metadata = await sharp(input, { limitInputPixels: 2_000_000 }).metadata();
      if (metadata.format !== "png" || metadata.width !== width || metadata.height !== height)
        throw new TemplatePreviewError("unavailable");
      const bytes = await sharp(input).webp({ quality: 85 }).toBuffer();
      const temporary = join(directory, "." + randomUUID());
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        const file = await open(temporary, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(directory, view + ".webp"));
      } finally {
        await rm(temporary, { force: true });
      }
      images[view] = { width, height, bytes: bytes.length, sha256: digest(bytes) };
    }
    return images;
  }
  async read(job: TemplatePreviewJob, view: "home" | "article" | "mobile") {
    const entry = job.images[view];
    if (job.phase !== "ready" || !entry) throw new TemplatePreviewError("notFound");
    const path = join(this.directory(job.id), view + ".webp"),
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== entry.bytes || stat.size > 6 * 1024 * 1024)
        throw new TemplatePreviewError("unavailable");
      const bytes = await file.readFile();
      if (digest(bytes) !== entry.sha256) throw new TemplatePreviewError("unavailable");
      return bytes;
    } finally {
      await file.close();
    }
  }
}
