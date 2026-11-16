import { contentSha256 } from "../../../shared/packages/digest.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import { slideAssert, OfficePresentationError } from "../../../shared/slides/contracts.js";
import type { NativeLayoutPage } from "../../../shared/slides/mapping.js";
import { OpcEdit } from "../../packages/opc/edit.js";
import { OpcError } from "../../packages/opc/errors.js";
import { physicalPartName, relationshipPartName } from "../../packages/opc/uris.js";
import { xmlChildren, type XmlElement } from "../../packages/opc/xml.js";
import { NativePresentation } from "./package.js";
import { nativeContentMapping } from "./mapping.js";
import { captureNativeValues } from "./values-input.js";
import { OFFICE_CONTENT_TYPES, presentationNamespaces } from "./namespaces.js";
import { instantiateNativeLayout } from "./layout-slide.js";
import { referencedNativeIds, selectedNativeRelationships, appendNativeRelationship } from "./relationships.js";
import { nativeShapeElement } from "./shape-target.js";
import { replaceNativeText } from "./edit-text.js";
import { replaceNativeImage } from "./edit-image.js";
import { assertEditableNativeSource } from "./source-policy.js";
import { updateComposedMetadata } from "./compose-metadata.js";

/** Compose explicitly selected layouts; unreferenced sample pages are removed, while template metadata is not anonymized. */
export async function composeNativeLayouts(
  source: NativePresentation,
  rawMapping: unknown,
  pages: readonly NativeLayoutPage[],
) {
  assertEditableNativeSource(source);
  const mapping = nativeContentMapping(source, rawMapping);
  slideAssert(
    mapping.slots.every((slot) => source.index.layouts.some((layout) => layout.path === slot.target.part)),
    "invalidMapping",
  );
  slideAssert(Array.isArray(pages) && pages.length > 0 && pages.length <= 500 && source.index.size, "invalidMapping");
  let total = 0;
  const validatedLayouts = new Set<string>();
  const captured = pages.map((page) => {
    slideAssert(page && source.index.layouts.some((layout) => layout.path === page.layout), "invalidMapping");
    if (!validatedLayouts.has(page.layout)) {
      source.part(page.layout);
      validatedLayouts.add(page.layout);
    }
    const slots = mapping.slots.filter((slot) => slot.target.part === page.layout),
      values = captureNativeValues({ ...mapping, slots }, page.values);
    for (const value of values.values()) total += value.kind === "text" ? value.text.length * 4 : value.bytes.length;
    slideAssert(total <= 32 * 1024 * 1024, "limitExceeded");
    return { layout: page.layout, slots, values };
  });
  const edit = new OpcEdit(source.parts),
    document = edit.xml(source.main),
    root = document.documentElement!,
    ns = presentationNamespaces(root.namespaceURI),
    keep = new Set(["sldMasterIdLst", "sldSz", "notesSz", "embeddedFontLst", "defaultTextStyle"]);
  // Sections, old slide IDs and view-dependent extensions belong to the source deck, not this new layout composition.
  for (const node of Array.from(root.childNodes))
    if (node.nodeType !== 1 || (node as XmlElement).namespaceURI !== ns.p || !keep.has((node as XmlElement).localName!))
      root.removeChild(node);
  const ids = referencedNativeIds(root, ns),
    relationships = selectedNativeRelationships(source.parts, source.main, ids),
    list = document.createElementNS(ns.p, "p:sldIdLst");
  root.insertBefore(list, xmlChildren(root, ns.p, "sldSz")[0]!);
  const created: { path: string; layout: string }[] = [];
  try {
    for (const [index, page] of captured.entries()) {
      let ordinal = index + 1;
      while (
        !edit.available(`panda/slides/slide${ordinal}.xml`) ||
        !edit.available(`panda/slides/_rels/slide${ordinal}.xml.rels`)
      )
        ordinal++;
      const path = `panda/slides/slide${ordinal}.xml`,
        slide = instantiateNativeLayout(edit, page.layout, path, ns);
      for (const slot of page.slots) {
        const value = page.values.get(slot.id);
        if (!value) continue;
        const shape = nativeShapeElement(slide, slot.target.shapeId, ns);
        if (value.kind === "text") replaceNativeText(shape, value.text, ns);
        else replaceNativeImage(edit, path, shape, value, ns);
      }
      edit.setXml(path, slide);
      let rid = index + 1;
      while (ids.has("pandaSlide" + rid)) rid++;
      const id = "pandaSlide" + rid,
        entry = document.createElementNS(ns.p, "p:sldId");
      ids.add(id);
      entry.setAttribute("id", String(256 + index));
      entry.setAttributeNS(ns.r, "r:id", id);
      list.appendChild(entry);
      appendNativeRelationship(relationships, id, {
        id,
        type: ns.r + "/slide",
        target: "",
        external: false,
        part: path,
        fragment: null,
      });
      created.push({ path, layout: page.layout });
    }
    edit.setXml(source.main, document);
    edit.setXml(edit.locate(physicalPartName(relationshipPartName(source.main))), relationships);
    edit.setContentType(source.main, OFFICE_CONTENT_TYPES.pptx);
    updateComposedMetadata(edit, created.length);
    const bytes = await edit.archive({ pruneUnreachable: true });
    return {
      bytes,
      sha256: await contentSha256(bytes),
      mappingSha256: await contentSha256(JSON.stringify(mapping)),
      sourceSha256: source.index.source.sha256,
      mode: "compose-native-layouts" as const,
      pages: created,
      templateMetadataPreserved: true as const,
      originalSourcePreserved: true as const,
    };
  } catch (error) {
    if (error instanceof OpcError || error instanceof SourceError)
      throw new OfficePresentationError(
        error.code === "xmlLimitExceeded" || error.code === "sourceTooLarge" ? "limitExceeded" : "invalidPackage",
      );
    throw error;
  }
}
