import { creativeFileExtension, creativeFilePreview } from "../creative/file-types.js";
import { isRecord } from "../records.js";

export const memoryMaterialKinds = ["document", "file", "image", "slides", "video"] as const;
export type MemoryMaterialKind = (typeof memoryMaterialKinds)[number];

export interface MemoryMaterialFile {
  name: string;
  digest: string;
  size: number;
}

export interface MemoryMaterialAnchor {
  key: string;
  scope: string;
  location:
    | { kind: "page" | "slide" | "paragraph"; number: number }
    | { kind: "image"; x: number; y: number; width: number; height: number };
}

export interface MemoryPackageMaterial {
  id: string;
  title: string;
  kind: MemoryMaterialKind;
  version: string;
  files: MemoryMaterialFile[];
  locale?: string;
  document?: {
    richBody?: string;
    images: Array<{ source: string; digest: string }>;
  };
  anchors?: MemoryMaterialAnchor[];
}

export function memoryMaterialOriginals(material: MemoryPackageMaterial) {
  return material.files.filter((file) => file.digest !== material.document?.richBody);
}

export interface MemoryMaterialNativeCopy {
  kind: "document" | "asset";
  id: string;
}

export interface MemoryMaterialSelection {
  id: string;
  version: string;
  kind: MemoryMaterialKind;
}

export const memoryMaterialAnchorLimit = 100;

export type MemoryMaterialLocation = MemoryMaterialAnchor["location"];
export type MemoryMaterialLocationKind = MemoryMaterialLocation["kind"];
export type MemoryMaterialCitation = Pick<MemoryMaterialAnchor, "key" | "scope">;
export type MemoryMaterialExportSelection = MemoryMaterialSelection & { anchors?: MemoryMaterialAnchor[] };
export type MemoryMaterialCatalogItem = MemoryMaterialSelection & {
  title: string;
  source: string;
  citation: MemoryMaterialLocationKind | null;
};

export function validMemoryMaterialAnchor(input: unknown): input is MemoryMaterialAnchor {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 3 ||
    typeof input.key !== "string" ||
    !/^[\p{L}\p{M}\p{N}-]{1,80}$/u.test(input.key) ||
    typeof input.scope !== "string" ||
    !/^[\p{L}\p{M}\p{N}-]{1,48}$/u.test(input.scope) ||
    !validMemoryMaterialLocation(input.location)
  )
    return false;
  return true;
}

export function validMemoryMaterialLocation(location: unknown): location is MemoryMaterialLocation {
  if (!isRecord(location)) return false;
  if (location.kind === "image") {
    return (
      Object.keys(location).length === 5 &&
      typeof location.x === "number" &&
      typeof location.y === "number" &&
      typeof location.width === "number" &&
      typeof location.height === "number" &&
      location.x >= 0 &&
      location.y >= 0 &&
      location.width > 0 &&
      location.height > 0 &&
      location.x + location.width <= 1 &&
      location.y + location.height <= 1
    );
  }
  return (
    Object.keys(location).length === 2 &&
    (location.kind === "page" || location.kind === "slide" || location.kind === "paragraph") &&
    typeof location.number === "number" &&
    Number.isSafeInteger(location.number) &&
    location.number > 0 &&
    location.number <= 1_000_000
  );
}

export const memoryMaterialCitationId = (reference: MemoryMaterialCitation) =>
  JSON.stringify([reference.key, reference.scope]);

export function memoryMaterialPreview(kind: MemoryMaterialKind, name: string) {
  if (kind === "slides" && creativeFileExtension(name) === "pptx")
    return { kind: "slides" as const, mime: "image/png" };
  return creativeFilePreview(name);
}

export function memoryMaterialCitationKind(kind: MemoryMaterialKind, name: string): MemoryMaterialLocationKind | null {
  const supported = memoryMaterialPreview(kind, name).kind;
  switch (supported) {
    case "slides":
      return "slide";
    case "pdf":
      return "page";
    case "image":
      return "image";
    case "text":
      return "paragraph";
    default:
      return null;
  }
}

export function memoryMaterialAnchorSupported(material: MemoryPackageMaterial, anchor: MemoryMaterialAnchor) {
  const name = material.files[0]?.name;
  return !!name && memoryMaterialCitationKind(material.kind, name) === anchor.location.kind;
}

export const memoryMaterialPreviewTextBytes = 1024 * 1024;

export interface MemoryMaterialHit {
  packageId: string;
  material: MemoryMaterialSelection & { title: string };
  file: MemoryMaterialFile;
  location?: MemoryMaterialAnchor["location"];
  excerpt?: string;
  recognition?: "ocr";
}

export interface MemoryMaterialSearchPage {
  hits: MemoryMaterialHit[];
  state: "pending" | "ready" | "unavailable";
}
