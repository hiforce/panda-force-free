import type { DocumentCheckpointResult, DocumentWorkingContent } from "../../shared/documents/working-copy.js";

/** An opaque intent hash includes caller-specific confirmation data, without coupling source storage to that workflow. */
export interface SavedDocumentEdit {
  operationId: string;
  expectedRevisionId: string;
  expectedVersion: number;
  expectedContentHash: string;
  intentHash: string;
  content: DocumentWorkingContent;
}
export interface ProjectDocumentChanges {
  apply(
    actor: string,
    projectId: string,
    documentId: string,
    command: SavedDocumentEdit,
  ): Promise<DocumentCheckpointResult>;
  receipt(
    actor: string,
    projectId: string,
    documentId: string,
    command: SavedDocumentEdit,
  ): Promise<DocumentCheckpointResult | null>;
}
