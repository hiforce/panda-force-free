import type { BuildEngine, BuildInput } from "../../../shared/builds/contracts.js";

interface EnginePreset {
  id: BuildInput["preset"];
  assetReference(path: string, basePath: string, syntax: "markdown" | "markup"): string;
}

/** Each engine owns its Markdown asset semantics; snapshots preserve the original asset names. */
const presets: Record<BuildEngine, EnginePreset> = {
  // Hexo adds the site's root itself; including it here would duplicate the prefix.
  hexo: {
    id: "reader",
    assetReference: (path, basePath, syntax) => (syntax === "markup" ? basePath + path : "/" + path),
  },
  // Docusaurus treats ordinary Markdown URLs as source file paths, including the site's base path.
  // Explicit URL syntax preserves our already-verified static assets without a second path resolver.
  docusaurus: {
    id: "handbook",
    assetReference: (path, basePath, syntax) => (syntax === "markup" ? "" : "pathname://") + basePath + path,
  },
};

export const enginePreset = (engine: BuildEngine): EnginePreset => presets[engine];
