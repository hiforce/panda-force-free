import type { VerifiedPortableTemplate } from "../portable/contracts.js";
import { PortableTemplateError, templateAssert } from "../portable/errors.js";
import { freezeTemplate, templateJson } from "../portable/validation.js";
import type { PortableTemplateTypeAdapter, PreparedPortableTemplate } from "./contracts.js";
import { siteProfileTemplateAdapter } from "./site.js";
import { documentLayoutTemplateAdapter } from "./document.js";
import { slidesLayoutTemplateAdapter } from "./slides.js";

/** The host registers trusted adapters; manifests cannot load code by naming a new adapter. */
export class PortableTemplateTypes {
  private adapters: ReadonlyMap<string, PortableTemplateTypeAdapter>;
  constructor(
    adapters: readonly PortableTemplateTypeAdapter[] = [
      siteProfileTemplateAdapter,
      documentLayoutTemplateAdapter,
      slidesLayoutTemplateAdapter,
    ],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.templateType + ":" + adapter.format, adapter]));
    if (this.adapters.size !== adapters.length) throw new PortableTemplateError("incompatibleAdapter");
  }
  prepare(template: VerifiedPortableTemplate): PreparedPortableTemplate {
    const manifest = template.manifest,
      adapter = this.adapters.get(manifest.templateType + ":" + manifest.payload.format);
    if (!adapter) throw new PortableTemplateError("unsupportedType");
    const requirements = manifest.requires.adapters;
    templateAssert(
      requirements.some((item) => item.id === adapter.adapter.id && item.api === adapter.adapter.api),
      "incompatibleAdapter",
    );
    for (const required of requirements)
      templateAssert(
        [...this.adapters.values()].some(
          (value) => value.adapter.id === required.id && value.adapter.api === required.api,
        ),
        "incompatibleAdapter",
      );
    try {
      return Object.freeze({
        template,
        model: freezeTemplate(adapter.parse(templateJson(template.read(manifest.payload.path)), manifest)),
      });
    } catch (error) {
      if (error instanceof PortableTemplateError && ["invalidPayload", "unknownPlaceholder"].includes(error.code))
        throw error;
      throw new PortableTemplateError("invalidPayload");
    }
  }
}
