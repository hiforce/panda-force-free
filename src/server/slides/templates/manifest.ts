import { NativeSlidesTemplateError, type NativeSlidesBundleManifest } from "../../../shared/slides/templates.js";
import {
  templateObject,
  templateDigest,
  templateInteger,
  freezeTemplate,
} from "../../../shared/templates/portable/validation.js";
import { nativeSlidesSettings } from "./settings.js";
export const NATIVE_SLIDES_MANIFEST_BYTES = 128 * 1024;

/** Metadata parsing is independent of body IO; bundle admission additionally verifies every declared resource. */
export function nativeSlidesManifestData(value: unknown): NativeSlidesBundleManifest {
  try {
    const input = templateObject(value, ["schema", "settings", "original", "mapping", "license", "readme"]);
    if (input.schema !== "panda.native-slides-bundle/v1") throw new NativeSlidesTemplateError("invalidBundle");
    const file = (raw: unknown, paths: readonly string[], max: number, min = 0) => {
      const entry = templateObject(raw, ["path", "bytes", "sha256"]);
      if (typeof entry.path !== "string" || !paths.includes(entry.path))
        throw new NativeSlidesTemplateError("invalidBundle");
      return { path: entry.path, bytes: templateInteger(entry.bytes, min, max), sha256: templateDigest(entry.sha256) };
    };
    const result: NativeSlidesBundleManifest = freezeTemplate({
      schema: "panda.native-slides-bundle/v1",
      settings: nativeSlidesSettings(input.settings),
      original: file(input.original, ["original.pptx", "original.potx"], 32 * 1024 * 1024, 1),
      mapping: file(input.mapping, ["mapping.json"], 512 * 1024, 1),
      license: file(input.license, ["LICENSE"], 256 * 1024, 1),
      readme: file(input.readme, ["README.md"], 512 * 1024),
    });
    if (Buffer.byteLength(JSON.stringify(result)) > NATIVE_SLIDES_MANIFEST_BYTES)
      throw new NativeSlidesTemplateError("limitExceeded");
    return result;
  } catch (error) {
    if (error instanceof NativeSlidesTemplateError) throw error;
    throw new NativeSlidesTemplateError("invalidBundle");
  }
}
