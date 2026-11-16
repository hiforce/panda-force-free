import type { LegacyProjectDocuments } from "./legacy-documents.js";
import type { LegacyProjectMetadata } from "./legacy-metadata.js";
import { planLegacyNavigation, type LegacyNavigationPlan } from "./navigation-plan.js";
import { encodeProjectSpace } from "../space-file.js";
import { encodeProjectManifest } from "../project-manifest.js";
import { encodeProjectNavigation } from "../navigation-file.js";
import { encodeProjectLanguages } from "../language-file.js";
import { encodeAssetRecords } from "../asset-file.js";
import { encodeNavigationOperations } from "../navigation-operation-file.js";
import { encodePlacementRecords, type ProjectPlacementFile } from "../placement-file.js";
import { projectRecordShard } from "../record-shards.js";
import { projectSpaceFile, projectDocumentFile } from "../paths.js";
import { PROJECT_CONTENT_LIMITS } from "../limits.js";
import { ProjectContentError } from "../errors.js";
import { encodeProjectLegacyImport, type ProjectLegacyImportFile } from "./import-file.js";

export interface LegacyMetadataPlan {
  metadata: LegacyProjectMetadata;
  navigation: LegacyNavigationPlan;
  files: Map<string, string>;
  marker: ProjectLegacyImportFile;
  paths: Set<string>;
}
function shards<T>(records: readonly T[], id: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const shard = projectRecordShard(id(record)),
      values = groups.get(shard) ?? [];
    values.push(record);
    groups.set(shard, values);
  }
  for (const values of groups.values()) values.sort((a, b) => id(a).localeCompare(id(b), "en"));
  return groups;
}
/** Every final metadata file is encoded before the first target write, including all same-shard records. */
export function planLegacyMetadata(source: LegacyProjectDocuments): LegacyMetadataPlan {
  const records = source.records(),
    metadata = source.metadata(),
    navigation = planLegacyNavigation(metadata, records),
    projectId = source.projectId,
    files = new Map<string, string>();
  files.set(
    "project.json",
    encodeProjectManifest({
      schema: 1,
      projectId,
      version: metadata.spaces.length ? 1 : 0,
      librarySpaceId: metadata.librarySpaceId,
      spaceIds: metadata.spaces.map((row) => row.space.id).sort(),
    }),
  );
  for (const value of metadata.spaces) files.set(projectSpaceFile(value.space.id), encodeProjectSpace(value));
  files.set("tree.json", encodeProjectNavigation(navigation.file));
  files.set("languages.json", encodeProjectLanguages(metadata.languages));
  for (const [shard, assets] of shards(metadata.assets, (row) => row.id))
    files.set("asset-records/" + shard + ".panda.json", encodeAssetRecords({ schema: 1, projectId, shard, assets }));
  for (const [shard, operations] of shards(navigation.operations, (row) => row.id))
    files.set(
      "navigation-operations/" + shard + ".panda.json",
      encodeNavigationOperations({ schema: 1, projectId, shard, operations }),
    );
  for (const [shard, placements] of shards(
    metadata.placements.map((row) => row.events.at(-1)!),
    (row: ProjectPlacementFile) => row.placement.id,
  ))
    files.set(
      "placements/" + shard + ".panda.json",
      encodePlacementRecords({ schema: 1, projectId, shard, placements }),
    );
  const marker: ProjectLegacyImportFile = {
      schema: 1,
      projectId,
      sourceHash: source.sourceHash,
      sourceSchema: source.schema,
      navigationSchema: metadata.navigation.schema,
      state: "importing",
      folders: metadata.folders.map((original) => ({
        original,
        documentId:
          navigation.file.spaces
            .find((row) => row.spaceId === original.spaceId)
            ?.origins.find((row) => row.path === original.path)?.documentId ?? null,
      })),
    },
    paths = new Set([
      ...files.keys(),
      "import.json",
      ...records.map((row) => projectDocumentFile(row.id)),
      ...navigation.generated.map((row) => projectDocumentFile(row.document.id)),
    ]);
  encodeProjectLegacyImport(marker);
  if (paths.size > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
  return { metadata, navigation, files, marker, paths };
}
