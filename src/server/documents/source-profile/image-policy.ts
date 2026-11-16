import { posix } from "node:path";
import type { SiteSourceProfile } from "../../../shared/sites/profile.js";
import { sourceMetadata } from "./yaml.js";

export interface SourceImagePolicy {
  webp: boolean;
  suffixes: string[];
  metadataSources: string[];
}
export function sourceImagePolicy(
  profile: SiteSourceProfile | null,
  locale: string,
  content: string,
): SourceImagePolicy | undefined {
  if (!profile || profile.imageMode !== "source-webp") return;
  const meta = sourceMetadata(content, profile.metadataFields),
    sources: string[] = [];
  if (typeof meta.cover === "string" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(meta.cover)) {
    if (meta.cover.startsWith("/")) sources.push(meta.cover);
    else if (profile.articleAssetRoot && typeof meta.slug === "string")
      sources.push(`/${profile.articleAssetRoot}/${meta.slug}/${meta.cover}`);
  }
  return {
    webp: true,
    suffixes: profile.localizedImages[locale] || profile.localizedImages[locale.split("-")[0]!] || [],
    metadataSources: sources,
  };
}
export function localizedImageCandidates(path: string, suffixes: string[]): string[] {
  const parsed = posix.parse(path),
    extensions = [...new Set([parsed.ext.toLowerCase(), ".png", ".jpg", ".jpeg"])];
  return [
    ...suffixes.flatMap((suffix) => extensions.map((ext) => posix.join(parsed.dir, parsed.name + suffix + ext))),
    path,
  ];
}
export const companionWebp = (path: string) => path.replace(/\.(?:png|jpe?g|webp)$/i, ".webp");
