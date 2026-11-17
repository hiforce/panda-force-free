import type { MetadataStore } from "../../shared/async-value.js";
import type { SQL } from "bun";
import { join } from "node:path";
import { builtinSiteThemes, type SiteThemeCatalog } from "../../shared/presentation/themes.js";
import { createMySQLDocumentStorage } from "./mysql-storage.js";
import { DocumentSourceReader } from "./source-reader.js";
import { DocumentImageIngestion } from "./ingestion/images.js";
import { MySQLDocumentIngestion } from "./ingestion/mysql-service.js";
import { MySQLDocumentService } from "./mysql-service.js";
import { MySQLDocumentAssets } from "./mysql-assets.js";
import { MySQLDocumentLanguages } from "./mysql-languages.js";
import { MySQLDocumentSourceProfiles } from "./source-profile/mysql-service.js";
import { MySQLProjectDocumentLibrary } from "./mysql-library-service.js";
import { MySQLDocumentPlacements } from "./placements/mysql-service.js";
import { MySQLProjectDocumentNavigation } from "./navigation/mysql-service.js";
import { MySQLDocumentSpaceSnapshots } from "./mysql-space-snapshot.js";
import { mysqlDocumentRoutes } from "./mysql-routes.js";
import { mysqlProjectLibraryRoutes } from "./mysql-library-routes.js";
import { mysqlDocumentPlacementRoutes } from "./placements/mysql-routes.js";
import { projectDocumentTreeRoutes } from "./navigation/routes.js";
import { sourceImagePolicy } from "./source-profile/image-policy.js";
import { assertOwnershipVisible } from "./ownership/record.js";
import { mysqlOwnershipBatch } from "./ownership/sql-batch.js";
import { createSQLDocumentOwnershipTransfers } from "./ownership/sql-application.js";
/** Explicit native MySQL composition. The caller upgrades/imports the module before injection and owns the pool. */
export function createMySQLDocumentFeature(options: {
  sql: SQL;
  storage?: ReturnType<typeof createMySQLDocumentStorage>;
  themes?: MetadataStore<SiteThemeCatalog>;
  stateRoot: string;
  allowedRoots: string[];
  requireProject(id: string): unknown;
}) {
  const storage = options.storage ?? createMySQLDocumentStorage(options.sql),
    { session, spaces, documents } = storage,
    sources = new DocumentSourceReader(options.allowedRoots);
  const detail = async (id: string) => {
    const value = await documents.get(id),
      space = await spaces.get(value.document.spaceId);
    await options.requireProject(space.projectId);
    assertOwnershipVisible(await storage.ownership.get(space.id, id));
    return { ...value, engine: space.engine, sourceMode: space.sourceMode };
  };
  const assets = new MySQLDocumentAssets(storage.assets, join(options.stateRoot, "data", "document-assets"), detail),
    profiles = new MySQLDocumentSourceProfiles(spaces, sources, storage.profiles, options.requireProject);
  const ingestion = new MySQLDocumentIngestion(
    sources,
    spaces,
    new DocumentImageIngestion(assets),
    storage.ingestion,
    options.requireProject,
    detail,
    async (space, locale, content) => sourceImagePolicy(await profiles.get(space), locale, content),
  );
  const service = new MySQLDocumentService(
      spaces,
      documents,
      sources,
      join(options.stateRoot, "data", "spaces"),
      options.requireProject,
      ingestion,
      options.themes ?? builtinSiteThemes,
    ),
    languages = new MySQLDocumentLanguages(session, (id) => service.detail(id)),
    library = new MySQLProjectDocumentLibrary(
      storage.library,
      service,
      join(options.stateRoot, "data", "spaces"),
      storage.folders,
    );
  const placements = new MySQLDocumentPlacements(storage.placements, service, async (id) => {
      const profile = await profiles.get(id);
      return profile ? { locales: Object.keys(profile.editions), metadataFields: profile.metadataFields } : {};
    }),
    navigation = new MySQLProjectDocumentNavigation(storage.navigation, library, service);
  return {
    transfers: createSQLDocumentOwnershipTransfers({
      batch: mysqlOwnershipBatch(session),
      library,
      navigation,
      assetRoot: join(options.stateRoot, "data", "document-assets"),
      authorize: options.requireProject,
    }),
    ownership: storage.ownership,
    persistence: session,
    storage,
    ingestion,
    profiles,
    service,
    assets,
    languages,
    library,
    placements,
    navigation,
    snapshots: new MySQLDocumentSpaceSnapshots(session, service, placements),
    routes: [
      ...mysqlDocumentRoutes(service, assets, languages, profiles),
      ...mysqlProjectLibraryRoutes(library),
      ...projectDocumentTreeRoutes(navigation),
      ...mysqlDocumentPlacementRoutes(placements),
    ],
    close() {},
  };
}
