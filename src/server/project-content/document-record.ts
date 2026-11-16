import type { DocumentRecord } from "../../shared/documents/contracts.js";
import { ProjectContentError } from "./errors.js";
import { projectContentId } from "./paths.js";
import { fileRecord, fileText, fileInteger, fileDigest, fileLocale } from "./codec-values.js";

export function decodeProjectDocumentRecord(value: unknown): DocumentRecord {
  const d = fileRecord(value, [
    "id",
    "spaceId",
    "path",
    "title",
    "locale",
    "revision",
    "revisionId",
    "contentHash",
    "importedHash",
    "importedRevision",
    "updatedAt",
  ]);
  const path = fileText(d.path, 2048);
  if (
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => !part || part.startsWith(".")) ||
    !/\.(md|mdx|markdown)$/i.test(path)
  )
    throw new ProjectContentError("invalidFile");
  const result: DocumentRecord = {
    id: projectContentId(d.id),
    spaceId: projectContentId(d.spaceId),
    path,
    title: fileText(d.title, 2000),
    locale: fileLocale(d.locale),
    revision: fileInteger(d.revision, 1),
    revisionId: projectContentId(d.revisionId),
    contentHash: fileDigest(d.contentHash),
    importedHash: d.importedHash === null ? null : fileDigest(d.importedHash),
    importedRevision: d.importedRevision === null ? null : fileInteger(d.importedRevision, 1),
    updatedAt: fileInteger(d.updatedAt),
  };
  if (
    (result.importedRevision !== null && result.importedRevision > result.revision) ||
    (result.importedHash === null) !== (result.importedRevision === null)
  )
    throw new ProjectContentError("invalidFile");
  return result;
}
