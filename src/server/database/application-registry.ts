import { mysqlGadgetModule } from "./modules/gadgets.js";
import { DatabaseRegistry, type DatabaseModule } from "./registry.js";
import { mysqlBotModule } from "./modules/bots.js";
import { mysqlDataMigrationModule } from "./modules/migrations.js";
import { mysqlCliAuthModule } from "./modules/cli-auth.js";
import { mysqlSkillWorkspaceModule } from "./modules/skill-workspace.js";
import { mysqlProjectsModule } from "./modules/projects.js";
import { mysqlSkillsModule } from "./modules/skills.js";
import { mysqlContentAccessModule } from "./modules/content-access.js";
import { mysqlIdentityModule } from "./modules/identity.js";
import { mysqlSettingsModule } from "./modules/settings.js";
import { mysqlDocumentsModule } from "./modules/documents.js";
import { mysqlEditorialModule } from "./modules/editorial.js";
import { mysqlCreationModule } from "./modules/creation.js";
import { mysqlKnowledgeModule } from "./modules/knowledge.js";
import { mysqlSearchModule } from "./modules/search.js";
import { mysqlSearchEmbeddingsModule } from "./modules/search-embeddings.js";
import { mysqlPluginsModule } from "./modules/plugins.js";
import { mysqlTemplatesModule } from "./modules/templates.js";
import { mysqlPackageSourcesModule } from "./modules/package-sources.js";
import { mysqlBuildsModule } from "./modules/builds.js";
import { mysqlPublishingModule } from "./modules/publishing.js";
import { mysqlConnectionsModule } from "./modules/connections.js";
import { mysqlDeliveryModule } from "./modules/delivery.js";

/** Every application-owned persistence domain must explicitly register both its schema and backend. */
export const applicationDatabaseModules = [
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
] as const;
/** Engine history and goals remain read-only engine state; application-owned links are registered under projects and bots. */
export const externalPersistenceOwners = [
  {
    owner: "installed-engine",
    domains: ["conversations", "goals"],
    access: "read-only",
    applicationReferenceModules: ["projects", "bots"],
  },
] as const;
export function createApplicationDatabaseRegistry(implementations: readonly DatabaseModule[] = []) {
  const known = new Map<string, DatabaseModule>([
    [mysqlBotModule.id, mysqlBotModule],
    [mysqlDataMigrationModule.id, mysqlDataMigrationModule],
    [mysqlCliAuthModule.id, mysqlCliAuthModule],
    [mysqlSkillWorkspaceModule.id, mysqlSkillWorkspaceModule],
    [mysqlGadgetModule.id, mysqlGadgetModule],
    [mysqlProjectsModule.id, mysqlProjectsModule],
    [mysqlSkillsModule.id, mysqlSkillsModule],
    [mysqlContentAccessModule.id, mysqlContentAccessModule],
    [mysqlIdentityModule.id, mysqlIdentityModule],
    [mysqlSettingsModule.id, mysqlSettingsModule],
    ...[
      mysqlDocumentsModule,
      mysqlEditorialModule,
      mysqlCreationModule,
      mysqlKnowledgeModule,
      mysqlSearchModule,
      mysqlSearchEmbeddingsModule,
      mysqlPluginsModule,
      mysqlTemplatesModule,
      mysqlPackageSourcesModule,
      mysqlBuildsModule,
      mysqlPublishingModule,
      mysqlConnectionsModule,
      mysqlDeliveryModule,
    ].map((module) => [module.id, module] as [string, DatabaseModule]),
  ]);
  for (const module of implementations) {
    if (
      !applicationDatabaseModules.includes(module.id as (typeof applicationDatabaseModules)[number]) &&
      module.id !== "data-migrations"
    )
      throw new Error("unregisteredApplicationDatabaseModule");
    known.set(module.id, module);
  }
  const registry = new DatabaseRegistry().register(known.get("data-migrations")!);
  for (const id of applicationDatabaseModules)
    registry.register(
      known.get(id) ?? {
        id,
        dependencies: [],
        migrations: {},
        inspect: async () => [{ module: id, object: "backend", code: "migrationIncomplete" }],
      },
    );
  return registry;
}
