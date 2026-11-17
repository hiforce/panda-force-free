import { createMySQLDocumentFeature } from "../documents/mysql-feature.js";
import { createContentAccess } from "../content-access/integration/feature.js";
import { scopedFileDocuments } from "../content-access/integration/files.js";
import { mkdir } from "node:fs/promises";
import { createDocumentFeature } from "../documents/feature.js";
import { createFileDocumentApplication } from "../documents/files/application.js";
import { documentTemplateCreationRoutes } from "../templates/integration/document-creation-routes.js";
import { documentProjectGuards } from "../documents/integration/project-guards.js";
import { ProjectWorkspaceService } from "../projects/workspaces/service.js";
import type { ApplicationConfig, ApplicationOwnerResolver } from "./types.js";
import type { ApplicationProjects } from "./projects.js";
import type { createApplicationExtensions } from "./extensions.js";
import { authorizedLegacyDocumentRoutes } from "../documents/integration/authorized-legacy-routes.js";
/** Compose project authorization and both document representations without starting content workers. */
export async function createApplicationDocuments(
  config: ApplicationConfig,
  projects: ApplicationProjects,
  plugins: Awaited<ReturnType<typeof createApplicationExtensions>>,
  resolveOwner: ApplicationOwnerResolver,
  sharedEngine: boolean,
  localAdministrator: () => string | null,
  changed: (project: string, owner?: string) => void,
) {
  const { pluginFeature, portableTemplateFeature } = plugins;
  const {
    requireProject: requireDocumentProject,
    requireFileProject: requireFileDocumentProject,
    requireLegacyProject: requireLegacyDocumentProject,
  } = documentProjectGuards(
    (id) => projects.catalog.project(id),
    (id) => projects.storage.files(id),
  );
  const backend =
    projects.driver === "mysql"
      ? {
          driver: "mysql" as const,
          feature: createMySQLDocumentFeature({
            sql: projects.sql,
            storage: projects.stores.documents,
            themes: pluginFeature.themes,
            stateRoot: config.stateRoot,
            allowedRoots: config.fileRoots,
            requireProject: requireLegacyDocumentProject,
          }),
        }
      : {
          driver: "sqlite" as const,
          feature: createDocumentFeature({
            themes: plugins.pluginSelection.driver === "sqlite" ? plugins.pluginSelection.feature.themes : undefined,
            stateRoot: config.stateRoot,
            allowedRoots: config.fileRoots,
            requireProject: requireLegacyDocumentProject,
          }),
        };
  const documentFeature = backend.feature;
  await mkdir(config.documentContentRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.documentAssetRoot, { recursive: true, mode: 0o700 });

  const fileDocuments = createFileDocumentApplication({
    root: config.documentContentRoot,
    assetRoot: config.documentAssetRoot,
    allowedRoots: config.fileRoots,
    themes: pluginFeature.themes,
    principal: (context) => "local:" + resolveOwner(context),
    requireProject: requireDocumentProject,
    changed: (project) => changed(project),
  });

  const contentAccess = createContentAccess({
    db: projects.driver === "sqlite" ? projects.catalog.db : undefined,
    store: projects.driver === "mysql" ? projects.stores.access : undefined,
    stateRoot: config.stateRoot,
    projects: async () => (await projects.catalog.snapshot()).projects,
    requireProject: requireDocumentProject,
    documents: fileDocuments.projectContent,
    requireLegacyProject: requireLegacyDocumentProject,
    localAdministrator,
    ownerAllowed: () => true,
    owner: resolveOwner,
    report: () => console.warn("[content-access] Content authorization is unavailable"),
  });
  const projectWorkspaces =
    projects.driver === "mysql"
      ? new ProjectWorkspaceService(
          projects.catalog,
          config.projectWorkspaceRoot,
          sharedEngine === false || config.projectWorkspaceRootConfigured,
          async (project, creator) => {
            await projects.catalog.bindFiles(project.id);
            if (creator) await contentAccess.reserveCreatorAsync(creator, project.id);
          },
        )
      : new ProjectWorkspaceService(
          projects.catalog,
          config.projectWorkspaceRoot,
          sharedEngine === false || config.projectWorkspaceRootConfigured,
          (project, creator) => {
            projects.storage.bindFiles(project.id);
            if (creator) contentAccess.reserveCreator(creator, project.id);
          },
        );
  if (!config.allowExternalDirectories) await projectWorkspaces.initialize();
  const scopedDocuments = scopedFileDocuments(
    {
      root: config.documentContentRoot,
      assetRoot: config.documentAssetRoot,
      allowedRoots: config.fileRoots,
      themes: pluginFeature.themes,
      changed: (project) => changed(project),
    },
    contentAccess.require,
  );
  const authorizedLegacyRoutes = authorizedLegacyDocumentRoutes(
    documentFeature.routes,
    documentFeature,
    (context, project) =>
      contentAccess.requireLegacy(resolveOwner(context), project, context.req.method === "GET" ? "read" : "contribute"),
  );
  fileDocuments.routes.push(
    ...documentTemplateCreationRoutes(
      portableTemplateFeature.documents,
      fileDocuments.navigation,
      (context) => "local:" + resolveOwner(context),
    ),
  );

  return {
    backend,
    documentFeature,
    authorizedLegacyRoutes,
    fileDocuments,
    contentAccess,
    projectWorkspaces,
    scopedDocuments,
    requireDocumentProject,
    requireFileDocumentProject,
    requireLegacyDocumentProject,
  };
}
export type ApplicationDocuments = Awaited<ReturnType<typeof createApplicationDocuments>>;
