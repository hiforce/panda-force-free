import type { NativePresentationIndex } from "../../../shared/slides/contracts.js";
import { slideAssert } from "../../../shared/slides/contracts.js";
import { OpcPackage, type OpcRelationship } from "../../packages/opc/package.js";
import { xmlChildren, type XmlElement } from "../../packages/opc/xml.js";
import {
  PRESENTATION_NAMESPACES,
  OFFICE_CONTENT_TYPES,
  presentationNamespaces,
  type PresentationNamespaces,
} from "./namespaces.js";
import { officeInteger, drawingId, officeLabel } from "./values.js";

export type PresentationStructure = Omit<NativePresentationIndex, "source" | "schema">;
export function internalRelation(
  opc: OpcPackage,
  source: string | null,
  id: string,
  type: string,
  relations = opc.relationships(source),
): string {
  const relationship = relations.find((item) => item.id === id);
  slideAssert(relationship && !relationship.external && relationship.type === type && relationship.fragment === null);
  return relationship.part;
}
const typedRelations = (relations: readonly OpcRelationship[], type: string) =>
  relations.filter((item) => item.type === type);

export function officePartRoot(opc: OpcPackage, path: string, local: string, ns: PresentationNamespaces): XmlElement {
  const root = opc.xml(path).documentElement!;
  slideAssert(root.localName === local && root.namespaceURI === ns.p);
  return root;
}
export const partName = (root: XmlElement, ns: PresentationNamespaces, fallback: string) =>
  officeLabel(xmlChildren(root, ns.p, "cSld")[0]?.getAttribute("name") ?? null, fallback);

/** Presentation order and master/layout reciprocity are derived from relationships, never guessed filenames. */
export function presentationStructure(opc: OpcPackage): {
  main: string;
  ns: PresentationNamespaces;
  index: PresentationStructure;
} {
  const office = opc
    .relationships(null)
    .filter((item) => PRESENTATION_NAMESPACES.some((ns) => item.type === ns.r + "/officeDocument"));
  slideAssert(office.length === 1 && !office[0]!.external && office[0]!.fragment === null);
  const main = office[0]!.part,
    document = opc.xml(main),
    ns = presentationNamespaces(document.documentElement?.namespaceURI ?? null),
    root = document.documentElement!;
  slideAssert(root.localName === "presentation");
  const kind = opc.contentTypes.matches(main, OFFICE_CONTENT_TYPES.pptx)
    ? "pptx"
    : opc.contentTypes.matches(main, OFFICE_CONTENT_TYPES.potx)
      ? "potx"
      : null;
  slideAssert(kind, "unsupportedPackage");
  slideAssert(office[0]!.type === ns.r + "/officeDocument");
  const relations = opc.relationships(main),
    masterList = xmlChildren(root, ns.p, "sldMasterIdLst"),
    slideList = xmlChildren(root, ns.p, "sldIdLst"),
    sizeNodes = xmlChildren(root, ns.p, "sldSz");
  slideAssert(masterList.length <= 1 && slideList.length <= 1 && sizeNodes.length <= 1);
  const entries = (
    parent: XmlElement | undefined,
    local: string,
    relationType: string,
    source: string,
    refs = relations,
  ) => {
    const ids = new Set<string>(),
      paths = new Set<string>();
    return (parent ? xmlChildren(parent, ns.p, local) : []).map((item) => {
      const id = drawingId(item.getAttribute("id")),
        path = internalRelation(opc, source, item.getAttributeNS(ns.r, "id") ?? "", ns.r + relationType, refs);
      slideAssert(!ids.has(id) && !paths.has(path));
      ids.add(id);
      paths.add(path);
      return path;
    });
  };
  const masterPaths = entries(masterList[0], "sldMasterId", "/slideMaster", main),
    slidePaths = entries(slideList[0], "sldId", "/slide", main);
  slideAssert(masterPaths.length <= 128 && slidePaths.length <= 500, "limitExceeded");
  const masters: NativePresentationIndex["masters"][number][] = [],
    layouts: NativePresentationIndex["layouts"][number][] = [];
  for (const path of masterPaths) {
    slideAssert(opc.contentTypes.matches(path, OFFICE_CONTENT_TYPES.master));
    const master = officePartRoot(opc, path, "sldMaster", ns),
      refs = opc.relationships(path),
      list = xmlChildren(master, ns.p, "sldLayoutIdLst");
    slideAssert(list.length <= 1);
    const paths = entries(list[0], "sldLayoutId", "/slideLayout", path, refs),
      themes = typedRelations(refs, ns.r + "/theme").map((ref) => {
        slideAssert(!ref.external && ref.fragment === null);
        return ref.part;
      });
    masters.push({ path, name: partName(master, ns, path.split("/").at(-1)!), layouts: paths, themes });
    for (const layoutPath of paths) {
      slideAssert(layouts.length < 1024, "limitExceeded");
      slideAssert(
        !layouts.some((item) => item.path === layoutPath) &&
          opc.contentTypes.matches(layoutPath, OFFICE_CONTENT_TYPES.layout),
      );
      const layout = officePartRoot(opc, layoutPath, "sldLayout", ns),
        back = typedRelations(opc.relationships(layoutPath), ns.r + "/slideMaster");
      slideAssert(back.length === 1 && !back[0]!.external && back[0]!.part === path && back[0]!.fragment === null);
      layouts.push({
        path: layoutPath,
        name: partName(layout, ns, layoutPath.split("/").at(-1)!),
        type: officeLabel(layout.getAttribute("type"), "cust"),
        master: path,
      });
    }
  }
  const slides = slidePaths.map((path) => {
    slideAssert(opc.contentTypes.matches(path, OFFICE_CONTENT_TYPES.slide));
    const slide = officePartRoot(opc, path, "sld", ns),
      refs = typedRelations(opc.relationships(path), ns.r + "/slideLayout"),
      ref = refs[0];
    slideAssert(refs.length === 1 && ref && !ref.external && ref.fragment === null);
    const layout = layouts.find((item) => item.path === ref.part);
    slideAssert(layout);
    return { path, name: partName(slide, ns, path.split("/").at(-1)!), layout: layout.path, master: layout.master };
  });
  const sizeNode = sizeNodes[0],
    size = sizeNode
      ? { width: officeInteger(sizeNode.getAttribute("cx")), height: officeInteger(sizeNode.getAttribute("cy")) }
      : null;
  slideAssert(!size || (size.width > 0 && size.height > 0));
  return { main, ns, index: { kind, dialect: ns.dialect, size, masters, layouts, slides } };
}
