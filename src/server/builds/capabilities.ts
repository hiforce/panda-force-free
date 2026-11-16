import { buildRequirements, type BuildRequirements } from "../../shared/builds/capabilities.js";
import type { BuildInput } from "../../shared/builds/contracts.js";
import type { BuildAvailability } from "../../shared/builds/jobs.js";
import { SiteBuildError } from "./errors.js";

const unsupported: Record<keyof BuildRequirements, string> = {
  hexoStylus: "hexoStylusWorkerRequired",
  nativeResources: "resourceBuildExecutorRequired",
  themes: "themeExecutorRequired",
  trustedThemes: "trustedThemeExecutorRequired",
  profileThemes: "profileThemeExecutorRequired",
  siteProjects: "sourceProjectExecutorRequired",
};
/** Reusable by project builds and sample builds before either creates durable execution work. */
export function assertBuildCapabilities(
  input: BuildInput,
  available: BuildAvailability,
  required = buildRequirements(input),
) {
  for (const key of Object.keys(unsupported) as (keyof BuildRequirements)[])
    if (required[key] && !available[key]) throw new SiteBuildError(unsupported[key], 503);
}
