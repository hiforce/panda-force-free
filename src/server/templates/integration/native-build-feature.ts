import type { SiteExecutor } from "../../builds/executor-port.js";
import type { NativeSampleServicePort } from "../../builds/native/service.js";
import type { Route } from "../../http/router.js";
import type { MetadataStore } from "../../../shared/async-value.js";
import type { NativeSampleStore } from "../../builds/native/ports.js";
import type { NativeThemeServicePort } from "../native/service.js";
import { SiteBuildPreview } from "../../builds/preview.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { SourceRuntime } from "../../packages/ingestion/runtime.js";
import { openNativeSampleDatabase } from "../../builds/native/database.js";
import { SqliteNativeSamples } from "../../builds/native/repository.js";
import { FileResourceBuildInputs } from "../../builds/resource-inputs.js";
import { NativeSampleService } from "../../builds/native/service.js";
import { nativeSampleDispatcher } from "../../builds/native/dispatch.js";
import { HttpSiteExecutor } from "../../builds/adapters/http-executor.js";
import { SiteBuildArtifacts } from "../../builds/artifacts.js";
import { SiteBuildRetention } from "../../builds/retention.js";
import { BuildRunReconciler } from "../../builds/runtime/reconciler.js";
import { staticSiteSampleRoutes } from "../../builds/integration/sample-routes.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { nativeBuildThemes } from "./native-build-themes.js";
import { templateManagementProtection } from "./protect.js";

interface NativeSampleOptions {
  stateRoot: string;
  themes: NativeThemeServicePort;
  jobs?: MetadataStore<NativeSampleStore>;
  runtimePool: SourceRuntime;
  owner(context: RouteContext): string;
  executor?: SiteExecutor | null;
  executorUrl?: string;
  tokenFile?: string;
}
interface NativeSampleFeature<S> {
  service: S;
  preview(actor: string): SiteBuildPreview;
  routes: Route[];
  start(): void;
  close(): Promise<void>;
}
export function createNativeSampleFeature(
  options: NativeSampleOptions & { jobs: MetadataStore<NativeSampleStore> },
): NativeSampleFeature<NativeSampleServicePort>;
export function createNativeSampleFeature(
  options: NativeSampleOptions & { jobs?: undefined },
): NativeSampleFeature<NativeSampleService>;
export function createNativeSampleFeature(options: NativeSampleOptions): NativeSampleFeature<NativeSampleServicePort>;
export function createNativeSampleFeature(options: NativeSampleOptions) {
  if (options.jobs !== undefined && !options.jobs) throw new Error("nativeSampleStorageRequired");
  const root = join(options.stateRoot, "templates", "native", "samples"),
    db = options.jobs ? null : openNativeSampleDatabase(join(root, "runs.sqlite"));
  try {
    const jobs = options.jobs ?? new SqliteNativeSamples(db!),
      files = new FileResourceBuildInputs(join(root, "inputs"), options.runtimePool),
      themes = nativeBuildThemes(options.themes),
      artifacts = new SiteBuildArtifacts(join(root, "artifacts")),
      retention = new SiteBuildRetention(jobs, artifacts),
      executor =
        options.executor !== undefined
          ? options.executor
          : options.executorUrl && options.tokenFile
            ? new HttpSiteExecutor(options.executorUrl, options.tokenFile)
            : null,
      monitor = executor
        ? new BuildRunReconciler(
            jobs,
            artifacts,
            executor,
            (event) => console.info("[native-site-sample]", JSON.stringify(event)),
            retention,
            nativeSampleDispatcher(jobs, files, themes, executor),
            "native-site-sample",
          )
        : null,
      service = new NativeSampleService(
        jobs,
        files,
        themes,
        executor,
        () => monitor?.wake(),
        (id) => artifacts.remove(id),
      );
    let timer: ReturnType<typeof setInterval> | undefined,
      maintenance: Promise<void> | undefined,
      closing: Promise<void> | undefined;
    function maintain() {
      if (closing || maintenance) return;
      maintenance = service
        .recover()
        .then(() => retention.prune())
        .catch((error) => reportDiagnostic("native-sample-maintenance", error))
        .finally(() => {
          maintenance = undefined;
        });
    }
    return {
      service,
      preview: (actor: string) =>
        new SiteBuildPreview({ requireArtifact: async (id) => service.requireArtifact(actor, id) }, artifacts),
      routes: staticSiteSampleRoutes(
        "/api/templates/native/samples",
        service,
        artifacts,
        templateManagementProtection(options.owner),
      ),
      start() {
        if (!timer && !closing) {
          maintain();
          monitor?.wake();
          timer = setInterval(maintain, 10000);
          timer.unref();
        }
      },
      close() {
        return (closing ??= (async () => {
          clearInterval(timer);
          monitor?.stop();
          retention.stop();
          await service.close();
          await monitor?.drain();
          await maintenance;
          await retention.drain();
          db?.close();
        })());
      },
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
