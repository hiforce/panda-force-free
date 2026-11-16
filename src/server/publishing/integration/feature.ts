import type { MetadataStore } from "../../../shared/async-value.js";
import type { ChannelTemplateCatalog } from "../../../shared/presentation/templates.js";
import type { VariantStore } from "../ports.js";
import type { Database } from "bun:sqlite";
import type { PublicationSources, PublicationAssets } from "../content/source-port.js";
import { VariantRepository } from "../variant-repository.js";
import { VariantService } from "../variant-service.js";
import { VariantExporter } from "../export-service.js";
import { builtinFormats } from "../adapters/builtin-formats.js";
import { publishingRoutes } from "./routes.js";
import type { VariantContents } from "../variant-content.js";

/** Composition binds trusted adapters; transport and future tool entry points share these services. */
export function createPublishingFeature<
  R extends VariantStore = VariantRepository,
  C extends MetadataStore<ChannelTemplateCatalog> = ChannelTemplateCatalog,
>(
  db: Database | null,
  sources: PublicationSources,
  assets: PublicationAssets,
  templates?: C,
  contents?: VariantContents,
  store?: R,
) {
  if (!store && !db) throw new Error("publicationStorageRequired");
  const formats = builtinFormats();
  const variants = new VariantService<R, C>(
    (store ?? new VariantRepository(db!)) as R,
    sources,
    formats,
    templates,
    contents,
  );
  const exporter = new VariantExporter(variants, assets, formats);
  return { variants, exporter, routes: publishingRoutes(variants, exporter) };
}
