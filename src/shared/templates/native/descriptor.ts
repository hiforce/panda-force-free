import { NativeThemeError, type NativeThemeDescriptorData } from "./contracts.js";
import { nativeThemeSettings } from "./settings.js";
import { templateObject, templateDigest, freezeTemplate } from "../portable/validation.js";
import { sourceOrigin } from "../../packages/sources/origin.js";
import { sourcePath } from "../../packages/sources/paths.js";
import { sourceInventory } from "../../packages/sources/inventory.js";
import { DEFAULT_SOURCE_LIMITS } from "../../packages/sources/contracts.js";
import { contentSha256 } from "../../packages/digest.js";
export const NATIVE_THEME_METADATA_BYTES = 8 * 1024 * 1024;

/** Registry projections validate metadata independently; execution additionally verifies the original owned bytes. */
export function nativeThemeDescriptorData(value: unknown): NativeThemeDescriptorData {
  try {
    const input = templateObject(value, ["schema", "settings", "source", "root", "projection", "license"]),
      source = templateObject(input.source, ["digest", "origin"]),
      projection = templateObject(input.projection, ["digest", "treeDigest", "files"]),
      license = templateObject(input.license, ["path", "bytes", "sha256"]);
    if (
      input.schema !== "panda.native-site-theme/v1" ||
      !Array.isArray(projection.files) ||
      !projection.files.length ||
      projection.files.length > DEFAULT_SOURCE_LIMITS.files
    )
      throw new NativeThemeError("invalidInput");
    const files = projection.files.map((value) => {
      const file = templateObject(value, ["path", "bytes", "sha256"]);
      if (typeof file.bytes !== "number") throw new NativeThemeError("invalidInput");
      return { path: sourcePath(file.path), bytes: file.bytes, sha256: templateDigest(file.sha256) };
    });
    const inventory = sourceInventory({
      files: files.map((file) => ({ ...file, integrity: { algorithm: "sha256", value: file.sha256 } })),
      unavailable: [],
    });
    if (
      files.some(
        (file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > DEFAULT_SOURCE_LIMITS.fileBytes,
      ) ||
      files.reduce((sum, file) => sum + file.bytes, 0) > DEFAULT_SOURCE_LIMITS.totalBytes ||
      JSON.stringify(files.map((f) => f.path)) !== JSON.stringify(inventory.files.map((f) => f.path))
    )
      throw new NativeThemeError("invalidInput");
    if (
      typeof license.bytes !== "number" ||
      !Number.isSafeInteger(license.bytes) ||
      license.bytes < 1 ||
      license.bytes > 256 * 1024
    )
      throw new NativeThemeError("invalidInput");
    const settings = nativeThemeSettings(input.settings),
      licenseFile = { path: sourcePath(license.path), bytes: license.bytes, sha256: templateDigest(license.sha256) };
    if (licenseFile.path !== settings.license.file) throw new NativeThemeError("invalidInput");
    return freezeTemplate({
      schema: "panda.native-site-theme/v1",
      settings,
      source: { digest: templateDigest(source.digest), origin: sourceOrigin(source.origin) },
      root: input.root === "" ? "" : sourcePath(input.root),
      projection: {
        digest: templateDigest(projection.digest),
        treeDigest: templateDigest(projection.treeDigest),
        files,
      },
      license: licenseFile,
    });
  } catch (error) {
    if (error instanceof NativeThemeError) throw error;
    throw new NativeThemeError("invalidInput");
  }
}
export class NativeThemeDescriptor {
  private constructor(
    readonly data: Readonly<NativeThemeDescriptorData>,
    readonly digest: string,
  ) {
    Object.freeze(this);
  }
  static async create(value: unknown) {
    const data = nativeThemeDescriptorData(value),
      treeDigest = await contentSha256(JSON.stringify({ schema: 1, files: data.projection.files })),
      projectionDigest = await contentSha256(
        JSON.stringify({
          schema: "panda.source-alias-projection/v1",
          sourceDigest: data.source.digest,
          root: data.root,
          treeDigest,
        }),
      );
    if (treeDigest !== data.projection.treeDigest || projectionDigest !== data.projection.digest)
      throw new NativeThemeError("invalidInput");
    const encoded = JSON.stringify(data);
    if (new TextEncoder().encode(encoded).length > NATIVE_THEME_METADATA_BYTES)
      throw new NativeThemeError("storageFull");
    return new NativeThemeDescriptor(data, await contentSha256(encoded));
  }
}
