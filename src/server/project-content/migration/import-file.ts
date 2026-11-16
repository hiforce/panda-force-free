import type { DocumentFolder } from "../../../shared/documents/contracts.js";
import { fileChoice, fileDigest, fileInteger, fileRecord, fileText } from "../codec-values.js";
import { decodeContentJson, encodeContentJson } from "../json-file.js";
import { projectContentId } from "../paths.js";
import { ProjectContentError } from "../errors.js";
import { PROJECT_CONTENT_LIMITS } from "../limits.js";

export interface ProjectLegacyImportFile {
  schema: 1;
  state: "importing" | "complete";
  projectId: string;
  sourceHash: string;
  sourceSchema: number;
  navigationSchema: number;
  folders: { original: DocumentFolder; documentId: string | null }[];
}
export function decodeLegacyFolder(value: unknown): DocumentFolder {
  const row = fileRecord(value, ["id", "spaceId", "path", "version", "createdAt", "updatedAt"]),
    path = fileText(row.path, 2048);
  if (path.includes("\\") || path.includes(":") || path.split("/").some((part) => !part || part.startsWith(".")))
    throw new ProjectContentError("invalidFile");
  return {
    id: projectContentId(row.id),
    spaceId: projectContentId(row.spaceId),
    path,
    version: fileInteger(row.version, 1),
    createdAt: fileInteger(row.createdAt),
    updatedAt: fileInteger(row.updatedAt),
  };
}
function validate(value: unknown): ProjectLegacyImportFile {
  const v = fileRecord(value, [
    "schema",
    "projectId",
    "sourceHash",
    "sourceSchema",
    "navigationSchema",
    "folders",
    "state",
  ]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const sourceSchema = fileInteger(v.sourceSchema, 1),
    navigationSchema = fileInteger(v.navigationSchema);
  if (
    sourceSchema > 6 ||
    navigationSchema > 2 ||
    !Array.isArray(v.folders) ||
    v.folders.length > PROJECT_CONTENT_LIMITS.files
  )
    throw new ProjectContentError("invalidFile");
  const ids = new Set<string>(),
    paths = new Set<string>(),
    folders = v.folders.map((value) => {
      const row = fileRecord(value, ["original", "documentId"]),
        original = decodeLegacyFolder(row.original),
        key = JSON.stringify([original.spaceId, original.path]);
      if (ids.has(original.id) || paths.has(key)) throw new ProjectContentError("invalidFile");
      ids.add(original.id);
      paths.add(key);
      return { original, documentId: row.documentId === null ? null : projectContentId(row.documentId) };
    });
  return {
    schema: 1,
    state: fileChoice(v.state, ["importing", "complete"]),
    projectId: projectContentId(v.projectId),
    sourceHash: fileDigest(v.sourceHash),
    sourceSchema,
    navigationSchema,
    folders,
  };
}
export const encodeProjectLegacyImport = (value: ProjectLegacyImportFile) => encodeContentJson(value, validate);
export const decodeProjectLegacyImport = (value: Uint8Array | string) => decodeContentJson(value, validate);
