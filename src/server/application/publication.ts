import { mysqlPublicationSources } from "../delivery/integration/mysql-sources.js";
import { mysqlSocialSources } from "../delivery/integration/mysql-social-sources.js";
import { routeMySQLSocialSources } from "../delivery/integration/mysql-social-source-routing.js";
import { createMySQLEditorialFeature } from "../editorial/integration/mysql-feature.js";
import { mysqlDocumentEditorialSources } from "../editorial/integration/mysql-document-source.js";
import { fileDocumentAsyncEditorialSources } from "../editorial/integration/async-file-document-source.js";
import { routeAsyncEditorialSources } from "../editorial/integration/async-source-routing.js";
import { createMySQLSitePublicationFeature } from "../delivery/integration/mysql-feature.js";
import { mysqlFileSocialSources } from "../delivery/integration/mysql-file-social-sources.js";
import { fileSocialSources } from "../delivery/integration/file-social-sources.js";
import { routeSocialSources } from "../delivery/integration/social-source-routing.js";
import { PublicationVariantFiles } from "../publishing/variant-files.js";
import { routePublicationSources } from "../publishing/integration/source-routing.js";
import { filePublicationSources } from "../publishing/integration/file-document-source.js";
import { join } from "node:path";
import { nativeBuildThemes } from "../templates/integration/native-build-themes.js";
import { createPublishingFeature } from "../publishing/integration/feature.js";
import { createSiteBuildFeature } from "../builds/integration/feature.js";
import { documentBuildSources } from "../builds/integration/document-sources.js";
import { projectDocumentBuildSources } from "../builds/integration/project-document-sources.js";
import { routeProjectBuildSources } from "../builds/integration/source-routing.js";
import { createSitePublicationFeature } from "../delivery/integration/feature.js";
import { socialSources } from "../delivery/integration/social-sources.js";
import { publicationSources } from "../delivery/integration/sources.js";
import { documentPublicationSources } from "../publishing/integration/document-source.js";
import { createEditorialFeature } from "../editorial/integration/feature.js";
import { documentEditorialSources } from "../editorial/integration/document-source.js";
import { fileDocumentEditorialSources } from "../editorial/integration/file-document-source.js";
import { routeEditorialSources } from "../editorial/integration/source-routing.js";
import { editorialModelSettings } from "../editorial/integration/model-config.js";
import type { ApplicationConfig, ApplicationStores, ApplicationOwnerResolver } from "./types.js";
import type { ApplicationProjects } from "./projects.js";
import type { ApplicationDocuments } from "./documents.js";
import type { createApplicationExtensions } from "./extensions.js";
function nativeSql(projects: ApplicationProjects) {
  if (projects.driver !== "mysql") throw new Error("Document persistence selection is inconsistent");
  return projects.sql;
}
/** Keep synchronous SQLite and asynchronous MySQL editorial/variant transactions explicit. */
export async function createApplicationPublication(
  config: ApplicationConfig,
  projects: ApplicationProjects,
  documents: ApplicationDocuments,
  plugins: Awaited<ReturnType<typeof createApplicationExtensions>>,
  resolveOwner: ApplicationOwnerResolver,
) {
  const { backend, documentFeature, fileDocuments, requireDocumentProject, requireFileDocumentProject } = documents;
  const { pluginFeature, nativeThemeFeature, packageSourceFeature } = plugins;
  const runtimeStores: ApplicationStores | null = projects.driver === "mysql" ? projects.stores : null;
  const publicationDocuments = routePublicationSources(
    documentPublicationSources(documentFeature.service, documentFeature.assets),
    filePublicationSources({
      queries: fileDocuments.queries,
      assets: fileDocuments.assets,
      requireProject: requireFileDocumentProject,
    }),
  );
  const editorialFeature =
    backend.driver === "mysql"
      ? createMySQLEditorialFeature(
          nativeSql(projects),
          (session) =>
            routeAsyncEditorialSources(
              mysqlDocumentEditorialSources(backend.feature.service, backend.feature.storage.session, session),
              fileDocumentAsyncEditorialSources({
                queries: fileDocuments.queries,
                changes: fileDocuments.changes,
                requireProject: requireFileDocumentProject,
              }),
            ),
          editorialModelSettings(config.stateRoot),
        )
      : createEditorialFeature(
          backend.feature.persistence,
          routeEditorialSources(
            documentEditorialSources(backend.feature.service, backend.feature.persistence),
            fileDocumentEditorialSources({
              queries: fileDocuments.queries,
              changes: fileDocuments.changes,
              requireProject: requireFileDocumentProject,
            }),
          ),
          editorialModelSettings(config.stateRoot),
        );
  const siteBuildFeature = createSiteBuildFeature({
    db: backend.driver === "sqlite" ? backend.feature.persistence : null,
    jobs: runtimeStores?.extensions.siteBuilds.jobs,
    transaction: runtimeStores?.extensions.siteBuilds.transaction,
    nativeThemes: nativeBuildThemes(nativeThemeFeature.service),
    inputBudget: packageSourceFeature.ingestion.runtime,
    owner: resolveOwner,
    sources: routeProjectBuildSources(
      documentBuildSources({
        service: documentFeature.service,
        assets: documentFeature.assets,
        snapshots: documentFeature.snapshots,
        captureTheme: pluginFeature.captureTheme,
        profiles: documentFeature.profiles,
      }),
      projectDocumentBuildSources({
        spaces: fileDocuments.spaces,
        snapshots: fileDocuments.snapshots,
        profiles: fileDocuments.profiles,
        assets: fileDocuments.assets,
        themes: pluginFeature.themes,
        captureTheme: pluginFeature.captureTheme,
      }),
    ),
    authorizeInput: pluginFeature.authorizeBuild,
    stateRoot: config.stateRoot,
    executorUrl: config.buildExecutorUrl,
    tokenFile: config.buildExecutorTokenFile,
  });

  if (backend.driver === "mysql") {
    if (!runtimeStores) throw new Error("Document persistence selection is inconsistent");
    const publishingFeature = createPublishingFeature(
      null,
      publicationDocuments.sources,
      publicationDocuments.assets,
      pluginFeature.templates,
      new PublicationVariantFiles(join(config.stateRoot, "publication-variants")),
      runtimeStores.extensions.publishing,
    );
    const nativeSourceRoots = async () => [
      config.documentContentRoot,
      config.documentAssetRoot,
      ...(
        await runtimeStores.documents.session.all<{ sourceRoot: string }>(
          "SELECT sourceRoot FROM panda_force_document_spaces",
        )
      ).map((space) => space.sourceRoot),
    ];

    const sitePublicationFeature = await createMySQLSitePublicationFeature({
      storage: runtimeStores.publication,
      stateRoot: config.stateRoot,
      sources: mysqlPublicationSources(
        siteBuildFeature.service,
        backend.feature.service,
        { spaces: fileDocuments.spaces, requireProject: requireFileDocumentProject },
        nativeSourceRoots,
      ),
      socialSources: routeMySQLSocialSources(
        mysqlSocialSources(backend.feature.service, publishingFeature.variants.repository, backend.feature.assets),
        mysqlFileSocialSources({
          variants: publishingFeature.variants,
          reference: (id) => publishingFeature.variants.repository.files.reference(id),
          queries: fileDocuments.queries,
          spaces: fileDocuments.spaces,
          assets: fileDocuments.assets,
          requireProject: requireFileDocumentProject,
        }),
        async (id) => (await publishingFeature.variants.repository.files.reference(id))?.source.projectId,
      ),
      requireProject: requireDocumentProject,
      sourceRoots: nativeSourceRoots,
      owner: resolveOwner,
    });
    return {
      editorialFeature,
      publishingFeature,
      siteBuildFeature,
      sitePublicationFeature,
      startDelivery: () => sitePublicationFeature.start(),
    };
  }
  const publishingFeature = createPublishingFeature(
    backend.feature.persistence,
    publicationDocuments.sources,
    publicationDocuments.assets,
    pluginFeature.templates,
    new PublicationVariantFiles(join(config.stateRoot, "publication-variants")),
  );
  const sitePublicationFeature = createSitePublicationFeature({
    db: backend.feature.persistence,
    stateRoot: config.stateRoot,
    sources: publicationSources(siteBuildFeature.service, backend.feature.service, {
      spaces: fileDocuments.spaces,
      requireProject: requireFileDocumentProject,
    }),
    socialSources: routeSocialSources(
      socialSources(backend.feature.service, publishingFeature.variants.repository, backend.feature.assets),
      fileSocialSources({
        variants: publishingFeature.variants,
        reference: (id) => publishingFeature.variants.repository.files.reference(id),
        queries: fileDocuments.queries,
        spaces: fileDocuments.spaces,
        assets: fileDocuments.assets,
        requireProject: requireFileDocumentProject,
      }),
      (id) => publishingFeature.variants.repository.files.reference(id)?.source.projectId,
    ),
    requireProject: requireDocumentProject,
    sourceRoots: () => [
      config.documentContentRoot,
      config.documentAssetRoot,
      ...backend.feature.persistence
        .query<{ sourceRoot: string }, []>("SELECT sourceRoot FROM document_spaces")
        .all()
        .map((space) => space.sourceRoot),
    ],
    owner: resolveOwner,
  });
  return { editorialFeature, publishingFeature, siteBuildFeature, sitePublicationFeature, startDelivery: () => {} };
}
