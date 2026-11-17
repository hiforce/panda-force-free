/** Project identity and private account identity stay distinct throughout a document ownership transfer. */
export interface DocumentOwnershipScope {
  projectId: string;
  personalOwnerHash?: string;
}
export interface DocumentOwnershipRecord {
  schema: 1;
  documentId: string;
  lineageId: string;
  operationId: string;
  rootDocumentId: string;
  manifestHash: string;
  kind: "incoming" | "active" | "outgoing";
  from: DocumentOwnershipScope;
  to: DocumentOwnershipScope;
}
