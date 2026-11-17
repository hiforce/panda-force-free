import {
  fileCreationDocumentRevisions,
  creationFileDocuments,
} from "../creation/integration/file-document-revisions.js";
import { recoverKnowledgeOutput } from "../knowledge/integration/output-recovery.js";
import { PersonalContent } from "../creative/personal.js";
import { creationDocumentImages, projectCreationDocuments } from "../creation/integration/document-port.js";
import { createNativeCreationFeature } from "../creation/integration/bootstrap.js";
import { createNativeKnowledgeFeature } from "../knowledge/integration/bootstrap.js";
import { FileDocumentKnowledgeContent } from "../knowledge/integration/document-content.js";
import { routeKnowledgeContent } from "../knowledge/integration/content-router.js";
import { documentTemplateCreationRoutes } from "../templates/integration/document-creation-routes.js";
import { createOptionalSearchFeature } from "../search/integration/bootstrap.js";
import { documentSearchSource } from "../search/integration/content-source.js";
import { originalSearchSource } from "../search/integration/original-source.js";
import { DocumentError } from "../documents/errors.js";
import type { ApplicationConfig, ApplicationStores, ApplicationOwnerResolver } from "./types.js";
import type { ApplicationDocuments } from "./documents.js";
import type { ApplicationProjects } from "./projects.js";
import type { createApplicationExtensions } from "./extensions.js";
import { FileCreationMaterials } from "../creation/integration/material-files.js";
import { join } from "node:path";
import { applicationCreationFileDirectories } from "./creation-file-directories.js";
import { applicationDocumentOwnership } from "./document-ownership.js";
/** Wire authorized content, generation and indexing ports without owning the host engine lifetime. */
export async function createApplicationContent(
  config: ApplicationConfig,
  runtimeStores: ApplicationStores | null,
  documents: ApplicationDocuments,
  projects: ApplicationProjects,
  extensions: Awaited<ReturnType<typeof createApplicationExtensions>>,
  resolveOwner: ApplicationOwnerResolver,
  appServerConnection: Parameters<typeof createNativeCreationFeature>[0]["connection"],
  models: () => Promise<unknown>,
  administrator: Parameters<typeof createOptionalSearchFeature>[0]["administrator"],
  changed: (project: string, owner?: string) => void,
  hostOwner?: () => string | null,
) {
  const {
    documentFeature,
    fileDocuments,
    contentAccess,
    scopedDocuments,
    requireDocumentProject,
    requireFileDocumentProject,
  } = documents;
  const { skillFeature, portableTemplateFeature } = extensions;
  const documentStorage = projects.storage;
  const creationMaterials = new FileCreationMaterials(join(config.stateRoot, "creation-materials"));
  const projectDocuments = projectCreationDocuments(
    (project) => documentStorage.files(project),
    {
      images: creationDocumentImages(
        async (owner, project) => {
          if (await documentStorage.files(project)) return scopedDocuments(owner, "contribute").assets;
          return { content: async (_project, id) => documentFeature.assets.content(id) };
        },
        (owner, project) => contentAccess.require(owner, project, "contribute"),
      ),
      revisions: fileCreationDocumentRevisions(
        (owner) => scopedDocuments(owner, "contribute"),
        (project) => fileDocuments.navigation.tree(project),
      ),
      tree: (project) => fileDocuments.navigation.tree(project),
      createFromSource: (owner, input, source) =>
        scopedDocuments(owner, "contribute").navigation.createFromSource(owner, input, source),
      appendFromSource: (owner, input, source) =>
        scopedDocuments(owner, "contribute").navigation.appendFromSource(owner, input, source),
    },
    documentFeature.navigation,
    (owner, project) => contentAccess.require(owner, project, "contribute"),
  );
  const archives = applicationDocumentOwnership({
    stateRoot: config.stateRoot,
    documents,
    projects,
    personal: () => personalContent,
    projectDocuments,
  });
  const directories = hostOwner
    ? applicationCreationFileDirectories(config, projects, hostOwner, (owner, project) =>
        contentAccess.require(owner, project, "contribute"),
      )
    : undefined;
  const creationFeature = createNativeCreationFeature({
    materials: creationMaterials,
    storage: runtimeStores?.creation,
    stateRoot: config.stateRoot,
    projectsRoot: config.projectWorkspaceRoot,
    engineId: config.engineId,
    connection: appServerConnection,
    version: config.version,
    models,
    owner: resolveOwner,
    requireProject: requireDocumentProject,
    authorizeProject: (owner, project) => contentAccess.require(owner, project, "contribute"),
    documents: archives.wrap(projectDocuments),
    archive: archives.archive,
    directories,
    destinations: archives.destinations,
    skills: skillFeature.catalog,
  });
  const personalContent: PersonalContent = new PersonalContent({
    authorize: (owner) => contentAccess.require(owner, "personal", "contribute"),
    contentRoot: config.documentContentRoot,
    assetRoot: config.documentAssetRoot,
    stateRoot: config.stateRoot,
    owner: resolveOwner,
    changed: (project, owner) => changed(project, owner),
    documentRoutes: (documents, owner) =>
      documentTemplateCreationRoutes(portableTemplateFeature.documents, documents.navigation, () => owner),
    creation: (root, owner, documents) =>
      createNativeCreationFeature({
        materials: creationMaterials,
        storage: runtimeStores?.personalCreation(owner),
        stateRoot: root,
        profileStateRoot: config.stateRoot,
        projectsRoot: config.projectWorkspaceRoot,
        engineId: config.engineId,
        connection: appServerConnection,
        version: config.version,
        models,
        owner: () => owner,
        requireProject: (id) => {
          if (id !== "personal") throw new DocumentError("notFound", 404);
        },
        documents: archives.wrap(creationFileDocuments(documents)),
        archive: archives.archive,
        directories,
        destinations: archives.destinations,
        skills: skillFeature.catalog,
      }),
  });
  const readOriginalSources = async (owner: string, project: string) => {
    await contentAccess.require(owner, project, "read");
    return project === "personal" ? personalContent.readOriginals(owner) : scopedDocuments(owner, "read").originals;
  };
  const knowledgeFeature = createNativeKnowledgeFeature({
    storage: runtimeStores?.knowledge,
    stateRoot: config.stateRoot,
    projectsRoot: config.projectWorkspaceRoot,
    engineId: config.engineId,
    connection: appServerConnection,
    version: config.version,
    models,
    content: routeKnowledgeContent(
      async (owner) => {
        const documents = scopedDocuments(owner, "contribute");
        return new FileDocumentKnowledgeContent(
          documents.projectContent,
          fileDocuments.projectContent,
          documents.originals,
        );
      },
      async (owner) => {
        await contentAccess.require(owner, "personal", "contribute");
        const { documents } = await personalContent.forOwner(owner);
        return new FileDocumentKnowledgeContent(
          documents.projectContent,
          documents.projectContent,
          documents.originals,
        );
      },
      async (owner) => {
        await contentAccess.require(owner, "personal", "contribute");
        await personalContent.readProjects(owner).authorize("personal");
      },
      async (owner, input, record, missing) =>
        recoverKnowledgeOutput(
          input.scope.project === "personal" ? personalContent.readProjects(owner) : fileDocuments.projectContent,
          owner,
          input,
          record,
          missing,
        ),
    ),
    documents: async (scope) => {
      await contentAccess.require(scope.owner, scope.project, "read");
      return scope.project === "personal"
        ? personalContent.readProjects(scope.owner)
        : scopedDocuments(scope.owner, "read").projectContent;
    },
    indexDocuments: async (scope) => {
      if (scope.project !== "personal") return fileDocuments.projectContent;
      await contentAccess.require(scope.owner, "personal", "read");
      return personalContent.readProjects(scope.owner);
    },
    originals: async (scope) => readOriginalSources(scope.owner, scope.project),
    indexOriginals: async (scope) => {
      if (scope.project !== "personal") return fileDocuments.originals;
      await contentAccess.require(scope.owner, "personal", "read");
      return personalContent.readOriginals(scope.owner);
    },
    generationDocuments: async (scope) => {
      await contentAccess.require(scope.owner, scope.project, "contribute");
      return scope.project === "personal"
        ? personalContent.readProjects(scope.owner)
        : scopedDocuments(scope.owner, "contribute").projectContent;
    },
    initializeDocuments: async (scope) => {
      await contentAccess.require(scope.owner, scope.project, "contribute");
      const documents =
        scope.project === "personal"
          ? (await personalContent.forOwner(scope.owner)).documents
          : scopedDocuments(scope.owner, "contribute");
      await documents.projectContent.initialize(scope.project, async () => {});
    },
    owner: resolveOwner,
    report: () => console.warn("[knowledge] A knowledge operation could not complete"),
  });
  const searchFeature = await createOptionalSearchFeature({
    storage: runtimeStores?.search,
    stateRoot: config.stateRoot,
    appRoot: config.appRoot,
    knowledge: knowledgeFeature.approved,
    indexKnowledge: knowledgeFeature.indexed,
    indexContent: originalSearchSource({
      originals: async (scope) =>
        scope.project === "personal" ? personalContent.readOriginals(scope.owner) : fileDocuments.originals,
      documents: documentSearchSource({
        project: fileDocuments.queries,
        personal: async (owner) => {
          await contentAccess.require(owner, "personal", "read");
          return personalContent.readQueries(owner);
        },
        authorizeProject: async (_owner, project) => {
          await requireFileDocumentProject(project);
        },
      }),
    }),
    content: originalSearchSource({
      originals: async (scope) =>
        scope.project === "personal"
          ? personalContent.readOriginals(scope.owner)
          : scopedDocuments(scope.owner, "read").originals,
      documents: documentSearchSource({
        project: async (owner) => scopedDocuments(owner, "read").queries,
        personal: async (owner) => {
          await contentAccess.require(owner, "personal", "read");
          return personalContent.readQueries(owner);
        },
        authorizeProject: async (owner, project) => {
          await contentAccess.require(owner, project, "read");
        },
      }),
    }),
    owner: resolveOwner,
    administrator,
    report: () => console.warn("[search] Index operation could not complete"),
  });

  creationFeature.routes.push(...creationMaterials.routes(resolveOwner));
  return {
    creationFeature,
    personalContent,
    readOriginalSources,
    knowledgeFeature,
    searchFeature,
    closeMaterialText: () => creationMaterials.close(),
  };
}
