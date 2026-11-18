import { stableJson } from "../../../shared/stable-json.js";
import type { CreationTaskSpec } from "../contracts.js";
import type { CreationDocumentArtifact } from "../../../shared/creation/contracts.js";
import { CreationError, CreationWriteError } from "../contracts.js";
import { creationId, creationRecord } from "../validation.js";
import { DocumentError } from "../../documents/errors.js";
import type { DocumentOwnershipApplication } from "../../documents/ownership/application.js";
import type { CreationDocumentPort } from "./document-port.js";
import type { RichDocumentBody } from "../../../shared/documents/rich-body.js";

export interface CreationArchiveDestination {
  projectId: string;
  parentId: string | null;
}
export function creationArchiveDestination(value: unknown): CreationArchiveDestination {
  const v = creationRecord(value, ["projectId", "parentId"]);
  return { projectId: creationId(v.projectId), parentId: v.parentId == null ? null : creationId(v.parentId) };
}
export interface CreationDocumentArchive {
  authorize(owner: string, destination: CreationArchiveDestination): Promise<void>;
  commit(
    task: CreationTaskSpec,
    artifact: CreationDocumentArtifact,
    output: {
      title: string;
      body: RichDocumentBody;
      archiveTo?: CreationArchiveDestination;
    },
  ): Promise<CreationDocumentArtifact>;
}
/** The primary receipt and its exact saved version bind an archive; the model cannot select another source document. */
export function creationDocumentArchive(
  ownership: DocumentOwnershipApplication,
  documents: (owner: string, project: string) => Promise<CreationDocumentPort>,
): CreationDocumentArchive {
  return {
    authorize: (owner, destination) => ownership.authorizeDestination(owner, destination.projectId),
    commit: async (task, artifact, output) => {
      const destination = output.archiveTo;
      if (!destination || destination.projectId === artifact.projectId) return artifact;
      try {
        let request = await ownership.request(task.owner, task.operationId);
        if (!request) {
          const port = await documents(task.owner, artifact.projectId);
          if (!port.revisions) throw new CreationError("unavailable");
          const current = await port.revisions.read(task.owner, artifact.projectId, artifact.documentId);
          if (
            current.base.version !== (artifact.revision ?? 1) ||
            stableJson(current.document.body) !== stableJson(output.body) ||
            current.document.title !== (artifact.title ?? output.title)
          )
            throw new DocumentError("conflict", 409);
          request = {
            owner: task.owner,
            operationId: task.operationId,
            fromProjectId: artifact.projectId,
            toProjectId: destination.projectId,
            parentId: destination.parentId,
            expected: {
              documentId: artifact.documentId,
              revision: current.base.version,
              revisionId: current.base.revisionId,
              contentHash: current.base.contentHash,
            },
          };
        }
        if (
          request.fromProjectId !== artifact.projectId ||
          request.toProjectId !== destination.projectId ||
          request.parentId !== destination.parentId ||
          request.expected.documentId !== artifact.documentId ||
          request.expected.revision !== (artifact.revision ?? 1)
        )
          throw new CreationError("conflict");
        const receipt = await ownership.execute(request);
        return {
          ...artifact,
          location: {
            projectId: receipt.projectId,
            operationId: receipt.operationId,
            treeVersion: receipt.treeVersion,
            revisionId: receipt.revisionId,
            revision: receipt.revision,
          },
        };
      } catch (error) {
        throw new CreationWriteError(
          error instanceof DocumentError && ["conflict", "workingCopyChanged", "notFound"].includes(error.code)
            ? "targetChanged"
            : "writeUnavailable",
          error,
        );
      }
    },
  };
}
