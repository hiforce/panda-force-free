import type { DocumentAsset, DocumentDetail, DocumentRecord } from "../../../shared/documents/contracts.js";
import type { DocumentOwnershipRecord, DocumentOwnershipScope } from "../../../shared/documents/ownership.js";
import type { DocumentTreePlacement } from "../../../shared/documents/navigation.js";
import type { DocumentHistorySummary } from "../history-page.js";

export interface DocumentOwnershipInventory {
  projectId: string;
  rootDocumentId: string;
  nodes: (DocumentTreePlacement & { document: DocumentRecord })[];
  assets: DocumentAsset[];
  ownership: DocumentOwnershipRecord[];
  revisions: DocumentHistorySummary[];
}
export interface DocumentOwnershipPlan {
  schema: 1;
  id: string;
  owner: string;
  from: DocumentOwnershipScope;
  to: DocumentOwnershipScope;
  parentId: string | null;
  startedAt: number;
  lineages: { documentId: string; lineageId: string }[];
  manifestHash: string;
}
/** Readers are application capabilities. A serialized manifest cannot select files, accounts or transport credentials. */
export interface DocumentOwnershipOriginals {
  /** Object identity proves a live source in the same relational store; serialized metadata cannot grant this. */
  relationalOrigin?: object;
  version(documentId: string, revisionId: string): Promise<DocumentDetail>;
  image(assetId: string): Promise<{ asset: DocumentAsset; bytes: Uint8Array }>;
}
export interface DocumentOwnershipReceipt {
  operationId: string;
  projectId: string;
  documentId: string;
  revisionId: string;
  revision: number;
  treeVersion: number;
  manifestHash: string;
}
