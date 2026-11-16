import { slideAssert } from "../../../shared/slides/contracts.js";
import { xmlChildren, type XmlElement } from "../../packages/opc/xml.js";
import type { PresentationNamespaces } from "./namespaces.js";

/** Plain content inherits each native paragraph and its first run style; formatting is never converted to a screenshot. */
export function replaceNativeText(shape: XmlElement, text: string, ns: PresentationNamespaces): void {
  const bodies = xmlChildren(shape, ns.p, "txBody");
  slideAssert(shape.localName === "sp" && bodies.length === 1, "unsupportedShape");
  const body = bodies[0]!,
    paragraphs = xmlChildren(body, ns.a, "p"),
    document = body.ownerDocument!;
  slideAssert(paragraphs.length > 0, "unsupportedShape");
  for (const paragraph of paragraphs)
    slideAssert(
      Array.from(paragraph.childNodes).every(
        (child) =>
          child.nodeType !== 1 ||
          ((child as XmlElement).namespaceURI === ns.a &&
            ["pPr", "r", "fld", "br", "endParaRPr"].includes((child as XmlElement).localName!)),
      ),
      "unsupportedShape",
    );
  const outputs = text.split("\n").map((line, i) => {
    const original = paragraphs[Math.min(i, paragraphs.length - 1)]!,
      paragraph = original.cloneNode(true) as XmlElement,
      first = xmlChildren(original, ns.a, "r")[0] ?? xmlChildren(original, ns.a, "fld")[0],
      properties = first && xmlChildren(first, ns.a, "rPr")[0];
    for (const child of Array.from(paragraph.childNodes))
      if (child.nodeType === 1 && ["r", "fld", "br"].includes((child as XmlElement).localName!))
        paragraph.removeChild(child);
    const run = document.createElementNS(ns.a, "a:r"),
      content = document.createElementNS(ns.a, "a:t");
    if (properties) {
      const style = properties.cloneNode(true) as XmlElement;
      // Replacing a label must not retain a hidden hyperlink to the original label's destination.
      for (const name of ["hlinkClick", "hlinkMouseOver"])
        for (const link of xmlChildren(style, ns.a, name)) style.removeChild(link);
      run.appendChild(style);
    }
    content.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
    content.textContent = line;
    run.appendChild(content);
    paragraph.insertBefore(run, xmlChildren(paragraph, ns.a, "endParaRPr")[0] ?? null);
    return paragraph;
  });
  for (const paragraph of paragraphs) body.removeChild(paragraph);
  for (const paragraph of outputs) body.appendChild(paragraph);
}
