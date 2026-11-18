import { defaultPresentationBytes } from "../../../slides/office/default-template.js";
import { NativePresentation } from "../../../slides/office/package.js";
import { composeNativeLayouts } from "../../../slides/office/compose.js";
import type { NativeContentSlot, NativeContentValues } from "../../../../shared/slides/mapping.js";
import { CreationError } from "../../contracts.js";
import { creationDigest, creationRecord, creationText } from "../../validation.js";
import sharp from "sharp";

const layouts = {
  cover: "ppt/slideLayouts/slideLayout1.xml",
  content: "ppt/slideLayouts/slideLayout2.xml",
  picture: "ppt/slideLayouts/slideLayout9.xml",
} as const;
export interface CreationSlidePage {
  layout: keyof typeof layouts;
  title: string;
  body: string;
  imageHandle?: string;
}
function textLines(text: string, width: number) {
  return text
    .split("\n")
    .reduce(
      (lines, line) =>
        lines +
        Math.max(
          1,
          Math.ceil(
            [...line].reduce((weight, letter) => weight + (letter.codePointAt(0)! > 255 ? 1.05 : 0.56), 0) / width,
          ),
        ),
      0,
    );
}
export function creationSlidePages(value: unknown): CreationSlidePage[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new CreationError("invalidInput");
  return value.map((page) => {
    const row = creationRecord(page, ["layout", "title", "body", "imageHandle"]),
      layout = row.layout as CreationSlidePage["layout"],
      title = creationText(row.title, 200),
      body = row.body ?? "";
    if (
      !Object.hasOwn(layouts, layout) ||
      typeof body !== "string" ||
      body.length > 2000 ||
      /[\p{Cc}\p{Cs}]/u.test(body.replace(/[\n\r\t]/g, "")) ||
      textLines(title, layout === "cover" ? 19 : 26) > 2 ||
      body.split("\n").length > 8 ||
      textLines(body, layout === "picture" ? 16 : 33) > (layout === "cover" ? 3 : 9) ||
      (layout === "content" && !body.trim()) ||
      (layout === "picture" && row.imageHandle === undefined) ||
      (layout !== "picture" && row.imageHandle !== undefined)
    )
      throw new CreationError("invalidInput");
    return {
      layout,
      title,
      body: body.replace(/\r\n?/g, "\n"),
      ...(row.imageHandle === undefined ? {} : { imageHandle: creationDigest(row.imageHandle) }),
    };
  });
}
let template: Promise<NativePresentation> | undefined;
/** Native layouts retain editable text and images; bounded pages never become screenshots or renamed outlines. */
export async function renderCreationSlides(value: unknown, image: (handle: string) => Promise<Uint8Array>) {
  const captured = creationSlidePages(value),
    source = await (template ??= NativePresentation.open(defaultPresentationBytes(), "PandaForce.pptx")),
    slots: NativeContentSlot[] = [];
  for (const [layout, part] of Object.entries(layouts)) {
    slots.push({ id: layout + "_title", label: "Title", kind: "text", target: { part, shapeId: "2" }, required: true });
    slots.push({
      id: layout + "_body",
      label: "Content",
      kind: "text",
      target: { part, shapeId: layout === "picture" ? "4" : "3" },
      required: false,
    });
    if (layout === "picture")
      slots.push({
        id: "picture_image",
        label: "Image",
        kind: "image",
        target: { part, shapeId: "3" },
        required: true,
      });
  }
  const pages: { layout: string; values: NativeContentValues }[] = [];
  for (const page of captured) {
    const values: Record<string, NativeContentValues[string]> = {
      [page.layout + "_title"]: { kind: "text", text: page.title },
      [page.layout + "_body"]: { kind: "text", text: page.body },
    };
    if (page.imageHandle) {
      const original = await image(page.imageHandle),
        bytes = await sharp(original, { limitInputPixels: 40_000_000 })
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer();
      values.picture_image = { kind: "image", mediaType: "image/png", bytes };
    }
    pages.push({ layout: layouts[page.layout], values });
  }
  const result = await composeNativeLayouts(
      source,
      { schema: "panda.powerpoint-mapping/v1", sourceSha256: source.index.source.sha256, slots },
      pages,
    ),
    reopened = await NativePresentation.open(result.bytes, "Presentation.pptx");
  if (reopened.index.slides.length !== captured.length) throw new CreationError("invalidOutput");
  for (const [index, page] of captured.entries()) {
    const native = reopened.part(reopened.index.slides[index]!.path),
      title = native.shapes.find((shape) => shape.id === "2");
    if (title?.kind !== "text" || title.text !== page.title) throw new CreationError("invalidOutput");
  }
  return { bytes: Buffer.from(result.bytes), pages: captured.length, mode: "editable-native-pptx" as const };
}
