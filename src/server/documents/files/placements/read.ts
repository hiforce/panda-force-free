import type { DocumentPlacement } from "../../../../shared/documents/placements.js";
import type { ProjectContentView } from "../../../project-content/read-view.js";
import { readPlacement, readPlacementShards } from "../../../project-content/placement-read.js";
import { readProjectManifest } from "../../../project-content/project-manifest.js";
import { readSpaceMetadata } from "../../../project-content/space-read.js";
import { DocumentError } from "../../errors.js";
import { documentIdentity } from "../projects.js";

export async function publicationSpace(view: ProjectContentView, projectId: string, spaceId: string) {
  const manifest = await readProjectManifest(view, projectId);
  if (spaceId === manifest.librarySpaceId) throw new DocumentError("invalidPlacementTarget");
  return readSpaceMetadata(view, manifest, spaceId);
}
export async function filePlacement(view: ProjectContentView, projectId: string, id: string) {
  documentIdentity(id);
  const row = await readPlacement(view, projectId, id);
  if (!row) throw new DocumentError("notFound", 404);
  await publicationSpace(view, projectId, row.placement.spaceId);
  return row;
}
export async function filePlacements(
  view: ProjectContentView,
  projectId: string,
  kind: "documentId" | "spaceId",
  id: string,
): Promise<DocumentPlacement[]> {
  return [...(await readPlacementShards(view, projectId)).values()]
    .flatMap((shard) => shard.placements.map((row) => row.placement))
    .filter((row) => row[kind] === id && row.deletedAt === null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en"));
}
