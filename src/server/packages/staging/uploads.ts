import type { MetadataStore } from "../../../shared/async-value.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import { SourceStageError, type SourceStageView } from "../../../shared/packages/stages/contracts.js";
import { stageRevision } from "../../../shared/packages/stages/input.js";
import type { SourceUploadBody } from "../uploads/contracts.js";
import type { SourceStageStore, SourceStageFiles } from "./ports.js";
import { SourceStageOperations } from "./operations.js";
import { sourceDeadline } from "../source-deadline.js";
import { stageError } from "./errors.js";
import { errorCode } from "../../../shared/errors.js";
/** Original uploads are durable before capture; recovering one never fetches a different remote source. */
export class SourceStageUploads {
  constructor(
    private store: MetadataStore<SourceStageStore>,
    private files: SourceStageFiles,
    private operations: SourceStageOperations,
    private owned: (actor: string, id: string) => SourceStageView | Promise<SourceStageView>,
    private now: () => number,
    private timeoutMs: number,
  ) {}
  upload(actor: string, id: string, revision: number, input: SourceUploadBody) {
    let cancelled = false;
    const body: SourceUploadBody = {
      chunks: input.chunks,
      cancel() {
        if (!cancelled) {
          cancelled = true;
          input.cancel();
        }
      },
    };
    return this.operations
      .run(() => this.write(actor, id, revision, body))
      .catch((error: unknown) => {
        body.cancel();
        throw stageError(error);
      });
  }
  private async write(actor: string, id: string, revision: number, body: SourceUploadBody) {
    const current = await this.owned(actor, id),
      source = current.request.source;
    stageRevision(revision);
    if (source.kind !== "zip-upload") throw new SourceStageError("stageInvalidInput");
    if (current.state !== "reserved") {
      body.cancel();
      return current;
    }
    const claim = await this.store.claimUpload(actor, id, revision, this.now(), this.timeoutMs + 10000),
      controller = this.operations.scope(id),
      deadline = sourceDeadline(controller.signal, this.timeoutMs);
    try {
      await this.files.upload(id, source, body, deadline.signal);
      if (deadline.signal.aborted) throw new SourceError("sourceCancelled");
      return await this.store.uploaded(actor, claim, this.now());
    } catch (error) {
      const failure = deadline.signal.aborted
        ? deadline.error(error).code
        : error instanceof SourceError
          ? error.code
          : "storageUnavailable";
      await this.store.fail(actor, claim, failure, this.now());
      return await this.owned(actor, id);
    } finally {
      deadline.close();
      this.operations.finish(id, controller);
    }
  }
  async original(actor: string, id: string, signal: AbortSignal) {
    return this.operations.run(async () => {
      const current = await this.owned(actor, id),
        source = current.request.source;
      if (source.kind !== "zip-upload" || !["uploaded", "acquiring"].includes(current.state))
        throw new SourceStageError("stageConflict");
      return this.files.original(id, source, signal);
    });
  }
  async recover(actor: string, id: string, revision: number) {
    return this.operations.run(async () => {
      const current = await this.owned(actor, id),
        source = current.request.source;
      if (source.kind !== "zip-upload" || current.digest) throw new SourceStageError("stageConflict");
      if (current.state === "uploaded") return current;
      const controller = this.operations.scope(id),
        deadline = sourceDeadline(controller.signal, this.timeoutMs);
      try {
        const stage = await this.store.recovery(actor, id, stageRevision(revision), this.now());
        try {
          await this.files.recoverOriginal(id, source, deadline.signal);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return await this.owned(actor, id);
          throw error;
        }
        if (deadline.signal.aborted) throw new SourceError("sourceCancelled");
        return await this.store.restoreUpload(actor, id, stage.revision, this.now());
      } catch (error) {
        throw deadline.signal.aborted ? deadline.error(error) : stageError(error);
      } finally {
        deadline.close();
        this.operations.finish(id, controller);
      }
    });
  }
}
