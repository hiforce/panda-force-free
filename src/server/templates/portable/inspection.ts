import type { PortableRegistrySnapshot } from "../../../shared/templates/portable/registry.js";
import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import { exportPortableTemplates } from "../../../shared/templates/portable/bundle.js";
import { templateDigest, templateId, templateVersion } from "../../../shared/templates/portable/validation.js";
import { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import { PortableRegistryError } from "./errors.js";
import type { PortableRegistryStore, PortableTemplateContent, PortableTemplateResourceValidation } from "./ports.js";
import { portableActor, portableRevision } from "./commands.js";
import { templateImageId } from "../../../shared/templates/authoring/images.js";
export class PortableTemplateInspection<S extends MetadataStore<PortableRegistryStore> = PortableRegistryStore> {
  constructor(
    private store: S,
    private content: PortableTemplateContent,
    private types: PortableTemplateTypes,
    private resources?: PortableTemplateResourceValidation,
  ) {}
  snapshot(): MetadataValue<S, PortableRegistryStore, PortableRegistrySnapshot> {
    return this.store.snapshot() as MetadataValue<S, PortableRegistryStore, PortableRegistrySnapshot>;
  }
  detail(
    id: string,
    version: string,
    digest: string,
  ): MetadataValue<S, PortableRegistryStore, ReturnType<PortableRegistryStore["detail"]>> {
    templateId(id);
    templateVersion(version);
    templateDigest(digest);
    return mapMetadata(this.store.detail(id, version), (detail) => {
      if (detail.template.digest !== digest) throw new PortableRegistryError("immutableVersion");
      return detail;
    }) as MetadataValue<S, PortableRegistryStore, ReturnType<PortableRegistryStore["detail"]>>;
  }
  async preview(id: string, version: string, digest: string) {
    await this.detail(id, version, digest);
    const value = await this.content.read(digest);
    if (value.manifest.id !== id || value.manifest.version !== version || value.digest !== digest)
      throw new PortableRegistryError("unavailable");
    const prepared = this.types.prepare(value);
    await this.resources?.(value);
    return { manifest: value.manifest, model: prepared.model };
  }
  async export(id: string, version: string, digest: string) {
    await this.detail(id, version, digest);
    const value = await this.content.read(digest);
    if (value.manifest.id !== id || value.manifest.version !== version || value.digest !== digest)
      throw new PortableRegistryError("unavailable");
    return exportPortableTemplates([value]);
  }
  async image(id: string, version: string, digest: string, imageId: string) {
    await this.detail(id, version, digest);
    const template = await this.content.read(digest);
    const { model } = this.types.prepare(template);
    const image =
      model.kind === "document" && model.syntax === "richtext"
        ? model.images.find((image) => image.id === templateImageId(imageId))
        : null;
    if (!image) throw new PortableRegistryError("notInstalled");
    return { image, bytes: template.read(image.path) };
  }
  async artwork(id: string, version: string, digest: string) {
    await this.detail(id, version, digest);
    const template = await this.content.read(digest);
    if (template.digest !== digest || template.manifest.id !== id || template.manifest.version !== version)
      throw new PortableRegistryError("unavailable");
    const path = template.manifest.previews.find((path) => /\.(?:png|jpe?g|webp)$/i.test(path));
    if (!path) throw new PortableRegistryError("notInstalled");
    return template.read(path);
  }
  state(
    id: string,
    version: string,
    digest: string,
    action: "enable" | "disable" | "activate",
    expectedRevision: number,
    actor: string,
  ): MetadataValue<S, PortableRegistryStore, ReturnType<PortableRegistryStore["detail"]>> {
    return mapMetadata(this.detail(id, version, digest), () => {
      portableActor(actor);
      portableRevision(expectedRevision);
      if (!["enable", "disable", "activate"].includes(action)) throw new PortableRegistryError("invalidInput");
      return mapMetadata(this.store.state(id, version, action, actor, expectedRevision, Date.now()), () =>
        this.store.detail(id, version),
      );
    }) as MetadataValue<S, PortableRegistryStore, ReturnType<PortableRegistryStore["detail"]>>;
  }
}
export type PortableTemplateInspectionPort = PortableTemplateInspection<MetadataStore<PortableRegistryStore>>;
