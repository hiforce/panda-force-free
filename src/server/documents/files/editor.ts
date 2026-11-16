import type { DocumentDraftAcknowledgement } from "../../../shared/documents/working-copy.js";
import type { ProjectDraftReceipt } from "../../project-content/drafts/file.js";
import type { DocumentFileProjects } from "./projects.js";
import { checkpointCommand, draftCommand, editorInput, workingContent } from "./commands.js";
import { documentIdentity } from "./projects.js";

function acknowledgement(receipt: ProjectDraftReceipt): DocumentDraftAcknowledgement {
  const { operationId, documentId, version, baseRevisionId, updatedAt } = receipt;
  return { operationId, documentId, version, baseRevisionId, updatedAt };
}

/** Editor commands own workflow checks. The file owner owns durable concurrency, receipts and immutable checkpoint creation. */
export class FileDocumentEditor {
  constructor(private readonly projects: DocumentFileProjects) {}
  async autosave(actor: string, projectId: string, documentId: string, value: unknown) {
    const input = editorInput(value, ["operationId", "version", "baseRevisionId", "working"]),
      command = { ...draftCommand(actor, documentId, input), content: workingContent(input.working) };
    return this.projects.write(projectId, async (project) => acknowledgement(await project.drafts.put(command)));
  }
  async discard(actor: string, projectId: string, documentId: string, value: unknown) {
    const input = editorInput(value, ["operationId", "version", "baseRevisionId"]),
      command = draftCommand(actor, documentId, input);
    return this.projects.write(projectId, async (project) => acknowledgement(await project.drafts.discard(command)));
  }
  async save(actor: string, projectId: string, documentId: string, value: unknown) {
    const input = editorInput(value, ["operationId", "revisionId", "draftVersion"]),
      command = checkpointCommand(actor, documentId, input);
    return this.projects.write(projectId, async (project) => project.checkpoints.save(command));
  }
  async restore(actor: string, projectId: string, documentId: string, value: unknown) {
    const input = editorInput(value, ["operationId", "revisionId", "draftVersion", "restoreRevisionId"]),
      command = {
        ...checkpointCommand(actor, documentId, input),
        revisionId: documentIdentity(input.restoreRevisionId),
      };
    return this.projects.write(projectId, async (project) => project.checkpoints.restore(command));
  }
}
