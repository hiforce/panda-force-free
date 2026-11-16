import { BuildError } from "./errors.js";
import { safeBuildPath, buildBinaryFile } from "./files.js";
import { buildProject } from "./project.js";
import { publicDocumentMetadata } from "../sites/metadata.js";
import { SiteProfileError } from "../sites/config.js";
export { BuildError } from "./errors.js";
export { safeBuildPath } from "./files.js";
import { validateBuildTheme, BuildThemeError } from "./theme.js";
import { BUILD_ENGINES, BUILD_PROTOCOL, type BuildInput, type BuildArtifact } from "./contracts.js";

export const BUILD_LIMITS = { inputBytes: 32 * 1024 * 1024, outputBytes: 64 * 1024 * 1024, files: 2000 };
export function buildId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new BuildError("invalidId");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BuildError("invalidInput");
  return value as Record<string, unknown>;
}
function string(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new BuildError("invalidInput");
  return value;
}
function entries(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new BuildError("invalidInput");
  return value;
}
function uniquePaths(paths: string[]) {
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) throw new BuildError("duplicatePath");
}
/** Reconstruct a closed shape: input cannot pass Docker options, commands or environment variables. */
export function buildInput(value: unknown): BuildInput {
  const input = record(value),
    site = record(input.site);
  if (
    Object.keys(input).some(
      (key) => !["protocol", "engine", "preset", "site", "documents", "assets", "theme", "project"].includes(key),
    )
  )
    throw new BuildError("unsupportedOption");
  if (input.protocol !== BUILD_PROTOCOL || !Object.hasOwn(BUILD_ENGINES, String(input.engine)))
    throw new BuildError("incompatibleProtocol");
  const engine = input.engine as BuildInput["engine"];
  if (input.preset !== (engine === "hexo" ? "reader" : "handbook")) throw new BuildError("unknownPreset");
  let url: URL;
  try {
    url = new URL(string(site.url, 500));
  } catch {
    throw new BuildError("invalidSiteUrl");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new BuildError("invalidSiteUrl");
  const basePath = string(site.basePath, 160);
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath)) throw new BuildError("invalidBasePath");
  const locale = string(site.locale, 35);
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale)) throw new BuildError("invalidLocale");
  const project = input.project === undefined ? undefined : buildProject(input.project);
  const documents = entries(input.documents, 500).map((value) => {
    const doc = record(value),
      path = safeBuildPath(doc.path);
    if (!/\.md$/.test(path)) throw new BuildError("invalidPath");
    try {
      return {
        id: string(doc.id, 128),
        path,
        title: string(doc.title, 200),
        content: string(doc.content, 1024 * 1024),
        ...(doc.metadata !== undefined
          ? { metadata: publicDocumentMetadata(doc.metadata, project?.metadataFields) }
          : {}),
      };
    } catch (error) {
      if (error instanceof SiteProfileError) throw new BuildError("invalidSiteProject");
      throw error;
    }
  });
  if (!documents.length) throw new BuildError("emptyDocuments");
  uniquePaths(documents.map((doc) => doc.path));
  const assets = entries(input.assets, 500).map(buildBinaryFile);
  uniquePaths(assets.map((file) => file.path));
  const result: BuildInput = {
    protocol: 1,
    engine,
    preset: input.preset as BuildInput["preset"],
    site: { title: string(site.title, 200), url: url.origin, basePath, locale },
    documents,
    assets,
  };
  if (input.project !== undefined) {
    result.project = project;
    if (engine !== "hexo") throw new BuildError("invalidSiteProject");
  }
  if (input.theme !== undefined) {
    try {
      result.theme = validateBuildTheme(input.theme, engine);
    } catch (error) {
      if (error instanceof BuildThemeError) throw new BuildError(error.message);
      throw error;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > BUILD_LIMITS.inputBytes)
    throw new BuildError("inputTooLarge", 413);
  return result;
}
export function buildArtifact(value: unknown): BuildArtifact {
  const output = record(value);
  if (output.protocol !== BUILD_PROTOCOL) throw new BuildError("incompatibleProtocol");
  const files = entries(output.files, BUILD_LIMITS.files).map(buildBinaryFile);
  uniquePaths(files.map((file) => file.path));
  const bytes = files.reduce(
    (total, file) =>
      total + (file.data.length / 4) * 3 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0),
    0,
  );
  if (bytes > BUILD_LIMITS.outputBytes || bytes !== output.bytes || !files.some((file) => file.path === "index.html"))
    throw new BuildError("invalidArtifact");
  return { protocol: 1, bytes, files };
}
