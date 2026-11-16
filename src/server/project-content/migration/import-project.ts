import { isAbsolute, relative, sep } from "node:path";
import type { ContentAuthor } from "../git/process.js";
import type { ProjectContentProject } from "../project.js";
import type { ProjectAssetBlobs } from "../asset-blobs.js";
import { ProjectGitSnapshots } from "../git/snapshot.js";
import { ProjectContentError } from "../errors.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { LegacyProjectDocuments } from "./legacy-documents.js";
import { importLegacyProjectDocuments } from "./import-documents.js";
import { importLegacyPlacementHistory } from "./import-placements.js";
import { planLegacyMetadata } from "./metadata-plan.js";
import { openLegacyAssets } from "./assets.js";
import {
  assertLegacyImportTarget,
  beginLegacyImport,
  completeLegacyImport,
  legacyImportOperation,
  writeLegacyMetadataFile,
} from "./write-metadata.js";
import { encodeProjectLegacyImport } from "./import-file.js";

const overlaps = (first: string, second: string) => {
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
  };
  return within(first, second) || within(second, first);
};

/** Staged imports remain inactive until verification; only the application owner may later activate the file backend. */
export async function importLegacyProjectContent(input: {
  source: LegacyProjectDocuments;
  project: ProjectContentProject;
  assets: ProjectAssetBlobs;
  legacyAssetRoot?: string;
  author: ContentAuthor;
}) {
  const { source, project, assets, legacyAssetRoot } = input,
    author = { name: input.author.name, email: input.author.email };
  if (
    source.projectId !== project.owned.projectId ||
    assets.owned.projectId !== source.projectId ||
    assets.owned.ownerId !== project.owned.ownerId
  )
    throw new ProjectContentError("unowned");
  await project.owned.verify();
  await assets.owned.verify();
  await source.assertSourceUnchanged();
  const inventory = source.inventory(),
    plan = planLegacyMetadata(source),
    legacy = legacyAssetRoot === undefined ? null : await openLegacyAssets(legacyAssetRoot);
  if (plan.metadata.assets.length && !legacy) throw new ProjectContentError("invalidFile");
  if (
    legacy &&
    (overlaps(legacy.directory, project.owned.directory) || overlaps(legacy.directory, assets.owned.directory))
  )
    throw new ProjectContentError("unowned");
  const knownAssets = new Map(plan.metadata.assets.map((row) => [row.id, row])),
    generatedRevisions = new Set(plan.navigation.generated.map((row) => row.revision.id));
  for (const item of inventory)
    for (const detail of source.versions(item.document)) {
      if (generatedRevisions.has(detail.revision.id)) throw new ProjectContentError("conflict");
      for (const resource of detail.revision.resources ?? [])
        if (knownAssets.get(resource.assetId)?.digest !== resource.digest) throw new ProjectContentError("invalidFile");
    }
  // Validate every binary's actual format and dimensions before changing target content files.
  for (const asset of plan.metadata.assets) await legacy!.read(asset);
  await source.assertSourceUnchanged();
  await assertLegacyImportTarget(project, plan);
  await beginLegacyImport(project, plan, author);
  for (const asset of plan.metadata.assets) await assets.put(asset.digest, await legacy!.read(asset));
  for (const [path, content] of plan.files)
    if (path.startsWith("spaces/")) await writeLegacyMetadataFile(project, source.sourceHash, path, content, author);
  await writeLegacyMetadataFile(project, source.sourceHash, "project.json", plan.files.get("project.json")!, author);
  const originals = await importLegacyProjectDocuments(source, project.owned, author, project);
  for (const detail of plan.navigation.generated)
    await project.documents.put(
      detail,
      null,
      legacyImportOperation(source.sourceHash, "directory", detail.document.id),
      author,
    );
  for (const [path, content] of plan.files)
    if (path !== "project.json" && !path.startsWith("spaces/") && !path.startsWith("placements/"))
      await writeLegacyMetadataFile(project, source.sourceHash, path, content, author);
  await importLegacyPlacementHistory(project, source.sourceHash, plan.metadata.placements, author);
  const commit = await new ProjectGitSnapshots(project.owned).head();
  for (const [path, content] of plan.files) {
    const actual = await project.coordinator.read([path]);
    if (actual.commit !== commit || actual.files.get(path)?.toString() !== content)
      throw new ProjectContentError("conflict");
  }
  for (const detail of [...source.records(), ...plan.navigation.generated.map((row) => row.document)]) {
    if (stableJson((await project.documents.get(detail.id)).document) !== stableJson(detail))
      throw new ProjectContentError("conflict");
  }
  for (const history of plan.metadata.placements)
    for (const event of history.events)
      if (
        stableJson(await project.placements.event(history.current.id, event.placement.version)) !==
        stableJson({ placement: event.placement, ...event.audit })
      )
        throw new ProjectContentError("invalidFile");
  for (const asset of plan.metadata.assets) await assets.read(asset.digest, asset.size);
  await source.assertSourceUnchanged();
  await legacy?.verify();
  await assertLegacyImportTarget(project, plan);
  const completed = await completeLegacyImport(project, plan.marker, author, commit),
    marker = await project.coordinator.read(["import.json"]);
  if (
    marker.commit !== completed.commit ||
    marker.files.get("import.json")?.toString() !== encodeProjectLegacyImport({ ...plan.marker, state: "complete" })
  )
    throw new ProjectContentError("conflict");
  return {
    ...originals,
    commit: completed.commit,
    metadataMigrated: true as const,
    assetsVerified: true as const,
    spaces: plan.metadata.spaces.length,
    assets: plan.metadata.assets.length,
    folders: plan.metadata.folders.length,
    generatedDirectories: plan.navigation.generated.length,
    placementEvents: plan.metadata.placements.reduce((sum, row) => sum + row.events.length, 0),
    navigationOperations: plan.navigation.operations.length,
    applicationCutover: false as const,
  };
}
