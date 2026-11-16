import type { DocumentPlacement, DocumentPlacementEvent } from "../../../shared/documents/placements.js";
import { documentJson as json } from "../api.js";

/** Configuration requests never start a build or publish content. */
export const documentPlacementsApi = {
  list: (document: string) =>
    json<{ placements: DocumentPlacement[] }>("/api/document-placements?" + new URLSearchParams({ document })),
  create: (value: Record<string, unknown>) =>
    json<{ placement: DocumentPlacement }>("/api/document-placements", "POST", value),
  update: (id: string, value: Record<string, unknown>) =>
    json<{ placement: DocumentPlacement }>(
      "/api/document-placements/detail?" + new URLSearchParams({ id }),
      "PUT",
      value,
    ),
  remove: (placement: DocumentPlacement) =>
    json<{ placement: DocumentPlacement }>(
      "/api/document-placements/detail?" + new URLSearchParams({ id: placement.id }),
      "DELETE",
      { version: placement.version },
    ),
  history: (id: string) =>
    json<{ events: DocumentPlacementEvent[] }>("/api/document-placements/history?" + new URLSearchParams({ id })),
};
