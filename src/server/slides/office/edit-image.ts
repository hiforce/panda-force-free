import type { NativeSlotValue } from "../../../shared/slides/mapping.js";
import { slideAssert } from "../../../shared/slides/contracts.js";
import { OpcEdit } from "../../packages/opc/edit.js";
import { RELATIONSHIP_NAMESPACE } from "../../packages/opc/package.js";
import { relationshipPartName, physicalPartName } from "../../packages/opc/uris.js";
import { xmlChildren, xmlDescendants, type XmlElement } from "../../packages/opc/xml.js";
import type { PresentationNamespaces } from "./namespaces.js";
import { materializePicturePlaceholder } from "./picture-placeholder.js";

export function replaceNativeImage(
  edit: OpcEdit,
  part: string,
  shape: XmlElement,
  value: Extract<NativeSlotValue, { kind: "image" }>,
  ns: PresentationNamespaces,
): void {
  shape = materializePicturePlaceholder(shape, ns);
  const blips = xmlDescendants(shape, ns.a, "blip"),
    blip = blips[0];
  slideAssert(
    shape.localName === "pic" && blips.length === 1 && blip?.getAttributeNS(ns.r, "embed"),
    "unsupportedShape",
  );
  // Alternative SVG and image-effect originals require a format-specific update, not just a changed raster fallback.
  const references = [shape, ...Array.from(shape.getElementsByTagName("*"))].filter(
    (element) => element.hasAttributeNS(ns.r, "embed") || element.hasAttributeNS(ns.r, "link"),
  );
  slideAssert(
    references.length === 1 && references[0] === blip && !blip.hasAttributeNS(ns.r, "link"),
    "unsupportedShape",
  );
  const path = edit.locate(physicalPartName(relationshipPartName(part))),
    relationships = edit.xml(path),
    root = relationships.documentElement!,
    ids = new Set(xmlChildren(root, RELATIONSHIP_NAMESPACE, "Relationship").map((r) => r.getAttribute("Id"))),
    extension = value.mediaType === "image/png" ? "png" : "jpg";
  let ordinal = 1;
  while (!edit.available(`panda/media/image${ordinal}.${extension}`)) ordinal++;
  const media = `panda/media/image${ordinal}.${extension}`;
  edit.add(media, value.bytes, value.mediaType);
  let rid = 1;
  while (ids.has("pandaImage" + rid)) rid++;
  const id = "pandaImage" + rid,
    relation = relationships.createElementNS(RELATIONSHIP_NAMESPACE, "Relationship");
  relation.setAttribute("Id", id);
  relation.setAttribute("Type", ns.r + "/image");
  relation.setAttribute("Target", "/" + media);
  root.appendChild(relation);
  edit.setXml(path, relationships);
  blip.setAttributeNS(ns.r, "r:embed", id);
}
