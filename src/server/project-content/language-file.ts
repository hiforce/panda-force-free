import { fileInteger, fileRecord } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { projectContentId } from "./paths.js";

export interface ProjectLanguageGroup {
  id: string;
  documentIds: string[];
}
export interface ProjectLanguageFile {
  schema: 1;
  projectId: string;
  version: number;
  groups: ProjectLanguageGroup[];
}
function validate(value: unknown): ProjectLanguageFile {
  const v = fileRecord(value, ["schema", "projectId", "version", "groups"]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  if (!Array.isArray(v.groups) || v.groups.length > PROJECT_CONTENT_LIMITS.files)
    throw new ProjectContentError("invalidFile");
  const groups = new Set<string>(),
    documents = new Set<string>();
  const result = v.groups.map((value): ProjectLanguageGroup => {
    const g = fileRecord(value, ["id", "documentIds"]),
      id = projectContentId(g.id);
    if (
      groups.has(id) ||
      !Array.isArray(g.documentIds) ||
      !g.documentIds.length ||
      g.documentIds.length > PROJECT_CONTENT_LIMITS.files
    )
      throw new ProjectContentError("invalidFile");
    groups.add(id);
    const ids = g.documentIds.map(projectContentId);
    for (const id of ids) {
      if (documents.has(id)) throw new ProjectContentError("invalidFile");
      documents.add(id);
    }
    return { id, documentIds: ids };
  });
  return { schema: 1, projectId: projectContentId(v.projectId), version: fileInteger(v.version), groups: result };
}
export const encodeProjectLanguages = (value: ProjectLanguageFile) => encodeContentJson(value, validate);
export const decodeProjectLanguages = (value: Uint8Array | string) => decodeContentJson(value, validate);
