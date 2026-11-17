import type { DocumentOwnershipScope, DocumentOwnershipRecord } from "../../../shared/documents/ownership.js";
import type { FileDocumentOwnershipSource, FileOwnershipSnapshot } from "./file-source.js";
import type { FileDocumentOwnershipRemoval } from "./file-source-removal.js";
import type { SQLDocumentOwnershipSource, SQLDocumentOwnershipSnapshot } from "./sql-source.js";
import type { SQLDocumentOwnershipRemoval } from "./sql-removal.js";
import type { DocumentOwnershipTarget } from "./move.js";
import type { DocumentOwnershipPlan } from "./contracts.js";
export interface DocumentOwnershipExpected {
  documentId: string;
  revision: number;
  contentHash: string;
  revisionId?: string;
}
export interface DocumentOwnershipRequest {
  owner: string;
  operationId: string;
  fromProjectId: string;
  toProjectId: string;
  parentId: string | null;
  expected: DocumentOwnershipExpected;
}
export type DocumentOwnershipBackend =
  | {
      kind: "files";
      source: FileDocumentOwnershipSource;
      removal: FileDocumentOwnershipRemoval;
      target: DocumentOwnershipTarget;
    }
  | {
      kind: "sql";
      source: SQLDocumentOwnershipSource;
      removal: SQLDocumentOwnershipRemoval;
      target: DocumentOwnershipTarget;
    };
export interface AdmittedDocumentOwnership {
  schema: 1;
  request: DocumentOwnershipRequest;
  plan: DocumentOwnershipPlan;
  source: { kind: "files"; snapshot: FileOwnershipSnapshot } | { kind: "sql"; snapshot: SQLDocumentOwnershipSnapshot };
}
export type DocumentOwnershipAccess = "read" | "contribute";
export interface DocumentOwnershipApplicationOptions {
  root: string;
  backend(owner: string, scope: DocumentOwnershipScope): Promise<DocumentOwnershipBackend>;
  location(
    owner: string,
    scope: DocumentOwnershipScope,
    documentId: string,
  ): Promise<{ active: boolean; ownership: DocumentOwnershipRecord | null }>;
  authorize(owner: string, scope: DocumentOwnershipScope, access: DocumentOwnershipAccess): Promise<void>;
}
