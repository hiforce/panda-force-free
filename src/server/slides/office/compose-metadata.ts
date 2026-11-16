import { OpcEdit } from "../../packages/opc/edit.js";
import { RELATIONSHIP_NAMESPACE } from "../../packages/opc/package.js";
import { physicalPartName } from "../../packages/opc/uris.js";
import { xmlChildren } from "../../packages/opc/xml.js";
import { slideAssert } from "../../../shared/slides/contracts.js";

/** A new composition must not advertise the old deck's thumbnail, slide count or sample title inventory. */
export function updateComposedMetadata(edit: OpcEdit, slides: number): void {
  const refs = edit.source.relationships(null),
    thumbnailIds = new Set(refs.filter((ref) => ref.type.endsWith("/metadata/thumbnail")).map((ref) => ref.id));
  if (thumbnailIds.size) {
    const path = edit.locate("_rels/.rels"),
      document = edit.xml(path),
      root = document.documentElement!;
    for (const node of xmlChildren(root, RELATIONSHIP_NAMESPACE, "Relationship"))
      if (thumbnailIds.has(node.getAttribute("Id")!)) root.removeChild(node);
    edit.setXml(path, document);
  }
  for (const ref of refs.filter(
    (r) => r.type.endsWith("/extended-properties") || r.type.endsWith("/extendedProperties"),
  )) {
    slideAssert(!ref.external && ref.fragment === null, "unsupportedPackage");
    const path = edit.locate(physicalPartName(ref.part)),
      document = edit.xml(path),
      root = document.documentElement!,
      ns = root.namespaceURI;
    slideAssert(root.localName === "Properties" && ns, "unsupportedPackage");
    for (const name of ["Slides", "Notes", "HiddenSlides", "MMClips", "HeadingPairs", "TitlesOfParts"])
      for (const node of xmlChildren(root, ns, name)) root.removeChild(node);
    const count = document.createElementNS(ns, "Slides");
    count.textContent = String(slides);
    root.appendChild(count);
    edit.setXml(path, document);
  }
}
