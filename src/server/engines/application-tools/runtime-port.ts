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

/** Domains select installed execution identities, never executable commands or provider endpoints. */
export interface ApplicationRuntimePort {
  catalog(owner: string, scope?: ApplicationCatalogScope): Promise<HarnessCatalog>;
  discover(owner: string, runtimeId: string, scope?: ApplicationCatalogScope): Promise<HarnessRuntimeView>;
  resolve(
    owner: string,
    selection: ApplicationRuntimeSelection,
    scope?: ApplicationRuntimeScope,
  ): Promise<Required<ApplicationRuntimeSelection>>;
  engine(
    owner: string,
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: ApplicationRuntimePurpose,
  ): ApplicationToolEngine;
}
