import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { encodeProjectDocument } from "../document-file.js";
import { ProjectContentProject } from "../project.js";
import { ProjectContentError } from "../errors.js";
import type { ContentAuthor } from "../git/process.js";
import { ProjectGitSnapshots } from "../git/snapshot.js";
import type { OwnedProjectDirectory } from "../owned-directory.js";
import type { LegacyProjectDocuments, LegacyDocumentInventory } from "./legacy-documents.js";
import { PROJECT_CONTENT_LIMITS } from "../limits.js";

export interface LegacyDocumentImport {
  projectId: string;
  sourceHash: string;
  sourceSchema: number;
  commit: string;
  documents: LegacyDocumentInventory[];
  revisions: number;
  currentAndHistoricalVerified: true;
  metadataMigrated: false;
  applicationCutover: false;
}

/** Validate the entire original history before any target writes; partial imports replay the same immutable operation IDs. */
export async function importLegacyProjectDocuments(
  source: LegacyProjectDocuments,
  target: OwnedProjectDirectory,
  author: ContentAuthor,
  project = new ProjectContentProject(target),
): Promise<LegacyDocumentImport> {
  if (source.projectId !== target.projectId || project.owned !== target) throw new ProjectContentError("unowned");
  await target.verify();
  await source.assertSourceUnchanged();
  const documents = source.inventory(),
    store = project.documents;
  if (documents.length > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
  for (const item of documents) {
    const actual = createHash("sha256");
    for (const detail of source.versions(item.document)) {
      const operation =
        "legacy-" +
        createHash("sha256")
          .update(stableJson({ project: source.projectId, document: detail.document.id, revision: detail.revision.id }))
          .digest("hex");
      const saved = await store.put(
        detail,
        detail.revision.number === 1 ? null : detail.revision.number - 1,
        operation,
        author,
      );
      if (encodeProjectDocument(saved) !== encodeProjectDocument(detail)) throw new ProjectContentError("invalidFile");
      actual.update(createHash("sha256").update(encodeProjectDocument(saved)).digest());
    }
    if (actual.digest("hex") !== item.historyHash) throw new ProjectContentError("invalidFile");
    for (const detail of source.versions(item.document)) {
      const historical = await store.revision(detail.document.id, detail.revision.id);
      if (stableJson(historical) !== stableJson(detail.revision)) throw new ProjectContentError("invalidFile");
    }
    const head = await store.get(item.document.id);
    if (stableJson(head.document) !== stableJson(item.document)) throw new ProjectContentError("invalidFile");
  }
  await source.assertSourceUnchanged();
  return {
    projectId: source.projectId,
    sourceHash: source.sourceHash,
    sourceSchema: source.schema,
    commit: await new ProjectGitSnapshots(target).head(),
    documents,
    revisions: documents.reduce((sum, row) => sum + row.revisions, 0),
    currentAndHistoricalVerified: true,
    metadataMigrated: false,
    applicationCutover: false,
  };
}
