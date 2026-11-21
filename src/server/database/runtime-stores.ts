import { MySQLHarnessMetadata } from "../harness/storage/mysql.js";
import { MySQLGadgetStore } from "../gadget/mysql-store.js";
import type { SQL } from "bun";
import { MySQLIdentityCredentials } from "../auth/mysql-credentials.js";
import { MySQLLocalUsers } from "../auth/users/mysql.js";
import { MySQLSessionRevocations } from "../auth/mysql-sessions.js";
import { MySQLBotStore } from "../bots/mysql-store.js";
import { openMySQLCliCredentialStore } from "../cli/auth/mysql.js";
import { MySQLContentAccessStore } from "../content-access/storage/mysql.js";
import { createMySQLCreationStorage, personalCreationLedgerNamespace } from "../creation/storage/mysql.js";
import { createMySQLPublicationPersistence } from "../delivery/integration/mysql-persistence.js";
import { createMySQLDocumentStorage } from "../documents/mysql-storage.js";
import { createMySQLKnowledgePersistence } from "../knowledge/storage/mysql.js";
import { MySQLProjectVisibilityStore } from "../misc/mysql-project-visibility.js";
import { MySQLProjectCatalog } from "../projects/mysql-catalog.js";
import { searchConfiguration } from "../search/integration/config.js";
import { createMySQLSearchPersistence } from "../search/storage/mysql.js";
import { MySQLSkillWorkspaceStore } from "../skill-workspace/mysql-store.js";
import { MySQLSkillRegistry } from "../skills/storage/mysql.js";
import { createMySQLExtensionStores, mySQLExtensionPersistence } from "./extension-stores.js";

/** Trusted compiled bindings are inspected by bootstrap; module flags and verified activation still gate selection. */
export const applicationMySQLRuntimeBindings = [
  "identity",
  "projects",
  "content-access",
  "documents",
  "editorial",
  "skills",
  "skill-workspace",
  "gadgets",
  "plugins",
  "templates",
  "package-sources",
  "builds",
  "creation",
  "publishing",
  "connections",
  "delivery",
  "knowledge",
  "search",
  "search-embeddings",
  "cli-auth",
  "settings",
  "bots",
  "harness",
] as const;

/** Bootstrap owns activation and the pool. This factory never opens a business SQLite ledger or starts a worker. */
export async function createMySQLRuntimeStores(
  sql: SQL,
  options: { stateRoot: string; homeDir: string; env?: NodeJS.ProcessEnv },
) {
  const env = options.env ?? process.env,
    projectCatalog = new MySQLProjectCatalog(sql),
    search = searchConfiguration(options.stateRoot, env);
  const value = env.PANDA_FORCE_BOT_MAX_PENDING_PER_OWNER,
    maxPendingPerOwner = value === undefined ? 10000 : Number(value);
  if (!Number.isSafeInteger(maxPendingPerOwner) || maxPendingPerOwner < 1000 || maxPendingPerOwner > 1000000)
    throw Error("invalidBotQueueCapacity");
  const documents = createMySQLDocumentStorage(sql),
    extensionStores = createMySQLExtensionStores(sql, {
      documentTransaction: (work) => documents.session.transactionConnection(work),
    });
  return {
    harness: new MySQLHarnessMetadata(sql),
    credentials: new MySQLIdentityCredentials(sql),
    users: new MySQLLocalUsers(sql),
    revocations: new MySQLSessionRevocations(sql),
    visibility: new MySQLProjectVisibilityStore(sql, options.homeDir),
    projectCatalog,
    documentStorage: projectCatalog,
    documents,
    access: new MySQLContentAccessStore(projectCatalog),
    skills: new MySQLSkillRegistry(sql),
    skillWorkspace: new MySQLSkillWorkspaceStore(sql),
    gadgets: new MySQLGadgetStore(sql),
    cli: openMySQLCliCredentialStore(sql),
    creation: createMySQLCreationStorage(sql, "application"),
    personalCreation: (owner: string) => createMySQLCreationStorage(sql, personalCreationLedgerNamespace(owner)),
    knowledge: await createMySQLKnowledgePersistence(sql),
    search: await createMySQLSearchPersistence(sql, {
      stateRoot: options.stateRoot,
      connections: search.connections,
      knowledge: search.knowledge,
    }),
    extensions: mySQLExtensionPersistence(extensionStores),
    publication: createMySQLPublicationPersistence(sql, Date.now, {
      transactionConnection: (work) =>
        documents.session.transactionConnection(async (connection) => {
          await extensionStores.publishing.lockConnection(connection);
          return extensionStores.publishing.withinConnection(connection, () => work(connection));
        }),
    }),
    bots: await MySQLBotStore.open(sql, { maxPendingPerOwner }),
  };
}
export type MySQLRuntimeStores = Awaited<ReturnType<typeof createMySQLRuntimeStores>>;
