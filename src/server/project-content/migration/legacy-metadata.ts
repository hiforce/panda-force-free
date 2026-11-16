import type { Database } from "bun:sqlite";
import type { DocumentAsset, DocumentFolder, DocumentRecord } from "../../../shared/documents/contracts.js";
import { decodeProjectDocumentRecord } from "../document-record.js";
import { ProjectContentError } from "../errors.js";
import type { ProjectLanguageFile } from "../language-file.js";
import { decodeProjectSpace, type ProjectSpaceFile } from "../space-file.js";
import { projectContentId } from "../paths.js";
import { LegacyMetadataContext, legacyMetadataJson } from "./metadata-context.js";
import {
  readLegacyAssets,
  readLegacyFolders,
  readLegacyLanguages,
  readLegacyTrash,
  type LegacyDocumentTrash,
} from "./legacy-relations.js";
import { readLegacyPlacements, type LegacyPlacementHistory } from "./legacy-placements.js";
import { readLegacyNavigation, type LegacyNavigationMetadata } from "./legacy-navigation.js";

export interface LegacyProjectMetadata {
  projectId: string;
  spaces: ProjectSpaceFile[];
  librarySpaceId: string | null;
  assets: DocumentAsset[];
  languages: ProjectLanguageFile;
  folders: DocumentFolder[];
  trash: LegacyDocumentTrash[];
  placements: LegacyPlacementHistory[];
  navigation: LegacyNavigationMetadata;
}
/** Extract every current metadata facet in the same read-only snapshot; no target files, schema updates or lazy bootstrap. */
export function readLegacyProjectMetadata(
  db: Database,
  projectId: string,
  schema: number,
  input: readonly DocumentRecord[],
): LegacyProjectMetadata {
  projectContentId(projectId);
  const documents = new Map(
      input.map((record) => {
        const doc = decodeProjectDocumentRecord(record);
        return [doc.id, doc] as const;
      }),
    ),
    context = new LegacyMetadataContext(db, projectId, documents);
  context.requireTables([
    "document_spaces",
    "documents",
    ...(schema >= 2 ? ["document_assets", "document_languages"] : []),
    ...(schema >= 4 ? ["document_site_profiles"] : []),
    ...(schema >= 5 ? ["project_document_libraries", "document_folders", "document_trash"] : []),
    ...(schema >= 6 ? ["document_placements", "document_placement_events"] : []),
  ]);
  const profiles = new Map<string, unknown>();
  if (context.tables.has("document_site_profiles"))
    for (const row of context.rows<{ spaceId: string; profile: string }>(
      "SELECT p.* FROM document_site_profiles p JOIN document_spaces s ON s.id=p.spaceId WHERE s.projectId=? ORDER BY p.spaceId",
      [projectId],
    ))
      profiles.set(row.spaceId, legacyMetadataJson(row.profile));
  const spaces = context
      .rows<ProjectSpaceFile["space"]>("SELECT * FROM document_spaces WHERE projectId=? ORDER BY id", [projectId])
      .map((space) =>
        decodeProjectSpace(JSON.stringify({ schema: 1, space, sourceProfile: profiles.get(space.id) ?? null })),
      ),
    ids = new Set(spaces.map((row) => row.space.id));
  if (
    documents.size !== input.length ||
    spaces.some((row) => row.space.projectId !== projectId) ||
    [...documents.values()].some((doc) => !ids.has(doc.spaceId))
  )
    throw new ProjectContentError("invalidFile");
  const library = context.tables.has("project_document_libraries")
    ? (context.rows<{ spaceId: string }>("SELECT spaceId FROM project_document_libraries WHERE projectId=?", [
        projectId,
      ])[0]?.spaceId ?? null)
    : null;
  if (library !== null && !ids.has(library)) throw new ProjectContentError("invalidFile");
  for (const { space } of spaces)
    if (
      (space.code === "__documents__") !== (space.id === library) ||
      (space.id === library && (space.engine !== "markdown" || space.sourceMode !== "managed"))
    )
      throw new ProjectContentError("invalidFile");
  return {
    projectId,
    spaces,
    librarySpaceId: library,
    assets: readLegacyAssets(context),
    languages: readLegacyLanguages(context),
    folders: readLegacyFolders(context, ids),
    trash: readLegacyTrash(context),
    placements: readLegacyPlacements(context, ids),
    navigation: readLegacyNavigation(context, ids),
  };
}
