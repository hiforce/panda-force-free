import type { SiteExecutor } from "../../builds/executor-port.js";
import type { Route } from "../../http/router.js";
import type { MetadataStore } from "../../../shared/async-value.js";
import type { PluginRegistryStore, SiteSampleStore } from "../ports.js";
import type { PluginRegistryServicePort } from "../service.js";
import type { TemplateLibraryMetadata, TemplateLibraryServicePort } from "../library-service.js";
import type { SiteSampleService, SiteSampleServicePort } from "../site-sample-service.js";
import type { InstalledPresentation, SynchronousInstalledPresentation } from "./presentation.js";
import type { SiteBuildPreview } from "../../builds/preview.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import { openPluginDatabase } from "../storage/database.js";
import { SqlitePluginRegistry } from "../storage/repository.js";
import { FilePluginBundles } from "../storage/bundles.js";
import { PluginRegistryService } from "../service.js";
import { installedPresentation } from "./presentation.js";
import { pluginRoutes } from "./routes.js";
import { SqliteTemplateLibrary } from "../storage/library.js";
import { TemplateLibraryService } from "../library-service.js";
import { templateFixtureRunner } from "./library-fixtures.js";
import { templateLibraryRoutes } from "./library-routes.js";
import { publishingStyleRoutes } from "./style-routes.js";
import { createSiteSampleFeature } from "./site-sample-feature.js";
import { siteSampleRoutes } from "./site-sample-routes.js";

interface PluginOptions {
  stateRoot: string;
  owner(context: RouteContext): string;
  executor?: SiteExecutor | null;
  executorUrl?: string;
  tokenFile?: string;
  persistence?: {
    registry: MetadataStore<PluginRegistryStore>;
    library: TemplateLibraryMetadata;
    samples: MetadataStore<SiteSampleStore>;
  };
}
type PluginFeature<S, L, J, P> = P & {
  service: S;
  library: L;
  samples: J;
  samplePreview: (actor: string) => SiteBuildPreview;
  routes: Route[];
  stop(): void;
  close(): Promise<void>;
};
export function createPluginFeature(
  options: PluginOptions & { persistence: NonNullable<PluginOptions["persistence"]> },
): PluginFeature<PluginRegistryServicePort, TemplateLibraryServicePort, SiteSampleServicePort, InstalledPresentation>;
export function createPluginFeature(
  options: PluginOptions & { persistence?: undefined },
): PluginFeature<PluginRegistryService, TemplateLibraryService, SiteSampleService, SynchronousInstalledPresentation>;
export function createPluginFeature(
  options: PluginOptions,
): PluginFeature<PluginRegistryServicePort, TemplateLibraryServicePort, SiteSampleServicePort, InstalledPresentation>;
export function createPluginFeature(options: PluginOptions) {
  if (
    options.persistence !== undefined &&
    (!options.persistence ||
      !options.persistence.registry ||
      !options.persistence.library ||
      !options.persistence.samples)
  )
    throw new Error("pluginStorageRequired");
  const db = options.persistence ? null : openPluginDatabase(join(options.stateRoot, "data", "plugins.sqlite"));
  const service = new PluginRegistryService(
    options.persistence?.registry ?? new SqlitePluginRegistry(db!),
    new FilePluginBundles(join(options.stateRoot, "plugins", "bundles")),
  );
  const presentation = installedPresentation(service);
  const drafts = options.persistence?.library ?? new SqliteTemplateLibrary(db!);
  const sampleOptions = {
    ...options,
    db,
    jobs: options.persistence?.samples,
    drafts,
    themes: presentation.themes,
    captureTheme: presentation.captureTheme,
    authorize: presentation.authorizeBuild,
  };
  const samples = options.persistence
    ? createSiteSampleFeature({ ...sampleOptions, jobs: options.persistence.samples })
    : createSiteSampleFeature({ ...sampleOptions, jobs: undefined, db: db! });
  const library = new TemplateLibraryService(drafts, templateFixtureRunner(samples.previewFixture), service);
  return {
    service,
    library,
    samples: samples.service,
    samplePreview: samples.preview,
    ...presentation,
    routes: [
      ...pluginRoutes(service, options.owner),
      ...templateLibraryRoutes(library, options.owner),
      ...publishingStyleRoutes(presentation.templates, options.owner),
      ...siteSampleRoutes(samples.service, samples.artifacts, options.owner),
    ],
    stop: () => samples.stop(),
    close: async () => {
      await samples.close();
      db?.close();
    },
  };
}
