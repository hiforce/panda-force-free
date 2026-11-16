import { slideAssert } from "../../../shared/slides/contracts.js";

export interface PresentationNamespaces {
  p: string;
  a: string;
  r: string;
  dialect: "transitional" | "strict";
}
const prefix = "http://schemas.openxmlformats.org/";
export const PRESENTATION_NAMESPACES: readonly PresentationNamespaces[] = Object.freeze([
  Object.freeze({
    p: prefix + "presentationml/2006/main",
    a: prefix + "drawingml/2006/main",
    r: prefix + "officeDocument/2006/relationships",
    dialect: "transitional" as const,
  }),
  Object.freeze({
    p: "http://purl.oclc.org/ooxml/presentationml/main",
    a: "http://purl.oclc.org/ooxml/drawingml/main",
    r: "http://purl.oclc.org/ooxml/officeDocument/relationships",
    dialect: "strict" as const,
  }),
]);
export function presentationNamespaces(namespace: string | null): PresentationNamespaces {
  const result = PRESENTATION_NAMESPACES.find((item) => item.p === namespace);
  slideAssert(result, "unsupportedPackage");
  return result;
}
export const OFFICE_CONTENT_TYPES = Object.freeze({
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  master: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  layout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
});
