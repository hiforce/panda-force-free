import type {
  DocumentDetail,
  DocumentPage,
  DocumentRecord,
  DocumentRevision,
} from "../../shared/documents/contracts.js";
import type {
  DocumentCheckpointResult,
  DocumentDraftAcknowledgement,
  DocumentEditorSnapshot,
} from "../../shared/documents/working-copy.js";

export interface ProjectDocumentQueries {
  record(projectId: string, documentId: string): Promise<DocumentRecord>;
  detail(projectId: string, documentId: string): Promise<DocumentDetail>;
  editor(projectId: string, documentId: string): Promise<DocumentEditorSnapshot>;
  revision(projectId: string, documentId: string, revisionId: string): Promise<DocumentRevision>;
  revisions(projectId: string, documentId: string): Promise<Omit<DocumentRevision, "content" | "body" | "resources">[]>;
  list(projectId: string, spaceId: string, search?: string, offset?: number): Promise<DocumentPage>;
}
export interface ProjectDocumentEditor {
  autosave(actor: string, projectId: string, documentId: string, value: unknown): Promise<DocumentDraftAcknowledgement>;
  discard(actor: string, projectId: string, documentId: string, value: unknown): Promise<DocumentDraftAcknowledgement>;
  save(actor: string, projectId: string, documentId: string, value: unknown): Promise<DocumentCheckpointResult>;
  restore(actor: string, projectId: string, documentId: string, value: unknown): Promise<DocumentCheckpointResult>;
}
