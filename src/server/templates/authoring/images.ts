import type { MetadataStore } from "../../../shared/async-value.js";
import type { TemplateImage } from "../../../shared/templates/authoring/images.js";
import { templateImageId, TEMPLATE_IMAGE_BYTES } from "../../../shared/templates/authoring/images.js";
import { stableJson } from "../../../shared/stable-json.js";
import { portableActor } from "../portable/commands.js";
import { PortableRegistryError } from "../portable/errors.js";
import { templateDraftId } from "./commands.js";
import type { TemplateDraftStore, TemplateImageDecoder, TemplateImageFiles, TemplateImageStore } from "./ports.js";
/** Uploads own resource bindings, never the editor generation or private project assets. */
export class TemplateDraftImages {
  constructor(
    private drafts: MetadataStore<TemplateDraftStore>,
    private store: MetadataStore<TemplateImageStore>,
    private files: TemplateImageFiles,
    private decoder: TemplateImageDecoder,
  ) {}
  private async require(actor: string, draft: string) {
    portableActor(actor);
    templateDraftId(draft);
    if ((await this.drafts.read(actor, draft)).removed) throw new PortableRegistryError("draftNotFound");
  }
  async upload(actor: string, draft: string, input: Uint8Array) {
    await this.require(actor, draft);
    if (!(input instanceof Uint8Array) || !input.length || input.length > TEMPLATE_IMAGE_BYTES)
      throw new PortableRegistryError("invalidInput");
    const value = await this.decoder.decode(new Uint8Array(input));
    await this.require(actor, draft);
    await this.files.put(value);
    // Ownership and quotas are rechecked transactionally after IO. Identical uploads are idempotent.
    await this.store.bind(actor, draft, value.image);
    return value.image;
  }
  async content(actor: string, draft: string, id: string) {
    await this.require(actor, draft);
    const image = await this.store.get(actor, draft, templateImageId(id));
    return { image, bytes: await this.files.read(image) };
  }
  async read(actor: string, draft: string, image: TemplateImage) {
    const value = await this.content(actor, draft, image.id);
    if (stableJson(value.image) !== stableJson(image)) throw new PortableRegistryError("invalidInput");
    return value.bytes;
  }
}
