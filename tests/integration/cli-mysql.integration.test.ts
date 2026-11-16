import { test, expect } from "bun:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlCliAuthModule } from "../../src/server/database/modules/cli-auth.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { openMySQLCliCredentialStore } from "../../src/server/cli/auth/mysql.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { migrateCliSnapshot } from "../../src/server/cli/auth/migrate.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "CLI credentials migrate without changing grants or secrets and revoke consistently through MySQL",
  async () => {
    const fixture = await isolatedMySQLDatabase("cli"),
      { sql } = fixture,
      root = await mkdtemp(join(tmpdir(), "mysql-cli-copy-"));
    const sourcePath = join(root, "source.sqlite"),
      source = openCliCredentialStore(sourcePath);
    let now = 1000;
    const input = {
      name: "Private agent",
      kind: "codex",
      projects: ["personal", "project-1"],
      capabilities: ["content:read"],
      expiresInDays: 1,
    };
    try {
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlCliAuthModule);
      await registry.upgrade(new MySQLSchemaConnection(sql));
      const legacy = new CliCredentials(source.store, () => now),
        issued = await legacy.issue("owner", "https://panda.example", input, async () => {});
      const snapshotPath = join(root, "snapshot.sqlite"),
        reader = new Database(sourcePath, { readonly: true });
      try {
        reader.query("VACUUM INTO ?").run(snapshotPath);
      } finally {
        reader.close();
      }
      await chmod(snapshotPath, 0o400);
      await migrateCliSnapshot({ sql, snapshotPath, migrationId: "cli-import-v1" });
      const target = openMySQLCliCredentialStore(sql),
        service = new CliCredentials(target.store, () => now),
        peer = new CliCredentials(openMySQLCliCredentialStore(sql).store, () => now);
      expect(await service.authenticate(issued.registration.clientId, issued.apiKey)).toMatchObject({
        owner: "owner",
        projects: input.projects,
        capabilities: input.capabilities,
      });
      expect(await service.list("other")).toEqual([]);
      expect(JSON.stringify(await service.list("owner"))).not.toContain(issued.apiKey);
      await expect(service.revoke("other", issued.registration.clientId)).rejects.toThrow("notFound");
      await service.revoke("owner", issued.registration.clientId);
      await service.revoke("owner", issued.registration.clientId);
      await expect(peer.authenticate(issued.registration.clientId, issued.apiKey)).rejects.toThrow(
        "authenticationRequired",
      );
      const current = await service.issue("owner", "https://panda.example", input, async () => {});
      expect((await peer.authenticate(current.registration.clientId, current.apiKey)).clientId).toBe(
        current.registration.clientId,
      );
      now += 86400000;
      await expect(peer.authenticate(current.registration.clientId, current.apiKey)).rejects.toThrow(
        "authenticationRequired",
      );
      expect(await registry.inspect(new MySQLSchemaConnection(sql))).toEqual([]);
    } finally {
      source.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
