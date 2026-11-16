import { contentSha256 } from "../../../shared/packages/digest.js";
import { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import { SourceError, DEFAULT_SOURCE_LIMITS } from "../../../shared/packages/sources/contracts.js";
import { NativeSlidesTemplateError, type NativeSlidesBundleManifest } from "../../../shared/slides/templates.js";
import type { NativeContentMapping } from "../../../shared/slides/mapping.js";
import { templateObject } from "../../../shared/templates/portable/validation.js";
import { NativePresentation } from "../office/package.js";
import { nativeContentMapping } from "../office/mapping.js";
import { nativeSlidesSettings } from "./settings.js";
import { writeSourceZip } from "../../packages/zip/write.js";
import { nativeSlidesManifestData } from "./manifest.js";

export const NATIVE_SLIDES_MANIFEST = "panda-slides.json";
export const NATIVE_SLIDES_MAPPING_BYTES = 512 * 1024;

/** The template owns real Office bytes and mapping files; installation authority and source provenance remain separate. */
export class NativeSlidesTemplate {
  private constructor(
    readonly presentation: NativePresentation,
    readonly mapping: NativeContentMapping,
    readonly manifest: Readonly<NativeSlidesBundleManifest>,
    readonly files: ImmutableSourceTree,
    readonly digest: string,
  ) {
    Object.freeze(this);
  }
  static async create(original: Uint8Array, settings: unknown, mapping: unknown, license: string, readme = "") {
    if (typeof license !== "string" || typeof readme !== "string") throw new NativeSlidesTemplateError("invalidInput");
    if (license.length > 256 * 1024 || readme.length > 512 * 1024) throw new NativeSlidesTemplateError("limitExceeded");
    let encoded: Uint8Array;
    try {
      const value = templateObject(mapping, ["schema", "sourceSha256", "slots"]);
      if (!Array.isArray(value.slots) || value.slots.length > 256) throw new NativeSlidesTemplateError("invalidInput");
      encoded = new TextEncoder().encode(JSON.stringify(value));
    } catch (error) {
      if (error instanceof NativeSlidesTemplateError) throw error;
      throw new NativeSlidesTemplateError("invalidInput");
    }
    return this.fromFiles(
      original,
      settings,
      encoded,
      new TextEncoder().encode(license),
      new TextEncoder().encode(readme),
    );
  }
  static async fromFiles(
    original: Uint8Array,
    settingsValue: unknown,
    mappingBytes: Uint8Array,
    licenseBytes: Uint8Array,
    readmeBytes: Uint8Array,
  ) {
    if (![original, mappingBytes, licenseBytes, readmeBytes].every((value) => value instanceof Uint8Array))
      throw new NativeSlidesTemplateError("invalidInput");
    if (original.length > DEFAULT_SOURCE_LIMITS.fileBytes) throw new NativeSlidesTemplateError("limitExceeded");
    const settings = nativeSlidesSettings(settingsValue),
      originalCopy = new Uint8Array(original),
      mappingCopy = new Uint8Array(mappingBytes),
      license = new Uint8Array(licenseBytes),
      readme = new Uint8Array(readmeBytes);
    if (
      !originalCopy.length ||
      mappingCopy.length > NATIVE_SLIDES_MAPPING_BYTES ||
      !license.length ||
      license.length > 256 * 1024 ||
      readme.length > 512 * 1024
    )
      throw new NativeSlidesTemplateError("limitExceeded");
    try {
      const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        rawMapping: unknown = JSON.parse(text(mappingCopy));
      text(license);
      text(readme);
      const presentation = await NativePresentation.open(originalCopy, "original"),
        mapping = nativeContentMapping(presentation, rawMapping),
        path = "original." + presentation.index.kind,
        files = await ImmutableSourceTree.create([
          { path, bytes: originalCopy },
          { path: "mapping.json", bytes: mappingCopy },
          { path: "LICENSE", bytes: license },
          { path: "README.md", bytes: readme },
        ]),
        get = (name: string) => files.files.find((file) => file.path === name)!,
        manifest: NativeSlidesBundleManifest = nativeSlidesManifestData({
          schema: "panda.native-slides-bundle/v1",
          settings,
          original: get(path),
          mapping: get("mapping.json"),
          license: get("LICENSE"),
          readme: get("README.md"),
        });
      return new NativeSlidesTemplate(
        presentation,
        mapping,
        manifest,
        files,
        await contentSha256(JSON.stringify(manifest)),
      );
    } catch (error) {
      if (error instanceof SourceError)
        throw new NativeSlidesTemplateError(error.code === "sourceTooLarge" ? "limitExceeded" : "invalidBundle");
      if (error instanceof NativeSlidesTemplateError) throw error;
      if (error instanceof SyntaxError || error instanceof TypeError)
        throw new NativeSlidesTemplateError("invalidBundle");
      throw error;
    }
  }
  original() {
    return this.files.read(this.manifest.original.path);
  }
  async export() {
    const bytes = await writeSourceZip([
      { path: NATIVE_SLIDES_MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(this.manifest)) },
      ...this.files.files.map((file) => ({ path: file.path, bytes: this.files.read(file.path) })),
    ]);
    return { filename: `${this.manifest.settings.id}-${this.manifest.settings.version}.native-slides.zip`, bytes };
  }
}
