import type { config } from "../config.js";
import type { createMySQLRuntimeStores } from "../database/runtime-stores.js";
import type { publicationOwner } from "../connections/integration/identity.js";

/** Only application composition depends on concrete adapter types; domain ports stay independent. */
export type ApplicationConfig = typeof config;
export type ApplicationStores = Awaited<ReturnType<typeof createMySQLRuntimeStores>>;
export type ApplicationOwnerResolver = (context: Parameters<typeof publicationOwner>[1]) => string;
