import {
  isProfileTheme,
  PACKAGE_LIMITS,
  PluginPackageError,
  type PackagePermission,
  type PluginManifest,
} from "./contracts.js";
import { packageRecord } from "./validation.js";

export interface PluginExportRef {
  kind: "site-theme" | "channel-template";
  id: string;
}
export interface InstalledPluginExport extends PluginExportRef {
  enabled: boolean;
  active: boolean;
}
export const samePluginExport = (a: PluginExportRef, b: PluginExportRef) => a.kind === b.kind && a.id === b.id;
type PluginExportManifest = Pick<PluginManifest, "siteThemes" | "channelTemplates">;
export function pluginExports(manifest: PluginExportManifest): PluginExportRef[] {
  return [
    ...manifest.siteThemes.map(({ id }): PluginExportRef => ({ kind: "site-theme", id })),
    ...manifest.channelTemplates.map(({ id }): PluginExportRef => ({ kind: "channel-template", id })),
  ];
}
/** Selection changes installation authority, never the immutable package or its digest. */
export function selectPluginExports(manifest: PluginManifest, value?: unknown): PluginExportRef[] {
  const available = pluginExports(manifest);
  if (value === undefined) return available;
  if (!Array.isArray(value) || !value.length || value.length > PACKAGE_LIMITS.exports)
    throw new PluginPackageError("invalidPackage");
  const seen = new Set<string>();
  for (const raw of value) {
    const item = packageRecord(raw, ["kind", "id"]);
    const entry = available.find((entry) => entry.kind === item.kind && entry.id === item.id);
    if (!entry || seen.has(entry.id)) throw new PluginPackageError("invalidPackage");
    seen.add(entry.id);
  }
  return available.filter((item) => seen.has(item.id));
}
export function pluginExportPermissions(
  manifest: PluginExportManifest,
  selected: readonly PluginExportRef[],
): PackagePermission[] {
  const permissions = new Set<PackagePermission>();
  for (const entry of selected) {
    if (entry.kind === "channel-template") {
      if (!manifest.channelTemplates.some((item) => item.id === entry.id))
        throw new PluginPackageError("invalidPackage");
      permissions.add("content:templates");
    } else {
      const theme = manifest.siteThemes.find((item) => item.id === entry.id);
      if (!theme) throw new PluginPackageError("invalidPackage");
      permissions.add("content:site-themes");
      if (!isProfileTheme(theme)) permissions.add("build:theme-code");
    }
  }
  return [...permissions].sort();
}
