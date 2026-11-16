import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlIdentityModule } from "../../src/server/database/modules/identity.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { createStoredAdministrator, saveStoredAdministrator } from "../../src/server/auth/administrator-store.js";
import { createMySQLAuthState } from "../../src/server/auth/mysql-state.js";
import { MySQLIdentityCredentials } from "../../src/server/auth/mysql-credentials.js";
import { captureIdentitySnapshot, migrateIdentitySnapshot } from "../../src/server/auth/mysql-migration.js";
import { SQLiteLocalUsers } from "../../src/server/auth/users/sqlite.js";
import { MySQLLocalUsers } from "../../src/server/auth/users/mysql.js";
import { LocalAccounts, localAdministratorIdentity } from "../../src/server/auth/users/service.js";
import { MemberInvitations } from "../../src/server/auth/users/invitations.js";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";
import { publicationOwner } from "../../src/server/connections/integration/identity.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "local users migrate with pending delivery; CAS and credential revocation agree across MySQL instances",
  async () => {
    const f = await isolatedMySQLDatabase("users"),
      root = await mkdtemp(join(tmpdir(), "local-users-mysql-"));
    const source = new SQLiteLocalUsers(join(root, "users.sqlite"));
    const cipher = new CredentialCipher({ load: async () => ({ id: "test-key", bytes: Buffer.alloc(32, 9) }) });
    const messages: string[] = [],
      codes: string[] = [],
      mail = {
        send: async (message: { link: string; code?: string }) => {
          messages.push(message.link);
          if (message.code) codes.push(message.code);
        },
      };
    const ownerId = createHash("sha256")
      .update(JSON.stringify(["idaas", "tenant-test", "identity-test"]))
      .digest("hex");
    const administrator = { ...createStoredAdministrator("rocky", "Original-password-123"), ownerId };
    const administratorPath = join(root, "administrator.json");
    try {
      saveStoredAdministrator(administratorPath, administrator);
      const invitations = new MemberInvitations(source, cipher, mail, "https://example.test");
      const user = await invitations.invite({ email: "member@example.com", operationId: randomUUID() });
      await source.saveSettings(
        { revision: 1, administratorEmail: { email: "rocky@example.com", verifiedAt: Date.now() } },
        0,
      );
      const snapshot = join(root, "users-snapshot.sqlite"),
        reader = new Database(join(root, "users.sqlite"), { readonly: true });
      reader.query("VACUUM INTO ?").run(snapshot);
      reader.close();
      const identity = await captureIdentitySnapshot({
        directory: root,
        administratorPath,
        usersSnapshotPath: snapshot,
      });
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlIdentityModule);
      await registry.upgrade(new MySQLSchemaConnection(f.sql));
      await migrateIdentitySnapshot({ sql: f.sql, snapshotPath: identity, migrationId: "local-users-v1" });
      const repository = new MySQLLocalUsers(f.sql),
        second = new MySQLLocalUsers(f.sql);
      expect(await repository.list()).toEqual(source.list());
      expect(await repository.settings()).toEqual(source.settings());
      const auth = await createMySQLAuthState(
        new MySQLIdentityCredentials(f.sql),
        { environmentPassword: null, accessToken: null, managedPasswordDisabled: false },
        { PANDA_FORCE_HOME: root, HOME: root, CODEX_HOME: join(root, "unused") },
      );
      expect(localAdministratorIdentity(auth)!.owner).toBe(ownerId);
      expect(publicationOwner(auth, {})).toBe(ownerId);
      const delivery = new MemberInvitations(repository, cipher, mail, "https://example.test");
      expect(await delivery.deliver(user.id, new AbortController().signal)).toBe(true);
      const token = new URLSearchParams(new URL(messages[0]).hash.slice(1)).get("token")!;
      await delivery.accept({ token, password: "Member-password-123" });
      const accounts = new LocalAccounts(repository, auth),
        other = new LocalAccounts(second, auth);
      try {
        const session = (await accounts.login("member@example.com", "Member-password-123"))!;
        expect((await other.authenticate(session.token))!.id).toBe(user.id);
        const challengeId = randomUUID();
        await delivery.reset((await repository.get(user.id))!, challengeId, "en", { verificationCode: true });
        expect((await second.findChallenge(challengeId))!.id).toBe(user.id);
        await delivery.deliver(user.id, new AbortController().signal);
        expect(codes[0]).toMatch(/^[0-9]{6}$/);
        const verifier = new MemberInvitations(second, cipher, mail, "https://example.test");
        const proof = await verifier.verifyCode({ challengeId, code: codes[0], verificationId: randomUUID() });
        expect(proof.token).toBe(new URLSearchParams(new URL(messages[1]).hash.slice(1)).get("token")!);
        expect((await other.authenticate(session.token))!.id).toBe(user.id);
        const current = (await repository.get(user.id))!;
        const competing = await Promise.allSettled([
          accounts.update(user.id, { revision: current.revision, role: "admin" }),
          other.update(user.id, { revision: current.revision, enabled: false }),
        ]);
        expect(competing.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        expect(await other.authenticate(session.token)).toBeNull();
        const settings = await repository.settings();
        await repository.saveSettings({ ...settings, revision: settings.revision + 1 }, settings.revision);
        await expect(
          second.saveSettings({ ...settings, revision: settings.revision + 1 }, settings.revision),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(localAdministratorIdentity(auth)!.owner).toBe(ownerId);
        await expect(delivery.accept({ token, password: "Another-password-123" })).rejects.toMatchObject({
          code: "invalidInvitation",
        });
      } finally {
        await accounts.close();
        await other.close();
      }
    } finally {
      source.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
