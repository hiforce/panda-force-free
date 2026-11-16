import type { MetadataStore } from "../../../shared/async-value.js";
import { stableJson } from "../../../shared/stable-json.js";
import { documentTemplateRequest } from "../../../shared/templates/application.js";
import { templateAssert } from "../../../shared/templates/portable/errors.js";
import type {
  PortableRegistryStore,
  PortableTemplateContent,
  PortableTemplateResourceValidation,
} from "../portable/ports.js";
import type { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import { applyDocumentLayout } from "../../../shared/templates/types/document.js";
import type { TemplateDocumentCodec } from "../authoring/ports.js";
import { PortableRegistryError } from "../portable/errors.js";
import { richBodyImageIds } from "../../../shared/documents/rich-body.js";
import { applyRichDocumentTemplate } from "./rich-document.js";
/** Materialization reads a pinned native template. Project storage and its atomic creation receipt remain separate authorities. */
export class DocumentTemplateApplication {
  constructor(
    private store: MetadataStore<PortableRegistryStore>,
    private content: PortableTemplateContent,
    private types: PortableTemplateTypes,
    private codec: TemplateDocumentCodec,
    private resources?: PortableTemplateResourceValidation,
  ) {}
  command(input: unknown) {
    const frozen = documentTemplateRequest(input);
    return { identity: stableJson(frozen), prepare: () => this.materialize(frozen.template, frozen.values) };
  }
  private async materialize(
    ref: {
      id: string;
      version: string;
      digest: string;
    },
    values: unknown,
  ) {
    const installed = (await this.store.detail(ref.id, ref.version)).template;
    if (installed.digest !== ref.digest) throw new PortableRegistryError("immutableVersion");
    if (!installed.enabled) throw new PortableRegistryError("templateDisabled");
    const template = await this.content.read(ref.digest);
    if (template.digest !== ref.digest || template.manifest.id !== ref.id || template.manifest.version !== ref.version)
      throw new PortableRegistryError("unavailable");
    const model = this.types.prepare(template).model;
    if (model.kind !== "document") throw new PortableRegistryError("unsupportedAuthoring");
    await this.resources?.(template);
    const body =
      model.syntax === "markdown"
        ? this.codec.fromMarkdown(applyDocumentLayout(model, template.manifest, values))
        : applyRichDocumentTemplate(model, template.manifest, values, this.codec);
    const images = model.syntax === "richtext" ? model.images : [],
      used = richBodyImageIds(body);
    templateAssert(
      used.every((id) => images.some((image) => image.id === id)),
      "invalidParameters",
    );
    if (!(await this.store.detail(ref.id, ref.version)).template.enabled)
      throw new PortableRegistryError("templateDisabled");
    return {
      body,
      images: images
        .filter((image) => used.includes(image.id))
        .map((image) => ({
          id: image.id,
          name:
            image.id + (image.mediaType === "image/jpeg" ? ".jpg" : image.mediaType === "image/png" ? ".png" : ".webp"),
          bytes: template.read(image.path),
        })),
    };
  }
}
