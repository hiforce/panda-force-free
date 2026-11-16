import { contentSha256 } from "../../../shared/packages/digest.js";
import { capturePackageSource } from "../../../shared/packages/sources/reader.js";
import { SourceError, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import {
  OfficePresentationError,
  slideAssert,
  type NativePresentationIndex,
  type NativeSlidePart,
} from "../../../shared/slides/contracts.js";
import { openZipSource } from "../../packages/zip/source.js";
import { OpcPackage } from "../../packages/opc/package.js";
import { OpcError } from "../../packages/opc/errors.js";
import type { XmlLimits } from "../../packages/opc/xml.js";
import { physicalPartName } from "../../packages/opc/uris.js";
import { presentationStructure, officePartRoot } from "./structure.js";
import type { PresentationNamespaces } from "./namespaces.js";
import { officeShapes } from "./shapes.js";

export type ImmutableSlides<T> = T extends object ? { readonly [K in keyof T]: ImmutableSlides<T[K]> } : T;
function freeze<T>(value: T): ImmutableSlides<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as ImmutableSlides<T>;
}
function boundary<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof OfficePresentationError) throw error;
    if (error instanceof OpcError)
      throw new OfficePresentationError(
        error.code === "xmlLimitExceeded" ? "limitExceeded" : "invalidPackage",
        error.part,
      );
    throw error;
  }
}

/** Raw Office bytes are authoritative; the immutable index and on-demand shape models are projections. */
export class NativePresentation {
  readonly index: ImmutableSlides<NativePresentationIndex>;
  #archive: Uint8Array;
  private constructor(
    archive: Uint8Array,
    readonly parts: OpcPackage,
    readonly main: string,
    private ns: PresentationNamespaces,
    index: NativePresentationIndex,
  ) {
    this.#archive = archive;
    this.index = freeze(index);
    Object.freeze(this);
  }
  static async open(
    input: Uint8Array,
    name: string,
    options: { sourceLimits?: SourceLimits; xmlLimits?: XmlLimits } = {},
  ) {
    slideAssert(input instanceof Uint8Array);
    const bytes = new Uint8Array(input);
    try {
      const reader = await openZipSource(bytes, name, options.sourceLimits),
        tree = await capturePackageSource(reader, undefined, options.sourceLimits),
        parts = boundary(() => new OpcPackage(tree, options.xmlLimits)),
        structure = boundary(() => presentationStructure(parts)),
        sha256 = await contentSha256(bytes);
      return new NativePresentation(bytes, parts, structure.main, structure.ns, {
        ...structure.index,
        schema: "panda.powerpoint-source/v1",
        source: { sha256, bytes: bytes.length, treeDigest: tree.digest, name },
      });
    } catch (error) {
      if (error instanceof SourceError)
        throw new OfficePresentationError(error.code === "sourceTooLarge" ? "limitExceeded" : "invalidPackage");
      throw error;
    }
  }
  original(): Uint8Array {
    return new Uint8Array(this.#archive);
  }
  part(path: string): ImmutableSlides<NativeSlidePart> {
    return boundary(() => {
      const actual = this.parts.locate(physicalPartName(path)),
        index = this.index,
        kind = index.slides.some((item) => item.path === actual)
          ? "sld"
          : index.layouts.some((item) => item.path === actual)
            ? "sldLayout"
            : index.masters.some((item) => item.path === actual)
              ? "sldMaster"
              : null;
      slideAssert(kind, "partNotFound");
      return freeze(officeShapes(this.parts, actual, officePartRoot(this.parts, actual, kind, this.ns), this.ns));
    });
  }
}
