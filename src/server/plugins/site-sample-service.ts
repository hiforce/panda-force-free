import { mapMetadata, type MetadataStore, type MetadataValue } from "../../shared/async-value.js";
import type { SiteSampleBuild } from "../../shared/plugins/site-samples.js";
import { siteSampleRequest, siteSampleSource, type SiteSampleRequest } from "../../shared/plugins/site-samples.js";
import { terminalBuildRun } from "../../shared/builds/run.js";
import type { SiteSampleStore, SiteSampleSources } from "./ports.js";
import { PluginRegistryError } from "./errors.js";
/** Durable sample intent and caller ownership remain independent of document and publication operations. */
export class SiteSampleService<S extends MetadataStore<SiteSampleStore> = SiteSampleStore> {
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private using<T>(work: () => Promise<T>) {
    if (this.closed) return Promise.reject(new PluginRegistryError("sampleBusy"));
    const result = Promise.resolve().then(work);
    this.pending.add(result);
    return result.finally(() => this.pending.delete(result));
  }
  close() {
    this.closed = true;
    return Promise.allSettled([...this.pending]).then(() => {});
  }
  private captures = new Map<
    string,
    {
      signature: string;
      result: ReturnType<SiteSampleService["capture"]>;
    }
  >();
  constructor(
    private jobs: S,
    private sources: SiteSampleSources,
    private wake: () => void,
    private removeArtifact: (id: string) => Promise<void>,
  ) {}
  start(value: unknown, actor: string) {
    return this.using(() => this.startCommand(value, actor));
  }
  private async startCommand(value: unknown, actor: string) {
    this.requireActor(actor);
    const request = siteSampleRequest(value),
      existing = await this.jobs.existing(request, actor);
    if (existing) return existing;
    const signature = JSON.stringify({ request, actor }),
      active = this.captures.get(request.id);
    if (active) {
      if (active.signature !== signature) throw new PluginRegistryError("sampleConflict");
      return active.result;
    }
    if (this.captures.size >= 2) throw new PluginRegistryError("sampleBusy");
    const result = this.capture(request, actor);
    this.captures.set(request.id, { signature, result });
    try {
      return await result;
    } finally {
      this.captures.delete(request.id);
    }
  }
  private async capture(request: SiteSampleRequest, actor: string) {
    const snapshot = await this.sources.capture(request.source);
    await this.sources.assertAvailable(snapshot.input);
    await this.sources.authorize(snapshot.input);
    const job = await this.jobs.create(request, snapshot, actor);
    this.wake();
    return job;
  }
  lookup(value: unknown, actor: string) {
    return this.using(() => this.lookupCommand(value, actor));
  }
  private async lookupCommand(value: unknown, actor: string) {
    this.requireActor(actor);
    const snapshot = await this.sources.capture(siteSampleSource(value));
    return await this.jobs.latest(snapshot.key, actor);
  }
  private requireActor(actor: string) {
    if (typeof actor !== "string" || !actor.trim() || actor.length > 200 || /[\p{Cc}\p{Cf}]/u.test(actor))
      throw new PluginRegistryError("identityRequired");
  }
  detail(id: string, actor: string): MetadataValue<S, SiteSampleStore, SiteSampleBuild> {
    this.requireActor(actor);
    return mapMetadata(this.jobs.owner(id), (owner) => {
      if (owner !== actor) throw new PluginRegistryError("sampleNotFound");
      return this.jobs.get(id);
    }) as MetadataValue<S, SiteSampleStore, SiteSampleBuild>;
  }
  list(actor: string): MetadataValue<S, SiteSampleStore, SiteSampleBuild[]> {
    this.requireActor(actor);
    return this.jobs.list(actor) as MetadataValue<S, SiteSampleStore, SiteSampleBuild[]>;
  }
  logs(id: string, actor: string): MetadataValue<S, SiteSampleStore, string> {
    return mapMetadata(this.detail(id, actor), () => this.jobs.logs(id)) as MetadataValue<S, SiteSampleStore, string>;
  }
  cancel(id: string, actor: string): MetadataValue<S, SiteSampleStore, SiteSampleBuild> {
    return mapMetadata(this.detail(id, actor), (job) => {
      if (terminalBuildRun(job)) return job;
      return mapMetadata(this.jobs.update(id, { phase: "cancelling" }), (next) => {
        this.wake();
        return next;
      });
    }) as MetadataValue<S, SiteSampleStore, SiteSampleBuild>;
  }
  requireArtifact(id: string, actor: string): MetadataValue<S, SiteSampleStore, SiteSampleBuild> {
    return mapMetadata(this.detail(id, actor), (job) => {
      if (job.phase !== "completed" || !job.artifactAvailable)
        throw new PluginRegistryError("sampleArtifactUnavailable");
      return job;
    }) as MetadataValue<S, SiteSampleStore, SiteSampleBuild>;
  }
  remove(id: string, actor: string) {
    return this.using(() => this.removeCommand(id, actor));
  }
  private async removeCommand(id: string, actor: string) {
    const job = await this.detail(id, actor);
    if (!terminalBuildRun(job)) throw new PluginRegistryError("sampleConflict");
    await this.jobs.remove(id);
    await this.removeArtifact(id);
  }
}
export type SiteSampleServicePort = SiteSampleService<MetadataStore<SiteSampleStore>>;
