import type { HarnessCatalog, HarnessRuntimeView } from "../../../shared/harness/contracts.js";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";

export interface ApplicationRuntimeSelection {
  runtimeId?: string;
  model?: string;
  effort?: string;
}
/** Domains select installed execution identities, never executable commands or provider endpoints. */
export interface ApplicationRuntimePort {
  catalog(owner: string): Promise<HarnessCatalog>;
  discover(owner: string, runtimeId: string): Promise<HarnessRuntimeView>;
  resolve(owner: string, selection: ApplicationRuntimeSelection): Promise<Required<ApplicationRuntimeSelection>>;
  engine(
    owner: string,
    selection: ApplicationRuntimeSelection,
    directory: string,
    purpose: "bots" | "bot-chat" | "creation" | "knowledge" | "editorial",
  ): ApplicationToolEngine;
}
