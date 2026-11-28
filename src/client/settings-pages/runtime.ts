import { createHarnessSettings } from "../harness/settings.js";
import { createStorageSettings } from "../original-storage/composed.js";
import { createDatabaseSettings } from "../database/settings.js";
import { createBotSettings } from "../bots/settings.js";
import { createBotWorkspace } from "../bots/workspace.js";
import { createCliSettings } from "../cli/settings.js";
import { createSearchSettings } from "../search/settings.js";
import { createEncryptionKeySettings } from "../encryption-keys/settings.js";
import { createProjectMemorySettings } from "./project-memory.js";
import { createUsersSettings } from "../users/settings.js";
import { createExecutorCredentialSettings } from "./executor-credentials.js";
import { createExecutorSettings } from "./executors.js";

/** Administrative page factories remain independent from the workspace entry and hold no mounted state. */
export const settingsPageFactories = {
  harness: createHarnessSettings,
  mediaExecutors: createExecutorSettings,
  mediaCredentials: createExecutorCredentialSettings,
  bots: createBotSettings,
  botWorkspace: createBotWorkspace,
  clients: createCliSettings,
  memory: createProjectMemorySettings,
  search: createSearchSettings,
  database: createDatabaseSettings,
  storage: createStorageSettings,
  users: createUsersSettings,
  encryptionKeys: createEncryptionKeySettings,
};
