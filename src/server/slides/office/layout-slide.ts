import { slideAssert } from "../../../shared/slides/contracts.js";
import { OpcEdit } from "../../packages/opc/edit.js";
import { relationshipPartName } from "../../packages/opc/uris.js";
import { xmlChildren, xmlDescendants, serializeXml, type XmlElement } from "../../packages/opc/xml.js";
import { OFFICE_CONTENT_TYPES, type PresentationNamespaces } from "./namespaces.js";
import { replaceNativeText } from "./edit-text.js";
import { referencedNativeIds, selectedNativeRelationships, appendNativeRelationship } from "./relationships.js";

/** New slides carry editable placeholders; decorative layout and master objects continue to be inherited natively. */
export function instantiateNativeLayout(edit: OpcEdit, layout: string, path: string, ns: PresentationNamespaces) {
  const document = edit.source.xml(layout),
    original = document.documentElement!,
    common = xmlChildren(original, ns.p, "cSld")[0],
    tree = common && xmlChildren(common, ns.p, "spTree")[0];
  slideAssert(tree && original.localName === "sldLayout");
  const root = document.createElementNS(ns.p, "p:sld");
  for (const attr of Array.from(original.attributes))
    if (attr.namespaceURI === "http://www.w3.org/2000/xmlns/")
      root.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
  const content = document.createElementNS(ns.p, "p:cSld"),
    shapes = document.createElementNS(ns.p, "p:spTree");
  content.setAttribute("name", common!.getAttribute("name") ?? "");
  function copy(parent: XmlElement, target: XmlElement) {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType !== 1) continue;
      const element = child as XmlElement;
      if (element.namespaceURI !== ns.p) continue;
      if (["nvGrpSpPr", "grpSpPr"].includes(element.localName!)) {
        target.appendChild(element.cloneNode(true));
        continue;
      }
      if (element.localName === "grpSp") {
        const group = element.cloneNode(false) as XmlElement;
        copy(element, group);
        if (
          Array.from(group.childNodes).some(
            (n) => n.nodeType === 1 && !["nvGrpSpPr", "grpSpPr"].includes((n as XmlElement).localName!),
          )
        )
          target.appendChild(group);
        continue;
      }
      const nv = Array.from(element.childNodes).find(
          (n) => n.nodeType === 1 && /^nv/.test((n as XmlElement).localName ?? ""),
        ) as XmlElement | undefined,
        placeholder = nv && xmlDescendants(nv, ns.p, "ph")[0];
      if (!placeholder || ["dt", "ftr", "hdr", "sldNum"].includes(placeholder.getAttribute("type") ?? "")) continue;
      slideAssert(["sp", "pic"].includes(element.localName!), "unsupportedShape");
      const clone = element.cloneNode(true) as XmlElement;
      if (element.localName === "sp" && xmlChildren(clone, ns.p, "txBody").length) replaceNativeText(clone, "", ns);
      target.appendChild(clone);
    }
  }
  copy(tree, shapes);
  content.appendChild(shapes);
  root.appendChild(content);
  const colors = document.createElementNS(ns.p, "p:clrMapOvr");
  colors.appendChild(document.createElementNS(ns.a, "a:masterClrMapping"));
  root.appendChild(colors);
  document.replaceChild(root, original);
  const ids = referencedNativeIds(root, ns),
    relations = selectedNativeRelationships(edit.source, layout, ids);
  let index = 1;
  while (ids.has("pandaLayout" + index)) index++;
  appendNativeRelationship(relations, "pandaLayout" + index, {
    id: "",
    type: ns.r + "/slideLayout",
    target: "",
    external: false,
    part: layout,
    fragment: null,
  });
  edit.add(path, serializeXml(document), OFFICE_CONTENT_TYPES.slide);
  edit.add(
    relationshipPartName(path),
    serializeXml(relations),
    "application/vnd.openxmlformats-package.relationships+xml",
  );
  return document;
}
