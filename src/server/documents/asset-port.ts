import type { DocumentAsset } from "../../shared/documents/contracts.js";

export interface ProjectDocumentAssets {
  metadata(projectId: string, assetId: string): Promise<DocumentAsset>;
  list(projectId: string, documentId: string): Promise<DocumentAsset[]>;
  content(projectId: string, assetId: string): Promise<{ asset: DocumentAsset; bytes: Uint8Array }>;
  upload(
    actor: string,
    projectId: string,
    documentId: string,
    name: string,
    operationId: string,
    bytes: Uint8Array,
  ): Promise<DocumentAsset>;
}
