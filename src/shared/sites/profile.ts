import { publicSiteConfig, privateConfigKey, SiteProfileError, type PublicValue } from "./config.js";
export interface SourceResourceRule {
  directory: string;
  target: string;
  extensions: string[];
  publish: boolean;
}
export interface SiteEdition {
  title: string;
  url: string;
  basePath: string;
  config: Record<string, PublicValue>;
}
export interface SiteSourceProfile {
  schema: 1;
  engine: "hexo";
  imageMode: "managed" | "source-webp";
  localizedImages: Record<string, string[]>;
  resources: SourceResourceRule[];
  editions: Record<string, SiteEdition>;
  articleAssetRoot?: string;
  metadataFields?: string[];
}
export interface SourceConfigurationOptions {
  files: string[];
  themes: string[];
  assets: boolean;
}
export interface SourceConfigurationProposal {
  profile: SiteSourceProfile;
  omitted: string[];
  spaceVersion: number;
}
export const sourceAssetExtensions = ["css", "js", "svg", "png", "jpg", "jpeg", "webp", "woff", "woff2", "ico"];
export function sourceRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    /[\\?#:%\p{Cc}]/u.test(value) ||
    value
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.length > 100 || new TextEncoder().encode(part).length > 255)
  )
    throw new SiteProfileError("invalidProfile");
  return value;
}
export function sourceLocale(value: string) {
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value) || value.length > 35)
    throw new SiteProfileError("invalidProfile");
  return value;
}
function record(value: unknown, fields?: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (fields && Object.keys(value).some((key) => !fields.includes(key)))
  )
    throw new SiteProfileError("invalidProfile");
  return value as Record<string, unknown>;
}
export function siteEdition(value: unknown): SiteEdition {
  const input = record(value, ["title", "url", "basePath", "config"]);
  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new SiteProfileError("invalidProfile");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 200 ||
    typeof input.basePath !== "string" ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(input.basePath)
  )
    throw new SiteProfileError("invalidProfile");
  return { title: input.title, url: url.origin, basePath: input.basePath, config: publicSiteConfig(input.config) };
}
export function siteSourceProfile(value: unknown): SiteSourceProfile {
  const input = record(value, [
    "schema",
    "engine",
    "imageMode",
    "localizedImages",
    "resources",
    "editions",
    "articleAssetRoot",
    "metadataFields",
  ]);
  if (
    input.schema !== 1 ||
    input.engine !== "hexo" ||
    !["managed", "source-webp"].includes(String(input.imageMode)) ||
    !Array.isArray(input.resources) ||
    input.resources.length > 8
  )
    throw new SiteProfileError("invalidProfile");
  const localized = record(input.localizedImages),
    editions = record(input.editions);
  if (Object.keys(localized).length > 20 || !Object.keys(editions).length || Object.keys(editions).length > 20)
    throw new SiteProfileError("invalidProfile");
  return {
    schema: 1,
    engine: "hexo",
    imageMode: input.imageMode as SiteSourceProfile["imageMode"],
    ...(input.articleAssetRoot !== undefined ? { articleAssetRoot: sourceRelativePath(input.articleAssetRoot) } : {}),
    ...(input.metadataFields !== undefined ? { metadataFields: metadataFieldNames(input.metadataFields) } : {}),
    localizedImages: Object.fromEntries(
      Object.entries(localized).map(([key, suffixes]) => {
        sourceLocale(key);
        if (
          !Array.isArray(suffixes) ||
          suffixes.length > 4 ||
          suffixes.some((suffix) => typeof suffix !== "string" || !/^[a-z_-]{1,12}$/.test(suffix))
        )
          throw new SiteProfileError("invalidProfile");
        return [key, [...new Set(suffixes)] as string[]];
      }),
    ),
    resources: input.resources.map((value) => {
      const rule = record(value, ["directory", "target", "extensions", "publish"]),
        directory = sourceRelativePath(rule.directory),
        target = sourceRelativePath(rule.target);
      if (
        !(target === "assets" || target.startsWith("assets/")) ||
        typeof rule.publish !== "boolean" ||
        !Array.isArray(rule.extensions) ||
        !rule.extensions.length ||
        rule.extensions.length > sourceAssetExtensions.length ||
        rule.extensions.some((ext) => !sourceAssetExtensions.includes(String(ext)))
      )
        throw new SiteProfileError("invalidProfile");
      return { directory, target, extensions: [...new Set(rule.extensions)] as string[], publish: rule.publish };
    }),
    editions: Object.fromEntries(
      Object.entries(editions).map(([locale, value]) => [sourceLocale(locale), siteEdition(value)]),
    ),
  };
}
export function metadataFieldNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some(
      (key) =>
        typeof key !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        privateConfigKey(key) ||
        ["content", "raw", "source", "full_source", "path", "asset_dir"].includes(key),
    )
  )
    throw new SiteProfileError("invalidMetadata");
  return [...new Set(value)] as string[];
}
