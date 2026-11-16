import type { MetadataStore } from "../../../shared/async-value.js";
import type { PortableRegistryStore } from "../portable/ports.js";
import type { TemplateDraftStore, TemplateImageStore } from "../authoring/ports.js";
import type { PortableTemplateInspectionPort } from "../portable/inspection.js";
import type { TemplateDraftAuthoringPort } from "../authoring/service.js";
import type { Route } from "../../http/router.js";
import { join } from "node:path";
import { openPortableTemplateDatabase } from "../storage/database.js";
import { SqlitePortableTemplates } from "../storage/registry.js";
import { FilePortableTemplates } from "../storage/content.js";
import { createPortableTemplateTypes, templateDocumentCodec } from "./types.js";
import { SqliteTemplateDrafts } from "../storage/drafts.js";
import { DocumentTemplateAuthoring } from "../authoring/document.js";
import { TemplateDraftAuthoring } from "../authoring/service.js";
import { templateDraftRoutes } from "./draft-routes.js";
import { PortableTemplateInstallation } from "../portable/installation.js";
import { PortableTemplateInspection } from "../portable/inspection.js";
import { portableTemplateRoutes } from "./portable-routes.js";
import type { RouteContext } from "../../http/router.js";
import { TemplateDraftImages } from "../authoring/images.js";
import { FileTemplateImages, SqliteTemplateImages } from "../storage/images.js";
import { templateImageDecoder, templateImageResources } from "./images.js";
import { templateImageRoutes } from "./image-routes.js";
import { TemplateSourceDiscovery } from "../sources/discovery.js";
import type { TemplateSourceReader, TemplateSourceConsumer } from "../sources/ports.js";
import { SourceTemplateImport } from "../sources/import.js";
import { sourceTemplateImportRoutes } from "./source-import-routes.js";
import { templateSourceDiscoveryRoutes } from "./source-discovery-routes.js";
import { DocumentTemplateApplication } from "../application/document.js";
import { standardSourceProbes, type TemplateSourceProbe } from "../sources/probes.js";
import type { TemplateSourceKind } from "../../../shared/templates/sources/contracts.js";
import { RasterCoverRenderer } from "../../media/raster-cover.js";

interface PortableOptions {
  stateRoot: string;
  owner(context: RouteContext): string;
  sourceReader?: TemplateSourceReader;
  sourceConsumer?: TemplateSourceConsumer;
  nativeThemeImport?: boolean;
  sourceAdapters?: readonly {
    probe: TemplateSourceProbe;
    importableKinds: readonly TemplateSourceKind[];
  }[];
  persistence?: {
    registry: MetadataStore<PortableRegistryStore>;
    drafts: MetadataStore<TemplateDraftStore>;
    images: MetadataStore<TemplateImageStore>;
  };
}
interface PortableFeature<I, D> {
  installation: PortableTemplateInstallation;
  inspection: I;
  drafts: D;
  images: TemplateDraftImages;
  documents: DocumentTemplateApplication;
  routes: Route[];
  close(): void;
}
export function createPortableTemplates(
  options: PortableOptions & { persistence: NonNullable<PortableOptions["persistence"]> },
): PortableFeature<PortableTemplateInspectionPort, TemplateDraftAuthoringPort>;
export function createPortableTemplates(
  options: PortableOptions & { persistence?: undefined },
): PortableFeature<PortableTemplateInspection, TemplateDraftAuthoring>;
export function createPortableTemplates(
  options: PortableOptions,
): PortableFeature<PortableTemplateInspectionPort, TemplateDraftAuthoringPort>;
export function createPortableTemplates(options: PortableOptions) {
  if (
    options.persistence !== undefined &&
    (!options.persistence ||
      !options.persistence.registry ||
      !options.persistence.drafts ||
      !options.persistence.images)
  )
    throw new Error("portableTemplateStorageRequired");
  const db = options.persistence
    ? null
    : openPortableTemplateDatabase(join(options.stateRoot, "templates", "registry.sqlite"));
  const store = options.persistence?.registry ?? new SqlitePortableTemplates(db!),
    content = new FilePortableTemplates(join(options.stateRoot, "templates", "resources")),
    types = createPortableTemplateTypes();
  const decoder = templateImageDecoder(),
    covers = new RasterCoverRenderer(),
    resources = templateImageResources(types, decoder, covers);
  const installation = new PortableTemplateInstallation(store, content, types, resources),
    inspection = new PortableTemplateInspection(store, content, types, resources);
  const draftStore = options.persistence?.drafts ?? new SqliteTemplateDrafts(db!),
    images = new TemplateDraftImages(
      draftStore,
      options.persistence?.images ?? new SqliteTemplateImages(db!),
      new FileTemplateImages(join(options.stateRoot, "templates", "images")),
      decoder,
    );
  const drafts = new TemplateDraftAuthoring(
    draftStore,
    content,
    store,
    installation,
    [new DocumentTemplateAuthoring(types, templateDocumentCodec)],
    images,
    resources,
  );
  return {
    installation,
    inspection,
    drafts,
    images,
    documents: new DocumentTemplateApplication(store, content, types, templateDocumentCodec, resources),
    routes: [
      ...(options.sourceReader && options.sourceConsumer
        ? sourceTemplateImportRoutes(
            new SourceTemplateImport(options.sourceReader, options.sourceConsumer, installation),
            options.owner,
          )
        : []),
      ...(options.sourceReader
        ? templateSourceDiscoveryRoutes(
            new TemplateSourceDiscovery(
              options.sourceReader,
              [...standardSourceProbes, ...(options.sourceAdapters ?? []).map((adapter) => adapter.probe)],
              [
                ...(options.sourceConsumer ? ["portable-library" as const] : []),
                ...(options.nativeThemeImport ? ["hexo-theme" as const, "docusaurus-theme" as const] : []),
                ...(options.sourceAdapters ?? []).flatMap((adapter) => adapter.importableKinds),
              ],
            ),
            options.owner,
          )
        : []),
      ...portableTemplateRoutes(installation, inspection, options.owner, covers),
      ...templateDraftRoutes(drafts, options.owner),
      ...templateImageRoutes(drafts, images, inspection, decoder, options.owner),
    ],
    close: () => db?.close(),
  };
}
