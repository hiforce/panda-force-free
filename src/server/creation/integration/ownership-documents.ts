import type { CreationDocumentPort } from "./document-port.js";
import type { DocumentOwnershipApplication } from "../../documents/ownership/application.js";
import { CreationError } from "../contracts.js";
import { DocumentError } from "../../documents/errors.js";

/** Conversations keep their home scope; new continuations freeze the authorized current document location. */
export function ownershipCreationDocuments(
  home: CreationDocumentPort,
  ownership: DocumentOwnershipApplication,
  documents: (owner: string, project: string) => Promise<CreationDocumentPort>,
): CreationDocumentPort {
  return {
    ...home,
    location: async (owner, project, document) => {
      try {
        return await ownership.locate(owner, project, document);
      } catch (error) {
        if (error instanceof DocumentError && [404, 503].includes(error.status)) return null;
        throw error;
      }
    },
    images: {
      read: async (owner, project, document, image) => {
        const port = await documents(owner, project);
        if (!port.images) throw new CreationError("unavailable");
        return port.images.read(owner, project, document, image);
      },
    },
    revisions: {
      read: async (owner, project, document) => {
        const location = await ownership.locate(owner, project, document, "contribute"),
          port = await documents(owner, location.projectId);
        if (!port.revisions) throw new CreationError("unavailable");
        const result = await port.revisions.read(owner, location.projectId, document),
          tree = await port.tree(location.projectId);
        return { ...result, projectId: location.projectId, treeVersion: tree.version };
      },
      save: async (task, digest, body) => {
        const projectId = task.target.documentProjectId ?? task.projectId,
          port = await documents(task.owner, projectId);
        if (!port.revisions) throw new CreationError("unavailable");
        // A queued save uses its frozen location. A later move requires a fresh continuation.
        return port.revisions.save({ ...task, projectId }, digest, body);
      },
    },
  };
}
