import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlIdentityModule } from "../../src/server/database/modules/identity.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { createStoredAdministrator, saveStoredAdministrator } from "../../src/server/auth/administrator-store.js";
import { saveStoredPassword } from "../../src/server/auth/password-store.js";
import {
  createStoredPassword,
  storedPasswordSessionSecret,
  createPasswordSession,
  passwordSessionCookie,
} from "../../src/server/auth/security.js";
import { createSessionRevocations } from "../../src/server/auth/session-revocations.js";
import { MySQLSessionRevocations } from "../../src/server/auth/mysql-sessions.js";
import { MySQLIdentityCredentials } from "../../src/server/auth/mysql-credentials.js";
import { createMySQLAuthState } from "../../src/server/auth/mysql-state.js";
import { captureIdentitySnapshot, migrateIdentitySnapshot } from "../../src/server/auth/mysql-migration.js";
import { createPasswordAuth } from "../../src/server/auth/routes.js";
const request = (token?: string) =>
  ({
    method: "GET",
    headers: {
      host: "application.example.test",
      ...(token ? { cookie: passwordSessionCookie(token).split(";")[0] } : {}),
    },
    socket: { remoteAddress: "198.51.100.10" },
  }) as IncomingMessage;
test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "administrator and legacy password migration preserves session signing and durable logout across MySQL store instances",
  async () => {
    const f = await isolatedMySQLDatabase("identity"),
      root = await mkdtemp(join(tmpdir(), "identity-mysql-")),
      administratorPath = join(root, "administrator.json"),
      passwordPath = join(root, "password.json"),
      sessionsPath = join(root, "sessions.sqlite"),
      administrator = createStoredAdministrator("migration.admin", "Example-Password-For-Tests1!"),
      password = createStoredPassword("Legacy-password1!"),
      secret = storedPasswordSessionSecret(administrator.password)!,
      valid = createPasswordSession(secret),
      revoked = createPasswordSession(secret),
      source = createSessionRevocations(sessionsPath);
    const first = new MySQLSessionRevocations(f.sql, Date.now, 60000),
      second = new MySQLSessionRevocations(f.sql, Date.now, 60000);
    try {
      saveStoredAdministrator(administratorPath, administrator);
      saveStoredPassword(passwordPath, password);
      source.revoke(revoked.token);
      source.close();
      const originalAdmin = await readFile(administratorPath),
        originalPassword = await readFile(passwordPath),
        revocationsSnapshotPath = join(root, "sessions-snapshot.sqlite"),
        reader = new Database(sessionsPath, { readonly: true });
      try {
        reader.query("VACUUM INTO ?").run(revocationsSnapshotPath);
      } finally {
        reader.close();
      }
      const snapshotPath = await captureIdentitySnapshot({
        directory: root,
        administratorPath,
        passwordPath,
        revocationsSnapshotPath,
      });
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlIdentityModule);
      await registry.upgrade(new MySQLSchemaConnection(f.sql));
      await migrateIdentitySnapshot({ sql: f.sql, snapshotPath, migrationId: "identity-v1" });
      const credentials = new MySQLIdentityCredentials(f.sql),
        state = await createMySQLAuthState(
          credentials,
          { environmentPassword: null, accessToken: null, managedPasswordDisabled: false },
          { PANDA_FORCE_HOME: root, HOME: root, CODEX_HOME: join(root, "engine-unused") },
        ),
        auth = createPasswordAuth({ authState: state, revocations: first });
      expect(await credentials.administrator()).toEqual(administrator);
      expect(await credentials.password()).toEqual(password);
      expect(state.secret).toBe(secret);
      expect(await auth.isAuthorized(request())).toBe(false);
      expect(await auth.isAuthorized(request(valid.token))).toBe(true);
      expect(await auth.isAuthorized(request(revoked.token))).toBe(false);
      let closed = 0;
      const unwatch = await auth.watch(request(valid.token), () => {
        closed++;
      });
      await second.revoke(valid.token);
      await first.poll();
      expect(closed).toBe(1);
      unwatch();
      expect(await auth.isAuthorized(request(valid.token))).toBe(false);
      expect(await second.has(revoked.token)).toBe(true);
      await expect(
        credentials.saveAdministrator(createStoredAdministrator("replacement.admin", "Other-password1!")),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await credentials.administrator()).toEqual(administrator);
      expect(await readFile(administratorPath)).toEqual(originalAdmin);
      expect(await readFile(passwordPath)).toEqual(originalPassword);
      expect(await registry.inspect(new MySQLSchemaConnection(f.sql))).toEqual([]);
    } finally {
      first.close();
      second.close();
      source.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
