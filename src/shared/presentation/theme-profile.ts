import type { BuildEngine } from "../builds/engines.js";

export interface SiteThemeProfile {
  layout: "reader" | "journal" | "handbook" | "reference";
  font: "sans" | "serif";
  accent: string;
  width: number;
  density: "comfortable" | "compact";
}
export class ThemeProfileError extends Error {
  constructor() {
    super("invalidThemeProfile");
  }
}
export function sameSiteThemeProfile(left: SiteThemeProfile, right: SiteThemeProfile): boolean {
  return (["layout", "font", "accent", "width", "density"] as const).every((key) => left[key] === right[key]);
}
/** Shared by package intake and build snapshots; profiles contain no CSS text, code or resource paths. */
export function validateSiteThemeProfile(value: unknown, engine: BuildEngine): SiteThemeProfile {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["layout", "font", "accent", "width", "density"].includes(key))
  )
    throw new ThemeProfileError();
  const profile = value as Record<string, unknown>;
  if (
    !["hexo", "docusaurus"].includes(engine) ||
    !(engine === "hexo" ? ["reader", "journal"] : ["handbook", "reference"]).includes(String(profile.layout)) ||
    !["sans", "serif"].includes(String(profile.font)) ||
    !["comfortable", "compact"].includes(String(profile.density)) ||
    typeof profile.accent !== "string" ||
    !/^#[a-f0-9]{6}$/i.test(profile.accent) ||
    !Number.isSafeInteger(profile.width) ||
    Number(profile.width) < 640 ||
    Number(profile.width) > 1280
  )
    throw new ThemeProfileError();
  return {
    layout: profile.layout as SiteThemeProfile["layout"],
    font: profile.font as SiteThemeProfile["font"],
    accent: profile.accent,
    width: Number(profile.width),
    density: profile.density as SiteThemeProfile["density"],
  };
}
