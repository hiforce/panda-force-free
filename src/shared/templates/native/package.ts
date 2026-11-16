import { NativeThemeError } from "./contracts.js";
import { nativeThemeSettings } from "./settings.js";
import { NativeThemeDescriptor } from "./descriptor.js";
import { CapturedPackageSource } from "../../packages/sources/snapshot.js";
import { projectSourceAliases } from "../../packages/sources/aliases.js";
import { sourcePath } from "../../packages/sources/paths.js";
import { nativeThemeDefinition } from "../../builds/native-theme.js";
import { BUILD_ENGINES } from "../../builds/engines.js";
import { readNativeThemeBundle } from "./bundle.js";

/** The original source stays private; only a complete selected root becomes an execution projection. */
export class NativeSiteTheme {
  private constructor(
    readonly descriptor: NativeThemeDescriptor,
    readonly source: CapturedPackageSource,
    readonly projection: Awaited<ReturnType<typeof projectSourceAliases>>,
  ) {
    Object.freeze(this);
  }
  get digest() {
    return this.descriptor.digest;
  }
  static async create(source: CapturedPackageSource, rootValue: unknown, settingsValue: unknown) {
    if (!(source instanceof CapturedPackageSource)) throw new NativeThemeError("invalidInput");
    const settings = nativeThemeSettings(settingsValue),
      root = rootValue === "" ? "" : sourcePath(rootValue),
      prefix = root ? root + "/" : "";
    const bundle = readNativeThemeBundle(source, root);
    if (bundle && bundle.settings.engine !== settings.engine) throw new NativeThemeError("invalidInput");
    if (source.descriptor.inventory.files.some((file) => file.path.startsWith(prefix) && !source.tree.has(file.path)))
      throw new NativeThemeError("incompleteSource");
    const license = source.tree.files.find((file) => file.path === settings.license.file);
    if (!license || !license.bytes || license.bytes > 256 * 1024) throw new NativeThemeError("invalidInput");
    source.tree.text(license.path, 256 * 1024);
    if (settings.readme) source.tree.text(settings.readme, 512 * 1024);
    const projection = await projectSourceAliases(source, root);
    if (settings.engine === "hexo" && !projection.tree.files.some((file) => file.path.startsWith("layout/")))
      throw new NativeThemeError("invalidInput");
    const descriptor = await NativeThemeDescriptor.create({
        schema: "panda.native-site-theme/v1",
        settings,
        source: { digest: source.digest, origin: source.descriptor.origin },
        root,
        projection: { digest: projection.digest, treeDigest: projection.tree.digest, files: projection.tree.files },
        license,
      }),
      theme = new NativeSiteTheme(descriptor, source, projection);
    theme.definition();
    return theme;
  }
  definition() {
    const { settings, source, root, projection } = this.descriptor.data;
    const definition = nativeThemeDefinition(
      {
        schema: 1,
        id: settings.id,
        version: settings.version,
        engine: settings.engine,
        engineVersion: BUILD_ENGINES[settings.engine],
        source: { digest: source.digest, projectionDigest: projection.digest, root },
        entry: settings.entry,
        dependencies: settings.dependencies,
      },
      settings.engine,
    );
    if (definition.entry && !this.projection.tree.has(definition.entry)) throw new NativeThemeError("invalidInput");
    return definition;
  }
}
