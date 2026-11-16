import type { SourceFile } from "../packages/sources/contracts.js";
export const NATIVE_SLIDES_BUNDLE_FILE = "panda-slides.json";
export const NATIVE_SLIDES_BUNDLE_SCHEMA = "panda.native-slides-bundle/v1";

export interface NativeSlidesSettings {
  readonly schema: 1;
  readonly id: string;
  readonly version: string;
  readonly name: Readonly<Record<string, string>>;
  readonly description: Readonly<Record<string, string>>;
  readonly publisher: string;
  readonly license: string;
}
export interface NativeSlidesBundleManifest {
  readonly schema: "panda.native-slides-bundle/v1";
  readonly settings: NativeSlidesSettings;
  readonly original: SourceFile;
  readonly mapping: SourceFile;
  readonly license: SourceFile;
  readonly readme: SourceFile;
}
export class NativeSlidesTemplateError extends Error {
  constructor(
    readonly code:
      | "invalidInput"
      | "invalidBundle"
      | "limitExceeded"
      | "sourceChanged"
      | "unavailable"
      | "conflict"
      | "busy"
      | "storageFull"
      | "notFound"
      | "immutableVersion"
      | "reviewChanged"
      | "disabled"
      | "licenseNotAcknowledged",
  ) {
    super(code);
    this.name = "NativeSlidesTemplateError";
  }
}
