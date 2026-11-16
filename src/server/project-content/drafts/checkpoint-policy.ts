import { richBodyImageIds } from "../../../shared/documents/rich-body.js";
import { decodeAssetRecords, projectAssetFile, projectAssetShard, type ProjectAssetRecords } from "../asset-file.js";
import { readProjectDocumentMetadata } from "../document-metadata.js";
import { ProjectContentError } from "../errors.js";
import { decodeProjectLanguages } from "../language-file.js";
import type { ProjectContentView } from "../read-view.js";
import type { ProjectDraftContent } from "./content.js";

/** Saving validates owned image references and current language-group uniqueness inside the same project snapshot. */
export async function assertCheckpointContent(
  view: ProjectContentView,
  projectId: string,
  documentId: string,
  spaceId: string,
  content: ProjectDraftContent,
) {
  const ids = new Set([
      ...(content.body ? richBodyImageIds(content.body) : []),
      ...(content.resources ?? []).map((row) => row.assetId),
    ]),
    shards = new Map<string, ProjectAssetRecords>();
  for (const id of ids) {
    const path = projectAssetFile(id);
    let file = shards.get(path);
    if (!file) {
      const bytes = await view.read(path);
      if (bytes === null) throw new ProjectContentError("invalidFile");
      file = decodeAssetRecords(bytes);
      if (file.projectId !== projectId || file.shard !== projectAssetShard(id))
        throw new ProjectContentError("invalidFile");
      shards.set(path, file);
    }
    const asset = file.assets.find((row) => row.id === id);
    if (
      !asset ||
      asset.documentId !== documentId ||
      (content.resources ?? []).some((row) => row.assetId === id && row.digest !== asset.digest)
    )
      throw new ProjectContentError("invalidFile");
  }
  const bytes = await view.read("languages.json");
  if (bytes === null) return;
  const languages = decodeProjectLanguages(bytes);
  if (languages.projectId !== projectId) throw new ProjectContentError("invalidFile");
  for (const id of languages.groups.find((row) => row.documentIds.includes(documentId))?.documentIds ?? []) {
    if (id === documentId) continue;
    const { document } = await readProjectDocumentMetadata(view, id);
    if (document.spaceId !== spaceId) throw new ProjectContentError("invalidFile");
    if (document.locale.toLowerCase() === content.locale.toLowerCase()) throw new ProjectContentError("conflict");
  }
}
