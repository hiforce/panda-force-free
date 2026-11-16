import { contentSha256 } from "../../../shared/packages/digest.js";
import type {
  PortableTemplateManifest,
  VerifiedPortableTemplate,
} from "../../../shared/templates/portable/contracts.js";
import type { DocumentTemplateDefinition } from "../../../shared/templates/authoring/contracts.js";
import { templateObject, templateText, freezeTemplate } from "../../../shared/templates/portable/validation.js";
import { validatePortableTemplateManifest } from "../../../shared/templates/portable/manifest.js";
import { verifyPortableTemplateResources } from "../../../shared/templates/portable/resources.js";
import { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import { PortableRegistryError } from "../portable/errors.js";
import type { TemplateDraftAuthoringAdapter, TemplateDocumentCodec, TemplateImageReader } from "./ports.js";
import { richDocumentTemplateData } from "../../../shared/templates/types/document-rich.js";
import { templateImages, templateImageBody } from "../../../shared/templates/authoring/images.js";
import { stableJson } from "../../../shared/stable-json.js";

/** Editor commands own only declarative content; unknown resources and original licenses remain under the source's file ownership. */
export class DocumentTemplateAuthoring implements TemplateDraftAuthoringAdapter {
  readonly templateType = "panda.document-template";
  constructor(
    private types: PortableTemplateTypes,
    private codec: TemplateDocumentCodec,
  ) {}
  supports(value: VerifiedPortableTemplate) {
    return (
      value.manifest.templateType === this.templateType &&
      ["panda.document-layout/v1", "panda.rich-document-layout/v1"].includes(value.manifest.payload.format)
    );
  }
  async create(input: unknown, images?: TemplateImageReader) {
    return this.assemble(null, input, images);
  }
  async edit(template: VerifiedPortableTemplate, input: unknown, images?: TemplateImageReader) {
    if (!this.supports(template)) throw new PortableRegistryError("unsupportedAuthoring");
    return this.assemble(template, input, images);
  }
  async fork(template: VerifiedPortableTemplate, version: string) {
    return this.edit(template, { ...this.definition(template), version });
  }
  definition(template: VerifiedPortableTemplate): DocumentTemplateDefinition {
    if (!this.supports(template)) throw new PortableRegistryError("unsupportedAuthoring");
    const model = this.types.prepare(template).model,
      manifest = template.manifest;
    if (model.kind !== "document") throw new PortableRegistryError("unsupportedAuthoring");
    return freezeTemplate({
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description,
      publisher: manifest.publisher,
      license: { expression: manifest.license.expression, text: template.text(manifest.license.file) },
      categories: manifest.categories,
      tags: manifest.tags,
      parameters: manifest.parameters,
      contentSlots: model.contentSlots,
      instructions: model.instructions,
      body: model.syntax === "richtext" ? model.body : this.codec.fromMarkdown(model.content),
      images: model.syntax === "richtext" ? model.images : [],
    });
  }
  private async assemble(source: VerifiedPortableTemplate | null, value: unknown, reader?: TemplateImageReader) {
    const input = templateObject(value, [
        "id",
        "version",
        "name",
        "description",
        "publisher",
        "license",
        "categories",
        "tags",
        "parameters",
        "contentSlots",
        "instructions",
        "body",
        "images",
      ]),
      license = templateObject(input.license, ["expression", "text"]),
      licenseText = templateText(license.text, 64000),
      body = this.codec.normalize(input.body),
      prior = source?.manifest,
      payloadPath = prior?.payload.path || "payload.json",
      licensePath = prior?.license.file || "LICENSE";
    if (payloadPath === licensePath) throw new PortableRegistryError("unsupportedAuthoring");
    const images = templateImages(input.images ?? []),
      payload = {
        body: templateImageBody(body, "write", images),
        images,
        contentSlots: input.contentSlots,
        instructions: input.instructions,
      };
    const declarations = [
      ...(prior?.files || [
        { path: payloadPath, sha256: "0".repeat(64), bytes: 0, mediaType: "application/json" },
        { path: licensePath, sha256: "0".repeat(64), bytes: 0, mediaType: "text/plain" },
      ]),
    ];
    for (const image of images) {
      const file = declarations.find((file) => file.path === image.path);
      if (file) {
        if (
          file.path === payloadPath ||
          file.path === licensePath ||
          file.sha256 !== image.sha256 ||
          file.bytes !== image.bytes ||
          file.mediaType !== image.mediaType
        )
          throw new PortableRegistryError("invalidInput");
      } else
        declarations.push({ path: image.path, sha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType });
    }
    const skeleton = validatePortableTemplateManifest({
      schemaVersion: 1,
      kind: "panda-force.template",
      id: input.id,
      version: input.version,
      templateType: this.templateType,
      categories: input.categories,
      name: input.name,
      description: input.description,
      publisher: input.publisher,
      license: { expression: license.expression, file: licensePath },
      tags: input.tags,
      parameters: input.parameters,
      payload: { format: "panda.rich-document-layout/v1", path: payloadPath },
      requires: { adapters: [{ id: "panda.document-editor", api: 1 }], skills: prior?.requires.skills || [] },
      composition: prior?.composition || { slots: [{ id: "document.structure", policy: "single" }] },
      previews: prior?.previews || [],
      files: declarations,
    });
    // The trusted type adapter captures slots and instructions before the first asynchronous hash.
    const adapterModel = richDocumentTemplateData.parse(payload, skeleton);
    if (adapterModel.kind !== "document" || adapterModel.syntax !== "richtext")
      throw new PortableRegistryError("unsupportedAuthoring");
    const priorModel = source ? this.types.prepare(source).model : null;
    const priorImages = priorModel?.kind === "document" && priorModel.syntax === "richtext" ? priorModel.images : [];
    const attached = new Map<string, Uint8Array>();
    for (const image of images) {
      const previous = priorImages.find((item) => item.id === image.id);
      if (previous && stableJson(previous) === stableJson(image)) continue;
      if (!reader) throw new PortableRegistryError("invalidInput");
      const bytes = new Uint8Array(await reader.read(image));
      if (bytes.length !== image.bytes || (await contentSha256(bytes)) !== image.sha256)
        throw new PortableRegistryError("invalidInput");
      attached.set(image.path, bytes);
    }
    const resources = skeleton.files.map((file) => ({
      path: file.path,
      bytes:
        file.path === payloadPath
          ? new TextEncoder().encode(
              JSON.stringify({
                ...adapterModel,
                kind: undefined,
                syntax: undefined,
                body: templateImageBody(adapterModel.body, "write", images),
              }),
            )
          : file.path === licensePath
            ? new TextEncoder().encode(licenseText)
            : attached.get(file.path) || source!.read(file.path),
      mediaType: file.path === payloadPath ? "application/json" : file.mediaType,
    }));
    const files: PortableTemplateManifest["files"][number][] = [];
    for (const file of resources)
      files.push({
        path: file.path,
        sha256: await contentSha256(file.bytes),
        bytes: file.bytes.length,
        mediaType: file.mediaType,
      });
    const manifest = { ...skeleton, files };
    const verified = await verifyPortableTemplateResources(
      new TextEncoder().encode(JSON.stringify(manifest)),
      resources,
    );
    this.types.prepare(verified);
    return verified;
  }
}
