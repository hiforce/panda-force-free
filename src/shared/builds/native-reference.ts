import type { NativeThemeDefinition } from "./native-theme.js";

export interface NativeBuildThemeRef {
  id: string;
  version: string;
  digest: string;
}
export interface NativeBuildThemeSnapshot extends NativeBuildThemeRef {
  source: NativeThemeDefinition["source"];
  engineVersion: string;
}
