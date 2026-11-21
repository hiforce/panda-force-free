import { SQLiteHarnessMetadata } from "../../harness/storage/sqlite.js";
import { harnessMigrationTables, migrateHarnessSnapshot } from "../../harness/storage/migrate.js";
import { GadgetStore } from "../../gadget/store.js";
import { gadgetMySQLModels } from "../modules/gadgets.js";
import { migrateGadgetSnapshot } from "../../gadget/migrate.js";
import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pandaEnvironment, existingApplicationPath } from "../../environment.js";
import { databaseConfiguration, readPrivateDatabaseFile, type ApplicationDatabaseConfig } from "../config.js";
import { databaseIdentifier } from "../management/state.js";
import { databaseTargetHash } from "./activation.js";
import {
  migrationUnitsFingerprint,
  type ApplicationMigrationManifest,
  type ApplicationMigrationUnit,
} from "./coordinator.js";
import {
  captureFrozenSQLiteSource,
  prepareFrozenSQLiteSource,
  snapshotDigest,
  verifyFrozenSQLiteSource,
  type FrozenSQLiteSource,
} from "./snapshot.js";
import type { MigrationTable } from "../data-migration.js";
import { activateBotDatabase, readBotDatabaseConfig } from "../../bots/database.js";
import { BotStore } from "../../bots/store.js";
import { botMigrationTables, migrateBotSnapshot } from "../../bots/migrate.js";
import { localAuthPaths } from "../../auth/paths.js";
import { importRevocations } from "../../auth/revocation-migration.js";
import { captureIdentitySnapshot, migrateIdentitySnapshot } from "../../auth/mysql-migration.js";
import { SQLiteLocalUsers } from "../../auth/users/sqlite.js";
import { identityMySQLModels } from "../modules/identity.js";
import { captureVisibilitySnapshot, migrateSettingsSnapshot } from "../../misc/visibility-migration.js";
import { settingsMySQLModels } from "../modules/settings.js";
import { ProjectCatalog } from "../../projects/catalog.js";
import { ProjectDocumentStorage } from "../../projects/document-storage.js";
import { projectMySQLModels } from "../modules/projects.js";
import { migrateProjectsSnapshot } from "../../projects/migrate.js";
import { ContentAccessStore } from "../../content-access/storage/grants.js";
import { contentAccessMySQLModels } from "../modules/content-access.js";
import { migrateContentAccessSnapshot } from "../../content-access/storage/migrate.js";
import { openDocumentDatabase } from "../../documents/database.js";
import { migrateDocumentNavigation } from "../../documents/navigation/schema.js";
import { documentSQLiteMappings, importDocumentsSQLite } from "../../documents/mysql-import.js";
import {
  documentOwnershipSQLiteMappings,
  importDocumentOwnershipSQLite,
} from "../../documents/ownership/mysql-migration.js";
import { migrateEditorial } from "../../editorial/schema.js";
import { editorialSQLiteMappings, importEditorialSQLite } from "../../editorial/mysql-import.js";
import { openCreationDatabase } from "../../creation/storage/database.js";
import {
  consolidateCreationSnapshots,
  creationSQLiteMappings,
  importCreationSQLite,
} from "../../creation/storage/mysql-import.js";
import { openSkillDatabase } from "../../skills/storage/database.js";
import { skillMySQLModels } from "../modules/skills.js";
import { migrateSkillsSnapshot } from "../../skills/storage/migrate.js";
import { SkillWorkspaceStore } from "../../skill-workspace/store.js";
import { skillWorkspaceMySQLModels } from "../modules/skill-workspace.js";
import { migrateSkillWorkspaceSnapshot } from "../../skill-workspace/migrate.js";
import { openCliCredentialStore } from "../../cli/auth/sqlite.js";
import { cliMySQLModels } from "../modules/cli-auth.js";
import { migrateCliSnapshot } from "../../cli/auth/migrate.js";
import { openPluginDatabase } from "../../plugins/storage/database.js";
import { pluginsMigrationTables, migratePluginsSnapshot } from "../../plugins/storage/migrate.js";
import { openPortableTemplateDatabase } from "../../templates/storage/database.js";
import { portableTemplatesMigrationTables, migratePortableTemplatesSnapshot } from "../../templates/storage/migrate.js";
import { openNativeThemeDatabase } from "../../templates/storage/native-database.js";
import { nativeThemesMigrationTables, migrateNativeThemesSnapshot } from "../../templates/storage/native-migrate.js";
import { openNativeSlidesDatabase } from "../../slides/storage/registry.js";
import { nativeSlidesMigrationTables, migrateNativeSlidesSnapshot } from "../../slides/storage/migrate.js";
import { openSourceStageDatabase } from "../../packages/staging/database.js";
import {
  packageSourcesMigrationTables,
  migratePackageSourcesSnapshot,
  migrateNativeThemeSourcesSnapshot,
  migrateNativeSlidesSourcesSnapshot,
} from "../../packages/staging/migrate.js";
import { openNativeSampleDatabase } from "../../builds/native/database.js";
import { nativeSamplesMigrationTables, migrateNativeSamplesSnapshot } from "../../builds/native/migrate.js";
import { SiteBuildRepository } from "../../builds/repository.js";
import { siteBuildsMigrationTables, migrateSiteBuildsSnapshot } from "../../builds/migrate.js";
import { VariantRepository } from "../../publishing/variant-repository.js";
import { publishingMigrationTables, migratePublishingSnapshot } from "../../publishing/migrate.js";
import { TemplatePreviewRepository } from "../../template-previews/repository.js";
import { templatePreviewsMigrationTables, migrateTemplatePreviewsSnapshot } from "../../template-previews/migrate.js";
import { ConnectionRepository } from "../../connections/repository.js";
import { CredentialRepository } from "../../connections/credentials/repository.js";
import { SocialAccountRepository } from "../../connections/accounts/repository.js";
import { OAuthAttempts } from "../../connections/oauth/attempts.js";
import { connectionMigrationTables, migrateConnectionSnapshot } from "../../connections/storage/mysql-migration.js";
import { initializePublicationSchema } from "../../delivery/storage/schema.js";
import { deliveryMigrationTables, migrateDeliverySnapshot } from "../../delivery/storage/mysql-migration.js";
import { prepareDeliverySnapshot } from "../../delivery/storage/normalize-snapshot.js";
import { openKnowledgeDatabase } from "../../knowledge/storage/database.js";
import { knowledgeMigrationTables, migrateKnowledgeSnapshot } from "../../knowledge/storage/mysql-migration.js";
import { openSearchDatabase } from "../../search/storage/database.js";
import { searchMigrationTables, migrateSearchSnapshot } from "../../search/storage/mysql-migration.js";
import { openEmbeddingDatabase } from "../../search/embeddings/database.js";
import { embeddingMigrationTables, migrateEmbeddingSnapshot } from "../../search/embeddings/mysql-migration.js";

type MySQLConfig = Extract<ApplicationDatabaseConfig, { driver: "mysql" }>;
type Initializer = (path: string) => void | Promise<void>;
type Copier = ApplicationMigrationUnit["copy"];
/** Overrides are exact administrator-selected files; a missing explicit path fails instead of creating an empty frame. */
export interface LegacySQLiteSourcePaths {
  projects?: string;
  documents?: string;
  publication?: string;
  skills?: string;
  skillWorkspace?: string;
  gadgets?: string;
  harness?: string;
  cliAuth?: string;
  plugins?: string;
  portableTemplates?: string;
  nativeThemes?: string;
  nativeSlides?: string;
  packageSources?: string;
  nativeThemeSources?: string;
  nativeSlidesSources?: string;
  nativeSamples?: string;
  templatePreviews?: string;
  creation?: string;
  knowledge?: string;
  search?: string;
  embeddings?: string;
  bots?: string;
  administrator?: string;
  password?: string;
  revocations?: string;
  legacyRevocations?: string;
}
export interface LegacySQLiteMigrationSourceOptions {
  stateRoot: string;
  operationId: string;
  current: ApplicationDatabaseConfig;
  target: MySQLConfig;
  env?: NodeJS.ProcessEnv;
  projectVisibilityPath?: string;
  paths?: LegacySQLiteSourcePaths;
}
interface SourceSpec {
  id: string;
  path: string;
  initialize: Initializer;
  explicit: boolean;
}
const targets = (tables: readonly MigrationTable[]) => tables.map((table) => table.target);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function emptySQLite(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.close();
}
function revocationsSQLite(path: string) {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("CREATE TABLE IF NOT EXISTS revoked_sessions(digest TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)");
  } finally {
    db.close();
  }
}
function publicationSQLite(db: Database) {
  new ConnectionRepository(db);
  new CredentialRepository(db);
  new SocialAccountRepository(db);
  new OAuthAttempts(db);
  initializePublicationSchema(db);
}
function documentsSQLite(path: string) {
  const db = openDocumentDatabase(path);
  try {
    migrateDocumentNavigation(db);
    migrateEditorial(db);
    new SiteBuildRepository(db);
    new VariantRepository(db);
  } finally {
    db.close();
  }
}
function projectsSQLite(path: string) {
  const catalog = new ProjectCatalog(path);
  try {
    new ProjectDocumentStorage(catalog.db);
    new ContentAccessStore(catalog.db);
  } finally {
    catalog.close();
  }
}
function publicationFile(path: string) {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000");
    publicationSQLite(db);
  } finally {
    db.close();
  }
}

/** Compile frozen SQLite sources only. Native-to-native export is a separate unsupported operation. */
export async function createLegacySQLiteMigrationSources(options: LegacySQLiteMigrationSourceOptions) {
  if (databaseConfiguration(options.current).driver !== "sqlite") throw Error("unsupportedMigrationSource");
  const parsedTarget = databaseConfiguration(options.target);
  if (parsedTarget.driver !== "mysql" || !isAbsolute(options.stateRoot) || !databaseIdentifier(options.operationId))
    throw Error("invalidMigrationConfiguration");
  const target = parsedTarget;
  const stateRoot = resolve(options.stateRoot),
    env = pandaEnvironment({ ...(options.env ?? process.env), PANDA_FORCE_HOME: stateRoot }),
    paths = options.paths ?? {},
    auth = localAuthPaths(env),
    bot = await readBotDatabaseConfig(stateRoot, env);
  if (bot.driver === "mysql" && databaseTargetHash(bot) !== databaseTargetHash(target))
    throw Error("botDatabaseTargetMismatch");
  const preservedModules = bot.driver === "mysql" ? ["bots"] : [],
    specs: SourceSpec[] = [],
    units: ApplicationMigrationUnit[] = [];
  const pathFor = (name: keyof LegacySQLiteSourcePaths, fallback: string) => {
    const path = paths[name] ?? fallback;
    if (!isAbsolute(path)) throw Error("invalidMigrationConfiguration");
    return resolve(path);
  };
  const addSource = (id: string, name: keyof LegacySQLiteSourcePaths, fallback: string, initialize: Initializer) => {
    const value = { id, path: pathFor(name, fallback), initialize, explicit: paths[name] !== undefined };
    specs.push(value);
    return value;
  };
  const addUnit = (id: string, module: string, source: string, targetTables: readonly string[], copy: Copier) =>
    units.push({ id, module, source, targetTables: [...targetTables], copy });
  const models = (items: readonly { name: string }[], excluded: readonly string[] = []) =>
    items.map((item) => item.name).filter((name) => !excluded.includes(name));
  const projects = addSource("projects", "projects", join(stateRoot, "data", "projects.sqlite"), projectsSQLite);
  const documents = addSource("documents", "documents", join(stateRoot, "data", "documents.sqlite"), documentsSQLite);
  const publicationPath = pathFor("publication", documents.path),
    sharedPublication = publicationPath === documents.path;
  if (sharedPublication) {
    const initialize = documents.initialize;
    documents.initialize = async (path) => {
      await initialize(path);
      publicationFile(path);
    };
  } else
    specs.push({
      id: "publication",
      path: publicationPath,
      initialize: publicationFile,
      explicit: paths.publication !== undefined,
    });
  const publicationSource = sharedPublication ? "documents" : "publication";
  addSource("skills", "skills", join(stateRoot, "data", "skills.sqlite"), (path) => openSkillDatabase(path).close());
  addSource("skill-workspace", "skillWorkspace", join(stateRoot, "data", "skill-workspace.sqlite"), (path) =>
    new SkillWorkspaceStore(path).close(),
  );
  addSource("harness", "harness", join(stateRoot, "data", "harness.sqlite"), (path) =>
    new SQLiteHarnessMetadata(path).close(),
  );
  addSource("gadgets", "gadgets", join(stateRoot, "data", "gadgets.sqlite"), (path) => new GadgetStore(path).close());
  addSource("cli-auth", "cliAuth", join(stateRoot, "data", "cli-auth.sqlite"), (path) =>
    openCliCredentialStore(path).close(),
  );
  addSource("plugins", "plugins", join(stateRoot, "data", "plugins.sqlite"), (path) =>
    openPluginDatabase(path).close(),
  );
  addSource("portable-templates", "portableTemplates", join(stateRoot, "templates", "registry.sqlite"), (path) =>
    openPortableTemplateDatabase(path).close(),
  );
  addSource("native-themes", "nativeThemes", join(stateRoot, "templates", "native", "registry.sqlite"), (path) =>
    openNativeThemeDatabase(path).close(),
  );
  addSource("native-slides", "nativeSlides", join(stateRoot, "templates", "native-slides", "registry.sqlite"), (path) =>
    openNativeSlidesDatabase(path).close(),
  );
  addSource("package-sources", "packageSources", join(stateRoot, "package-sources", "stages.sqlite"), (path) =>
    openSourceStageDatabase(path).close(),
  );
  addSource(
    "native-theme-sources",
    "nativeThemeSources",
    join(stateRoot, "templates", "native", "sources", "stages.sqlite"),
    (path) => openSourceStageDatabase(path).close(),
  );
  addSource(
    "native-slides-sources",
    "nativeSlidesSources",
    join(stateRoot, "templates", "native-slides", "sources", "stages.sqlite"),
    (path) => openSourceStageDatabase(path).close(),
  );
  addSource(
    "native-samples",
    "nativeSamples",
    join(stateRoot, "templates", "native", "samples", "runs.sqlite"),
    (path) => openNativeSampleDatabase(path).close(),
  );
  addSource("template-previews", "templatePreviews", join(stateRoot, "templates", "previews", "jobs.sqlite"), (path) =>
    new TemplatePreviewRepository(path).close(),
  );
  addSource("creation-application", "creation", join(stateRoot, "creation", "tasks.sqlite"), (path) =>
    openCreationDatabase(path).close(),
  );
  addSource("knowledge", "knowledge", join(stateRoot, "data", "knowledge.sqlite"), (path) =>
    openKnowledgeDatabase(path).close(),
  );
  addSource("search", "search", join(stateRoot, "data", "search.sqlite"), (path) => openSearchDatabase(path).close());
  addSource("embeddings", "embeddings", join(stateRoot, "data", "embeddings.sqlite"), (path) =>
    openEmbeddingDatabase(path).close(),
  );
  if (bot.driver === "sqlite")
    addSource("bots", "bots", join(stateRoot, "data", "bot-tasks.sqlite"), (path) => new BotStore(path).close());
  addUnit("identity", "identity", "identity", models(identityMySQLModels), migrateIdentitySnapshot);
  addUnit("projects", "projects", projects.id, models(projectMySQLModels), migrateProjectsSnapshot);
  addUnit(
    "content-access",
    "content-access",
    projects.id,
    models(contentAccessMySQLModels),
    migrateContentAccessSnapshot,
  );
  addUnit("documents", "documents", documents.id, targets(documentSQLiteMappings), (options) =>
    importDocumentsSQLite({ ...options, ownershipWillFollow: true }),
  );
  addUnit(
    "document-ownership",
    "documents",
    documents.id,
    targets(documentOwnershipSQLiteMappings),
    importDocumentOwnershipSQLite,
  );
  addUnit("editorial", "editorial", documents.id, targets(editorialSQLiteMappings), importEditorialSQLite);
  addUnit("skills", "skills", "skills", models(skillMySQLModels), migrateSkillsSnapshot);
  addUnit(
    "skill-workspace",
    "skill-workspace",
    "skill-workspace",
    models(skillWorkspaceMySQLModels, ["panda_force_skill_workspace_controls"]),
    migrateSkillWorkspaceSnapshot,
  );
  addUnit(
    "gadgets",
    "gadgets",
    "gadgets",
    models(gadgetMySQLModels, ["panda_force_gadget_workspace_controls"]),
    migrateGadgetSnapshot,
  );
  addUnit("harness", "harness", "harness", targets(harnessMigrationTables), migrateHarnessSnapshot);
  addUnit("plugins", "plugins", "plugins", targets(pluginsMigrationTables), migratePluginsSnapshot);
  addUnit(
    "portable-templates",
    "templates",
    "portable-templates",
    targets(portableTemplatesMigrationTables),
    migratePortableTemplatesSnapshot,
  );
  addUnit(
    "native-themes",
    "templates",
    "native-themes",
    targets(nativeThemesMigrationTables),
    migrateNativeThemesSnapshot,
  );
  addUnit(
    "native-slides",
    "templates",
    "native-slides",
    targets(nativeSlidesMigrationTables),
    migrateNativeSlidesSnapshot,
  );
  addUnit(
    "template-previews",
    "templates",
    "template-previews",
    targets(templatePreviewsMigrationTables),
    migrateTemplatePreviewsSnapshot,
  );
  addUnit(
    "package-sources",
    "package-sources",
    "package-sources",
    targets(packageSourcesMigrationTables),
    migratePackageSourcesSnapshot,
  );
  addUnit(
    "native-theme-sources",
    "package-sources",
    "native-theme-sources",
    targets(packageSourcesMigrationTables).map((name) =>
      name.replace("panda_force_package_", "panda_force_native_theme_"),
    ),
    migrateNativeThemeSourcesSnapshot,
  );
  addUnit(
    "native-slides-sources",
    "package-sources",
    "native-slides-sources",
    targets(packageSourcesMigrationTables).map((name) =>
      name.replace("panda_force_package_", "panda_force_native_slides_"),
    ),
    migrateNativeSlidesSourcesSnapshot,
  );
  addUnit("site-builds", "builds", documents.id, targets(siteBuildsMigrationTables), migrateSiteBuildsSnapshot);
  addUnit(
    "native-samples",
    "builds",
    "native-samples",
    targets(nativeSamplesMigrationTables),
    migrateNativeSamplesSnapshot,
  );
  addUnit("creation", "creation", "creation", targets(creationSQLiteMappings), importCreationSQLite);
  addUnit("publishing", "publishing", documents.id, targets(publishingMigrationTables), migratePublishingSnapshot);
  addUnit(
    "connections",
    "connections",
    publicationSource,
    targets(connectionMigrationTables),
    migrateConnectionSnapshot,
  );
  addUnit("delivery", "delivery", publicationSource, targets(deliveryMigrationTables), (copy) =>
    migrateDeliverySnapshot({ ...copy, normalizedDirectory: join(dirname(copy.snapshotPath), "delivery-chunks") }),
  );
  addUnit("knowledge", "knowledge", "knowledge", targets(knowledgeMigrationTables), migrateKnowledgeSnapshot);
  addUnit("search", "search", "search", targets(searchMigrationTables), migrateSearchSnapshot);
  addUnit(
    "search-embeddings",
    "search-embeddings",
    "embeddings",
    targets(embeddingMigrationTables),
    migrateEmbeddingSnapshot,
  );
  addUnit("cli-auth", "cli-auth", "cli-auth", models(cliMySQLModels, ["panda_force_cli_control"]), migrateCliSnapshot);
  addUnit("settings", "settings", "settings", models(settingsMySQLModels), migrateSettingsSnapshot);
  if (bot.driver === "sqlite") addUnit("bots", "bots", "bots", targets(botMigrationTables), migrateBotSnapshot);

  async function prepare(directory: string): Promise<ApplicationMigrationManifest> {
    const latestBot = await readBotDatabaseConfig(stateRoot, env);
    if (
      latestBot.driver !== bot.driver ||
      (latestBot.driver === "mysql" && databaseTargetHash(latestBot) !== databaseTargetHash(target))
    )
      throw Error("botDatabaseTargetMismatch");
    for (const spec of specs)
      if (spec.explicit) {
        try {
          const info = await lstat(spec.path);
          if (!info.isFile() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
        } catch (error) {
          if (missing(error)) throw Error("migrationSourceMissing", { cause: error });
          throw error;
        }
      }
    for (const name of ["revocations", "legacyRevocations"] as const)
      if (paths[name] !== undefined) {
        try {
          const info = await lstat(pathFor(name, auth[name]));
          if (!info.isFile() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
        } catch (error) {
          if (missing(error)) throw Error("migrationSourceMissing", { cause: error });
          throw error;
        }
      }
    if (!isAbsolute(directory)) throw Error("invalidMigrationSnapshot");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
    const sources: FrozenSQLiteSource[] = [],
      prepared = new Map<string, FrozenSQLiteSource>();
    const record = (source: FrozenSQLiteSource) => {
      if (sources.some((item) => item.id === source.id)) throw Error("migrationSourceChanged");
      sources.push(source);
      return source;
    };
    const derived = async (id: string, path: string, originalPath: string | null = null) => {
      await chmod(path, 0o400);
      const file = await open(path, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      return record({ id, originalPath, snapshotPath: path, ...(await snapshotDigest(path)) });
    };
    async function capture(spec: SourceSpec) {
      if (spec.explicit) {
        const info = await lstat(spec.path);
        if (!info.isFile() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
      }
      const raw = record(
        await captureFrozenSQLiteSource({
          id: spec.id + "-raw",
          directory,
          sourcePath: spec.path,
          initializeEmpty: emptySQLite,
        }),
      );
      const normalized = await prepareFrozenSQLiteSource(raw, join(directory, spec.id + ".sqlite"), spec.initialize);
      const source = record({ ...normalized, id: spec.id });
      prepared.set(spec.id, source);
      return source;
    }
    for (const spec of specs) await capture(spec);
    const publication = prepared.get(publicationSource)!;
    // The same physical source can serve multiple units while retaining an explicit raw publication binding.
    if (sharedPublication) {
      const raw = sources.find((source) => source.id === documents.id + "-raw")!;
      record({ ...raw, id: "publication-raw" });
    }
    const delivery = await prepareDeliverySnapshot({
      snapshotPath: publication.snapshotPath,
      directory: join(directory, "delivery-chunks"),
    });
    await derived("delivery-chunks", delivery.snapshotPath);
    const creation = [{ namespace: "application", snapshotPath: prepared.get("creation-application")!.snapshotPath }],
      personalRoot = join(stateRoot, "personal");
    try {
      const info = await lstat(personalRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
      for (const entry of (await readdir(personalRoot, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
        try {
          const folder = await lstat(join(personalRoot, entry.name, "creation"));
          if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        const path = join(personalRoot, entry.name, "creation", "tasks.sqlite");
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        const source = await capture({
          id: "creation-p-" + entry.name.slice(0, 48),
          path,
          initialize: (path) => openCreationDatabase(path).close(),
          explicit: true,
        });
        creation.push({ namespace: "personal:" + entry.name, snapshotPath: source.snapshotPath });
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const creationFrame = consolidateCreationSnapshots(join(directory, "creation.sqlite"), creation);
    await derived("creation", creationFrame.snapshotPath);

    async function privateFile(id: string, path: string, max: number, privateMode = true, required = false) {
      let bytes: Buffer;
      try {
        bytes = await readPrivateDatabaseFile(path, max, privateMode);
      } catch (error) {
        if (missing(error) && !required) return undefined;
        throw error;
      }
      const snapshotPath = join(directory, id + ".json"),
        file = await open(snapshotPath, "wx", 0o400);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      return derived(id, snapshotPath, path);
    }
    const administrator = await privateFile(
        "identity-administrator-raw",
        pathFor("administrator", auth.administrator),
        65536,
        true,
        paths.administrator !== undefined,
      ),
      password = await privateFile(
        "identity-password-raw",
        pathFor("password", auth.password),
        65536,
        true,
        paths.password !== undefined,
      );
    const revocationPath = pathFor("revocations", auth.revocations),
      legacyPath = pathFor("legacyRevocations", auth.legacyRevocations),
      rawRevocations = record(
        await captureFrozenSQLiteSource({
          id: "identity-revocations-raw",
          directory,
          sourcePath: revocationPath,
          initializeEmpty: revocationsSQLite,
        }),
      );
    let legacy: FrozenSQLiteSource | undefined;
    if (legacyPath !== revocationPath)
      legacy = record(
        await captureFrozenSQLiteSource({
          id: "identity-legacy-revocations-raw",
          directory,
          sourcePath: legacyPath,
          initializeEmpty: revocationsSQLite,
        }),
      );
    const merged = await prepareFrozenSQLiteSource(
      rawRevocations,
      join(directory, "identity-revocations.sqlite"),
      (path) => {
        revocationsSQLite(path);
        if (legacy) {
          const db = new Database(path, { strict: true });
          try {
            importRevocations(db, legacy.snapshotPath, Number.MIN_SAFE_INTEGER);
          } finally {
            db.close();
          }
        }
      },
    );
    record({ ...merged, id: "identity-revocations" });
    const identity = await captureIdentitySnapshot({
      directory: join(directory, "identity-frame"),
      administratorPath: administrator?.snapshotPath,
      passwordPath: password?.snapshotPath,
      revocationsSnapshotPath: merged.snapshotPath,
      usersSnapshotPath: (
        await capture({
          id: "identity-users",
          path: join(stateRoot, "data", "users.sqlite"),
          explicit: false,
          initialize: (path) => {
            new SQLiteLocalUsers(path).close();
          },
        })
      ).snapshotPath,
    });
    await derived("identity", identity);
    const visibilityPath =
      options.projectVisibilityPath ??
      existingApplicationPath(
        join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "panda-force-project-visibility.json"),
      );
    if (!isAbsolute(visibilityPath)) throw Error("invalidMigrationConfiguration");
    const visibility = await privateFile("settings-visibility-raw", visibilityPath, 4 * 1024 * 1024, false, false),
      settings = await captureVisibilitySnapshot({
        directory: join(directory, "settings-frame"),
        path: visibility?.snapshotPath,
      });
    await derived("settings", settings);
    for (const source of sources) await verifyFrozenSQLiteSource(source);
    return {
      schema: 1,
      operationId: options.operationId,
      sources,
      preservedModules: [...preservedModules],
      unitsFingerprint: migrationUnitsFingerprint(units),
    };
  }
  async function verifyPreservedModules(sql: SQL) {
    if (bot.driver !== "mysql") return;
    const current = await readBotDatabaseConfig(stateRoot, env);
    if (current.driver !== "mysql" || databaseTargetHash(current) !== databaseTargetHash(target))
      throw Error("botDatabaseTargetMismatch");
    await activateBotDatabase({ sql, config: current, stateRoot, migrateSQLite: false });
  }
  return {
    units: units as readonly ApplicationMigrationUnit[],
    prepare,
    preservedModules: preservedModules as readonly string[],
    verifyPreservedModules,
  };
}
