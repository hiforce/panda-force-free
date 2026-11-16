import { publicSiteConfig, type PublicValue } from "../sites/config.js";
import { sourceAssetExtensions } from "../sites/profile.js";
import { metadataFieldNames } from "../sites/profile.js";
import { buildBinaryFile } from "./files.js";
import { BuildError } from "./errors.js";
import { packageSha256 } from "../plugins/validation.js";

export const SITE_PROJECT_PROTOCOL = "site-projects/v1";
export interface BuildProjectSnapshot {
  schema: 1;
  engine: "hexo";
  config: Record<string, PublicValue>;
  metadataFields?: string[];
  files: { path: string; data: string; sha256: string; publish: boolean }[];
}
export interface BuildProjectMetadata {
  schema: 1;
  engine: "hexo";
  config: Record<string, PublicValue>;
  metadataFields?: string[];
  files: { path: string; sha256: string; publish: boolean; bytes: number }[];
}
export function buildProject(value: unknown): BuildProjectSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BuildError("invalidSiteProject");
  const input = value as Record<string, unknown>;
  if (
    input.schema !== 1 ||
    input.engine !== "hexo" ||
    Object.keys(input).some((key) => !["schema", "engine", "config", "files", "metadataFields"].includes(key)) ||
    !Array.isArray(input.files) ||
    input.files.length > 500
  )
    throw new BuildError("invalidSiteProject");
  const paths = new Set<string>(),
    directories = new Map<string, string>();
  try {
    return {
      schema: 1,
      engine: "hexo",
      config: publicSiteConfig(input.config),
      ...(input.metadataFields !== undefined ? { metadataFields: metadataFieldNames(input.metadataFields) } : {}),
      files: input.files.map((value) => {
        const file = buildBinaryFile(value),
          fields = value as Record<string, unknown>,
          key = file.path.normalize("NFC").toLowerCase();
        if (
          !file.path.startsWith("assets/") ||
          !sourceAssetExtensions.includes(file.path.split(".").at(-1)!.toLowerCase()) ||
          typeof fields.publish !== "boolean" ||
          Object.keys(fields).some((key) => !["path", "data", "sha256", "publish"].includes(key)) ||
          paths.has(key) ||
          directories.has(key)
        )
          throw new BuildError("invalidSiteProject");
        const parts = file.path.split("/");
        for (let index = 1; index < parts.length; index++) {
          const path = parts.slice(0, index).join("/"),
            normalized = path.normalize("NFC").toLowerCase();
          if (paths.has(normalized) || (directories.has(normalized) && directories.get(normalized) !== path))
            throw new BuildError("invalidSiteProject");
          directories.set(normalized, path);
        }
        paths.add(key);
        return { ...file, publish: fields.publish };
      }),
    };
  } catch {
    throw new BuildError("invalidSiteProject");
  }
}
export async function verifyBuildProject(value: BuildProjectSnapshot) {
  const project = buildProject(value);
  for (const file of project.files)
    if ((await packageSha256(Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)))) !== file.sha256)
      throw new BuildError("inputDigestMismatch");
  return project;
}
export const buildProjectMetadata = (value: BuildProjectSnapshot): BuildProjectMetadata => ({
  schema: value.schema,
  engine: value.engine,
  config: structuredClone(value.config),
  ...(value.metadataFields ? { metadataFields: [...value.metadataFields] } : {}),
  files: value.files.map(({ path, sha256, publish, data }) => ({
    path,
    sha256,
    publish,
    bytes: (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0),
  })),
});
