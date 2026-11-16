import type { SourceStageView, SourceStageEvent } from "../../../shared/packages/stages/contracts.js";
import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import { randomUUID } from "node:crypto";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { SourceError, sourceLimits, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import {
  SourceStageError,
  type SourceStagePurpose,
  type SourceStageFailure,
} from "../../../shared/packages/stages/contracts.js";
import {
  stageText,
  stageId,
  stagePurpose,
  stageRevision,
  sourceStageRequest,
} from "../../../shared/packages/stages/input.js";
import type { SourceStageStore, SourceStageFiles, SourceStageAcquisition } from "./ports.js";
import { sourceDeadline, awaitSourceResult } from "../source-deadline.js";
import { validateStagedSource } from "./validation.js";
import { SourceStageOperations } from "./operations.js";
import { SourceStageUploads } from "./uploads.js";
import { stageError } from "./errors.js";
import type { SourceUploadBody } from "../uploads/contracts.js";
/** No source work begins until a durable reservation exists; a stage performs at most one body write. */
export class PackageSourceStages<S extends MetadataStore<SourceStageStore> = SourceStageStore> {
  private purpose: SourceStagePurpose;
  private limits: SourceLimits;
  private operations = new SourceStageOperations();
  private uploads: SourceStageUploads;
  constructor(
    purpose: SourceStagePurpose,
    private store: S,
    private files: SourceStageFiles,
    limits?: SourceLimits,
    private now: () => number = Date.now,
    private timeoutMs = 120000,
  ) {
    this.purpose = stagePurpose(purpose);
    this.limits = sourceLimits(limits);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      throw new SourceStageError("stageInvalidInput");
    this.uploads = new SourceStageUploads(
      store,
      files,
      this.operations,
      (actor, id) => this.read(actor, id),
      now,
      timeoutMs,
    );
  }
  submit(actor: string, operationId: string, input: unknown): Promise<SourceStageView> {
    return this.operations.run(() => this.submitCommand(actor, operationId, input));
  }
  private async submitCommand(actor: string, operationId: string, input: unknown) {
    actor = stageText(actor);
    operationId = stageId(operationId);
    const existing = await this.store.operation(actor, operationId),
      request = sourceStageRequest(input, existing?.limits ?? this.limits),
      fingerprint = await contentSha256(JSON.stringify({ purpose: this.purpose, request }));
    try {
      const replay = await this.store.replay(actor, operationId, fingerprint);
      if (replay) return replay;
      sourceStageRequest(request, this.limits);
      return await this.store.create(
        {
          actor,
          id: randomUUID(),
          operationId,
          purpose: this.purpose,
          request,
          limits: this.limits,
          fingerprint,
          reservedBytes: this.files.reserve(request, this.limits),
          now: this.now(),
        },
        (id) => this.files.prepare(id),
      );
    } catch (error) {
      throw stageError(error);
    }
  }
  read(actor: string, id: string): MetadataValue<S, SourceStageStore, SourceStageView> {
    return mapMetadata(this.store.read(stageText(actor), stageId(id)), (stage) => {
      if (stage.purpose !== this.purpose) throw new SourceStageError("stageNotFound");
      return stage;
    }) as MetadataValue<S, SourceStageStore, SourceStageView>;
  }
  operation(actor: string, operationId: string): MetadataValue<S, SourceStageStore, SourceStageView | null> {
    return mapMetadata(this.store.operation(stageText(actor), stageId(operationId)), (stage) => {
      if (stage && stage.purpose !== this.purpose) throw new SourceStageError("stageNotFound");
      return stage;
    }) as MetadataValue<S, SourceStageStore, SourceStageView | null>;
  }
  list(actor: string): MetadataValue<S, SourceStageStore, readonly SourceStageView[]> {
    return this.store.list(stageText(actor), this.purpose) as MetadataValue<
      S,
      SourceStageStore,
      readonly SourceStageView[]
    >;
  }
  events(actor: string, id: string): MetadataValue<S, SourceStageStore, readonly SourceStageEvent[]> {
    return mapMetadata(this.read(actor, id), () => this.store.events(actor, id)) as MetadataValue<
      S,
      SourceStageStore,
      readonly SourceStageEvent[]
    >;
  }
  execute(actor: string, id: string, revision: number, acquire: SourceStageAcquisition): Promise<SourceStageView> {
    return this.operations.run(() => this.executeCommand(actor, id, revision, acquire));
  }
  private async executeCommand(
    actor: string,
    id: string,
    revision: number,
    acquire: SourceStageAcquisition,
  ): Promise<SourceStageView> {
    const current = await this.read(actor, id);
    stageRevision(revision);
    if (!["reserved", "uploaded"].includes(current.state)) return current;
    const claim = await this.store.claim(actor, id, revision, this.now(), this.timeoutMs + 10000),
      controller = this.operations.scope(id),
      deadline = sourceDeadline(controller.signal, this.timeoutMs);
    let phase: "acquiring" | "writing" = "acquiring";
    try {
      const source = await awaitSourceResult(
        acquire(actor, this.purpose, claim.stage.request, deadline.signal, claim.stage.limits, claim.stage.entryPolicy),
        deadline.signal,
      );
      if (deadline.signal.aborted) throw new SourceError("sourceCancelled");
      validateStagedSource(claim.stage.request, source, claim.stage.entryPolicy);
      await this.store.bind(actor, claim, source.digest, this.now());
      phase = "writing";
      await this.files.put(id, source, claim.stage.limits);
      if (deadline.signal.aborted) throw new SourceError("sourceCancelled");
      if (claim.stage.request.source.kind === "zip-upload") await this.files.dropOriginal(id);
      if (deadline.signal.aborted) throw new SourceError("sourceCancelled");
      return await this.store.complete(actor, claim, source, this.files.size(source), this.now());
    } catch (error) {
      let failure: SourceStageFailure;
      if (deadline.signal.aborted) failure = deadline.error(error).code;
      else
        failure =
          error instanceof SourceError
            ? error.code
            : error instanceof SourceStageError && ["stageConflict", "stageBusy"].includes(error.code)
              ? "interrupted"
              : phase === "acquiring"
                ? "sourceUnavailable"
                : "storageUnavailable";
      await this.store.fail(actor, claim, failure, this.now());
      return await this.read(actor, id);
    } finally {
      deadline.close();
      this.operations.finish(id, controller);
    }
  }
  cancel(actor: string, id: string, revision: number): MetadataValue<S, SourceStageStore, SourceStageView> {
    return mapMetadata(this.read(actor, id), () =>
      mapMetadata(this.store.cancel(actor, id, stageRevision(revision), this.now()), (value) => {
        this.operations.abort(id);
        return value;
      }),
    ) as MetadataValue<S, SourceStageStore, SourceStageView>;
  }
  content(actor: string, id: string) {
    return this.operations.run(() => this.contentCommand(actor, id));
  }
  private async contentCommand(actor: string, id: string) {
    const stage = await this.read(actor, id);
    if (stage.state !== "ready" || !stage.digest) throw new SourceStageError("stageConflict");
    const source = await this.files.read(id, stage.digest, stage.limits).catch((error: unknown) => {
      throw stageError(error);
    });
    validateStagedSource(stage.request, source, stage.entryPolicy);
    const current = await this.read(actor, id);
    if (current.state !== "ready" || current.revision !== stage.revision) throw new SourceStageError("stageConflict");
    return source;
  }
  async recover(actor: string, id: string, revision: number): Promise<SourceStageView> {
    const current = await this.read(actor, id);
    if (current.request.source.kind === "zip-upload" && !current.digest)
      return this.uploads.recover(actor, id, revision);
    return this.operations.run(() => this.recoverCommand(actor, id, revision));
  }
  upload(actor: string, id: string, revision: number, body: SourceUploadBody): Promise<SourceStageView> {
    return this.uploads.upload(actor, id, revision, body);
  }
  original(actor: string, id: string, signal: AbortSignal) {
    return this.uploads.original(actor, id, signal);
  }
  private async recoverCommand(actor: string, id: string, revision: number): Promise<SourceStageView> {
    await this.read(actor, id);
    const stage = await this.store.recovery(actor, id, stageRevision(revision), this.now());
    if (!stage.digest) return stage;
    const source = await this.files.recover(id, stage.digest, stage.limits).catch((error: unknown) => {
      throw stageError(error);
    });
    validateStagedSource(stage.request, source, stage.entryPolicy);
    if (stage.request.source.kind === "zip-upload") await this.files.dropOriginal(id);
    return await this.store.recover(actor, id, stage.revision, source, this.files.size(source), this.now());
  }
  remove(actor: string, id: string, revision: number): Promise<SourceStageView> {
    return this.operations.run(() => this.removeCommand(actor, id, revision));
  }
  private async removeCommand(actor: string, id: string, revision: number): Promise<SourceStageView> {
    const current = await this.read(actor, id);
    stageRevision(revision);
    if (current.state === "removed") return current;
    const stage = await this.store.removing(actor, id, revision, this.now());
    this.operations.abort(id);
    await this.files.remove(id).catch((error: unknown) => {
      throw stageError(error);
    });
    const value = await this.read(actor, id);
    if (value.state === "removed") return value;
    return await this.store.removed(actor, id, stage.revision, this.now());
  }
  async shutdown(): Promise<void> {
    await this.operations.drain();
  }
}
