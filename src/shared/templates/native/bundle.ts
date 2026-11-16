import type { CapturedPackageSource } from "../../packages/sources/snapshot.js";
import { DEFAULT_SOURCE_LIMITS, type SourceFile } from "../../packages/sources/contracts.js";
import { SourcePaths, sourcePath } from "../../packages/sources/paths.js";
import { NativeThemeError, type NativeThemeSettings } from "./contracts.js";
import { nativeThemeSettings } from "./settings.js";
import { templateObject, templateDigest, templateInteger, templateList } from "../portable/validation.js";

export const NATIVE_THEME_BUNDLE_FILE = "panda-native-theme.json";
export const NATIVE_THEME_BUNDLE_SCHEMA = "panda.native-theme-bundle/v1";
export const NATIVE_THEME_BUNDLE_METADATA_BYTES = 8 * 1024 * 1024;
export interface NativeThemeBundleManifest {
  schema: typeof NATIVE_THEME_BUNDLE_SCHEMA;
  root: "theme";
  settings: Readonly<NativeThemeSettings>;
  files: readonly SourceFile[];
  provenance: { themeDigest: string; projectionDigest: string };
}

/** Export provenance is a content reference, never a claimed repository identity, principal or execution grant. */
export function nativeThemeBundleManifest(value: unknown): NativeThemeBundleManifest {
  try {
    const row = templateObject(value, ["schema", "root", "settings", "files", "provenance"]),
      provenance = templateObject(row.provenance, ["themeDigest", "projectionDigest"]),
      settings = nativeThemeSettings(row.settings),
      paths = new SourcePaths();
    if (row.schema !== NATIVE_THEME_BUNDLE_SCHEMA || row.root !== "theme") throw new NativeThemeError("invalidInput");
    let total = 0;
    const files = templateList(
      row.files,
      (value) => {
        const file = templateObject(value, ["path", "bytes", "sha256"]),
          path = paths.add(sourcePath(file.path)),
          bytes = templateInteger(file.bytes, 0, DEFAULT_SOURCE_LIMITS.fileBytes);
        if (
          !path.startsWith("theme/") &&
          (!path.startsWith("notices/") || (path !== settings.license.file && path !== settings.readme))
        )
          throw new NativeThemeError("invalidInput");
        total += bytes;
        return { path, bytes, sha256: templateDigest(file.sha256) };
      },
      DEFAULT_SOURCE_LIMITS.files - 1,
      1,
    );
    if (total > DEFAULT_SOURCE_LIMITS.totalBytes || !files.some((file) => file.path.startsWith("theme/")))
      throw new NativeThemeError("invalidInput");
    const includes = (path: string) => files.some((file) => file.path === path);
    if (!includes(settings.license.file) || (settings.readme !== null && !includes(settings.readme)))
      throw new NativeThemeError("invalidInput");
    return {
      schema: NATIVE_THEME_BUNDLE_SCHEMA,
      root: "theme",
      settings,
      files,
      provenance: {
        themeDigest: templateDigest(provenance.themeDigest),
        projectionDigest: templateDigest(provenance.projectionDigest),
      },
    };
  } catch {
    throw new NativeThemeError("invalidInput");
  }
}

/** The immutable intake tree already verifies bytes. A closed bundle also rejects unlisted or substituted files. */
export function readNativeThemeBundle(source: CapturedPackageSource, root: string) {
  if (root !== "theme" && !root.endsWith("/theme")) return null;
  const tree = source.tree,
    prefix = root.slice(0, -"theme".length),
    path = prefix + NATIVE_THEME_BUNDLE_FILE;
  if (!tree.has(path)) return null;
  if (source.descriptor.inventory.unavailable.some((entry) => entry.path === root || entry.path.startsWith(root + "/")))
    throw new NativeThemeError("invalidInput");
  let manifest: NativeThemeBundleManifest;
  try {
    manifest = nativeThemeBundleManifest(JSON.parse(tree.text(path, NATIVE_THEME_BUNDLE_METADATA_BYTES)));
  } catch {
    throw new NativeThemeError("invalidInput");
  }
  const expected = new Map(manifest.files.map((file) => [prefix + file.path, file])),
    actual = tree.files.filter((file) => file.path.startsWith(root + "/") || expected.has(file.path));
  if (
    actual.length !== expected.size ||
    actual.some((file) => {
      const saved = expected.get(file.path);
      return !saved || saved.sha256 !== file.sha256 || saved.bytes !== file.bytes;
    })
  )
    throw new NativeThemeError("invalidInput");
  const settings = nativeThemeSettings({
    ...manifest.settings,
    license: { ...manifest.settings.license, file: prefix + manifest.settings.license.file },
    readme: manifest.settings.readme === null ? null : prefix + manifest.settings.readme,
  });
  return { settings, provenance: manifest.provenance };
}
