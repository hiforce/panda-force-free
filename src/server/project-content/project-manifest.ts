import { fileRecord, fileInteger } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { projectContentId } from "./paths.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";
import type { ProjectContentView } from "./read-view.js";

export interface ProjectContentManifest {
  schema: 1;
  projectId: string;
  version: number;
  librarySpaceId: string | null;
  spaceIds: string[];
}
function validate(value: unknown): ProjectContentManifest {
  const v = fileRecord(value, ["schema", "projectId", "version", "librarySpaceId", "spaceIds"]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  if (!Array.isArray(v.spaceIds) || v.spaceIds.length > PROJECT_CONTENT_LIMITS.files)
    throw new ProjectContentError("invalidFile");
  const ids = v.spaceIds.map(projectContentId),
    library = v.librarySpaceId === null ? null : projectContentId(v.librarySpaceId);
  if (new Set(ids).size !== ids.length || (library !== null && !ids.includes(library)))
    throw new ProjectContentError("invalidFile");
  return {
    schema: 1,
    projectId: projectContentId(v.projectId),
    version: fileInteger(v.version),
    librarySpaceId: library,
    spaceIds: ids,
  };
}
export const encodeProjectManifest = (value: ProjectContentManifest) => encodeContentJson(value, validate);
export const decodeProjectManifest = (bytes: Uint8Array | string) => decodeContentJson(bytes, validate);

export async function readProjectManifest(
  view: ProjectContentView,
  projectId: string,
): Promise<ProjectContentManifest> {
  projectContentId(projectId);
  const bytes = await view.read("project.json"),
    manifest: ProjectContentManifest =
      bytes === null
        ? { schema: 1, projectId, version: 0, librarySpaceId: null, spaceIds: [] }
        : decodeProjectManifest(bytes);
  if (manifest.projectId !== projectId) throw new ProjectContentError("invalidFile");
  const tracked = new Set(view.paths.filter((path) => path.startsWith("spaces/")).map((path) => path.slice(7, -11)));
  if (tracked.size !== manifest.spaceIds.length || manifest.spaceIds.some((id) => !tracked.has(id)))
    throw new ProjectContentError("conflict");
  return manifest;
}
