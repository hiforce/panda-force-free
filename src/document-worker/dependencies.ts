import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildInput } from "../shared/builds/contracts.js";
import { BuildError } from "../shared/builds/validation.js";
import { trustedThemeExport } from "../shared/builds/trusted-theme.js";

export function themeDependencies(input: BuildInput): Record<string, string> {
  const theme = input.theme;
  if (theme?.schema !== 2) return {};
  return trustedThemeExport(theme).dependencies || {};
}
/** Inspect installed metadata without importing dependency code or running installation hooks. */
export async function verifyThemeDependencies(input: BuildInput, toolchain: string, declared?: Record<string, string>) {
  for (const [name, version] of Object.entries(declared ?? themeDependencies(input))) {
    try {
      const installed: unknown = JSON.parse(
        await readFile(join(toolchain, "node_modules", name, "package.json"), "utf8"),
      );
      if (!installed || typeof installed !== "object" || !("version" in installed) || installed.version !== version)
        throw Error("Version mismatch");
    } catch {
      throw new BuildError("themeDependencyUnavailable");
    }
  }
}
