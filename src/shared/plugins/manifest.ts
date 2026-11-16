import { BUILD_ENGINES } from "../builds/engines.js";
import { validTemplateSnapshot } from "../presentation/template-snapshot.js";
import { validateSiteThemeProfile } from "../presentation/theme-profile.js";
import type { PublicationFormat } from "../publishing/content.js";
import {
  PACKAGE_LIMITS,
  PluginPackageError,
  type PackageChannelTemplate,
  type PackageLabel,
  type PackagePermission,
  type PackageSiteTheme,
  type PackageCodeTheme,
  type PluginManifest,
} from "./contracts.js";
import { packageExportId, packageId, packagePath, packageRecord, packageText, packageVersion } from "./validation.js";
import { pluginExportPermissions, pluginExports } from "./exports.js";

const labelFields = ["name", "description", "labels"];
const supportedPermissions: PackagePermission[] = ["content:site-themes", "content:templates", "build:theme-code"];
const formats: PublicationFormat[] = ["html", "plain", "x-post", "x-thread", "x-article", "wechat", "toutiao"];
function label(input: Record<string, unknown>): PackageLabel {
  const result: PackageLabel = {
    name: packageText(input.name, 120),
    description: packageText(input.description, 1000, true),
  };
  if (input.labels !== undefined) {
    const labels = input.labels;
    if (!labels || typeof labels !== "object" || Array.isArray(labels) || Object.keys(labels).length > 20)
      throw new PluginPackageError("invalidPackage");
    result.labels = {};
    for (const locale of Object.keys(labels).sort()) {
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(locale)) throw new PluginPackageError("invalidPackage");
      const value = packageRecord((labels as Record<string, unknown>)[locale], ["name", "description"]);
      result.labels[locale] = {
        name: packageText(value.name, 120),
        description: packageText(value.description, 1000, true),
      };
    }
  }
  return result;
}
function theme(value: unknown, id: string): PackageSiteTheme {
  if (value && typeof value === "object" && "kind" in value && value.kind === "profile") {
    const input = packageRecord(value, [...labelFields, "kind", "id", "engine", "profile"]);
    if (input.engine !== "hexo" && input.engine !== "docusaurus") throw new PluginPackageError("invalidPackage");
    try {
      return {
        ...label(input),
        kind: "profile",
        id: packageExportId(input.id, id),
        engine: input.engine,
        profile: validateSiteThemeProfile(input.profile, input.engine),
      };
    } catch {
      throw new PluginPackageError("invalidPackage");
    }
  }
  const input = packageRecord(value, [
    ...labelFields,
    "id",
    "engine",
    "engineVersion",
    "root",
    "entry",
    "dependencies",
  ]);
  if (input.engine !== "hexo" && input.engine !== "docusaurus") throw new PluginPackageError("invalidPackage");
  if (input.engineVersion !== BUILD_ENGINES[input.engine]) throw new PluginPackageError("incompatibleEngine");
  const output: PackageCodeTheme = {
    ...label(input),
    id: packageExportId(input.id, id),
    engine: input.engine,
    engineVersion: BUILD_ENGINES[input.engine],
    root: packagePath(input.root),
  };
  if (input.dependencies !== undefined) {
    if (
      !input.dependencies ||
      typeof input.dependencies !== "object" ||
      Array.isArray(input.dependencies) ||
      Object.keys(input.dependencies).length > 32
    )
      throw new PluginPackageError("invalidPackage");
    output.dependencies = Object.fromEntries(
      Object.entries(input.dependencies)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, version]) => {
          if (
            !/^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ||
            typeof version !== "string" ||
            !/^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(version)
          )
            throw new PluginPackageError("invalidPackage");
          return [name, version];
        }),
    );
  }
  if (input.engine === "hexo") {
    if (input.entry !== undefined) throw new PluginPackageError("invalidPackage");
  } else {
    output.entry = packagePath(input.entry);
    if (!/\.(?:c?js|mjs)$/.test(output.entry)) throw new PluginPackageError("invalidPackage");
  }
  return output;
}
function template(value: unknown, id: string, version: string): PackageChannelTemplate {
  const input = packageRecord(value, [...labelFields, "id", "formats", "style"]),
    exportId = packageExportId(input.id, id);
  if (
    !Array.isArray(input.formats) ||
    !input.formats.length ||
    input.formats.length > formats.length ||
    input.formats.some((item) => !formats.includes(item)) ||
    new Set(input.formats).size !== input.formats.length
  )
    throw new PluginPackageError("invalidPackage");
  const style = packageRecord(input.style, ["font", "color", "accent", "width", "size"]);
  try {
    const parsed = validTemplateSnapshot({
      id: `${id}.${exportId}`,
      version,
      style: { ...style, version } as Parameters<typeof validTemplateSnapshot>[0]["style"],
    });
    const { version: _version, ...safeStyle } = parsed.style;
    return { ...label(input), id: exportId, formats: [...input.formats].sort(), style: safeStyle };
  } catch {
    throw new PluginPackageError("invalidPackage");
  }
}
/** The manifest declares only supported exports. Unknown permissions and executable commands fail closed. */
export function validatePluginManifest(value: unknown): PluginManifest {
  const input = packageRecord(value, [
    ...labelFields,
    "schema",
    "id",
    "version",
    "permissions",
    "siteThemes",
    "channelTemplates",
  ]);
  if (input.schema !== 1) throw new PluginPackageError("invalidPackage");
  const id = packageId(input.id),
    version = packageVersion(input.version);
  if (!Array.isArray(input.permissions) || input.permissions.some((item) => !supportedPermissions.includes(item)))
    throw new PluginPackageError("unsupportedPermission");
  if (new Set(input.permissions).size !== input.permissions.length) throw new PluginPackageError("permissionMismatch");
  if (
    !Array.isArray(input.siteThemes) ||
    !Array.isArray(input.channelTemplates) ||
    input.siteThemes.length + input.channelTemplates.length < 1 ||
    input.siteThemes.length + input.channelTemplates.length > PACKAGE_LIMITS.exports
  )
    throw new PluginPackageError("invalidPackage");
  const permissions = input.permissions,
    siteThemes = input.siteThemes.map((item) => theme(item, id)),
    channelTemplates = input.channelTemplates.map((item) => template(item, id, version)),
    exports = { siteThemes, channelTemplates },
    required = pluginExportPermissions(exports, pluginExports(exports));
  if (required.length !== permissions.length || required.some((item) => !permissions.includes(item)))
    throw new PluginPackageError("permissionMismatch");
  const ids = [...siteThemes, ...channelTemplates].map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new PluginPackageError("invalidPackage");
  return {
    schema: 1,
    ...label(input),
    id,
    version,
    permissions: required.sort(),
    siteThemes: siteThemes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    channelTemplates: channelTemplates.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
