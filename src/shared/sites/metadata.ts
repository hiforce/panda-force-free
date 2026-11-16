import { publicValue, SiteProfileError, type PublicValue } from "./config.js";
import { sourceRelativePath } from "./profile.js";
export type PublicDocumentMetadata = Record<string, PublicValue>;
export const publicMetadataKeys = [
  "layout",
  "title",
  "title_html",
  "subtitle",
  "description",
  "slug",
  "translation_key",
  "date",
  "updated",
  "tags",
  "categories",
  "cover",
  "cover_width",
  "cover_height",
  "cover_alt",
  "eyebrow",
  "permalink",
  "published",
  "draft",
];
export function publicDocumentMetadata(value: unknown, fields: string[] = []): PublicDocumentMetadata {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !publicMetadataKeys.includes(key) && !fields.includes(key))
  )
    throw new SiteProfileError("invalidMetadata");
  const parsed = publicValue(value) as PublicDocumentMetadata;
  if (JSON.stringify(parsed).length > 32 * 1024) throw new SiteProfileError("invalidMetadata");
  for (const key of ["slug", "layout", "permalink"]) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] !== "string") throw new SiteProfileError("invalidMetadata");
    sourceRelativePath(String(parsed[key]).replace(/\/$/, ""));
  }
  for (const key of ["date", "updated"])
    if (
      parsed[key] !== undefined &&
      (typeof parsed[key] !== "string" ||
        !/^\d{4}-\d\d-\d\d(?:[T ][\d:.+-]+Z?)?$/.test(String(parsed[key])) ||
        !Number.isFinite(Date.parse(String(parsed[key]))))
    )
      throw new SiteProfileError("invalidMetadata");
  for (const key of ["cover_width", "cover_height"])
    if (
      parsed[key] !== undefined &&
      (!Number.isSafeInteger(parsed[key]) || Number(parsed[key]) < 1 || Number(parsed[key]) > 20000)
    )
      throw new SiteProfileError("invalidMetadata");
  for (const key of ["published", "draft"])
    if (parsed[key] !== undefined && typeof parsed[key] !== "boolean") throw new SiteProfileError("invalidMetadata");
  for (const key of [
    "title",
    "title_html",
    "subtitle",
    "description",
    "translation_key",
    "cover",
    "cover_alt",
    "eyebrow",
  ])
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") throw new SiteProfileError("invalidMetadata");
  return parsed;
}
