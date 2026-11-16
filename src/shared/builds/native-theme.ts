import { BUILD_ENGINES, type BuildEngine } from "./engines.js";
import { BuildError } from "./errors.js";
import { sourcePath } from "../packages/sources/paths.js";

export interface NativeThemeDefinition {
  schema: 1;
  id: string;
  version: string;
  engine: BuildEngine;
  engineVersion: string;
  source: { digest: string; projectionDigest: string; root: string };
  entry: string | null;
  dependencies: Record<string, string>;
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new BuildError("invalidNativeTheme");
  return value as Record<string, unknown>;
}
/** A native theme declares content and exact dependencies, never images, commands or environment variables. */
export function nativeThemeDefinition(value: unknown, engine: BuildEngine): NativeThemeDefinition {
  const input = record(value, [
      "schema",
      "id",
      "version",
      "engine",
      "engineVersion",
      "source",
      "entry",
      "dependencies",
    ]),
    source = record(input.source, ["digest", "projectionDigest", "root"]),
    dependencies = record(input.dependencies, Object.keys((input.dependencies ?? {}) as object));
  if (
    input.schema !== 1 ||
    input.engine !== engine ||
    input.engineVersion !== BUILD_ENGINES[engine] ||
    typeof input.id !== "string" ||
    !/^[a-z][a-z0-9.-]{1,63}$/.test(input.id) ||
    typeof input.version !== "string" ||
    !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.version) ||
    typeof source.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.digest) ||
    typeof source.projectionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.projectionDigest) ||
    Object.keys(dependencies).length > 32 ||
    (engine === "hexo" ? input.entry !== null : typeof input.entry !== "string")
  )
    throw new BuildError("invalidNativeTheme");
  const root = source.root === "" ? "" : sourcePath(source.root),
    entry = input.entry === null ? null : sourcePath(input.entry);
  if (entry && !/\.(?:c?js|mjs)$/.test(entry)) throw new BuildError("invalidNativeTheme");
  const versions = Object.fromEntries(
    Object.entries(dependencies)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, version]) => {
        if (
          !/^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ||
          typeof version !== "string" ||
          !/^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(version)
        )
          throw new BuildError("invalidNativeTheme");
        return [name, version];
      }),
  );
  return {
    schema: 1,
    id: input.id,
    version: input.version,
    engine,
    engineVersion: BUILD_ENGINES[engine],
    source: { digest: source.digest, projectionDigest: source.projectionDigest, root },
    entry,
    dependencies: versions,
  };
}
