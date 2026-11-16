import { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { templateObject } from "../../../shared/templates/portable/validation.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";

/** A raw Office upload and a file selected from a source library have different byte ownership. */
export function nativeSlidesOriginal(source: CapturedPackageSource, selection: unknown): Uint8Array {
  if (!(source instanceof CapturedPackageSource)) throw new NativeSlidesTemplateError("invalidInput");
  try {
    const input = templateObject(selection, ["kind", "path"]);
    if (input.kind === "archive" && !Object.hasOwn(input, "path")) {
      const bytes = source.readArchive();
      if (!bytes) throw new NativeSlidesTemplateError("invalidInput");
      return bytes;
    }
    if (input.kind === "file") return source.tree.read(sourcePath(input.path));
    throw new NativeSlidesTemplateError("invalidInput");
  } catch (error) {
    if (error instanceof NativeSlidesTemplateError) throw error;
    throw new NativeSlidesTemplateError("invalidInput");
  }
}
