import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import type {
  TemplateDraftDetail,
  TemplateDraftRecord,
  TemplateDraftResult,
} from "../../../shared/templates/authoring/contracts.js";
import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
import type {
  PortableTemplateContent,
  PortableRegistryStore,
  PortableTemplateResourceValidation,
} from "../portable/ports.js";
import type { TemplateDraftStore, TemplateDraftAuthoringAdapter } from "./ports.js";
import { PortableRegistryError } from "../portable/errors.js";
import { portableActor, portableRevision } from "../portable/commands.js";
import {
  templateDigest,
  templateId,
  templateObject,
  templateVersion,
} from "../../../shared/templates/portable/validation.js";
import { templateDraftCommand, templateDraftId } from "./commands.js";
import { PortableTemplateSource } from "../portable/source.js";
import type { PortableTemplateInstallation } from "../portable/installation.js";
import type { TemplateDraftImages } from "./images.js";
import { templateImageId } from "../../../shared/templates/authoring/images.js";
/** Draft generations, immutable installed versions and editor adapters have independent authorities. */
export class TemplateDraftAuthoring<S extends MetadataStore<TemplateDraftStore> = TemplateDraftStore> {
  constructor(
    private store: S,
    private content: PortableTemplateContent,
    private installed: MetadataStore<PortableRegistryStore>,
    private installation: PortableTemplateInstallation,
    private adapters: readonly TemplateDraftAuthoringAdapter[],
    private images?: TemplateDraftImages,
    private resources?: PortableTemplateResourceValidation,
  ) {
    if (new Set(adapters.map((item) => item.templateType)).size !== adapters.length)
      throw new PortableRegistryError("unsupportedAuthoring");
  }
  list(actor: string): MetadataValue<S, TemplateDraftStore, { drafts: TemplateDraftRecord[] }> {
    portableActor(actor);
    return mapMetadata(this.store.list(actor), (drafts) => ({ drafts })) as MetadataValue<
      S,
      TemplateDraftStore,
      { drafts: TemplateDraftRecord[] }
    >;
  }
  async detail(actor: string, id: string): Promise<TemplateDraftDetail> {
    portableActor(actor);
    templateDraftId(id);
    const draft = await this.store.read(actor, id);
    if (draft.removed) throw new PortableRegistryError("draftNotFound");
    const template = await this.read(draft);
    await this.resources?.(template);
    return { draft, definition: this.adapter(template).definition(template) };
  }
  async image(actor: string, id: string, imageId: string) {
    portableActor(actor);
    templateDraftId(id);
    templateImageId(imageId);
    if (this.images) {
      try {
        return await this.images.content(actor, id, imageId);
      } catch (error) {
        if (!(error instanceof PortableRegistryError) || error.code !== "draftNotFound") throw error;
      }
    }
    const draft = await this.store.read(actor, id);
    if (draft.removed) throw new PortableRegistryError("draftNotFound");
    const template = await this.read(draft),
      image = this.adapter(template)
        .definition(template)
        .images.find((image) => image.id === imageId);
    if (!image) throw new PortableRegistryError("draftNotFound");
    return { image, bytes: template.read(image.path) };
  }
  async execute(
    actor: string,
    kind: "create" | "fork" | "save" | "remove",
    value: unknown,
  ): Promise<TemplateDraftResult> {
    const { command, input } = await templateDraftCommand(actor, kind, value),
      replay = await this.store.replay(actor, command.operationId, command.request);
    if (replay) return this.result(actor, replay);
    if (kind === "remove") return this.result(actor, await this.store.remove(command));
    let template: VerifiedPortableTemplate;
    if (kind === "create") {
      const adapter = this.adapters.find((item) => item.templateType === input.templateType);
      if (!adapter) throw new PortableRegistryError("unsupportedAuthoring");
      template = await adapter.create(input.definition);
    } else if (kind === "fork") {
      const ref = templateObject(input.reference, ["registry", "kind", "id", "version", "digest"]);
      if (ref.registry !== "portable" || ref.kind !== "template")
        throw new PortableRegistryError("unsupportedAuthoring");
      const id = templateId(ref.id),
        version = templateVersion(ref.version),
        digest = templateDigest(ref.digest),
        source = (await this.installed.detail(id, version)).template;
      if (source.digest !== digest) throw new PortableRegistryError("immutableVersion");
      const original = await this.content.read(digest),
        next = await this.nextVersion(id, version);
      if (original.manifest.id !== id || original.manifest.version !== version)
        throw new PortableRegistryError("unavailable");
      template = await this.adapter(original).fork(original, next);
    } else {
      const draft = await this.store.read(actor, command.id);
      if (draft.removed || draft.revision !== command.expectedRevision)
        throw new PortableRegistryError("draftConflict");
      const original = await this.read(draft);
      template = await this.adapter(original).edit(
        original,
        input.definition,
        this.images ? { read: (image) => this.images!.read(actor, command.id, image) } : undefined,
      );
    }
    await this.content.put(template);
    return this.result(actor, await this.store.save(template, command));
  }
  async review(actor: string, id: string, revision: number, digest: string) {
    portableActor(actor);
    portableRevision(revision);
    templateDigest(digest);
    const draft = await this.store.read(actor, templateDraftId(id));
    if (draft.removed || draft.revision !== revision || draft.digest !== digest)
      throw new PortableRegistryError("draftConflict");
    return this.installation.review(await PortableTemplateSource.authored(await this.read(draft), draft));
  }
  async publish(actor: string, id: string, revision: number, digest: string, approval: unknown) {
    portableActor(actor);
    templateDraftId(id);
    portableRevision(revision);
    templateDigest(digest);
    await this.store.prove(actor, id, revision, digest);
    const template = await this.content.read(digest),
      source = await PortableTemplateSource.authored(template, { id, revision, digest, removed: false });
    return this.installation.install(source, approval, actor);
  }
  private async result(
    actor: string,
    acknowledgement: TemplateDraftResult["acknowledgement"],
  ): Promise<TemplateDraftResult> {
    const current = await this.store.read(actor, acknowledgement.id);
    return { acknowledgement, current: current.removed ? null : await this.detail(actor, current.id) };
  }
  private adapter(template: VerifiedPortableTemplate) {
    const adapter = this.adapters.find((item) => item.supports(template));
    if (!adapter) throw new PortableRegistryError("unsupportedAuthoring");
    return adapter;
  }
  private async read(draft: TemplateDraftRecord) {
    const value = await this.content.read(draft.digest);
    if (
      value.digest !== draft.digest ||
      value.manifest.id !== draft.manifest.id ||
      value.manifest.version !== draft.manifest.version
    )
      throw new PortableRegistryError("unavailable");
    return value;
  }
  private async nextVersion(id: string, from: string) {
    const versions = new Set(
      (await this.installed.snapshot()).templates.filter((item) => item.id === id).map((item) => item.version),
    );
    let [major, minor, patch] = from.split(".").map(Number) as [number, number, number];
    for (let attempt = 0; attempt <= versions.size; attempt++) {
      if (++patch > 9999) {
        patch = 0;
        if (++minor > 9999) {
          minor = 0;
          major++;
        }
      }
      if (major > 9999) throw new PortableRegistryError("immutableVersion");
      const version = `${major}.${minor}.${patch}`;
      if (!versions.has(version)) return version;
    }
    throw new PortableRegistryError("immutableVersion");
  }
}
export type TemplateDraftAuthoringPort = TemplateDraftAuthoring<MetadataStore<TemplateDraftStore>>;
