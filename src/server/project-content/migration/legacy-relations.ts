import type { DocumentAsset, DocumentFolder } from "../../../shared/documents/contracts.js";
import { decodeAssetRecord } from "../asset-file.js";
import { fileInteger } from "../codec-values.js";
import { decodeProjectLanguages, type ProjectLanguageFile } from "../language-file.js";
import { ProjectContentError } from "../errors.js";
import { decodeLegacyFolder } from "./import-file.js";
import { LegacyMetadataContext } from "./metadata-context.js";

export interface LegacyDocumentTrash {
  documentId: string;
  deletedAt: number;
}
export function readLegacyAssets(context: LegacyMetadataContext): DocumentAsset[] {
  if (!context.tables.has("document_assets")) return [];
  return context
    .rows<DocumentAsset>(
      "SELECT a.* FROM document_assets a JOIN documents d ON d.id=a.documentId JOIN document_spaces s ON s.id=d.spaceId WHERE s.projectId=? ORDER BY a.id",
      [context.projectId],
    )
    .map((row) => {
      const record = decodeAssetRecord(row);
      context.requireDocument(record.documentId);
      return record;
    });
}
export function readLegacyLanguages(context: LegacyMetadataContext): ProjectLanguageFile {
  const groups = new Map<string, string[]>();
  if (context.tables.has("document_languages"))
    for (const row of context.rows<{ documentId: string; groupId: string }>(
      "SELECT l.* FROM document_languages l JOIN documents d ON d.id=l.documentId JOIN document_spaces s ON s.id=d.spaceId WHERE s.projectId=? ORDER BY l.groupId,l.documentId",
      [context.projectId],
    )) {
      const group = groups.get(row.groupId) || [];
      group.push(row.documentId);
      groups.set(row.groupId, group);
    }
  for (const [id, members] of groups) {
    const docs = members.map((id) => context.requireDocument(id));
    if (docs.some((doc) => doc.spaceId !== docs[0]!.spaceId)) throw new ProjectContentError("invalidFile");
    if (
      context.rows(
        "SELECT 1 FROM document_languages l JOIN documents d ON d.id=l.documentId JOIN document_spaces s ON s.id=d.spaceId WHERE l.groupId=? AND s.projectId<>? LIMIT 1",
        [id, context.projectId],
      ).length
    )
      throw new ProjectContentError("invalidFile");
  }
  return decodeProjectLanguages(
    JSON.stringify({
      schema: 1,
      projectId: context.projectId,
      version: 0,
      groups: [...groups].map(([id, documentIds]) => ({ id, documentIds })),
    }),
  );
}
export function readLegacyFolders(context: LegacyMetadataContext, spaces: ReadonlySet<string>): DocumentFolder[] {
  if (!context.tables.has("document_folders")) return [];
  return context
    .rows<DocumentFolder>(
      "SELECT f.* FROM document_folders f JOIN document_spaces s ON s.id=f.spaceId WHERE s.projectId=? ORDER BY f.id",
      [context.projectId],
    )
    .map((row) => {
      const folder = decodeLegacyFolder(row);
      if (!spaces.has(folder.spaceId)) throw new ProjectContentError("invalidFile");
      return folder;
    });
}
export function readLegacyTrash(context: LegacyMetadataContext): LegacyDocumentTrash[] {
  if (!context.tables.has("document_trash")) return [];
  return context
    .rows<LegacyDocumentTrash>(
      "SELECT t.* FROM document_trash t JOIN documents d ON d.id=t.documentId JOIN document_spaces s ON s.id=d.spaceId WHERE s.projectId=? ORDER BY t.documentId",
      [context.projectId],
    )
    .map((row) => {
      context.requireDocument(row.documentId);
      return { documentId: row.documentId, deletedAt: fileInteger(row.deletedAt) };
    });
}
