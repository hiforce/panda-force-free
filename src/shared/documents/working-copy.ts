import type { DocumentDetail, DocumentRevision } from "./contracts.js";

/** A working copy has its own generation; it is never represented as an immutable saved revision. */
export type DocumentWorkingContent = Pick<DocumentRevision, "title" | "locale" | "content" | "body" | "resources">;
export interface DocumentWorkingState {
  version: number;
  savedRevisionId: string;
  baseRevisionId: string;
  dirty: boolean;
  stale: boolean;
  updatedAt: number;
}
export interface DocumentEditorSnapshot {
  saved: DocumentDetail;
  working: DocumentWorkingContent;
  draft: DocumentWorkingState;
}
export interface DocumentDraftAcknowledgement {
  operationId: string;
  documentId: string;
  version: number;
  baseRevisionId: string;
  updatedAt: number;
}
export interface DocumentCheckpointResult {
  detail: DocumentDetail;
  commit: string;
  changed: boolean;
}
