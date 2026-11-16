import { readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DocumentService } from "../../documents/service.js";
import type { MetadataStore } from "../../../shared/async-value.js";
import { readSourceBytes } from "../../documents/ingestion/files.js";
import { packagePath } from "../../../shared/plugins/validation.js";
import { PACKAGE_LIMITS, PluginPackageError, type PluginManifest } from "../../../shared/plugins/contracts.js";
import { packageSourceTheme, type ThemeSourceTree } from "../authoring.js";

/** The integration grants exactly one theme within an authorized, read-only document source. */
export type DocumentThemeSources = MetadataStore<Pick<DocumentService, "space">> & {
  sources: Pick<DocumentService["sources"], "root">;
};
export function documentThemePackager(documents: DocumentThemeSources) {
  return async (spaceId: string, theme: string, manifest: PluginManifest) => {
    const space = await documents.space(spaceId);
    if (space.sourceMode !== "external" || space.engine !== "hexo" || typeof theme !== "string" || theme.includes("/"))
      throw new PluginPackageError("invalidPackage");
    packagePath(theme);
    if (manifest.siteThemes?.length !== 1 || manifest.siteThemes[0]?.engine !== space.engine)
      throw new PluginPackageError("incompatibleEngine");
    const root = await documents.sources.root(space.sourceRoot),
      prefix = `themes/${theme}/`;
    let visited = 0;
    async function* walk(path = "", depth = 0): ReturnType<ThemeSourceTree["files"]> {
      if (depth > 12) throw new PluginPackageError("packageTooLarge");
      const directory = root + "/" + prefix + path;
      if ((await realpath(directory)) !== directory.replace(/\/$/, ""))
        throw new PluginPackageError("invalidPackagePath");
      for (const entry of (await readdir(root + "/" + prefix + path, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        if (++visited > 10000) throw new PluginPackageError("packageTooLarge");
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const relative = packagePath(path + entry.name);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
          throw new PluginPackageError("invalidPackagePath");
        if (entry.isDirectory()) yield* walk(relative + "/", depth + 1);
        else yield { path: relative, bytes: await readSourceBytes(root, prefix + relative, PACKAGE_LIMITS.fileBytes) };
      }
    }
    const result = await packageSourceTheme(manifest, {
      files: () => walk(),
      async verify(stamps) {
        for (const [path, sha256] of stamps)
          if (
            createHash("sha256")
              .update(await readSourceBytes(root, prefix + path, PACKAGE_LIMITS.fileBytes))
              .digest("hex") !== sha256
          )
            throw new PluginPackageError("packageDigestMismatch");
      },
    });
    if ((await documents.space(space.id)).version !== space.version)
      throw new PluginPackageError("packageDigestMismatch");
    return result;
  };
}
