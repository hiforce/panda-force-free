import type { MetadataStore } from "../../../shared/async-value.js";
import { builtinSiteThemes, type SiteThemeCatalog } from "../../../shared/presentation/themes.js";
import { FileOriginalQueries } from "../../content-sources/reader.js";
import { FileCreativeAssets } from "../../creative/assets/service.js";
import type { RouteContext } from "../../http/router.js";
import { projectDocumentAssetRoutes } from "../asset-routes.js";
import { projectDocumentEditorRoutes } from "../editor-routes.js";
import { projectDocumentTreeRoutes } from "../navigation/routes.js";
import { projectDocumentPlacementRoutes } from "../placement-routes.js";
import { projectSourceProfileRoutes } from "../source-profile/routes.js";
import { DocumentSourceReader } from "../source-reader.js";
import { projectDocumentSpaceRoutes } from "../space-routes.js";
import { FileDocumentAssets } from "./assets.js";
import { FileDocumentCreationContent } from "./creation-content.js";
import { FileDocumentEditor } from "./editor.js";
import { FileDocumentNavigation } from "./navigation/service.js";
import { FileDocumentPlacements } from "./placements/service.js";
import { DocumentFileProjects } from "./projects.js";
import { FileDocumentQueries } from "./queries.js";
import { FileDocumentSnapshots } from "./snapshots.js";
import { FileDocumentChanges } from "./source-edits.js";
import { FileDocumentSourceProfiles } from "./spaces/profiles.js";
import { FileDocumentSpaces } from "./spaces/service.js";

/** Activation belongs to the application cutover, after all publishing consumers use the same file-backed source. */
export function createFileDocumentApplication(options: {
  root: string;
  assetRoot: string;
  allowedRoots?: string[];
  themes?: MetadataStore<SiteThemeCatalog>;
  requireProject: (projectId: string) => unknown | Promise<unknown>;
  principal: (context: RouteContext) => string;
  changed?: (projectId: string) => void;
  authorizeUnderLease?: (projectId: string) => void | Promise<void>;
}) {
  const projects = new DocumentFileProjects(
      options.root,
      options.requireProject,
      options.changed,
      options.authorizeUnderLease,
    ),
    queries = new FileDocumentQueries(projects),
    editor = new FileDocumentEditor(projects),
    changes = new FileDocumentChanges(projects),
    navigation = new FileDocumentNavigation(projects, new FileDocumentCreationContent(options.assetRoot)),
    placements = new FileDocumentPlacements(projects),
    snapshots = new FileDocumentSnapshots(projects),
    assets = new FileDocumentAssets(projects, options.assetRoot),
    sourceReader = new DocumentSourceReader([...(options.allowedRoots ?? [])]),
    profiles = new FileDocumentSourceProfiles(projects, sourceReader),
    spaces = new FileDocumentSpaces(projects, sourceReader, options.themes ?? builtinSiteThemes);
  return {
    projectContent: projects,
    queries,
    originals: new FileOriginalQueries(projects, options.assetRoot),
    editor,
    changes,
    navigation,
    assets,
    creations: new FileCreativeAssets(projects, options.assetRoot),
    spaces,
    placements,
    snapshots,
    profiles,
    routes: [
      ...projectDocumentEditorRoutes(queries, editor, options.principal),
      ...projectDocumentTreeRoutes(navigation, options.principal),
      ...projectDocumentAssetRoutes(assets, options.principal),
      ...projectDocumentSpaceRoutes(spaces, options.principal),
      ...projectDocumentPlacementRoutes(placements, options.principal),
      ...projectSourceProfileRoutes(profiles),
    ],
  };
}
