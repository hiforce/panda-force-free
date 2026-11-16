import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import type { NativeSlidesSelection } from "../../../shared/slides/registry.js";
import type { nativeSlidesDefinition } from "./input.js";
import { NativeSlidesTemplate } from "./model.js";
import { nativeSlidesOriginal } from "./source.js";
import { readNativeSlidesBundle } from "./bundle.js";

export async function loadNativeSlidesTemplate(
  source: CapturedPackageSource,
  selection: NativeSlidesSelection,
  definition: ReturnType<typeof nativeSlidesDefinition>,
): Promise<NativeSlidesTemplate> {
  if (selection.kind === "bundle") {
    const template = await readNativeSlidesBundle(source.tree, selection.root);
    if (!definition) return template;
    return NativeSlidesTemplate.create(
      template.original(),
      definition.settings,
      definition.mapping,
      definition.licenseText,
      definition.readmeText,
    );
  }
  if (!definition) throw new NativeSlidesTemplateError("invalidInput");
  return NativeSlidesTemplate.create(
    nativeSlidesOriginal(source, selection),
    definition.settings,
    definition.mapping,
    definition.licenseText,
    definition.readmeText,
  );
}
