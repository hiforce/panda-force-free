import type { NativeSlidesSnapshot, InstalledNativeSlides } from "../../../shared/slides/registry.js";
import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import type { CapturedSourceReader, CapturedSourceConsumer } from "../../../shared/packages/ownership.js";
import { CommandScope } from "../../../shared/packages/runtime/commands.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import type { NativeSlidesRegistry, NativeSlidesBodyMetadata } from "./ports.js";
import type { NativeSlidesTemplate } from "./model.js";
import type { NativeSlidesDescriptor } from "./descriptor.js";
import {
  nativeSlidesActor,
  nativeSlidesInstallInput,
  nativeSlidesSourceInput,
  nativeSlidesReference,
  nativeSlidesRevision,
} from "./input.js";
import { templateObject } from "../../../shared/templates/portable/validation.js";
import { admitNativeSlides } from "./admit.js";
import { NativeSlidesInstallCommitter } from "./install-commit.js";
import { inspectNativeSlidesSource } from "./prepare.js";
import type { NativeSlidesProposal, NativeSlidesReview } from "../../../shared/slides/registry.js";
/** Format admission, version authority and owned file publication are separate; accepted commands survive missing intake sources. */
export class NativeSlidesService<S extends MetadataStore<NativeSlidesRegistry> = NativeSlidesRegistry> {
  private scope = new CommandScope((code) => new NativeSlidesTemplateError(code));
  private committer: NativeSlidesInstallCommitter;
  constructor(
    private registry: S,
    private bodies: NativeSlidesBodyMetadata,
    private reader: CapturedSourceReader,
    private consumer: CapturedSourceConsumer,
    now = Date.now,
  ) {
    this.committer = new NativeSlidesInstallCommitter(registry, bodies, this.scope, now);
  }
  snapshot(actor: string): MetadataValue<S, NativeSlidesRegistry, NativeSlidesSnapshot> {
    nativeSlidesActor(actor);
    return mapMetadata(this.registry.snapshot(actor), (value) => ({
      revision: value.revision,
      templates: value.versions,
    })) as MetadataValue<S, NativeSlidesRegistry, NativeSlidesSnapshot>;
  }
  prepare(actor: string, value: unknown): Promise<NativeSlidesProposal> {
    nativeSlidesActor(actor);
    const input = templateObject(value, ["source"]),
      command = nativeSlidesSourceInput(input.source);
    return this.scope.run(() =>
      this.reader.project(actor, command.id, async (captured) => {
        if (captured.digest !== command.sha256) throw new NativeSlidesTemplateError("reviewChanged");
        const { presentation, template } = await inspectNativeSlidesSource(captured, command.selection);
        return {
          original: presentation.index,
          importedFrom: { digest: captured.digest, origin: captured.descriptor.origin, selection: command.selection },
          definition: template
            ? {
                settings: template.manifest.settings,
                mapping: template.mapping,
                licenseText: template.files.text("LICENSE", 256 * 1024),
                readmeText: template.files.text("README.md", 512 * 1024),
              }
            : null,
        };
      }),
    );
  }
  part(actor: string, value: unknown) {
    nativeSlidesActor(actor);
    const input = templateObject(value, ["source", "part"]),
      command = nativeSlidesSourceInput(input.source);
    if (typeof input.part !== "string") throw new NativeSlidesTemplateError("invalidInput");
    const part = input.part;
    return this.scope.run(() =>
      this.reader.project(actor, command.id, async (captured) => {
        if (captured.digest !== command.sha256) throw new NativeSlidesTemplateError("reviewChanged");
        return (await inspectNativeSlidesSource(captured, command.selection)).presentation.part(part);
      }),
    );
  }
  private async reviewValue(
    actor: string,
    descriptor: NativeSlidesDescriptor,
    template: NativeSlidesTemplate,
  ): Promise<NativeSlidesReview> {
    const snapshot = await this.registry.snapshot(actor),
      settings = descriptor.data.manifest.settings,
      prior = snapshot.versions.find((version) => version.id === settings.id && version.version === settings.version);
    if (prior && prior.digest !== descriptor.digest) throw new NativeSlidesTemplateError("immutableVersion");
    return {
      revision: snapshot.revision,
      reviewHash: await contentSha256(
        JSON.stringify({
          revision: snapshot.revision,
          digest: descriptor.digest,
          licenseAcknowledgementRequired: true,
        }),
      ),
      digest: descriptor.digest,
      descriptor: descriptor.data,
      installed: !!prior,
      licenseText: template.files.text("LICENSE", 256 * 1024),
      licenseAcknowledgementRequired: true as const,
    };
  }
  review(actor: string, input: unknown) {
    nativeSlidesActor(actor);
    const command = nativeSlidesInstallInput(input, false);
    return this.scope.run(() =>
      this.reader.project(actor, command.source.id, async (source) => {
        if (source.digest !== command.source.sha256) throw new NativeSlidesTemplateError("reviewChanged");
        const { template, descriptor } = await admitNativeSlides(source, command);
        return this.reviewValue(actor, descriptor, template);
      }),
    );
  }
  async install(actor: string, input: unknown) {
    nativeSlidesActor(actor);
    const command = nativeSlidesInstallInput(input, true),
      approval = command.approval!;
    return this.scope.run(async () => {
      const signature = await contentSha256(
        JSON.stringify({
          source: { sha256: command.source.sha256, selection: command.source.selection },
          definition: command.definition,
          approval,
        }),
      );
      return this.scope.command(JSON.stringify([actor, approval.operationId]), signature, async () => {
        const prior = await this.registry.operation(actor, approval.operationId);
        if (prior) {
          if (prior.signature !== signature) throw new NativeSlidesTemplateError("conflict");
          return this.committer.finish(prior);
        }
        return this.consumer.consume(actor, command.source.id, command.source.sha256, async (source) => {
          const { template, descriptor } = await admitNativeSlides(source, command),
            review = await this.reviewValue(actor, descriptor, template);
          if (review.revision !== approval.expectedRevision || review.reviewHash !== approval.reviewHash)
            throw new NativeSlidesTemplateError("reviewChanged");
          const intent = await this.registry.reserve(
            actor,
            signature,
            descriptor,
            approval,
            await contentSha256(JSON.stringify(template.manifest.settings)),
          );
          return this.committer.finish(intent, template);
        });
      });
    });
  }
  recover() {
    return this.committer.recover();
  }
  detail(actor: string, value: unknown): MetadataValue<S, NativeSlidesRegistry, InstalledNativeSlides> {
    nativeSlidesActor(actor);
    const ref = nativeSlidesReference(value);
    return mapMetadata(this.registry.detail(actor, ref.id, ref.version), (template) => {
      if (template.digest !== ref.digest) throw new NativeSlidesTemplateError("immutableVersion");
      return template;
    }) as MetadataValue<S, NativeSlidesRegistry, InstalledNativeSlides>;
  }
  with<T>(actor: string, value: unknown, read: (template: NativeSlidesTemplate) => Promise<T>) {
    return this.scope.run(async () => {
      const installed = await this.detail(actor, value),
        source = await this.registry.source(actor, installed.id, installed.version);
      return this.bodies.with(actor, { source, templateDigest: installed.descriptor.templateDigest }, read);
    });
  }
  state(
    actor: string,
    value: unknown,
    action: "enable" | "disable" | "activate",
    revision: unknown,
  ): MetadataValue<S, NativeSlidesRegistry, InstalledNativeSlides> {
    return mapMetadata(this.detail(actor, value), (installed) =>
      this.registry.state(
        actor,
        installed.id,
        installed.version,
        installed.digest,
        action,
        nativeSlidesRevision(revision),
      ),
    ) as MetadataValue<S, NativeSlidesRegistry, InstalledNativeSlides>;
  }
  authorize(actor: string, value: unknown): MetadataValue<S, NativeSlidesRegistry, InstalledNativeSlides> {
    return mapMetadata(this.detail(actor, value), (template) => {
      if (!template.enabled) throw new NativeSlidesTemplateError("disabled");
      return template;
    }) as MetadataValue<S, NativeSlidesRegistry, InstalledNativeSlides>;
  }
  close() {
    return this.scope.close();
  }
}
export type NativeSlidesServicePort = NativeSlidesService<MetadataStore<NativeSlidesRegistry>>;
