import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  databaseConfiguration,
  databaseConfigurationSummary,
  readApplicationDatabaseConfig,
} from "../../src/server/database/config.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { openApplicationDatabase } from "../../src/server/database/provider.js";
const external = () => ({
  schema: 1,
  driver: "mysql",
  mysql: {
    hostname: "database.internal",
    database: "shared_schema",
    username: "panda",
    password: "secret-value",
    tls: { mode: "verify" },
  },
});
test("database selection validates explicit transport and never exposes or silently downgrades external credentials", async () => {
  const config = databaseConfiguration(external());
  expect(config.driver).toBe("mysql");
  if (config.driver === "mysql") expect(config.mysql.maxLifetime).toBe(1800);
  expect(JSON.stringify(databaseConfigurationSummary(config))).not.toContain("secret-value");
  expect(JSON.stringify(databaseConfigurationSummary(config))).not.toContain("username");
  for (const mutate of [
    (v: any) => delete v.mysql.tls,
    (v: any) => (v.mysql.tls.rejectUnauthorized = false),
    (v: any) => (v.mysql.max = 0),
    (v: any) => (v.mysql.database = "schema; DROP TABLE x"),
    (v: any) => (v.mysql.hostname = "https://database/"),
  ]) {
    const value = external();
    mutate(value);
    expect(() => databaseConfiguration(value)).toThrow("invalidDatabaseConfiguration");
  }
  const unavailable = new DatabaseRegistry().register({
    id: "unavailable",
    dependencies: [],
    migrations: {},
    inspect: async () => [],
  });
  await expect(openApplicationDatabase(config, unavailable)).rejects.toThrow("missingDialect");
});
test("missing default config selects SQLite; unreadable, linked, public or malformed config fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-db-config-")),
    path = join(root, "database.json"),
    env = { PANDA_FORCE_DATABASE_CONFIG_FILE: path };
  try {
    expect(await readApplicationDatabaseConfig(root, {})).toEqual({ schema: 1, driver: "sqlite" });
    await expect(readApplicationDatabaseConfig(root, env)).rejects.toThrow("invalidDatabaseConfiguration");
    await writeFile(path, JSON.stringify(external()), { mode: 0o600 });
    expect((await readApplicationDatabaseConfig(root, env)).driver).toBe("mysql");
    await chmod(path, 0o644);
    await expect(readApplicationDatabaseConfig(root, env)).rejects.toThrow("invalidDatabaseConfiguration");
    await chmod(path, 0o600);
    const link = join(root, "linked.json");
    await symlink(path, link);
    await expect(readApplicationDatabaseConfig(root, { PANDA_FORCE_DATABASE_CONFIG_FILE: link })).rejects.toThrow(
      "invalidDatabaseConfiguration",
    );
    await writeFile(path, '{"driver":"mysql"}');
    await expect(readApplicationDatabaseConfig(root, env)).rejects.toThrow("invalidDatabaseConfiguration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
