import type { BuildInput } from "./contracts.js";
import { trustedThemeExport } from "./trusted-theme.js";
import type { BuildEngine } from "./engines.js";

export const HEXO_STYLUS_PROTOCOL = "hexo-stylus/v1";

/** Required protocols describe the frozen input, independently of deployment and image selection. */
export interface BuildRequirements {
  nativeResources?: boolean;
  hexoStylus?: boolean;
  themes: boolean;
  trustedThemes: boolean;
  profileThemes: boolean;
  siteProjects: boolean;
}
export function buildRequirements(input: BuildInput): BuildRequirements {
  const theme = input.theme,
    selected = theme?.schema === 2 ? trustedThemeExport(theme) : null,
    prefix = selected?.root ? selected.root + "/" : "",
    files = theme?.schema === 2 ? theme.bundle.files.filter((file) => file.path.startsWith(prefix)) : [];
  return {
    themes: Boolean(input.theme),
    trustedThemes: input.theme?.schema === 2,
    profileThemes: input.theme?.schema === 1 && Boolean(input.theme.package),
    siteProjects: requiresSiteProjectProtocol(input),
    ...rendererRequirements(input.engine, [...files, ...(input.project?.files ?? [])]),
  };
}
/** A format requirement comes from frozen filenames, never a source-provided image or command. */
export function rendererRequirements(engine: BuildEngine, files: readonly { path: string }[]) {
  return engine === "hexo" && files.some((file) => /\.styl$/i.test(file.path)) ? { hexoStylus: true as const } : {};
}
export function resourceBuildRequirements(input: BuildInput, files: readonly { path: string }[]): BuildRequirements {
  return { ...buildRequirements(input), nativeResources: true, ...rendererRequirements(input.engine, files) };
}
export function requiresSiteProjectProtocol(input: BuildInput): boolean {
  const theme = input.theme;
  const selected = theme?.schema === 2 ? trustedThemeExport(theme) : undefined;
  return Boolean(input.project || input.documents.some((doc) => doc.metadata !== undefined) || selected?.dependencies);
}
