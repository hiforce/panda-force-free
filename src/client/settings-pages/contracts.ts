import type { SessionControlView } from "../contracts/session-workspace.js";

/** Settings read the same named model projection and loader as session controls. */
export interface SettingsModelCatalog {
  read(): Pick<SessionControlView, "models">;
  load(): Promise<boolean>;
}
