import type { DocumentRecord, DocumentRevision } from "../../../shared/documents/contracts.js";
import type { DocumentPlacement, DocumentPlacementEvent } from "../../../shared/documents/placements.js";
import type { DocumentSpaceApi } from "../space-api.js";

export interface DocumentPublicationScope {
  projectId: string;
  storage: "files" | "legacy";
}
export type PublicationRevision = Pick<DocumentRevision, "id" | "number" | "title" | "locale">;
export type PublicationHistoryItem = Pick<DocumentPlacementEvent, "operation" | "actor" | "createdAt"> & {
  placement: Pick<DocumentPlacement, "path" | "version">;
};
export interface PublicationSourceApi {
  detail(id: string): Promise<{ document: DocumentRecord }>;
  history(id: string): Promise<{ revisions: PublicationRevision[] }>;
  revision(id: string, revision: string): Promise<{ revision: PublicationRevision }>;
}
export interface PublicationPlacementApi {
  list(document: string): Promise<{ placements: DocumentPlacement[] }>;
  create(input: Record<string, unknown>): Promise<{ placement: DocumentPlacement }>;
  update(id: string, input: Record<string, unknown>): Promise<{ placement: DocumentPlacement }>;
  remove(placement: DocumentPlacement, spaceVersion: number): Promise<{ placement: DocumentPlacement }>;
  history(id: string): Promise<{ events: PublicationHistoryItem[] }>;
}
export interface PublicationConfigurationApi {
  sources: PublicationSourceApi;
  spaces: DocumentSpaceApi;
  placements: PublicationPlacementApi;
  recovery?: { readonly pending: boolean; retry(): Promise<unknown> };
}
