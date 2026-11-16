import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { NativeSlidesDescriptor } from "./descriptor.js";
import { captureNativeSlidesBundle } from "./bundle.js";
import { loadNativeSlidesTemplate } from "./load.js";
import type { nativeSlidesInstallInput } from "./input.js";

/** Review and commit use one byte admission path, including the actual intake provenance. */
export async function admitNativeSlides(
  source: CapturedPackageSource,
  command: ReturnType<typeof nativeSlidesInstallInput>,
) {
  if (source.digest !== command.source.sha256) throw new NativeSlidesTemplateError("reviewChanged");
  const template = await loadNativeSlidesTemplate(source, command.source.selection, command.definition),
    captured = await captureNativeSlidesBundle(template),
    descriptor = await NativeSlidesDescriptor.create(template, captured, {
      digest: source.digest,
      origin: source.descriptor.origin,
      selection: command.source.selection,
    });
  return { template, descriptor };
}
