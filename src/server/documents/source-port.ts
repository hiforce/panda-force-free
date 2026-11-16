import type { DocumentRecord, DocumentRevision, DocumentEngine } from "../../shared/documents/contracts.js";

/** A saved source and its engine are read under one project view; consumers never inspect a mutable draft. */
export interface ProjectSavedDocument {
  projectId: string;
  commit: string;
  document: DocumentRecord;
  revision: DocumentRevision;
  engine: DocumentEngine;
}
export interface ProjectDocumentSources {
  source(projectId: string, documentId: string, revisionId: string): Promise<ProjectSavedDocument>;
}
