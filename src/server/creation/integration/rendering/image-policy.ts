import { isAbsolute, resolve, dirname, basename } from "node:path";
import { codexApplicationThread } from "../../../engines/application-tools/codex-policy.js";
import { ImageRenderError, type ImageRenderIntent } from "./image-contracts.js";

export const IMAGE_RENDER_PROFILE = "panda_image_renderer";
export function rendererDirectory(root: string, path: string) {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    dirname(path) !== root ||
    !/^image-[a-f0-9-]{36}$/.test(basename(path))
  )
    throw new ImageRenderError("invalidInput");
  return path;
}
export function nativeImagePolicy(directory: string, input: ImageRenderIntent) {
  const { sandbox: _sandbox, ...base } = codexApplicationThread(
    directory,
    "You are an application image renderer. Generate or edit exactly one finished raster image using the native image generation tool, then stop. Deliver the actual image; do not substitute a document, plan, prompt, or design brief. Supplied images are the only authorized image inputs. No shell, web, applications, plugins, other files or subagents are authorized. Any temporary files belong only to this directory: " +
      directory,
    [],
    input.profile.model,
  );
  return {
    ...base,
    ephemeral: false,
    permissions: IMAGE_RENDER_PROFILE,
    runtimeWorkspaceRoots: [directory],
    config: {
      ...base.config,
      "features.image_generation": true,
      "features.multi_agent_v2": false,
      "agents.enabled": false,
      default_permissions: IMAGE_RENDER_PROFILE,
      permissions: {
        [IMAGE_RENDER_PROFILE]: {
          description: "Application-owned image renderer scratch only",
          filesystem: { ":root": "deny", ":minimal": "read", [directory]: "write" },
          network: { enabled: false },
        },
      },
    },
  };
}
