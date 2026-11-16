import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { captureSourceSnapshot } from "../../../shared/packages/sources/snapshot.js";
import type { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { SourceFile } from "../../../shared/packages/sources/contracts.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { nativeSlidesManifestData, NATIVE_SLIDES_MANIFEST_BYTES } from "./manifest.js";
import { NativeSlidesTemplate, NATIVE_SLIDES_MANIFEST } from "./model.js";
import { openZipSource } from "../../packages/zip/source.js";

/** Imported metadata cannot carry an actor, old permissions or install receipts into a new installation. */
export async function readNativeSlidesBundle(tree: ImmutableSourceTree, root = ""): Promise<NativeSlidesTemplate> {
  try {
    const prefix = root === "" ? "" : sourcePath(root) + "/";
    const input = nativeSlidesManifestData(
      JSON.parse(tree.text(prefix + NATIVE_SLIDES_MANIFEST, NATIVE_SLIDES_MANIFEST_BYTES)),
    );
    const file = (value: SourceFile) => {
      const owned = tree.files.find((f) => f.path === prefix + value.path);
      if (!owned || owned.bytes !== value.bytes || owned.sha256 !== value.sha256)
        throw new NativeSlidesTemplateError("sourceChanged");
      return { path: value.path, bytes: tree.read(prefix + value.path) };
    };
    const original = file(input.original),
      mapping = file(input.mapping),
      license = file(input.license),
      readme = file(input.readme),
      value = await NativeSlidesTemplate.fromFiles(
        original.bytes,
        input.settings,
        mapping.bytes,
        license.bytes,
        readme.bytes,
      );
    if (value.manifest.original.path !== original.path) throw new NativeSlidesTemplateError("invalidBundle");
    return value;
  } catch (error) {
    if (error instanceof NativeSlidesTemplateError) throw error;
    if (error instanceof SourceError)
      throw new NativeSlidesTemplateError(error.code === "sourceTooLarge" ? "limitExceeded" : "invalidBundle");
    throw new NativeSlidesTemplateError("invalidBundle");
  }
}
export async function captureNativeSlidesBundle(value: NativeSlidesTemplate): Promise<CapturedPackageSource> {
  const archive = await value.export(),
    reader = await openZipSource(archive.bytes, archive.filename);
  return captureSourceSnapshot(reader, undefined, archive.bytes);
}
