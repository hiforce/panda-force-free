import { join } from "node:path";
import { DocumentOwnershipApplication } from "../documents/ownership/application.js";
import { fileOwnershipLocation } from "../documents/ownership/location.js";
import { creationDocumentArchive } from "../creation/integration/document-archive.js";
import { ownershipCreationDocuments } from "../creation/integration/ownership-documents.js";
import { creationFileDocuments } from "../creation/integration/file-document-revisions.js";
import type { CreationDocumentPort } from "../creation/integration/document-port.js";
import type { PersonalContent } from "../creative/personal.js";
import type { ApplicationDocuments } from "./documents.js";
import type { ApplicationProjects } from "./projects.js";

/** Per-document ownership follows the installation's selected adapters and the current caller's project grants. */
export function applicationDocumentOwnership(options: {
  stateRoot: string;
  documents: ApplicationDocuments;
  projects: ApplicationProjects;
  personal(): PersonalContent;
  projectDocuments: CreationDocumentPort;
}) {
  const { documents, projects } = options;
  const authorize = async (owner: string, project: string, access: "read" | "contribute") => {
    await (project === "personal" || (await projects.storage.files(project))
      ? documents.contentAccess.require(owner, project, access)
      : documents.contentAccess.requireLegacy(owner, project, access));
  };
  const ownership = new DocumentOwnershipApplication({
    root: join(options.stateRoot, "document-ownership"),
    authorize: (owner, scope, access) => authorize(owner, scope.projectId, access),
    backend: async (owner, scope) => {
      await authorize(owner, scope.projectId, "contribute");
      if (scope.projectId === "personal")
        return { kind: "files", ...(await options.personal().forOwner(owner)).documents.transfers };
      return (await projects.storage.files(scope.projectId))
        ? { kind: "files", ...documents.scopedDocuments(owner, "contribute").transfers }
        : { kind: "sql", ...documents.documentFeature.transfers };
    },
    location: async (owner, scope, id) => {
      if (scope.projectId === "personal")
        return fileOwnershipLocation(options.personal().readProjects(owner), "personal", id);
      return (await projects.storage.files(scope.projectId))
        ? documents.scopedDocuments(owner, "read").transfers.location(scope.projectId, id)
        : documents.documentFeature.transfers.location(scope.projectId, id);
    },
  });
  const content = async (owner: string, project: string) => {
    await authorize(owner, project, "contribute");
    return project === "personal"
      ? creationFileDocuments((await options.personal().forOwner(owner)).documents)
      : options.projectDocuments;
  };
  return {
    ownership,
    archive: creationDocumentArchive(ownership, content),
    wrap: (home: CreationDocumentPort): CreationDocumentPort => {
      const wrapped = ownershipCreationDocuments(home, ownership, content);
      return {
        ...wrapped,
        location: async (owner, project, id) => {
          const location = await wrapped.location!(owner, project, id);
          if (!location) return null;
          const projectName =
            location.projectId === "personal" ? undefined : (await projects.catalog.project(location.projectId)).name;
          await authorize(owner, location.projectId, "read");
          return { ...location, ...(projectName ? { projectName } : {}) };
        },
      };
    },
    destinations: async (owner: string, search: string, offset: number) => {
      await authorize(owner, "personal", "contribute");
      const catalog = await documents.contentAccess.service.view(owner),
        query = search.trim().toLocaleLowerCase(),
        targets = catalog.projects.filter(
          (project) =>
            project.role === "contributor" &&
            (!query || `${project.id} ${project.name}`.toLocaleLowerCase().includes(query)),
        ),
        page = targets.slice(offset, offset + 20);
      return {
        projects: page.map(({ id, name }) => ({ id, name })),
        personalProjectId: "personal",
        nextOffset: offset + page.length < targets.length ? offset + page.length : null,
      };
    },
  };
}
