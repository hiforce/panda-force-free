import {
  PACKAGE_LIMITS,
  PluginPackageError,
  isProfileTheme,
  type PluginManifest,
  type PluginPackageFile,
} from "../../shared/plugins/contracts.js";
import { validatePluginManifest } from "../../shared/plugins/manifest.js";
import { verifyPluginPackage } from "../../shared/plugins/package.js";
import { packagePath, packageSha256 } from "../../shared/plugins/validation.js";

/** A source adapter grants a selected tree, never arbitrary host paths or executable callbacks. */
export interface ThemeSourceTree {
  files(): AsyncIterable<{ path: string; bytes: Uint8Array }>;
  verify(files: ReadonlyMap<string, string>): Promise<void>;
}

/** Assemble immutable package bytes without installing, importing or executing any source code. */
export async function packageSourceTheme(manifest: PluginManifest, source: ThemeSourceTree) {
  manifest = validatePluginManifest(manifest);
  if (manifest.siteThemes.length !== 1 || manifest.channelTemplates.length)
    throw new PluginPackageError("invalidPackage");
  const selected = manifest.siteThemes[0]!;
  if (isProfileTheme(selected)) throw new PluginPackageError("invalidPackage");
  const root = selected.root,
    files: PluginPackageFile[] = [],
    stamps = new Map<string, string>();
  let total = 0;
  for await (const file of source.files()) {
    const path = packagePath(file.path);
    if (stamps.has(path)) throw new PluginPackageError("invalidPackagePath");
    total += file.bytes.length;
    if (
      file.bytes.length > PACKAGE_LIMITS.fileBytes ||
      total > PACKAGE_LIMITS.totalBytes ||
      files.length >= PACKAGE_LIMITS.files
    )
      throw new PluginPackageError("packageTooLarge");
    const sha256 = await packageSha256(file.bytes);
    stamps.set(path, sha256);
    files.push({ path: root + "/" + path, data: Buffer.from(file.bytes).toString("base64"), sha256 });
  }
  await source.verify(stamps);
  return verifyPluginPackage({ schema: 1, manifest, files });
}
