import { mapMetadata, type MetadataValue } from "../../../shared/async-value.js";
import type { OwnedSourceMetadata } from "../../packages/ownership/ports.js";
import {
  OwnedSourceError,
  type OwnedSourceReference,
  type OwnedPackageSources,
} from "../../../shared/packages/ownership.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { NativeSlidesTemplate } from "./model.js";
import { captureNativeSlidesBundle, readNativeSlidesBundle } from "./bundle.js";
import type { OwnedNativeSlides } from "../../../shared/slides/registry.js";
export type { OwnedNativeSlides } from "../../../shared/slides/registry.js";

/** Native originals, mapping and notices share one owned durable source; no binary enters registry metadata. */
export class NativeSlidesContent<S extends OwnedSourceMetadata = OwnedPackageSources> {
  constructor(private sources: S) {}
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OwnedSourceError)
        throw new NativeSlidesTemplateError(error.code === "capacity" ? "storageFull" : error.code);
      throw error;
    }
  }
  put(actor: string, operationId: string, template: NativeSlidesTemplate): Promise<OwnedNativeSlides> {
    if (!(template instanceof NativeSlidesTemplate)) throw new NativeSlidesTemplateError("invalidInput");
    return this.run(async () => {
      const source = await this.sources.save(actor, operationId, await captureNativeSlidesBundle(template));
      return { source, templateDigest: template.digest };
    });
  }
  with<T>(actor: string, ref: OwnedNativeSlides, read: (template: NativeSlidesTemplate) => Promise<T>): Promise<T> {
    return this.run(() =>
      this.sources.with(actor, ref.source, async (source) => {
        const template = await readNativeSlidesBundle(source.tree);
        if (template.digest !== ref.templateDigest) throw new NativeSlidesTemplateError("sourceChanged");
        return read(template);
      }),
    );
  }
  recover(actor: string, operationId: string): Promise<OwnedNativeSlides | null> {
    return this.run(async () => {
      const source = await this.sources.recover(actor, operationId);
      if (!source) return null;
      return this.sources.with(actor, source, async (captured) => ({
        source,
        templateDigest: (await readNativeSlidesBundle(captured.tree)).digest,
      }));
    });
  }
  reference(actor: string, operationId: string): MetadataValue<S, OwnedPackageSources, OwnedSourceReference | null> {
    return mapMetadata(this.sources.find(actor, operationId), (value) => value?.ref ?? null) as MetadataValue<
      S,
      OwnedPackageSources,
      OwnedSourceReference | null
    >;
  }
  remove(actor: string, operationId: string) {
    return this.sources.remove(actor, operationId);
  }
}
