import type { ProjectDocumentChanges, SavedDocumentEdit } from "../saved-edits-port.js";
import { documentAuthor } from "./commands.js";
import { documentIdentity, type DocumentFileProjects } from "./projects.js";

/** Application ownership stays outside native Git storage; replay uses the same author, source and confirmation identity. */
export class FileDocumentChanges implements ProjectDocumentChanges {
  constructor(private readonly projects: DocumentFileProjects) {}
  private command(actor: string, documentId: string, command: SavedDocumentEdit) {
    return { ...structuredClone(command), documentId: documentIdentity(documentId), author: documentAuthor(actor) };
  }
  apply(actor: string, projectId: string, documentId: string, command: SavedDocumentEdit) {
    const input = this.command(actor, documentId, command);
    return this.projects.write(projectId, (project) => project.sourceEdits.apply(input));
  }
  receipt(actor: string, projectId: string, documentId: string, command: SavedDocumentEdit) {
    const input = this.command(actor, documentId, command);
    return this.projects.write(projectId, (project) => project.sourceEdits.receipt(input));
  }
}
