import type { PublicDocumentMetadata } from "../sites/metadata.js";

/** A space references an immutable source identity; a null revision follows its latest saved version. */
export interface DocumentPlacement {
  id: string;
  projectId: string;
  documentId: string;
  spaceId: string;
  path: string;
  locale: string;
  revisionId: string | null;
  metadata: PublicDocumentMetadata;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
export interface DocumentPlacementEvent {
  placement: DocumentPlacement;
  operation: "create" | "update" | "remove";
  actor: string;
  createdAt: number;
}
export interface DocumentPlacementInput {
  id: string;
  documentId: string;
  spaceId: string;
  path: string;
  locale: string;
  revisionId: string | null;
  metadata: PublicDocumentMetadata;
}

/** A bounded history list does not hydrate full custom metadata for every event. */
export interface DocumentPlacementHistorySummary {
  placement: Omit<DocumentPlacement, "metadata">;
  audit: Omit<DocumentPlacementEvent, "placement">;
  recordHash: string;
}
