import type { DocumentPlacement } from "../../../shared/documents/placements.js";
import { stableJson } from "../../../shared/stable-json.js";
import { ProjectContentError } from "../errors.js";
import { decodePlacementRecord, decodeProjectPlacement, type ProjectPlacementFile } from "../placement-file.js";
import { LegacyMetadataContext, legacyMetadataJson } from "./metadata-context.js";

export interface LegacyPlacementHistory {
  current: DocumentPlacement;
  events: ProjectPlacementFile[];
}
type Row = Omit<DocumentPlacement, "metadata"> & { metadata: string; pathKey: string };
export function readLegacyPlacements(
  context: LegacyMetadataContext,
  spaces: ReadonlySet<string>,
): LegacyPlacementHistory[] {
  if (!context.tables.has("document_placements")) return [];
  context.requireTables(["document_placement_events"]);
  const result: LegacyPlacementHistory[] = [];
  for (const row of context.rows<Row>(
    "SELECT p.* FROM document_placements p JOIN document_spaces t ON t.id=p.spaceId JOIN documents d ON d.id=p.documentId JOIN document_spaces s ON s.id=d.spaceId WHERE p.projectId=? OR t.projectId=? OR s.projectId=? ORDER BY p.id",
    [context.projectId, context.projectId, context.projectId],
  )) {
    const { metadata, pathKey, ...fields } = row,
      current = decodePlacementRecord({ ...fields, metadata: legacyMetadataJson(metadata) });
    if (pathKey !== current.path.normalize("NFC").toLowerCase()) throw new ProjectContentError("invalidFile");
    const events: ProjectPlacementFile[] = [];
    for (const event of context.rows<{
      version: number;
      snapshot: string;
      operation: string;
      actor: string;
      createdAt: number;
    }>(
      "SELECT version,snapshot,operation,actor,createdAt FROM document_placement_events WHERE placementId=? ORDER BY version",
      [current.id],
    )) {
      const file = decodeProjectPlacement(
          JSON.stringify({
            schema: 1,
            placement: legacyMetadataJson(event.snapshot),
            audit: { operation: event.operation, actor: event.actor, createdAt: event.createdAt },
          }),
        ),
        p = file.placement;
      if (
        event.version !== events.length + 1 ||
        p.version !== event.version ||
        p.id !== current.id ||
        p.documentId !== current.documentId ||
        p.spaceId !== current.spaceId ||
        p.projectId !== current.projectId ||
        p.createdAt !== current.createdAt ||
        events.at(-1)?.audit.operation === "remove"
      )
        throw new ProjectContentError("invalidFile");
      if (p.projectId !== context.projectId || !spaces.has(p.spaceId)) throw new ProjectContentError("invalidFile");
      context.requireDocument(p.documentId);
      if (
        p.revisionId !== null &&
        context.rows<{ documentId: string }>("SELECT documentId FROM document_revisions WHERE id=?", [p.revisionId])[0]
          ?.documentId !== p.documentId
      )
        throw new ProjectContentError("invalidFile");
      events.push(file);
    }
    if (events.length !== current.version || stableJson(events.at(-1)?.placement) !== stableJson(current))
      throw new ProjectContentError("invalidFile");
    result.push({ current, events });
  }
  return result;
}
