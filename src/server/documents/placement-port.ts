import type {
  DocumentPlacement,
  DocumentPlacementHistorySummary,
  DocumentPlacementEvent,
} from "../../shared/documents/placements.js";

/** Every file publication link carries its project scope; no global document index is required. */
export interface ProjectDocumentPlacements {
  get(projectId: string, id: string): Promise<DocumentPlacement>;
  list(projectId: string, kind: "documentId" | "spaceId", id: string): Promise<DocumentPlacement[]>;
  history(projectId: string, id: string): Promise<DocumentPlacementHistorySummary[]>;
  event(projectId: string, id: string, version: number): Promise<DocumentPlacementEvent>;
  create(actor: string, projectId: string, value: unknown): Promise<DocumentPlacement>;
  update(actor: string, projectId: string, id: string, value: unknown): Promise<DocumentPlacement>;
  remove(actor: string, projectId: string, id: string, value: unknown): Promise<DocumentPlacement>;
}
