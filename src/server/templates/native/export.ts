import { zip, type Zippable } from "fflate";
import type { NativeSiteTheme } from "../../../shared/templates/native/package.js";
import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { DEFAULT_SOURCE_LIMITS, type SourceFile } from "../../../shared/packages/sources/contracts.js";
import {
  nativeThemeBundleManifest,
  NATIVE_THEME_BUNDLE_FILE,
  NATIVE_THEME_BUNDLE_SCHEMA,
  NATIVE_THEME_BUNDLE_METADATA_BYTES,
} from "../../../shared/templates/native/bundle.js";

/** Only effective theme files and selected notices leave the owned source; unrelated originals remain private. */
export async function exportNativeTheme(theme: NativeSiteTheme) {
  const files = new Map<string, { bytes: Uint8Array; file: SourceFile }>();
  for (const file of theme.projection.tree.files) {
    const path = "theme/" + file.path;
    files.set(path, { bytes: theme.projection.tree.read(file.path), file: { ...file, path } });
  }
  const { settings, root } = theme.descriptor.data,
    originalPrefix = root ? root + "/" : "",
    notices = new Map<string, string>();
  const notice = (original: string, fallback: string) => {
    const previous = notices.get(original);
    if (previous) return previous;
    const inside = original.startsWith(originalPrefix) ? "theme/" + original.slice(originalPrefix.length) : null,
      path = inside && files.has(inside) ? inside : "notices/" + fallback;
    if (!files.has(path)) {
      const source = theme.source.tree.files.find((file) => file.path === original);
      if (!source) throw new NativeThemeError("unavailable");
      files.set(path, { bytes: theme.source.tree.read(original), file: { ...source, path } });
    }
    notices.set(original, path);
    return path;
  };
  const exportedSettings = {
    ...settings,
    license: { ...settings.license, file: notice(settings.license.file, "LICENSE") },
    readme: settings.readme === null ? null : notice(settings.readme, "README.md"),
  };
  if (files.size + 1 > DEFAULT_SOURCE_LIMITS.files) throw new NativeThemeError("exportTooLarge");
  const manifest = nativeThemeBundleManifest({
      schema: NATIVE_THEME_BUNDLE_SCHEMA,
      root: "theme",
      settings: exportedSettings,
      files: [...files.values()].map((value) => value.file).sort((a, b) => a.path.localeCompare(b.path, "en")),
      provenance: { themeDigest: theme.digest, projectionDigest: theme.projection.tree.digest },
    }),
    metadata = new TextEncoder().encode(JSON.stringify(manifest));
  if (
    metadata.length > NATIVE_THEME_BUNDLE_METADATA_BYTES ||
    metadata.length + [...files.values()].reduce((n, f) => n + f.bytes.length, 0) > DEFAULT_SOURCE_LIMITS.totalBytes
  )
    throw new NativeThemeError("exportTooLarge");
  const archive: Zippable = Object.create(null),
    options = { level: 0 as const, mtime: new Date("2000-01-01T00:00:00Z"), attrs: (0o100644 << 16) >>> 0, os: 3 };
  archive[NATIVE_THEME_BUNDLE_FILE] = [metadata, options];
  for (const [path, value] of files) archive[path] = [value.bytes, options];
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(archive, { level: 0 }, (error, value) => (error ? reject(error) : resolve(value))),
  );
  if (bytes.length > DEFAULT_SOURCE_LIMITS.archiveBytes) throw new NativeThemeError("exportTooLarge");
  return { filename: `${settings.id}-${settings.version}.native-theme.zip`, bytes };
}
