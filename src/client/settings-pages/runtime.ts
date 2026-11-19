import { createStorageSettings } from "../original-storage/composed.js";
import { createDatabaseSettings } from "../database/settings.js";
import { createBotSettings } from "../bots/settings.js";
import { createBotWorkspace } from "../bots/workspace.js";
import { createCliSettings } from "../cli/settings.js";
import { createSearchSettings } from "../search/settings.js";
import { createUsersSettings } from "../users/settings.js";

/** Administrative page factories remain independent from the workspace entry and hold no mounted state. */
export const settingsPageFactories = {
  bots: createBotSettings,
  botWorkspace: createBotWorkspace,
  clients: createCliSettings,
  search: createSearchSettings,
  database: createDatabaseSettings,
  storage: createStorageSettings,
  users: createUsersSettings,
};
