import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { siteSourceProfile, type SiteSourceProfile } from "../../shared/sites/profile.js";
import { fileRecord, fileInteger, fileText, fileLocale, fileChoice } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { projectContentId } from "./paths.js";
import { decodeContentJson, encodeContentJson } from "./json-file.js";

export interface ProjectSpaceFile {
  schema: 1;
  space: DocumentSpace;
  sourceProfile: SiteSourceProfile | null;
}
export function decodeSpaceRecord(value: unknown): DocumentSpace {
  const s = fileRecord(value, [
    "id",
    "projectId",
    "code",
    "name",
    "engine",
    "theme",
    "sourceMode",
    "sourceRoot",
    "locale",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  const code = fileText(s.code, 64);
  if (code !== "__documents__" && !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(code))
    throw new ProjectContentError("invalidFile");
  return {
    id: projectContentId(s.id),
    projectId: projectContentId(s.projectId),
    code,
    name: fileText(s.name, 400),
    engine: fileChoice(s.engine, ["markdown", "hexo", "docusaurus"]),
    theme: fileText(s.theme, 400),
    sourceMode: fileChoice(s.sourceMode, ["managed", "external"]),
    sourceRoot: fileText(s.sourceRoot, 16384),
    locale: fileLocale(s.locale),
    version: fileInteger(s.version, 1),
    createdAt: fileInteger(s.createdAt),
    updatedAt: fileInteger(s.updatedAt),
  };
}
function validate(value: unknown): ProjectSpaceFile {
  const root = fileRecord(value, ["schema", "space", "sourceProfile"]);
  if (root.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const space = decodeSpaceRecord(root.space);
  let profile: SiteSourceProfile | null = null;
  if (root.sourceProfile !== null) {
    if (space.engine !== "hexo") throw new ProjectContentError("invalidFile");
    try {
      profile = siteSourceProfile(root.sourceProfile);
    } catch {
      throw new ProjectContentError("invalidFile");
    }
  }
  return { schema: 1, space, sourceProfile: profile };
}
export function encodeProjectSpace(value: ProjectSpaceFile): string {
  const valid = validate(value);
  // Every newly written space must be readable through the bounded header port as well as the full codec.
  if (Buffer.byteLength(JSON.stringify({ space: valid.space }, null, 2)) > 65536)
    throw new ProjectContentError("invalidFile");
  return encodeContentJson(valid, validate, ["space", "sourceProfile", "schema"]);
}
export const decodeProjectSpace = (bytes: Uint8Array | string) => decodeContentJson(bytes, validate);
