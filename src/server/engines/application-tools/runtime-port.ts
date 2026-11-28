import type { HarnessCatalog, HarnessRuntimeView } from "../../../shared/harness/contracts.js";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";

export interface ApplicationRuntimeSelection {
  runtimeId?: string;
  model?: string;
  effort?: string;
}
export type ApplicationRuntimePurpose = "bots" | "bot-chat" | "creation" | "knowledge" | "editorial" | "project-memory";
export type ApplicationRuntimeScope = "bots" | "creation" | "project-memory";
export type ApplicationCatalogScope = boolean | ApplicationRuntimeScope;

export type ApplicationImageProvider = "zcode" | "grok-build";

export interface ApplicationImageRenderer {
  readonly provider: ApplicationImageProvider;
  readonly maxReferences: number;
  readonly maxReferenceBytes: number;
  version?(): Promise<string>;
  render(
    prompt: string,
    references: readonly { bytes: Uint8Array; mime: string }[],
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; invocationId?: string }>;
}

/** Domains select installed execution identities, never executable commands or provider endpoints. */
export interface ApplicationRuntimePort {
  catalog(owner: string, scope?: ApplicationCatalogScope): Promise<HarnessCatalog>;
  discover(owner: string, runtimeId: string, scope?: ApplicationCatalogScope): Promise<HarnessRuntimeView>;
  resolve(
    owner: string,
    selection: ApplicationRuntimeSelection,
    scope?: ApplicationRuntimeScope,
  ): Promise<Required<ApplicationRuntimeSelection>>;
  hasCreationImage?(): boolean;
  creationImage?(owner: string, runtimeId: string): Promise<ApplicationImageRenderer | undefined>;
  engine(
    owner: string,
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: ApplicationRuntimePurpose,
  ): ApplicationToolEngine;
}
