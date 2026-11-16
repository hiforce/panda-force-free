import type { SiteExecutor } from "../../builds/executor-port.js";
import type { MetadataStore } from "../../../shared/async-value.js";
import type { SiteSampleStore } from "../ports.js";
import type { SiteSampleServicePort } from "../site-sample-service.js";
import type { SiteThemeMetadataCatalog } from "../presentation-ports.js";
import type { BuildAuthorityPort } from "../../builds/authority.js";
import { SiteBuildPreview } from "../../builds/preview.js";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SiteThemeCatalog } from "../../../shared/presentation/themes.js";
import type { BuildThemeSnapshot } from "../../../shared/builds/theme.js";
import { HttpSiteExecutor } from "../../builds/adapters/http-executor.js";
import { SiteBuildArtifacts } from "../../builds/artifacts.js";
import { SiteBuildRetention } from "../../builds/retention.js";
import { BuildRunReconciler } from "../../builds/runtime/reconciler.js";
import { SqliteSiteSamples } from "../storage/site-samples.js";
import { SiteSampleService } from "../site-sample-service.js";
import type { TemplateLibraryStore } from "../ports.js";
import { siteSampleSources } from "./site-sample-sources.js";
import { siteFixturePreview } from "./site-fixture-preview.js";
import { siteSampleRunStore } from "./site-sample-runtime.js";
import { legacyBuildRunDispatcher } from "../../builds/runtime/legacy-dispatch.js";

interface SampleOptions {
  db?: Database | null;
  jobs?: MetadataStore<SiteSampleStore>;
  stateRoot: string;
  drafts: MetadataStore<TemplateLibraryStore>;
  themes: SiteThemeMetadataCatalog;
  captureTheme: (theme: ReturnType<SiteThemeCatalog["resolve"]>) => Promise<BuildThemeSnapshot>;
  authorize: BuildAuthorityPort;
  executor?: SiteExecutor | null;
  executorUrl?: string;
  tokenFile?: string;
}
interface SampleFeature<S> {
  service: S;
  artifacts: SiteBuildArtifacts;
  preview: (actor: string) => SiteBuildPreview;
  previewFixture: ReturnType<typeof siteFixturePreview>;
  stop(): void;
  close(): Promise<void>;
}
export function createSiteSampleFeature(
  options: SampleOptions & { jobs: MetadataStore<SiteSampleStore> },
): SampleFeature<SiteSampleServicePort>;
export function createSiteSampleFeature(
  options: SampleOptions & { jobs?: undefined; db: Database },
): SampleFeature<SiteSampleService>;
export function createSiteSampleFeature(options: SampleOptions): SampleFeature<SiteSampleServicePort>;
export function createSiteSampleFeature(options: SampleOptions) {
  if (!options.jobs && !options.db) throw new Error("siteSampleStorageRequired");
  const jobs = options.jobs ?? new SqliteSiteSamples(options.db!),
    artifacts = new SiteBuildArtifacts(join(options.stateRoot, "plugins", "site-samples"));
  const executor =
    options.executor !== undefined
      ? options.executor
      : options.executorUrl && options.tokenFile
        ? new HttpSiteExecutor(options.executorUrl, options.tokenFile)
        : null;
  const retention = new SiteBuildRetention(jobs, artifacts);
  const runtimeStore = siteSampleRunStore(jobs);
  const reconciler = executor
    ? new BuildRunReconciler(
        runtimeStore,
        artifacts,
        executor,
        (event) => console.info("[site-sample]", JSON.stringify(event)),
        retention,
        legacyBuildRunDispatcher(runtimeStore, executor, options.authorize),
        "site-sample",
      )
    : null;
  const service = new SiteSampleService(
    jobs,
    siteSampleSources({ ...options, executor }),
    () => reconciler?.wake(),
    (id) => artifacts.remove(id),
  );
  const prune = () => {
    void retention.prune().catch(() => console.warn("[site-sample] Artifact retention is temporarily unavailable"));
  };
  prune();
  const timer = setInterval(prune, 3600000);
  timer.unref();
  reconciler?.wake();
  function stop() {
    clearInterval(timer);
    retention.stop();
    reconciler?.stop();
  }
  return {
    service,
    artifacts,
    preview: (actor: string) =>
      new SiteBuildPreview({ requireArtifact: async (id) => service.requireArtifact(id, actor) }, artifacts),
    previewFixture: siteFixturePreview(jobs, artifacts),
    stop,
    async close() {
      stop();
      await service.close();
      await reconciler?.drain();
      await retention.drain();
    },
  };
}
