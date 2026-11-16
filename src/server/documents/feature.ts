import { builtinSiteThemes, type SiteThemeCatalog } from "../../shared/presentation/themes.js";
import { DocumentImageIngestion } from "./ingestion/images.js";
import { DocumentIngestionRepository } from "./ingestion/repository.js";
import { DocumentIngestion } from "./ingestion/service.js";
import { join } from "node:path";
import { openDocumentDatabase } from "./database.js";
import { SpaceRepository } from "./space-repository.js";
import { DocumentRepository } from "./document-repository.js";
import { DocumentSourceReader } from "./source-reader.js";
import { DocumentService } from "./service.js";
import { DocumentAssetRepository } from "./asset-repository.js";
import { DocumentAssets } from "./assets.js";
import { DocumentLanguages } from "./languages.js";
import { documentRoutes } from "./routes.js";
import { SourceProfileRepository } from "./source-profile/repository.js";
import { DocumentSourceProfiles } from "./source-profile/service.js";
import { sourceImagePolicy } from "./source-profile/image-policy.js";
import { ProjectLibraryRepository } from "./library-repository.js";
import { ProjectDocumentLibrary } from "./library-service.js";
import { DocumentFolderRepository } from "./folder-repository.js";
import { DocumentPlacementRepository } from "./placements/repository.js";
import { DocumentPlacements } from "./placements/service.js";
import { documentPlacementRoutes } from "./placements/routes.js";
import { DocumentSpaceSnapshots } from "./space-snapshot.js";
import { projectLibraryRoutes } from "./library-routes.js";
import { DocumentNavigationRepository } from "./navigation/repository.js";
import { ProjectDocumentNavigation } from "./navigation/service.js";
import { projectDocumentTreeRoutes } from "./navigation/routes.js";
import { asyncLegacyNavigation } from "./navigation/async-legacy.js";

/** The feature composition owns persistence and adapter lifetime, never the shared engine. */
export function createDocumentFeature(options: {
  themes?: SiteThemeCatalog;
  stateRoot: string;
  allowedRoots: string[];
  requireProject: (id: string) => unknown;
}) {
  const db = openDocumentDatabase(join(options.stateRoot, "data", "documents.sqlite"));
  try {
    const spaces = new SpaceRepository(db),
      documents = new DocumentRepository(db),
      sources = new DocumentSourceReader(options.allowedRoots),
      assetRepository = new DocumentAssetRepository(db);
    const detail = (id: string) => {
      const value = documents.get(id),
        space = spaces.get(value.document.spaceId);
      options.requireProject(space.projectId);
      return { ...value, engine: space.engine, sourceMode: space.sourceMode };
    };
    const assets = new DocumentAssets(assetRepository, join(options.stateRoot, "data", "document-assets"), detail);
    const profiles = new DocumentSourceProfiles(
      spaces,
      sources,
      new SourceProfileRepository(db, spaces),
      options.requireProject,
    );
    const ingestion = new DocumentIngestion(
      sources,
      spaces,
      new DocumentImageIngestion(assets),
      new DocumentIngestionRepository(db, documents, assetRepository),
      options.requireProject,
      detail,
      (space, locale, content) => sourceImagePolicy(profiles.get(space), locale, content),
    );
    const service = new DocumentService(
      spaces,
      documents,
      sources,
      join(options.stateRoot, "data", "spaces"),
      options.requireProject,
      ingestion,
      options.themes || builtinSiteThemes,
    );
    const languages = new DocumentLanguages(db, (id) => service.detail(id));
    const library = new ProjectDocumentLibrary(
      new ProjectLibraryRepository(db, spaces),
      service,
      join(options.stateRoot, "data", "spaces"),
      new DocumentFolderRepository(db),
    );
    const placements = new DocumentPlacements(new DocumentPlacementRepository(db), service, (id) => {
      const profile = profiles.get(id);
      return profile ? { locales: Object.keys(profile.editions), metadataFields: profile.metadataFields } : {};
    });
    const navigation = new ProjectDocumentNavigation(new DocumentNavigationRepository(db), library, service);
    return {
      persistence: db,
      ingestion,
      profiles,
      service,
      assets,
      languages,
      library,
      placements,
      navigation,
      snapshots: new DocumentSpaceSnapshots(db, service, placements),
      routes: [
        ...documentRoutes(service, assets, languages, profiles),
        ...projectLibraryRoutes(library),
        ...projectDocumentTreeRoutes(asyncLegacyNavigation(navigation)),
        ...documentPlacementRoutes(placements),
      ],
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
