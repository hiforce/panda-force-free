import { contentSha256 } from "../../../shared/packages/digest.js";
import { slideAssert, OfficePresentationError } from "../../../shared/slides/contracts.js";
import type { NativeContentValues } from "../../../shared/slides/mapping.js";
import { OpcEdit } from "../../packages/opc/edit.js";
import { OpcError } from "../../packages/opc/errors.js";
import { NativePresentation } from "./package.js";
import { nativeContentMapping } from "./mapping.js";
import { captureNativeValues } from "./values-input.js";
import { OFFICE_CONTENT_TYPES, presentationNamespaces } from "./namespaces.js";
import { nativeShapeElement } from "./shape-target.js";
import { replaceNativeText } from "./edit-text.js";
import { replaceNativeImage } from "./edit-image.js";
import { assertEditableNativeSource } from "./source-policy.js";

/** Adapt the complete source deck; this is neither a selected-slide composition nor a redacted source export. */
export async function applyNativeContent(source: NativePresentation, rawMapping: unknown, values: NativeContentValues) {
  const mapping = nativeContentMapping(source, rawMapping),
    captured = captureNativeValues(mapping, values),
    edit = new OpcEdit(source.parts),
    ns = presentationNamespaces(source.parts.xml(source.main).documentElement!.namespaceURI);
  slideAssert(
    mapping.slots.every((slot) => source.index.slides.some((slide) => slide.path === slot.target.part)),
    "invalidMapping",
  );
  assertEditableNativeSource(source);
  try {
    const changed = new Set<string>();
    for (const slot of mapping.slots) {
      const value = captured.get(slot.id);
      if (!value) continue;
      const document = edit.xml(slot.target.part),
        shape = nativeShapeElement(document, slot.target.shapeId, ns);
      if (value.kind === "text") replaceNativeText(shape, value.text, ns);
      else replaceNativeImage(edit, slot.target.part, shape, value, ns);
      edit.setXml(slot.target.part, document);
      changed.add(slot.target.part);
    }
    if (source.index.kind === "potx") edit.setContentType(source.main, OFFICE_CONTENT_TYPES.pptx);
    const bytes = await edit.archive(),
      sha256 = await contentSha256(bytes),
      mappingSha256 = await contentSha256(JSON.stringify(mapping));
    return {
      bytes,
      sha256,
      mappingSha256,
      sourceSha256: source.index.source.sha256,
      mode: "adapt-source-deck" as const,
      changedSlides: [...changed],
      originalSourcePreserved: true as const,
    };
  } catch (error) {
    if (error instanceof OpcError)
      throw new OfficePresentationError(
        error.code === "xmlLimitExceeded" ? "limitExceeded" : "invalidPackage",
        error.part,
      );
    throw error;
  }
}
