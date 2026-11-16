import { slideAssert } from "../../../shared/slides/contracts.js";
import { xmlChildren, xmlDescendants, type XmlElement } from "../../packages/opc/xml.js";
import type { PresentationNamespaces } from "./namespaces.js";

/** Native picture placeholders retain their drawing identity and layout binding when filled for the first time. */
export function materializePicturePlaceholder(shape: XmlElement, ns: PresentationNamespaces): XmlElement {
  if (shape.localName === "pic") return shape;
  const nonvisual = xmlChildren(shape, ns.p, "nvSpPr")[0],
    placeholder = nonvisual && xmlDescendants(nonvisual, ns.p, "ph")[0],
    identity = nonvisual && xmlChildren(nonvisual, ns.p, "cNvPr")[0],
    nativeProperties = nonvisual && xmlChildren(nonvisual, ns.p, "nvPr")[0],
    properties = xmlChildren(shape, ns.p, "spPr")[0];
  slideAssert(
    shape.localName === "sp" &&
      placeholder?.getAttribute("type") === "pic" &&
      identity &&
      nativeProperties &&
      properties,
    "unsupportedShape",
  );
  const doc = shape.ownerDocument!,
    p = (name: string) => doc.createElementNS(ns.p, "p:" + name),
    a = (name: string) => doc.createElementNS(ns.a, "a:" + name),
    picture = p("pic"),
    nv = p("nvPicPr"),
    nvProps = p("cNvPicPr"),
    lock = a("picLocks"),
    fill = p("blipFill"),
    blip = a("blip"),
    stretch = a("stretch");
  lock.setAttribute("noChangeAspect", "1");
  nvProps.appendChild(lock);
  nv.appendChild(identity.cloneNode(true));
  nv.appendChild(nvProps);
  nv.appendChild(nativeProperties.cloneNode(true));
  blip.setAttributeNS(ns.r, "r:embed", "pandaPendingImage");
  fill.appendChild(blip);
  stretch.appendChild(a("fillRect"));
  fill.appendChild(stretch);
  picture.appendChild(nv);
  picture.appendChild(fill);
  picture.appendChild(properties.cloneNode(true));
  shape.parentNode!.replaceChild(picture, shape);
  return picture;
}
