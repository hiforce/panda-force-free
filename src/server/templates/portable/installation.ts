import type { MetadataStore } from "../../../shared/async-value.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import { PortableRegistryError } from "./errors.js";
import type { PortableRegistryStore, PortableTemplateContent, PortableTemplateResourceValidation } from "./ports.js";
import type { PortableTemplateSource } from "./source.js";
import { reviewPortableTemplates, selectedPortableTemplates } from "./review.js";
import {
  portableActor,
  portableInstallApproval,
  portableSelectionKeys,
  type PortableInstallApproval,
} from "./commands.js";
import type { PortableTemplateOrigin } from "../../../shared/templates/portable/registry.js";
export type { PortableInstallApproval } from "./commands.js";
export class PortableTemplateInstallation {
  constructor(
    private store: MetadataStore<PortableRegistryStore>,
    private content: PortableTemplateContent,
    private types: PortableTemplateTypes,
    private resources?: PortableTemplateResourceValidation,
  ) {}
  private request(
    source: PortableTemplateOrigin,
    keys: readonly string[],
    digests: readonly string[],
    approval: PortableInstallApproval,
  ) {
    return contentSha256(
      JSON.stringify({
        source,
        selected: keys,
        digests,
        reviewHash: approval.reviewHash,
        expectedRevision: approval.expectedRevision,
      }),
    );
  }
  async replayCaptured(actor: string, sha256: string, root: string, input: unknown) {
    portableActor(actor);
    const approval = portableInstallApproval(input),
      operation = await this.store.operation(actor, approval.operationId);
    if (!operation) return null;
    const receipt = operation.receipt,
      source = receipt.source,
      keys = portableSelectionKeys(approval.selected);
    if (
      source.kind !== "captured" ||
      source.sha256 !== sha256 ||
      source.root !== root ||
      keys.join("\n") !== receipt.results.map((value) => value.id + "@" + value.version).join("\n")
    )
      throw new PortableRegistryError("operationConflict");
    const request = await this.request(
        source,
        keys,
        receipt.results.map((value) => value.digest),
        approval,
      ),
      replay = await this.store.replay(actor, approval.operationId, request);
    if (!replay) throw new PortableRegistryError("registryConflict");
    return { receipt: replay, current: await this.store.snapshot() };
  }
  async review(upload: PortableTemplateSource, selected?: unknown) {
    const review = await reviewPortableTemplates(upload, await this.store.snapshot(), this.types, selected);
    if (this.resources)
      for (const candidate of review.candidates) {
        if (candidate.supported && review.selected.includes(candidate.key))
          await this.resources(upload.library.templates.find((template) => template.digest === candidate.digest)!);
      }
    return review;
  }
  async install(upload: PortableTemplateSource, input: unknown, actor: string) {
    const approval = portableInstallApproval(input);
    portableActor(actor);
    const { keys, templates } = selectedPortableTemplates(upload, approval.selected);
    const request = await this.request(
      upload.origin,
      keys,
      templates.map((value) => value.digest),
      approval,
    );
    const replay = await this.store.replay(actor, approval.operationId, request);
    if (replay) return { receipt: replay, current: await this.store.snapshot() };
    const review = await this.review(upload, keys);
    if (review.revision !== approval.expectedRevision) throw new PortableRegistryError("registryConflict");
    if (review.reviewHash !== approval.reviewHash) throw new PortableRegistryError("reviewChanged");
    for (const template of templates) this.types.prepare(template);
    const snapshot = await this.store.snapshot();
    if (snapshot.revision !== approval.expectedRevision) throw new PortableRegistryError("registryConflict");
    for (const template of templates) {
      const prior = snapshot.templates.find(
        (value) => value.id === template.manifest.id && value.version === template.manifest.version,
      );
      if (prior && prior.digest !== template.digest) throw new PortableRegistryError("immutableVersion");
    }
    // Durable content precedes the atomic metadata transaction; a concurrent state change fails its final CAS.
    for (const template of templates) await this.content.put(template);
    const receipt = await this.store.install(templates, upload.origin, {
      operationId: approval.operationId,
      actor,
      expectedRevision: approval.expectedRevision,
      request,
      now: Date.now(),
    });
    return { receipt, current: await this.store.snapshot() };
  }
}
