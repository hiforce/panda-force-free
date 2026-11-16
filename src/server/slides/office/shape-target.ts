import { slideAssert } from "../../../shared/slides/contracts.js";
import { xmlDescendants, type XmlDocument, type XmlElement } from "../../packages/opc/xml.js";
import type { PresentationNamespaces } from "./namespaces.js";
import { drawingId } from "./values.js";

export function nativeShapeElement(document: XmlDocument, id: string, ns: PresentationNamespaces): XmlElement {
  const identities = xmlDescendants(document, ns.p, "cNvPr").filter(
    (node) => drawingId(node.getAttribute("id")) === id,
  );
  slideAssert(identities.length === 1, "invalidMapping");
  const shape = identities[0]!.parentNode?.parentNode;
  slideAssert(shape?.nodeType === 1, "invalidMapping");
  return shape as XmlElement;
}
