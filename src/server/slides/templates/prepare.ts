import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { DEFAULT_SOURCE_LIMITS } from "../../../shared/packages/sources/contracts.js";
import type { NativeSlidesSelection } from "../../../shared/slides/registry.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { NativePresentation } from "../office/package.js";
import { readNativeSlidesBundle } from "./bundle.js";
import { nativeSlidesOriginal } from "./source.js";

export async function inspectNativeSlidesSource(source: CapturedPackageSource, selection: NativeSlidesSelection) {
  if (selection.kind === "bundle") {
    const template = await readNativeSlidesBundle(source.tree, selection.root);
    return { presentation: template.presentation, template };
  }
  const original = nativeSlidesOriginal(source, selection);
  if (original.length > DEFAULT_SOURCE_LIMITS.fileBytes) throw new NativeSlidesTemplateError("limitExceeded");
  return { presentation: await NativePresentation.open(original, "original"), template: null };
}
