import type { TemplateImageDecoder } from "../authoring/ports.js";
import { DocumentImageDecoder } from "../../documents/image-decoder.js";
import { PortableRegistryError } from "../portable/errors.js";
import { createHash } from "node:crypto";
import { TEMPLATE_IMAGE_BYTES, type TemplateImage } from "../../../shared/templates/authoring/images.js";
import type { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import type { PortableTemplateResourceValidation } from "../portable/ports.js";
import { RasterCoverBusyError, RasterCoverRenderer } from "../../media/raster-cover.js";

/** Only the host bridge selects a raster decoder; the authoring domain knows bytes and declarative metadata. */
export function templateImageDecoder(): TemplateImageDecoder {
  const decoder = new DocumentImageDecoder();
  let active = 0;
  const waiting: (() => void)[] = [];
  const validated = new Map<string, TemplateImage>();
  return {
    async decode(input) {
      if (!(input instanceof Uint8Array) || !input.length || input.length > TEMPLATE_IMAGE_BYTES)
        throw new PortableRegistryError("invalidInput");
      const bytes = new Uint8Array(input),
        sha256 = createHash("sha256").update(bytes).digest("hex"),
        cached = validated.get(sha256);
      if (cached) {
        validated.delete(sha256);
        validated.set(sha256, cached);
        return { image: structuredClone(cached), bytes };
      }
      if (active >= 2) {
        if (waiting.length >= 16) throw new PortableRegistryError("invalidInput");
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else active++;
      try {
        const value = await decoder.decode("template-image", bytes),
          digest = value.digest;
        const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
        const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[value.mime];
        if (!extension) throw new PortableRegistryError("invalidInput");
        const image: TemplateImage = {
          id,
          path: `images/${digest}.${extension}`,
          sha256: digest,
          bytes: value.size,
          mediaType: value.mime as "image/png" | "image/jpeg" | "image/webp",
          width: value.width,
          height: value.height,
        };
        if (validated.size >= 256) validated.delete(validated.keys().next().value!);
        validated.set(digest, image);
        return { image: structuredClone(image), bytes };
      } catch {
        throw new PortableRegistryError("invalidInput");
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

/** Selected resources are decoded before installation or preview; a MIME label alone is not raster proof. */
export function templateImageResources(
  types: PortableTemplateTypes,
  decoder: TemplateImageDecoder,
  covers = new RasterCoverRenderer(),
): PortableTemplateResourceValidation {
  return async (template) => {
    try {
      for (const path of template.manifest.previews.filter((path) => /\.(?:png|jpe?g|webp)$/i.test(path)))
        await covers.render(template.read(path));
    } catch (error) {
      throw new PortableRegistryError(error instanceof RasterCoverBusyError ? "unavailable" : "invalidInput");
    }
    const model = types.prepare(template).model;
    if (model.kind !== "document" || model.syntax !== "richtext") return;
    for (const image of model.images) {
      const checked = (await decoder.decode(template.read(image.path))).image;
      if (
        checked.sha256 !== image.sha256 ||
        checked.bytes !== image.bytes ||
        checked.mediaType !== image.mediaType ||
        checked.width !== image.width ||
        checked.height !== image.height
      )
        throw new PortableRegistryError("invalidInput");
    }
  };
}
