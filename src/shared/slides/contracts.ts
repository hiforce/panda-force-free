export interface SlideTransform {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  childCoordinates: { x: number; y: number; width: number; height: number } | null;
}
export interface SlidePlaceholder {
  index: string;
  type: string;
}
export interface NativeSlideShape {
  id: string;
  name: string;
  kind: "text" | "picture" | "group" | "table" | "chart" | "diagram" | "embedded" | "other";
  placeholder: SlidePlaceholder | null;
  transform: SlideTransform | null;
  text: string | null;
  image: { part: string; mediaType: string; relationshipId: string } | null;
  children: readonly NativeSlideShape[];
}
export interface NativeSlidePart {
  path: string;
  name: string;
  shapes: readonly NativeSlideShape[];
  externalRelationships: number;
  preservedOpaqueElements: number;
}
export interface NativePresentationIndex {
  schema: "panda.powerpoint-source/v1";
  kind: "pptx" | "potx";
  dialect: "transitional" | "strict";
  source: { sha256: string; bytes: number; treeDigest: string; name: string };
  size: { width: number; height: number } | null;
  masters: readonly { path: string; name: string; layouts: readonly string[]; themes: readonly string[] }[];
  layouts: readonly { path: string; name: string; type: string; master: string }[];
  slides: readonly { path: string; name: string; layout: string; master: string }[];
}

export class OfficePresentationError extends Error {
  constructor(
    readonly code:
      | "invalidPackage"
      | "unsupportedPackage"
      | "limitExceeded"
      | "partNotFound"
      | "invalidMapping"
      | "unsupportedShape",
    readonly part?: string,
  ) {
    super(code);
    this.name = "OfficePresentationError";
  }
}
export function slideAssert(value: unknown, code: OfficePresentationError["code"] = "invalidPackage"): asserts value {
  if (!value) throw new OfficePresentationError(code);
}
