import { slideAssert } from "../../../shared/slides/contracts.js";
import { RELATIONSHIP_NAMESPACE, type OpcPackage, type OpcRelationship } from "../../packages/opc/package.js";
import { physicalPartName, relationshipPartName } from "../../packages/opc/uris.js";
import { xmlChildren, type XmlDocument, type XmlElement } from "../../packages/opc/xml.js";
import type { PresentationNamespaces } from "./namespaces.js";

export function referencedNativeIds(root: XmlElement, ns: PresentationNamespaces): Set<string> {
  const ids = new Set<string>();
  for (const node of [root, ...Array.from(root.getElementsByTagName("*"))])
    for (const attr of Array.from(node.attributes)) if (attr.namespaceURI === ns.r) ids.add(attr.value);
  return ids;
}
export function appendNativeRelationship(document: XmlDocument, id: string, ref: OpcRelationship): void {
  const node = document.createElementNS(RELATIONSHIP_NAMESPACE, "Relationship");
  node.setAttribute("Id", id);
  node.setAttribute("Type", ref.type);
  if (ref.external) {
    node.setAttribute("TargetMode", "External");
    node.setAttribute("Target", ref.target);
  } else
    node.setAttribute(
      "Target",
      "/" +
        physicalPartName(ref.part).split("/").map(encodeURIComponent).join("/") +
        (ref.fragment === null ? "" : "#" + encodeURIComponent(ref.fragment)),
    );
  document.documentElement!.appendChild(node);
}
/** Only relationships actually referenced by cloned markup cross into a new owning slide. */
export function selectedNativeRelationships(opc: OpcPackage, part: string, ids: Set<string>): XmlDocument {
  const path = opc.locate(physicalPartName(relationshipPartName(part))),
    document = opc.xml(path),
    root = document.documentElement!,
    refs = opc.relationships(part);
  for (const node of xmlChildren(root, RELATIONSHIP_NAMESPACE, "Relationship")) root.removeChild(node);
  for (const id of ids) {
    const ref = refs.find((item) => item.id === id);
    slideAssert(ref && !ref.type.endsWith("/slide") && !ref.type.endsWith("/notesSlide"), "unsupportedShape");
    appendNativeRelationship(document, id, ref);
  }
  return document;
}
