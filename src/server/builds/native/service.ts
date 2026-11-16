import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import { ResourceBuildRequest } from "../../../shared/builds/resources.js";
import { BUILD_ENGINES } from "../../../shared/builds/engines.js";
import { terminalBuildRun } from "../../../shared/builds/run.js";
import type { NativeSampleRequest, NativeSampleBuild } from "../../../shared/builds/native-samples.js";
import type { ResourceBuildInputs } from "../resource-input-port.js";
import type { SiteExecutor } from "../executor-port.js";
import type { NativeSampleStore, NativeBuildThemeMetadata } from "./ports.js";
import { nativeBuildActor, nativeBuildThemeRef, nativeSampleRequest } from "./commands.js";
import { nativeSampleInput, nativeSampleKey, NATIVE_SAMPLE_RUNNER } from "./sample-input.js";
import { SiteBuildError } from "../errors.js";
import { ResourceInputLifecycle } from "../resource-input-lifecycle.js";
import { resourceBuildRequirements } from "../../../shared/builds/capabilities.js";
import { assertBuildCapabilities } from "../capabilities.js";
/** Admissions freeze one native sample input; execution state remains with the shared build monitor. */
export class NativeSampleService<S extends MetadataStore<NativeSampleStore> = NativeSampleStore> {
  private closed = false;
  private inputs: ResourceInputLifecycle<NativeSampleBuild>;
  private pending = new Set<Promise<unknown>>();
  private captures = new Map<
    string,
    {
      actor: string;
      signature: string;
      result: Promise<NativeSampleBuild>;
    }
  >();
  constructor(
    private jobs: S,
    files: ResourceBuildInputs,
    private themes: NativeBuildThemeMetadata,
    private executor: SiteExecutor | null,
    private wake: () => void,
    private removeArtifact: (id: string) => Promise<void>,
    private now = Date.now,
  ) {
    this.inputs = new ResourceInputLifecycle(jobs, files, wake, now);
  }
  private accepting() {
    if (this.closed) throw new SiteBuildError("unavailable", 503);
  }
  private using<T>(work: () => Promise<T>) {
    this.accepting();
    const result = Promise.resolve().then(work);
    this.pending.add(result);
    return result.finally(() => this.pending.delete(result));
  }
  async start(actor: string, value: unknown) {
    nativeBuildActor(actor);
    const request = nativeSampleRequest(value),
      signature = JSON.stringify(request);
    return this.using(async () => {
      const existing = await this.jobs.existing(actor, request.id, signature);
      if (existing) return this.inputs.resume(existing);
      const active = this.captures.get(request.id);
      if (active) {
        if (active.actor !== actor) throw new SiteBuildError("notFound", 404);
        if (active.signature !== signature) throw new SiteBuildError("idempotencyConflict", 409);
        return active.result;
      }
      if (this.captures.size >= 2) throw new SiteBuildError("busy", 429);
      const result = this.capture(actor, request, signature);
      this.captures.set(request.id, { actor, signature, result });
      try {
        return await result;
      } finally {
        this.captures.delete(request.id);
      }
    });
  }
  private async capture(actor: string, request: NativeSampleRequest, signature: string) {
    await this.themes.authorize(actor, request.theme);
    const available = await this.executor?.availability();
    if (!this.executor?.startResource || !available || available.state !== "ready")
      throw new SiteBuildError(
        !available || available.state === "unconfigured" ? "executorUnconfigured" : "executorUnavailable",
        503,
      );
    if (!available.nativeResources) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
    return await this.themes.with(actor, request.theme, async (theme) => {
      if (available.engines[theme.definition.engine] !== BUILD_ENGINES[theme.definition.engine])
        throw new SiteBuildError("incompatibleImage", 503);
      const input = await ResourceBuildRequest.create(
          nativeSampleInput(theme.definition.engine),
          theme.definition,
          theme.resources,
        ),
        key = await nativeSampleKey(request.theme, input.engine),
        now = this.now();
      assertBuildCapabilities(
        input.descriptor.input,
        available,
        resourceBuildRequirements(input.descriptor.input, input.descriptor.files),
      );
      await this.themes.authorize(actor, request.theme);
      const job: NativeSampleBuild = {
          id: request.id,
          key,
          theme: request.theme,
          site: input.descriptor.input.site,
          runnerVersion: NATIVE_SAMPLE_RUNNER,
          engineVersion: BUILD_ENGINES[input.engine],
          engine: input.engine,
          inputHash: input.digest,
          phase: "queued",
          createdAt: now,
          updatedAt: now,
          error: null,
          connection: "ready",
          outputBytes: 0,
          fileCount: 0,
          artifactAvailable: false,
          image: null,
        },
        reserved = await this.jobs.reserve(actor, signature, job);
      if (!reserved.created) return this.inputs.resume(reserved.value);
      return this.inputs.create(job, input);
    });
  }
  recover() {
    return this.using(() => this.inputs.recover());
  }
  async lookup(actor: string, value: unknown) {
    nativeBuildActor(actor);
    const ref = nativeBuildThemeRef(value);
    return this.using(async () => {
      const theme = await this.themes.describe(actor, ref);
      return await this.jobs.latest(actor, await nativeSampleKey(ref, theme.engine));
    });
  }
  detail(actor: string, id: string): MetadataValue<S, NativeSampleStore, NativeSampleBuild> {
    this.accepting();
    nativeBuildActor(actor);
    return mapMetadata(this.jobs.owner(id), (owner) => {
      if (owner !== actor) throw new SiteBuildError("notFound", 404);
      return this.jobs.get(id);
    }) as MetadataValue<S, NativeSampleStore, NativeSampleBuild>;
  }
  list(actor: string): MetadataValue<S, NativeSampleStore, NativeSampleBuild[]> {
    this.accepting();
    nativeBuildActor(actor);
    return this.jobs.list(actor) as MetadataValue<S, NativeSampleStore, NativeSampleBuild[]>;
  }
  logs(actor: string, id: string): MetadataValue<S, NativeSampleStore, string> {
    return mapMetadata(this.detail(actor, id), () => this.jobs.logs(id)) as MetadataValue<S, NativeSampleStore, string>;
  }
  cancel(actor: string, id: string): MetadataValue<S, NativeSampleStore, NativeSampleBuild> {
    return mapMetadata(this.detail(actor, id), (job) => {
      if (terminalBuildRun(job)) return job;
      return mapMetadata(this.jobs.reservation(id), (reservation) =>
        mapMetadata(this.jobs.update(id, { phase: reservation.ready ? "cancelling" : "cancelled" }), (next) => {
          this.wake();
          return next;
        }),
      );
    }) as MetadataValue<S, NativeSampleStore, NativeSampleBuild>;
  }
  requireArtifact(actor: string, id: string): MetadataValue<S, NativeSampleStore, NativeSampleBuild> {
    return mapMetadata(this.detail(actor, id), (job) => {
      if (job.phase !== "completed" || !job.artifactAvailable) throw new SiteBuildError("artifactUnavailable", 404);
      return job;
    }) as MetadataValue<S, NativeSampleStore, NativeSampleBuild>;
  }
  async remove(actor: string, id: string) {
    return this.using(async () => {
      const job = await this.detail(actor, id);
      if (!terminalBuildRun(job)) throw new SiteBuildError("buildActive", 409);
      await this.jobs.archive(id);
      await this.inputs.cleanup(id);
      await this.removeArtifact(id);
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
export type NativeSampleServicePort = NativeSampleService<MetadataStore<NativeSampleStore>>;
