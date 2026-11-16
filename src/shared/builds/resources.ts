import type { BuildInput } from "./contracts.js";
import { buildInput, BuildError } from "./validation.js";
import { nativeThemeDefinition, type NativeThemeDefinition } from "./native-theme.js";
import { DEFAULT_SOURCE_LIMITS, SourceError } from "../packages/sources/contracts.js";
import { ImmutableSourceTree } from "../packages/sources/tree.js";
import { contentSha256 } from "../packages/digest.js";

export const RESOURCE_BUILD_PROTOCOL = "resource-builds/v2";
export const RESOURCE_BUILD_LIMITS = Object.freeze({ ...DEFAULT_SOURCE_LIMITS });
export interface ResourceBuildDescriptor {
  schema: "panda.resource-build/v2";
  input: BuildInput;
  theme: NativeThemeDefinition;
  files: ImmutableSourceTree["files"];
  treeDigest: string;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** A separate immutable request keeps native binary resources outside historical JSON build quotas. */
export class ResourceBuildRequest {
  readonly protocol = 2 as const;
  private constructor(
    readonly descriptor: Readonly<ResourceBuildDescriptor>,
    readonly tree: ImmutableSourceTree,
    readonly digest: string,
  ) {
    freeze(descriptor);
    Object.freeze(this);
  }
  get engine() {
    return this.descriptor.input.engine;
  }
  static async create(value: unknown, themeValue: unknown, tree: ImmutableSourceTree): Promise<ResourceBuildRequest> {
    try {
      const input = buildInput(value),
        theme = nativeThemeDefinition(themeValue, input.engine);
      if (input.theme || !(tree instanceof ImmutableSourceTree) || !tree.files.length)
        throw new BuildError("invalidNativeTheme");
      if (
        tree.files.length > RESOURCE_BUILD_LIMITS.files ||
        tree.byteLength > RESOURCE_BUILD_LIMITS.totalBytes ||
        tree.files.some((file) => file.bytes > RESOURCE_BUILD_LIMITS.fileBytes)
      )
        throw new BuildError("resourceBuildTooLarge", 413);
      if (tree.files.some((file) => file.path.split("/").some((part) => part === ".git" || part === "node_modules")))
        throw new BuildError("invalidNativeTheme");
      if (theme.entry && !tree.has(theme.entry)) throw new BuildError("invalidNativeTheme");
      const expected = await contentSha256(
        JSON.stringify({
          schema: "panda.source-alias-projection/v1",
          sourceDigest: theme.source.digest,
          root: theme.source.root,
          treeDigest: tree.digest,
        }),
      );
      if (expected !== theme.source.projectionDigest) throw new BuildError("inputDigestMismatch");
      const descriptor: ResourceBuildDescriptor = {
        schema: "panda.resource-build/v2",
        input,
        theme,
        files: tree.files,
        treeDigest: tree.digest,
      };
      return new ResourceBuildRequest(descriptor, tree, await contentSha256(JSON.stringify(descriptor)));
    } catch (error) {
      if (error instanceof SourceError) throw new BuildError("invalidNativeTheme");
      throw error;
    }
  }
}
export type ExecutionInput = BuildInput | ResourceBuildRequest;
