import type { BuildRun } from "./run.js";
import type { BuildInput } from "./contracts.js";
import type { NativeBuildThemeRef } from "./native-reference.js";
export type { NativeBuildThemeRef } from "./native-reference.js";
export interface NativeSampleRequest {
  id: string;
  theme: NativeBuildThemeRef;
}
export interface NativeSampleBuild extends BuildRun {
  key: string;
  theme: NativeBuildThemeRef;
  site: BuildInput["site"];
  runnerVersion: string;
  engineVersion: string;
}
