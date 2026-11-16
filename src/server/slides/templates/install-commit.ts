import type { MetadataStore } from "../../../shared/async-value.js";
import type { NativeSlidesDescriptorData, NativeSlidesInstallReceipt } from "../../../shared/slides/registry.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import type { CommandScope } from "../../../shared/packages/runtime/commands.js";
import type { VersionIntent } from "../../packages/versions/contracts.js";
import type { NativeSlidesRegistry, NativeSlidesBodyMetadata } from "./ports.js";
import type { NativeSlidesTemplate } from "./model.js";
type Intent = VersionIntent<NativeSlidesDescriptorData, NativeSlidesInstallReceipt>;
/** Only the accepted immutable intent can publish an owned body; recovery never reopens a mutable intake source. */
export class NativeSlidesInstallCommitter {
  constructor(
    private registry: MetadataStore<NativeSlidesRegistry>,
    private bodies: NativeSlidesBodyMetadata,
    private scope: CommandScope,
    private now = Date.now,
  ) {}
  private async result(intent: Intent) {
    if (intent.state !== "committed" || !intent.receipt) throw new NativeSlidesTemplateError("conflict");
    const snapshot = await this.registry.snapshot(intent.actor);
    return { receipt: intent.receipt, current: { revision: snapshot.revision, templates: snapshot.versions } };
  }
  private async cleanup(actor: string, id: string) {
    if ((await this.registry.operation(actor, id))?.state !== "failed") return;
    const source = await this.bodies.reference(actor, id);
    if (source && (await this.registry.referenced(actor, source.id))) {
      await this.registry.cleanupDone(actor, id);
      return;
    }
    await this.bodies.remove(actor, id);
    await this.registry.cleanupDone(actor, id);
  }
  async finish(original: Intent, template?: NativeSlidesTemplate) {
    const intent = (await this.registry.operation(original.actor, original.operationId))!;
    if (intent.state === "committed") return await this.result(intent);
    if (intent.state !== "pending" || !intent.descriptor) throw new NativeSlidesTemplateError("conflict");
    try {
      const body = template
        ? await this.bodies.put(intent.actor, intent.operationId, template)
        : await this.bodies.recover(intent.actor, intent.operationId);
      if (!body) throw new NativeSlidesTemplateError(this.now() < intent.recoverAfter ? "busy" : "unavailable");
      if (
        body.source.digest !== intent.descriptor.sourceDigest ||
        body.templateDigest !== intent.descriptor.templateDigest
      )
        throw new NativeSlidesTemplateError("sourceChanged");
      // The body port verifies content before returning; rereading here would acquire a nested source allocation.
      await this.registry.commit(intent.actor, intent.operationId, body.source);
      return await this.result((await this.registry.operation(intent.actor, intent.operationId))!);
    } catch (error) {
      if ((await this.registry.operation(intent.actor, intent.operationId))?.state === "committed")
        return await this.result((await this.registry.operation(intent.actor, intent.operationId))!);
      const permanent =
        error instanceof NativeSlidesTemplateError &&
        ["storageFull", "sourceChanged", "invalidBundle", "invalidInput", "immutableVersion", "conflict"].includes(
          error.code,
        );
      // Unknown write outcomes retain the accepted intent until its body can be recovered or the write grace expires.
      if (
        permanent ||
        (this.now() >= intent.recoverAfter && !(error instanceof NativeSlidesTemplateError && error.code === "busy"))
      ) {
        await this.registry.fail(intent.actor, intent.operationId);
        await this.cleanup(intent.actor, intent.operationId);
      }
      throw error;
    }
  }
  async recover() {
    return this.scope.run(async () => {
      for (const intent of await this.registry.recoverable()) {
        try {
          if (intent.state === "failed") await this.cleanup(intent.actor, intent.operationId);
          else
            await this.scope.command(JSON.stringify([intent.actor, intent.operationId]), intent.signature, () =>
              this.finish(intent),
            );
        } catch (error) {
          if (!(
            error instanceof NativeSlidesTemplateError &&
            ["busy", "conflict", "unavailable", "sourceChanged"].includes(error.code)
          ))
            throw error;
        }
      }
    });
  }
}
