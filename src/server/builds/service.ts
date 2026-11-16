import type { MetadataStore } from "../../shared/async-value.js";
import type { SiteBuild, SiteBuildRequest, BuildAvailability } from "../../shared/builds/jobs.js";
import type { BuildSources } from "./source-port.js";
import type { SiteExecutor } from "./executor-port.js";
import { terminalBuildRun as terminalBuild } from "../../shared/builds/run.js";
import type { SiteBuildJobs, BuildMutation } from "./job-port.js";
import type { SiteBuildArtifacts } from "./artifacts.js";
import type { SiteBuildReconciler } from "./reconciler.js";
import { SiteBuildError } from "./errors.js";
import { siteBuildRequest } from "./validation.js";
import { builtinBuildAuthority, type BuildAuthorityPort } from "./authority.js";
import { assertBuildCapabilities } from "./capabilities.js";
import type { NativeProjectBuildMetadata } from "./native/project-ports.js";
/** Application operations are shared by HTTP and future natural-language/plugin entry points. */
export class SiteBuildService {
  private captures = new Map<
    string,
    {
      request: string;
      actor?: string;
      result: ReturnType<SiteBuildService["capture"]>;
    }
  >();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(
    private sources: BuildSources,
    private jobs: MetadataStore<SiteBuildJobs>,
    private artifacts: SiteBuildArtifacts,
    private executor: SiteExecutor | null,
    private reconciler: SiteBuildReconciler | null,
    private authorizeInput: BuildAuthorityPort = builtinBuildAuthority,
    private native?: NativeProjectBuildMetadata,
    private mutation: BuildMutation = (work) => work(),
  ) {}
  private using<T>(work: () => Promise<T>) {
    if (this.closed) return Promise.reject(new SiteBuildError("unavailable", 503));
    const result = Promise.resolve().then(work);
    this.pending.add(result);
    return result.finally(() => this.pending.delete(result));
  }
  availability(): Promise<BuildAvailability> {
    return this.executor?.availability() || Promise.resolve({ state: "unconfigured", engines: {} });
  }
  async start(value: unknown, actor?: string) {
    const request = siteBuildRequest(value);
    return this.using(() => this.startAuthorized(request, actor));
  }
  private async startAuthorized(request: SiteBuildRequest, actor?: string) {
    await this.sources.authorize(request.spaceId, request.projectId);
    const existing = await this.jobs.existing(request, actor);
    if (existing) return existing.inputProtocol === 2 ? this.requireNative().resume(actor, existing) : existing;
    const previous = this.captures.get(request.id),
      signature = JSON.stringify(request);
    if (previous) {
      if (request.nativeTheme && previous.actor !== actor) throw new SiteBuildError("notFound", 404);
      if (previous.request !== signature) throw new SiteBuildError("idempotencyConflict", 409);
      return previous.result;
    }
    if (this.captures.size >= 2) throw new SiteBuildError("busy", 429);
    const result = this.capture(request, actor);
    this.captures.set(request.id, { request: signature, actor, result });
    try {
      return await result;
    } finally {
      this.captures.delete(request.id);
    }
  }
  private requireNative() {
    if (!this.native) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
    return this.native;
  }
  private async capture(request: SiteBuildRequest, actor?: string) {
    const availability = await this.availability();
    if (availability.state !== "ready" || !availability.engines[request.engine])
      throw new SiteBuildError(
        availability.state === "unconfigured" ? "executorUnconfigured" : "executorUnavailable",
        503,
      );
    const snapshot = await this.sources.capture(request);
    await this.sources.authorize(request.spaceId, request.projectId);
    if (request.nativeTheme) {
      if (!this.executor?.startResource) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
      const job = await this.requireNative().capture(actor, request, snapshot, availability, async () => {
        await this.sources.authorize(request.spaceId, request.projectId);
      });
      this.reconciler?.wake();
      return job;
    }
    assertBuildCapabilities(snapshot.input, availability);
    const job = await this.mutation(async () => {
      await this.sources.authorize(request.spaceId, request.projectId);
      await this.authorizeInput(snapshot.input);
      return this.jobs.create(request, snapshot.input, snapshot.sources, snapshot.sourceSnapshot);
    });
    this.reconciler?.wake();
    return job;
  }
  async list(spaceId: string, projectId?: string, actor?: string) {
    await this.sources.authorize(spaceId, projectId);
    const visible: SiteBuild[] = [];
    for (const job of await this.jobs.list(spaceId, undefined, projectId)) {
      if (job.inputProtocol === 2) {
        try {
          await this.requireNative().authorizeRead(actor, job);
        } catch (error) {
          if (error instanceof SiteBuildError && error.code === "notFound") continue;
          throw error;
        }
      }
      visible.push(job);
    }
    return visible;
  }
  async detail(id: string, actor?: string) {
    const job = await this.jobs.get(id);
    if (job.inputProtocol === 2) await this.requireNative().authorizeRead(actor, job);
    await this.sources.authorize(job.spaceId, job.projectId);
    return job;
  }
  async logs(id: string, actor?: string) {
    await this.detail(id, actor);
    return await this.jobs.logs(id);
  }
  async cancel(id: string, actor?: string) {
    const next = await this.mutation(async () => {
      const job = await this.detail(id, actor);
      if (terminalBuild(job)) return job;
      return job.inputProtocol === 2
        ? await this.requireNative().cancel(job)
        : await this.jobs.update(id, { phase: "cancelling" });
    });
    this.reconciler?.wake();
    return next;
  }
  async remove(id: string, actor?: string) {
    const job = await this.mutation(async () => {
      const current = await this.detail(id, actor);
      if (!terminalBuild(current)) throw new SiteBuildError("buildActive", 409);
      await this.jobs.remove(id);
      return current;
    });
    if (job.inputProtocol === 2) await this.requireNative().cleanup(id);
    await this.artifacts.remove(id);
  }
  async download(id: string, actor?: string) {
    const job = await this.requireArtifact(id, actor),
      bytes = await this.artifacts.download(id);
    await this.requireArtifact(job.id, actor);
    return bytes;
  }
  async publicationSnapshot(id: string, actor?: string) {
    const build = await this.requireArtifact(id, actor);
    const artifact = await this.artifacts.read(id);
    await this.requireArtifact(build.id, actor);
    return { build, artifact };
  }
  async requireArtifact(id: string, actor?: string) {
    const job = await this.detail(id, actor);
    if (job.phase !== "completed" || !job.artifactAvailable) throw new SiteBuildError("artifactUnavailable", 404);
    return job;
  }
  recover() {
    return this.using(async () => {
      await this.native?.recover();
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
