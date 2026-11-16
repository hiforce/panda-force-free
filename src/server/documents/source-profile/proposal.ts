import type { SiteSourceProfile, SourceConfigurationOptions, SiteEdition } from "../../../shared/sites/profile.js";
import { siteSourceProfile } from "../../../shared/sites/profile.js";

/** Both storage adapters project the same public profile; source paths and operational secrets never enter this value. */
export function proposedSourceProfile(
  prior: SiteSourceProfile | null,
  options: SourceConfigurationOptions,
  edition: SiteEdition,
  locale: string,
  webp: boolean,
): SiteSourceProfile {
  return siteSourceProfile({
    schema: 1,
    engine: "hexo",
    imageMode: webp ? "source-webp" : "managed",
    localizedImages: prior?.localizedImages || (webp ? { en: ["-en", "_en", "en"] } : {}),
    resources:
      prior?.resources ||
      (options.assets
        ? [
            {
              directory: "assets",
              target: "assets",
              extensions: ["css", "js", "svg", "webp", "jpg", "jpeg", ...(webp ? [] : ["png"])],
              publish: true,
            },
          ]
        : []),
    editions: { ...prior?.editions, [locale]: edition },
    ...(prior?.articleAssetRoot
      ? { articleAssetRoot: prior.articleAssetRoot }
      : webp
        ? { articleAssetRoot: "assets/articles" }
        : {}),
    ...(prior?.metadataFields ? { metadataFields: prior.metadataFields } : {}),
  });
}
