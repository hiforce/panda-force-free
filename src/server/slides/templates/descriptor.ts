import type { NativeSlidesDescriptorData, NativeSlidesProvenance } from "../../../shared/slides/registry.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { sourceOrigin } from "../../../shared/packages/sources/origin.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { templateObject, templateDigest, freezeTemplate } from "../../../shared/templates/portable/validation.js";
import { nativeSlidesManifestData } from "./manifest.js";
import { nativeSlidesSelection } from "./input.js";
import type { NativeSlidesTemplate } from "./model.js";
import { readNativeSlidesBundle } from "./bundle.js";

export const NATIVE_SLIDES_DESCRIPTOR_BYTES = 256 * 1024;
export function nativeSlidesDescriptorData(value: unknown): NativeSlidesDescriptorData {
  const input = templateObject(value, ["schema", "manifest", "templateDigest", "sourceDigest", "importedFrom"]),
    origin = templateObject(input.importedFrom, ["digest", "origin", "selection"]);
  if (input.schema !== "panda.native-slides-template/v1") throw new NativeSlidesTemplateError("invalidInput");
  return freezeTemplate({
    schema: "panda.native-slides-template/v1",
    manifest: nativeSlidesManifestData(input.manifest),
    templateDigest: templateDigest(input.templateDigest),
    sourceDigest: templateDigest(input.sourceDigest),
    importedFrom: {
      digest: templateDigest(origin.digest),
      origin: sourceOrigin(origin.origin),
      selection: nativeSlidesSelection(origin.selection),
    },
  });
}
/** A registry descriptor is trusted only after the complete owned bundle and its immutable template identity agree. */
export class NativeSlidesDescriptor {
  private constructor(
    readonly data: NativeSlidesDescriptorData,
    readonly digest: string,
  ) {
    Object.freeze(this);
  }
  static async create(
    template: NativeSlidesTemplate,
    captured: CapturedPackageSource,
    provenance: NativeSlidesProvenance,
  ) {
    const data = nativeSlidesDescriptorData({
        schema: "panda.native-slides-template/v1",
        manifest: template.manifest,
        templateDigest: template.digest,
        sourceDigest: captured.digest,
        importedFrom: provenance,
      }),
      serialized = JSON.stringify(data);
    const check = await readNativeSlidesBundle(captured.tree);
    if (check.digest !== data.templateDigest) throw new NativeSlidesTemplateError("sourceChanged");
    if (
      Buffer.byteLength(serialized) > NATIVE_SLIDES_DESCRIPTOR_BYTES ||
      (await contentSha256(JSON.stringify(data.manifest))) !== data.templateDigest
    )
      throw new NativeSlidesTemplateError("invalidInput");
    return new NativeSlidesDescriptor(data, await contentSha256(serialized));
  }
}
