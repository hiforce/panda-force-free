import type { BuildThemeSnapshot } from "./theme.js";
import type { BuildProjectSnapshot } from "./project.js";
import type { PublicDocumentMetadata } from "../sites/metadata.js";
/** Versioned transport data; deployment adapters keep image names and credentials private. */
import type { BuildEngine } from "./engines.js";
export { BUILD_PROTOCOL, BUILD_ENGINES, type BuildEngine } from "./engines.js";
export interface BuildInput {
  protocol: 1;
  theme?: BuildThemeSnapshot;
  project?: BuildProjectSnapshot;
  engine: BuildEngine;
  preset: "reader" | "handbook";
  site: { title: string; url: string; basePath: string; locale: string };
  documents: { id: string; path: string; title: string; content: string; metadata?: PublicDocumentMetadata }[];
  assets: { path: string; data: string; sha256: string }[];
}
export interface BuildArtifact {
  protocol: 1;
  files: { path: string; data: string; sha256: string }[];
  bytes: number;
}
export type BuildPhase = "queued" | "resolving" | "running" | "completed" | "failed";
export interface BuildExecution {
  id: string;
  inputHash: string;
  engine: BuildEngine;
  phase: BuildPhase;
  createdAt: number;
  updatedAt: number;
  image?: { reference: string; id: string; digest: string | null };
  error?: string;
}
export interface BuildExecutor {
  start(id: string, input: BuildInput): Promise<BuildExecution>;
  status(id: string): Promise<BuildExecution>;
  result(id: string): Promise<BuildArtifact>;
  cancel(id: string): Promise<BuildExecution>;
}
