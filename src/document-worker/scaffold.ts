import { mkdir, writeFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { verifyBuildTheme, BuildThemeError } from "../shared/builds/theme.js";
import { verifyBuildProject } from "../shared/builds/project.js";
import { buildInput, BuildError } from "../shared/builds/validation.js";
import { materializeInstalledTheme } from "./installed-theme.js";
import { verifyThemeDependencies, themeDependencies } from "./dependencies.js";
import { prepareHexo } from "./engines/hexo.js";
import { prepareDocusaurus } from "./engines/docusaurus.js";
import { ResourceBuildRequest, type ExecutionInput } from "../shared/builds/resources.js";
import { materializeResourceTheme } from "./resource-theme.js";
import { buildRequirements, resourceBuildRequirements } from "../shared/builds/capabilities.js";
import { HEXO_STYLUS_VERSION } from "../shared/builds/toolchain.js";

/** Verify frozen inputs and grant only a private workspace to each engine adapter. */
export async function scaffold(value: ExecutionInput, root: string, toolchain = "/opt/engines") {
  const resource = value instanceof ResourceBuildRequest ? value : null,
    input = buildInput(resource ? resource.descriptor.input : value);
  if (input.theme) {
    try {
      await verifyBuildTheme(input.theme, input.engine);
    } catch (error) {
      if (error instanceof BuildThemeError) throw new BuildError(error.message);
      throw error;
    }
  }
  if (input.project) await verifyBuildProject(input.project);
  const requirements = resource
    ? resourceBuildRequirements(input, resource.descriptor.files)
    : buildRequirements(input);
  await verifyThemeDependencies(input, toolchain, {
    ...(requirements.hexoStylus ? { "hexo-renderer-stylus": HEXO_STYLUS_VERSION } : {}),
    ...(resource?.descriptor.theme.dependencies ?? themeDependencies(input)),
  });
  const put = async (path: string, content: string | Uint8Array) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await mkdir(root, { recursive: true });
  await symlink(join(toolchain, "node_modules"), join(root, "node_modules"));
  const assetRoot = input.engine === "hexo" ? "source/assets/" : "static/assets/";
  for (const asset of input.assets) {
    const bytes = Buffer.from(asset.data, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new BuildError("inputDigestMismatch");
    await put(assetRoot + asset.path, bytes);
  }
  for (const file of input.project?.files || []) await put(file.path, Buffer.from(file.data, "base64"));
  const installed = resource
      ? await materializeResourceTheme(resource, root)
      : await materializeInstalledTheme(input, root),
    workspace = {
      root,
      toolchain,
      put,
      installed,
      ...(resource ? { dependencies: resource.descriptor.theme.dependencies } : {}),
    };
  return { hexo: prepareHexo, docusaurus: prepareDocusaurus }[input.engine](input, workspace);
}
