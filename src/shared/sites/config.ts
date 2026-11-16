export type PublicValue = string | number | boolean | null | PublicValue[] | { [key: string]: PublicValue };
export class SiteProfileError extends Error {}
export const publicConfigKeys = [
  "author",
  "subtitle",
  "description",
  "keywords",
  "timezone",
  "blog_language",
  "google_tag_id",
  "default_category",
  "category_map",
  "tag_map",
  "per_page",
  "pagination_dir",
  "theme_config",
  "asset_cdn_base_url",
  "feed",
  "sitemap",
  "highlight",
  "prismjs",
  "marked",
  "pretty_urls",
  "future",
] as const;
export const privateConfigKey = (key: string) =>
  /password|credential|secret|apikey|accesskey|privatekey|refreshtoken|accesstoken|authtoken|bearertoken/.test(
    key.toLowerCase().replace(/[_-]/g, ""),
  ) ||
  /(?:^|[_-])token$/i.test(key) ||
  /^(?:token|authorization)$/i.test(key) ||
  ["__proto__", "constructor", "prototype"].includes(key);
/** Only bounded JSON can enter generated configuration; no environment, functions or YAML custom types. */
export function publicValue(value: unknown, depth = 0): PublicValue {
  if (depth > 8) throw new SiteProfileError("invalidProfile");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 8000 && !/[\p{Cc}]/u.test(value.replace(/[\r\n\t]/g, "")))
    return value;
  if (Array.isArray(value) && value.length <= 256) return value.map((item) => publicValue(item, depth + 1));
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length <= 128
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key.length > 100 || privateConfigKey(key)) throw new SiteProfileError("privateConfiguration");
        return [key, publicValue(item, depth + 1)];
      }),
    );
  }
  throw new SiteProfileError("invalidProfile");
}
export function publicSiteConfig(value: unknown): Record<string, PublicValue> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !(publicConfigKeys as readonly string[]).includes(key))
  )
    throw new SiteProfileError("invalidProfile");
  const config = publicValue(value) as Record<string, PublicValue>;
  if (JSON.stringify(config).length > 64 * 1024) throw new SiteProfileError("invalidProfile");
  if (config.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(config.timezone) });
    } catch {
      throw new SiteProfileError("invalidProfile");
    }
  }
  if (config.asset_cdn_base_url) {
    let url: URL;
    try {
      url = new URL(String(config.asset_cdn_base_url));
    } catch {
      throw new SiteProfileError("invalidProfile");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new SiteProfileError("privateConfiguration");
  }
  return config;
}
