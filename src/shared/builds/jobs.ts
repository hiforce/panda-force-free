import type { BuildEngine, BuildInput } from "./contracts.js";
import type { BuildRun } from "./run.js";
import type { BuildThemeMetadata } from "./theme.js";
import type { BuildProjectMetadata } from "./project.js";
import type { BuildRequirements } from "./capabilities.js";
import type { NativeBuildThemeRef, NativeBuildThemeSnapshot } from "./native-reference.js";

/** Browser-safe build records omit executor addresses, tokens and registry configuration. */
export interface BuildSourceRevision {
  id: string;
  path: string;
  revisionId: string;
  contentHash: string;
  sourcePath?: string;
  placement?: { id: string; version: number };
}
export interface SiteBuild extends BuildRun {
  inputProtocol?: 2;
  nativeTheme?: NativeBuildThemeSnapshot;
  projectId?: string;
  sourceSnapshot?: { projectId: string; commit: string; spaceVersion: number };
  spaceId: string;
  preset: BuildInput["preset"];
  theme?: BuildThemeMetadata;
  project?: BuildProjectMetadata;
  site: BuildInput["site"];
  sources: BuildSourceRevision[];
}
export interface BuildAvailability extends Partial<BuildRequirements> {
  state: "ready" | "unconfigured" | "unavailable" | "incompatible";
  engines: Partial<Record<BuildEngine, string>>;
}
export interface SiteBuildRequest {
  nativeTheme?: NativeBuildThemeRef;
  projectId?: string;
  spaceVersion?: number;
  id: string;
  spaceId: string;
  engine: BuildEngine;
  locale: string;
  title: string;
  url: string;
  basePath: string;
}
