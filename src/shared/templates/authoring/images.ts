import type { RichDocumentBody, RichTextNode } from "../../documents/rich-body.js";
import { normalizeRichBody, richImageId } from "../../documents/rich-body.js";
import type { PortableTemplateManifest } from "../portable/contracts.js";
import { templateAssert } from "../portable/errors.js";
import {
  templateDigest,
  templateInteger,
  templateList,
  templateObject,
  templatePath,
  templateText,
  templateUnique,
} from "../portable/validation.js";

export interface TemplateImage {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}
export const TEMPLATE_IMAGE_BYTES = 8 * 1024 * 1024;
export const TEMPLATE_IMAGES_BYTES = 48 * 1024 * 1024;

export function templateImageId(value: unknown): string {
  const id = templateText(value, 36);
  templateAssert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id));
  return id;
}
export function templateImages(value: unknown): readonly TemplateImage[] {
  const images = templateList(
    value,
    (item): TemplateImage => {
      const input = templateObject(item, ["id", "path", "sha256", "bytes", "mediaType", "width", "height"]);
      templateAssert(["image/png", "image/jpeg", "image/webp"].includes(String(input.mediaType)));
      const width = templateInteger(input.width, 1, 20000),
        height = templateInteger(input.height, 1, 20000);
      templateAssert(width * height <= 16_000_000);
      return {
        id: templateImageId(input.id),
        path: templatePath(input.path),
        sha256: templateDigest(input.sha256),
        bytes: templateInteger(input.bytes, 1, TEMPLATE_IMAGE_BYTES),
        mediaType: input.mediaType as TemplateImage["mediaType"],
        width,
        height,
      };
    },
    64,
  );
  templateUnique(images, (item) => item.id);
  templateAssert(images.reduce((sum, item) => sum + item.bytes, 0) <= TEMPLATE_IMAGES_BYTES, "packageTooLarge");
  return images;
}
export function validateTemplateImageFiles(images: readonly TemplateImage[], manifest: PortableTemplateManifest) {
  for (const image of images) {
    const file = manifest.files.find((file) => file.path === image.path);
    templateAssert(
      file && file.sha256 === image.sha256 && file.bytes === image.bytes && file.mediaType === image.mediaType,
      "resourceMismatch",
    );
  }
}

/** Portable files use symbolic image references; editor URLs exist only in the host projection. */
export function templateImageBody(
  value: unknown,
  direction: "read" | "write",
  images: readonly TemplateImage[],
): RichDocumentBody {
  const body = structuredClone(value) as RichDocumentBody,
    allowed = new Set(images.map((image) => image.id));
  let count = 0;
  const visit = (node: RichTextNode, depth: number) => {
    templateAssert(node && typeof node === "object" && ++count <= 20000 && depth <= 32, "invalidPayload");
    if (node.type === "image") {
      const source = node.attrs?.src;
      templateAssert(typeof source === "string", "invalidPayload");
      const id =
        direction === "read"
          ? templateImageId(source.startsWith("template-asset:") ? source.slice(15) : "")
          : richImageId(source);
      templateAssert(allowed.has(id), "resourceMissing");
      node.attrs = {
        ...node.attrs,
        src: direction === "read" ? "/api/document-assets/content?id=" + id : "template-asset:" + id,
      };
    }
    if (node.content !== undefined) {
      templateAssert(Array.isArray(node.content), "invalidPayload");
      node.content.forEach((child) => visit(child, depth + 1));
    }
  };
  if (direction === "write") {
    const normalized = normalizeRichBody(body);
    visit(normalized.document, 0);
    return normalized;
  }
  templateAssert(body?.schema === 1 && body.format === "richtext", "invalidPayload");
  visit(body.document, 0);
  return normalizeRichBody(body);
}
