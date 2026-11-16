import { mapMetadata, isMetadataPending, type MetadataStore } from "../../../shared/async-value.js";
import { SourceError } from "../../../shared/packages/sources/contracts.js";
import {
  SourceStageError,
  type SourceStagePurpose,
  type SourceStageView,
} from "../../../shared/packages/stages/contracts.js";
import { stagePurpose } from "../../../shared/packages/stages/input.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type { SourceStageStore, SourceStageCandidate } from "../staging/ports.js";
import type { PackageSourceStages } from "../staging/service.js";
import type { SourceUploadBody } from "../uploads/contracts.js";
import type { SourceCaptureProvider } from "./providers.js";
import { SourceRuntime, SOURCE_UPLOAD_RUNTIME_BYTES, sourceCaptureBytes } from "./runtime.js";

export type SourceStageServices<S extends MetadataStore<SourceStageStore> = SourceStageStore> = Readonly<
  Record<SourceStagePurpose, PackageSourceStages<S>>
>;
export interface SourceIngestionDiagnostic {
  readonly id: string;
  readonly code: string;
}

/** The worker schedules captured sources; native template installation remains a separate reviewed authority. */
export class PackageSourceIngestion<S extends MetadataStore<SourceStageStore> = SourceStageStore> {
  private jobs = new Map<string, Promise<void>>();
  private controls = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private automatic = false;
  private closing = false;
  private polling = false;
  private pollingTask: Promise<void> | undefined;
  private retryAt = new Map<string, number>();
  constructor(
    private stages: SourceStageServices<S>,
    private store: S,
    private provider: SourceCaptureProvider,
    readonly runtime: SourceRuntime,
    private now: () => number = Date.now,
    private diagnostic: (value: SourceIngestionDiagnostic) => void = () => {},
  ) {}
  private service(purpose: SourceStagePurpose) {
    return this.stages[stagePurpose(purpose)];
  }
  private accepting() {
    if (this.closing) throw new SourceStageError("stageUnavailable");
  }
  private report(id: string, error: unknown) {
    this.diagnostic({
      id,
      code: error instanceof SourceError || error instanceof SourceStageError ? error.code : "sourceUnavailable",
    });
  }
  private wake() {
    if (this.automatic && !this.closing) queueMicrotask(() => this.poll());
  }
  start(): void {
    this.accepting();
    if (this.automatic) return;
    this.automatic = true;
    this.timer = setInterval(() => this.poll(), 1000);
    this.timer.unref();
    this.poll();
  }
  submit(actor: string, purpose: SourceStagePurpose, operationId: string, input: unknown): Promise<SourceStageView> {
    this.accepting();
    const pending = this.service(purpose)
      .submit(actor, operationId, input)
      .then((value) => {
        this.wake();
        return value;
      });
    return this.control(pending);
  }
  read(actor: string, purpose: SourceStagePurpose, id: string) {
    return this.service(purpose).read(actor, id);
  }
  list(actor: string, purpose: SourceStagePurpose) {
    return this.service(purpose).list(actor);
  }
  inspect(actor: string, purpose: SourceStagePurpose, id: string) {
    return this.project(actor, purpose, id, (source) => source.descriptor);
  }
  project<T>(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    read: (source: CapturedPackageSource) => T | Promise<T>,
  ) {
    return this.usingSource(actor, purpose, id, read);
  }
  consume<T>(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    sha256: string,
    run: (source: CapturedPackageSource) => Promise<T>,
  ) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new SourceStageError("stageInvalidInput");
    return this.usingSource(actor, purpose, id, run, sha256);
  }
  private usingSource<T>(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    run: (source: CapturedPackageSource) => T | Promise<T>,
    acceptedDigest?: string,
  ) {
    this.accepting();
    const service = this.service(purpose);
    const pendingRead = mapMetadata(service.read(actor, id), (stage) => {
      this.accepting();
      if (stage.state !== "ready" || (acceptedDigest && stage.digest !== acceptedDigest))
        throw new SourceStageError("stageConflict");
      const lease = this.runtime.acquire(sourceCaptureBytes(stage));
      if (!lease) throw new SourceStageError("stageBusy");
      const pending = service.content(actor, id).then(async (source) => {
        const current = await service.read(actor, id);
        if (current.state !== "ready" || current.revision !== stage.revision)
          throw new SourceStageError("stageConflict");
        const result = await run(source);
        // Accepted commands own these bytes. Removing their intake task cannot invalidate an already committed effect.
        if (!acceptedDigest) {
          const latest = await service.read(actor, id);
          if (latest.state !== "ready" || latest.revision !== stage.revision)
            throw new SourceStageError("stageConflict");
        }
        return result;
      });
      return pending.finally(() => lease.release());
    });
    return this.control(Promise.resolve(pendingRead));
  }
  cancel(actor: string, purpose: SourceStagePurpose, id: string, revision: number) {
    this.accepting();
    const value = this.service(purpose).cancel(actor, id, revision);
    return (isMetadataPending(value) ? this.control(Promise.resolve(value)) : value) as typeof value;
  }
  remove(actor: string, purpose: SourceStagePurpose, id: string, revision: number): Promise<SourceStageView> {
    this.accepting();
    return this.control(this.service(purpose).remove(actor, id, revision));
  }
  upload(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    revision: number,
    body: SourceUploadBody,
  ): Promise<SourceStageView> {
    return this.control(this.uploadCommand(actor, purpose, id, revision, body));
  }
  private async uploadCommand(
    actor: string,
    purpose: SourceStagePurpose,
    id: string,
    revision: number,
    body: SourceUploadBody,
  ): Promise<SourceStageView> {
    let lease: ReturnType<SourceRuntime["acquire"]> = null;
    try {
      this.accepting();
      const service = this.service(purpose),
        current = await service.read(actor, id),
        buffered = body.bufferedBytes ?? 0;
      this.accepting();
      if (current.request.source.kind !== "zip-upload") throw new SourceStageError("stageInvalidInput");
      if (current.state !== "reserved") {
        body.cancel();
        return current;
      }
      if (!Number.isSafeInteger(buffered) || buffered < 0 || buffered > 2 * current.request.source.bytes)
        throw new SourceError("invalidSource");
      lease = this.runtime.acquire(SOURCE_UPLOAD_RUNTIME_BYTES + buffered);
      if (!lease) throw new SourceStageError("stageBusy");
      const pending = service.upload(actor, id, revision, body).then((value) => value);
      return await this.control(pending);
    } catch (error) {
      body.cancel();
      throw error;
    } finally {
      lease?.release();
      this.wake();
    }
  }
  private control<T>(pending: Promise<T>): Promise<T> {
    this.controls.add(pending);
    return pending.finally(() => {
      this.controls.delete(pending);
    });
  }
  poll(): void {
    if (this.closing || this.polling) return;
    this.polling = true;
    this.pollingTask = this.pollQueue().finally(() => {
      this.polling = false;
      this.pollingTask = undefined;
    });
  }
  private async pollQueue() {
    try {
      for (const [id, at] of this.retryAt) if (at <= this.now()) this.retryAt.delete(id);
      for (const candidate of await this.store.candidates(this.now())) {
        if (this.closing) return;
        if (this.jobs.has(candidate.id) || (this.retryAt.get(candidate.id) ?? 0) > this.now()) continue;
        try {
          await this.launch(candidate);
        } catch (error) {
          this.report(candidate.id, error);
        }
      }
    } catch (error) {
      this.report("queue", error);
    }
  }
  private async launch(candidate: SourceStageCandidate) {
    const service = this.service(candidate.purpose),
      stage = await service.read(candidate.actor, candidate.id);
    if (this.closing) return;
    if (stage.revision !== candidate.revision) return;
    if (stage.state === "removing") {
      this.schedule(stage.id, () => service.remove(candidate.actor, stage.id, stage.revision));
      return;
    }
    const capture = ["reserved", "uploaded"].includes(stage.state),
      bytes = capture || stage.digest ? sourceCaptureBytes(stage) : SOURCE_UPLOAD_RUNTIME_BYTES;
    let lease: ReturnType<SourceRuntime["acquire"]>;
    try {
      lease = this.runtime.acquire(bytes);
    } catch (error) {
      if (!capture || !(error instanceof SourceError)) throw error;
      this.schedule(stage.id, () =>
        service.execute(candidate.actor, stage.id, stage.revision, async () => {
          throw error;
        }),
      );
      return;
    }
    if (!lease) return;
    const held = lease;
    this.schedule(stage.id, async () => {
      let acquiring: Promise<CapturedPackageSource> | undefined;
      try {
        if (!capture) return await service.recover(candidate.actor, stage.id, stage.revision);
        return await service.execute(
          candidate.actor,
          stage.id,
          stage.revision,
          (actor, purpose, request, signal, limits, entryPolicy) => {
            acquiring = this.provider.capture(actor, purpose, stage.id, request, signal, limits, entryPolicy);
            return acquiring;
          },
        );
      } finally {
        // Cancellation may finish metadata before a bounded provider finishes releasing its owned buffers.
        if (acquiring) await Promise.allSettled([acquiring]);
        held.release();
      }
    });
  }
  private schedule(id: string, work: () => Promise<unknown>) {
    const pending = Promise.resolve()
      .then(work)
      .then(
        () => {
          this.retryAt.delete(id);
        },
        (error: unknown) => {
          this.retryAt.set(id, this.now() + 1000);
          this.report(id, error);
        },
      )
      .finally(() => {
        this.jobs.delete(id);
        this.wake();
      });
    this.jobs.set(id, pending);
  }
  async settle(): Promise<void> {
    await this.pollingTask;
    await Promise.allSettled([...this.jobs.values(), ...this.controls]);
  }
  stop(): void {
    this.closing = true;
    this.automatic = false;
    clearInterval(this.timer);
  }
  async drain(): Promise<void> {
    this.stop();
    await this.settle();
  }
}
