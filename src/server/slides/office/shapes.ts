import {
  slideAssert,
  type NativeSlideShape,
  type NativeSlidePart,
  type SlideTransform,
} from "../../../shared/slides/contracts.js";
import type { OpcPackage, OpcRelationship } from "../../packages/opc/package.js";
import { xmlChildren, xmlDescendants, type XmlElement } from "../../packages/opc/xml.js";
import type { PresentationNamespaces } from "./namespaces.js";
import { drawingId, officeBoolean, officeInteger, officeLabel } from "./values.js";

function transform(shape: XmlElement, ns: PresentationNamespaces): SlideTransform | null {
  const properties = xmlChildren(shape, ns.p, shape.localName === "grpSp" ? "grpSpPr" : "spPr")[0],
    frame = shape.localName === "graphicFrame" ? xmlChildren(shape, ns.p, "xfrm")[0] : undefined,
    element = frame ?? (properties && xmlChildren(properties, ns.a, "xfrm")[0]);
  if (!element) return null;
  const coordinate = (name: string, attribute: string) => {
    const node = xmlChildren(element, ns.a, name)[0];
    return node ? officeInteger(node.getAttribute(attribute)) : null;
  };
  const x = coordinate("off", "x"),
    y = coordinate("off", "y"),
    width = coordinate("ext", "cx"),
    height = coordinate("ext", "cy"),
    cx = coordinate("chOff", "x"),
    cy = coordinate("chOff", "y"),
    cw = coordinate("chExt", "cx"),
    ch = coordinate("chExt", "cy");
  slideAssert((width === null || width >= 0) && (height === null || height >= 0));
  slideAssert([cx, cy, cw, ch].every((n) => n === null) || [cx, cy, cw, ch].every((n) => n !== null));
  return {
    x,
    y,
    width,
    height,
    rotation: element.hasAttribute("rot") ? officeInteger(element.getAttribute("rot")) / 60000 : 0,
    flipH: officeBoolean(element, "flipH"),
    flipV: officeBoolean(element, "flipV"),
    childCoordinates: cx === null ? null : { x: cx, y: cy!, width: cw!, height: ch! },
  };
}

/** Shape projections keep native identity and local geometry; source XML retains all unprojected formatting. */
export function officeShapes(
  opc: OpcPackage,
  path: string,
  root: XmlElement,
  ns: PresentationNamespaces,
): NativeSlidePart {
  const common = xmlChildren(root, ns.p, "cSld");
  slideAssert(common.length === 1);
  const trees = xmlChildren(common[0]!, ns.p, "spTree");
  slideAssert(trees.length === 1);
  const tree = trees[0]!,
    ids = new Set<string>(),
    relations = opc.relationships(path);
  let count = 0,
    unsupported = 0;
  const rootId = xmlChildren(tree, ns.p, "nvGrpSpPr")[0];
  if (rootId) {
    const value = xmlChildren(rootId, ns.p, "cNvPr")[0];
    if (value) ids.add(drawingId(value.getAttribute("id")));
  }
  function image(shape: XmlElement): NativeSlideShape["image"] {
    const blip = xmlDescendants(shape, ns.a, "blip")[0],
      id = blip?.getAttributeNS(ns.r, "embed");
    if (!id) return null;
    const ref = relations.find((item) => item.id === id);
    slideAssert(ref && !ref.external && ref.type === ns.r + "/image" && ref.fragment === null);
    return { part: ref.part, mediaType: opc.contentTypes.forPart(ref.part), relationshipId: id };
  }
  function shapes(parent: XmlElement, depth: number): NativeSlideShape[] {
    slideAssert(depth <= 64, "limitExceeded");
    const result: NativeSlideShape[] = [];
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as XmlElement;
      if (element.namespaceURI !== ns.p) {
        unsupported++;
        continue;
      }
      if (["nvGrpSpPr", "grpSpPr"].includes(element.localName!)) continue;
      if (element.localName === "extLst") {
        unsupported++;
        continue;
      }
      slideAssert(++count <= 10000, "limitExceeded");
      const properties = Array.from(element.childNodes).find(
          (child) =>
            child.nodeType === 1 &&
            (child as XmlElement).namespaceURI === ns.p &&
            /^nv/.test((child as XmlElement).localName ?? ""),
        ) as XmlElement | undefined,
        identity = properties && xmlChildren(properties, ns.p, "cNvPr")[0];
      // Extension payloads are preserved by the package even when they are not DrawingML shape objects.
      if (!identity) {
        unsupported++;
        continue;
      }
      const id = drawingId(identity.getAttribute("id"));
      slideAssert(!ids.has(id));
      ids.add(id);
      const placeholder = properties && xmlDescendants(properties, ns.p, "ph")[0],
        body = xmlChildren(element, ns.p, "txBody")[0],
        paragraphs = body ? xmlChildren(body, ns.a, "p") : [],
        text = body
          ? paragraphs
              .map((p) =>
                Array.from(p.childNodes)
                  .map((node) => {
                    if (node.nodeType !== 1) return "";
                    const child = node as XmlElement;
                    if (child.namespaceURI !== ns.a) return "";
                    if (child.localName === "br") return "\n";
                    if (child.localName === "r" || child.localName === "fld")
                      return xmlChildren(child, ns.a, "t")
                        .map((t) => t.textContent ?? "")
                        .join("");
                    return "";
                  })
                  .join(""),
              )
              .join("\n")
          : null,
        data = xmlDescendants(element, ns.a, "graphicData")[0],
        uri = data?.getAttribute("uri") ?? "";
      let kind: NativeSlideShape["kind"] =
        element.localName === "grpSp" ? "group" : element.localName === "pic" ? "picture" : body ? "text" : "other";
      if (element.localName === "graphicFrame") {
        if (xmlDescendants(element, ns.a, "tbl").length) kind = "table";
        else if (/\/chart$/.test(uri)) kind = "chart";
        else if (/\/diagram$/.test(uri)) kind = "diagram";
        else if (xmlDescendants(element, ns.p, "oleObj").length) kind = "embedded";
      }
      result.push({
        id,
        name: officeLabel(identity.getAttribute("name"), id),
        kind,
        placeholder: placeholder
          ? {
              index: placeholder.hasAttribute("idx") ? drawingId(placeholder.getAttribute("idx")) : "0",
              type: officeLabel(placeholder.getAttribute("type"), "obj"),
            }
          : null,
        transform: transform(element, ns),
        text,
        image: kind === "picture" ? image(element) : null,
        children: kind === "group" ? shapes(element, depth + 1) : [],
      });
    }
    return result;
  }
  return {
    path,
    name: officeLabel(common[0]!.getAttribute("name"), path.split("/").at(-1)!),
    shapes: shapes(tree, 0),
    externalRelationships: relations.filter((ref: OpcRelationship) => ref.external).length,
    preservedOpaqueElements: unsupported,
  };
}
