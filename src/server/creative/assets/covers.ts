import sharp from "sharp";
import { DocumentError } from "../../documents/errors.js";
import type { FileCreativeAssetReader } from "./reader.js";
import { creativeFilePreview } from "../../../shared/creative/file-types.js";
import type { CreativeAsset, CreativeResource } from "../../../shared/creative/assets.js";
import { CreativeSlidePreviews } from "./slide-previews.js";
import { renderVideoCover } from "./video-cover.js";

interface Cover {
  bytes: Buffer;
  width: number;
  height: number;
}
interface Pending {
  controller: AbortController;
  value: Promise<Cover>;
  users: number;
}
/** Pure thumbnails are bounded and shared by exact owner/version. Every delivery rechecks current authorization and metadata. */
export class CreativeAssetCovers {
  private readonly cache = new Map<string, { cover: Cover; expires: number }>();
  private readonly pending = new Map<string, Pending>();
  private bytes = 0;
  private active = 0;
  constructor(private readonly slides: Pick<CreativeSlidePreviews, "read"> = new CreativeSlidePreviews()) {}
  async read(
    owner: string,
    service: Pick<FileCreativeAssetReader, "resource">,
    project: string,
    id: string,
    version: string,
    signal: AbortSignal,
  ) {
    const validate = (asset: CreativeAsset, resource: CreativeResource) => {
      const type = creativeFilePreview(resource.name).kind;
      if (asset.kind !== "slides" && (asset.kind === "web" || !["image", "video"].includes(type)))
        throw new DocumentError("invalidInput");
      return { head: true };
    };
    const metadata = await service.resource(project, id, { version, signal, select: validate }),
      key = JSON.stringify([owner, project, id, version, metadata.resource.digest, "cover-v1"]);
    const cached = this.cache.get(key);
    let cover: Cover;
    if (cached && cached.expires > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      cover = cached.cover;
    } else {
      if (cached) this.remove(key);
      let pending = this.pending.get(key);
      if (pending?.controller.signal.aborted) pending = undefined;
      if (!pending) {
        if (this.active >= 4) throw new DocumentError("busy", 429);
        this.active++;
        const controller = new AbortController();
        const value: Promise<Cover> = (async () => {
          const sourceSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]);
          let bytesForCover: Buffer;
          if (metadata.asset.kind === "slides") {
            bytesForCover = (await this.slides.read(owner, service, project, id, version, 1, sourceSignal)).bytes;
          } else {
            const value = await service.resource(project, id, {
              version,
              signal: sourceSignal,
              select: (asset, resource) => {
                validate(asset, resource);
                return {};
              },
            });
            bytesForCover =
              creativeFilePreview(value.resource.name).kind === "video"
                ? await renderVideoCover(value.bytes!, value.resource.name, sourceSignal)
                : value.bytes!;
          }
          if (controller.signal.aborted) throw new DocumentError("unavailable", 503);
          const image = sharp(bytesForCover, { limitInputPixels: 40_000_000 }),
            info = await image.metadata(),
            rotated = (info.orientation ?? 1) >= 5,
            bytes = await image
              .rotate()
              .resize(512, 320, { fit: "inside", withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer(),
            result = {
              bytes,
              width: (rotated ? info.height : info.width)!,
              height: (rotated ? info.width : info.height)!,
            };
          if (controller.signal.aborted) throw new DocumentError("unavailable", 503);
          if (bytes.length > 512 * 1024) throw new DocumentError("invalidInput");
          while (this.cache.size && (this.cache.size >= 64 || this.bytes + bytes.length > 16 * 1024 * 1024))
            this.remove(this.cache.keys().next().value!);
          this.cache.set(key, { cover: result, expires: Date.now() + 300000 });
          this.bytes += bytes.length;
          return result;
        })().finally(() => {
          this.active--;
          if (this.pending.get(key)?.value === value) this.pending.delete(key);
        });
        pending = { controller, value, users: 0 };
        this.pending.set(key, pending);
      }
      cover = await this.wait(pending, signal);
    }
    await service.resource(project, id, { version, signal, select: validate });
    if (signal.aborted) throw new DocumentError("unavailable", 503);
    return cover;
  }
  private remove(key: string) {
    const value = this.cache.get(key);
    if (value) this.bytes -= value.cover.bytes.length;
    this.cache.delete(key);
  }
  private async wait(pending: Pending, signal: AbortSignal) {
    pending.users++;
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        pending.value,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new DocumentError("unavailable", 503));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
      if (!--pending.users) pending.controller.abort();
    }
  }
}
