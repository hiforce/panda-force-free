import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocialAccountRepository } from "../../src/server/connections/accounts/repository.js";
import { XOAuthProvider } from "../../src/server/connections/adapters/x/oauth.js";
import { CredentialRepository } from "../../src/server/connections/credentials/repository.js";
import { createMySQLPublicationConnections } from "../../src/server/connections/integration/mysql-feature.js";
import { mysqlConnectionKey } from "../../src/server/connections/integration/mysql-key-provider.js";
import { OAuthAttempts } from "../../src/server/connections/oauth/attempts.js";
import { ConnectionRepository } from "../../src/server/connections/repository.js";
import { migrateConnectionSnapshot } from "../../src/server/connections/storage/mysql-migration.js";
import { mysqlConnectionsModule } from "../../src/server/database/modules/connections.js";
import { mysqlDeliveryModule } from "../../src/server/database/modules/delivery.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { MySQLSession } from "../../src/server/database/mysql-session.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { digest } from "../../src/server/delivery/digest.js";
import { createMySQLSitePublicationFeature } from "../../src/server/delivery/integration/mysql-feature.js";
import { createMySQLPublicationPersistence } from "../../src/server/delivery/integration/mysql-persistence.js";
import { mysqlSocialAccounts } from "../../src/server/delivery/integration/mysql-social-accounts.js";
import { createMySQLSocialPublicationFeature } from "../../src/server/delivery/integration/mysql-social-feature.js";
import { PublicationRepository } from "../../src/server/delivery/repository.js";
import { migrateDeliverySnapshot } from "../../src/server/delivery/storage/mysql-migration.js";
import { MySQLPublicationSnapshots } from "../../src/server/delivery/storage/mysql-snapshots.js";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { MySQLWorkflowWorker } from "../../src/server/delivery/workflows/mysql-worker.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

const guarded = test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE);
async function fixture() {
  const database = await isolatedMySQLDatabase("delivery"),
    root = await mkdtemp(join(tmpdir(), "publication-mysql-"));
  try {
    const registry = new DatabaseRegistry()
        .register(mysqlDataMigrationModule)
        .register(mysqlConnectionsModule)
        .register(mysqlDeliveryModule),
      schema = new MySQLSchemaConnection(database.sql);
    await registry.upgrade(schema);
    expect(await registry.inspect(schema)).toEqual([]);
    return {
      ...database,
      root,
      async dispose() {
        await database.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await database.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

guarded(
  "publication migration preserves scoped records, ciphertext, large snapshots and unresolved workflow history",
  async () => {
    const f = await fixture();
    let clock = 100000;
    try {
      const path = join(f.root, "publication.sqlite"),
        db = new Database(path, { create: true });
      db.exec("PRAGMA foreign_keys=ON");
      const records = new ConnectionRepository(db),
        secrets = new CredentialRepository(db, () => clock),
        accounts = new SocialAccountRepository(db),
        attempts = new OAuthAttempts(db, () => clock),
        sites = new PublicationRepository(db, () => clock),
        workflows = new WorkflowRepository(db, "x-post", () => clock);
      const projectId = randomUUID(),
        connectionId = randomUUID(),
        input = {
          id: connectionId,
          projectId,
          connector: "local-site" as const,
          name: "Frozen target",
          root: "local",
          directory: "site",
          publicUrl: "https://example.com/",
        };
      const connection = records.create("owner", input, "/isolated/fixture/site");
      const envelope = {
        version: 1 as const,
        keyId: "fixture-key",
        nonce: "a",
        tag: "b",
        ciphertext: "ciphertext-preserved",
      };
      const binding = { ownerId: "owner", connectionId, connectorId: "local-site" };
      secrets.put(binding, 0, envelope);
      const refresh = secrets.acquire(binding, 1);
      secrets.dispatch(binding, refresh);
      clock += 61000;
      const accountId = randomUUID(),
        storedAccount = {
          ownerId: "owner",
          configurationId: randomUUID(),
          configuration: digest("configuration"),
          secret: envelope,
          credentialRevision: 0,
          connection: {
            id: accountId,
            projectId,
            name: "Frozen social account",
            provider: "x" as const,
            enabled: true,
            version: 1,
            createdAt: clock,
            updatedAt: clock,
            application: {
              clientId: "fixture-client",
              callbackUrl: "https://example.com/api/publication-accounts/x/callback",
              confidential: false,
            },
          },
        };
      accounts.create(storedAccount);
      const attempt = attempts.reserve({
        ownerId: "owner",
        projectId,
        connectionId: accountId,
        connectionVersion: 1,
        providerId: "x",
        configuration: storedAccount.configuration,
      });
      const oauthState = "a".repeat(43),
        preparedAttempt = attempts.prepare("owner", attempt.id, oauthState, envelope, () => {});
      const payload = JSON.stringify({ frozen: "多語🙂".repeat(180000) }),
        hash = digest(payload),
        bytes = Buffer.byteLength(payload);
      db.query("INSERT INTO publication_snapshots(hash,payload,bytes) VALUES(?,?,?)").run(hash, payload, bytes);
      const workflow = workflows.prepare("owner", digest("legacy-identity"), {
        id: randomUUID(),
        projectId,
        spaceId: randomUUID(),
        connectionId,
        payload: { posts: ["frozen"] },
      });
      workflows.queue("owner", workflow.plan.id, workflow.plan.fingerprint, () => {});
      const oldLease = workflows.leases.acquire()!,
        pending = workflows.steps.intent(oldLease, "post.1", "post.create", { text: "frozen" }).step;
      workflows.finish(oldLease, "needsAttention", null, "outcomeUnknown");
      const captured = workflows.recovery.capture("owner", workflow.plan.id, pending.id),
        evidence = workflows.recovery.record("owner", workflow.plan.id, pending.id, captured.stateToken, {
          status: "match",
          result: { postId: "123" },
          details: { remoteId: "123" },
        });
      const frozen = workflows.get(workflow.plan.id);
      expect(accounts.encryptedCount()).toBe(1);
      expect(attempts.encryptedCount()).toBe(1);
      expect(sites.list("owner", workflow.plan.spaceId)).toEqual([]);
      db.close();
      const sourceBytes = await readFile(path);
      await migrateConnectionSnapshot({ sql: f.sql, snapshotPath: path, migrationId: "connections-v1" });
      await migrateDeliverySnapshot({ sql: f.sql, snapshotPath: path, migrationId: "delivery-v1" });
      await migrateDeliverySnapshot({ sql: f.sql, snapshotPath: path, migrationId: "delivery-v1" });
      expect(await readFile(path)).toEqual(sourceBytes);
      const first = createMySQLPublicationPersistence(f.sql, () => clock),
        second = createMySQLPublicationPersistence(f.sql, () => clock),
        store = first.workflow("x-post");
      expect((await first.connections.records.get(connectionId)).connection).toEqual(connection);
      expect(await first.connections.records.list("other", projectId)).toEqual([]);
      expect(await first.connections.accounts.get("owner", accountId)).toEqual(storedAccount);
      expect(await first.connections.attempts.lookup("owner", oauthState)).toEqual(preparedAttempt);
      await expect(first.connections.attempts.lookup("other", oauthState)).rejects.toThrow("authorizationExpired");
      expect(await first.connections.secrets.get(binding)).toMatchObject({
        envelope,
        metadata: { revision: 1, refreshState: "uncertain" },
      });
      await expect(first.connections.secrets.acquire(binding, 1)).rejects.toThrow("refreshFailed");
      expect(await store.get(workflow.plan.id)).toEqual(frozen);
      expect(await first.workflow("x-article").leases.acquire()).toBeNull();
      await expect(store.owned("other", workflow.plan.id)).rejects.toThrow("notFound");
      await expect(
        store.queue("owner", workflow.plan.id, workflow.plan.fingerprint, async () => {}, true),
      ).rejects.toThrow("conflict");
      await expect(
        store.recovery.adopt("owner", workflow.plan.id, evidence.id, async () => {
          await Promise.resolve();
          throw Error("revoked");
        }),
      ).rejects.toThrow("revoked");
      expect((await store.get(workflow.plan.id)).resolutions).toEqual([]);
      const decision = await store.recovery.adopt("owner", workflow.plan.id, evidence.id, async () => {});
      expect(
        await second.workflow("x-post").recovery.adopt("owner", workflow.plan.id, evidence.id, async () => {}),
      ).toEqual(decision);
      await store.queue("owner", workflow.plan.id, workflow.plan.fingerprint, async () => {}, true);
      let sends = 0;
      const worker = new MySQLWorkflowWorker(
        store,
        {
          authorize: async () => async () => {},
          execute: async (_owner, _plan, effects) =>
            effects.run("post.1", "post.create", { text: "frozen" }, async () => {
              sends++;
              return null;
            }),
        },
        (code) => {
          throw Error(code);
        },
      );
      worker.wake();
      await worker.idle();
      await worker.stop();
      expect(sends).toBe(0);
      expect((await store.get(workflow.plan.id)).phase).toBe("completed");
      const nativeInput = {
        id: randomUUID(),
        projectId,
        sourceProjectId: projectId,
        spaceId: randomUUID(),
        connectionId,
        payload: { posts: ["native"] },
      };
      const native = await store.prepare("owner", digest("native-identity"), nativeInput);
      await expect(
        store.queue("owner", native.plan.id, native.plan.fingerprint, async () => {
          await Promise.resolve();
          throw Error("revoked");
        }),
      ).rejects.toThrow("revoked");
      expect((await store.get(native.plan.id)).confirmations).toHaveLength(0);
      await store.queue("owner", native.plan.id, native.plan.fingerprint, async () => {});
      const claims = await Promise.all([store.leases.acquire(), second.workflow("x-post").leases.acquire()]),
        lease = claims.find(Boolean)!;
      expect(claims.filter(Boolean)).toHaveLength(1);
      const sent = await store.steps.intent(lease, "post.native", "post.create", { text: "native" });
      expect(sent.send).toBe(true);
      expect(sent.step.id).toBeGreaterThan(pending.id);
      await store.observations.record(lease, "fixture.state", {}, { status: "read" });
      await store.cancel("owner", native.plan.id);
      await expect(store.steps.intent(lease, "post.cancelled", "post.create", {})).rejects.toThrow("cancelled");
      await store.steps.settle(lease, sent.step.id, "succeeded", { postId: "456" }, null);
      expect((await store.finish(lease, "failed", null, "cancelled")).phase).toBe("cancelled");
      expect(await store.list("owner", nativeInput.spaceId)).toEqual([]);
      expect(await store.list("owner", nativeInput.spaceId, projectId)).toHaveLength(1);
      const parent = await store.get(native.plan.id),
        childInput = { ...nativeInput, id: randomUUID() };
      await expect(
        store.lineage.create("owner", parent.plan.id, parent.continuationToken, childInput, async () => {
          throw Error("revoked");
        }),
      ).rejects.toThrow("revoked");
      const child = await store.lineage.create(
        "owner",
        parent.plan.id,
        parent.continuationToken,
        childInput,
        async () => {},
      );
      expect(child.lineage.depth).toBe(1);
      expect(child.lineage.steps[0]?.result).toEqual({ postId: "456" });
      expect(
        (await store.lineage.create("owner", parent.plan.id, parent.continuationToken, childInput, async () => {})).plan
          .id,
      ).toBe(child.plan.id);
      const session = new MySQLSession(f.sql, {
          mutexTable: "panda_force_publication_mutex",
          numericColumns: ["bytes", "chunkCount", "ordinal"],
        }),
        snapshots = new MySQLPublicationSnapshots(session);
      expect(await snapshots.get(hash)).toBe(payload);
      const count = await f.sql.unsafe(
        "SELECT COUNT(*) n,MAX(bytes) largest FROM panda_force_publication_snapshot_chunks",
      );
      expect(Number(count[0].n)).toBeGreaterThan(16);
      expect(Number(count[0].largest)).toBeLessThanOrEqual(65536);
      await f.sql.unsafe(
        "UPDATE panda_force_publication_snapshot_chunks SET digest=? WHERE snapshotId=? AND ordinal=1",
        ["0".repeat(64), hash],
      );
      await expect(snapshots.get(hash)).rejects.toThrow("snapshotUnavailable");
      await f.sql.unsafe(
        "UPDATE panda_force_publication_snapshot_chunks SET digest=SHA2(payload,256) WHERE snapshotId=? AND ordinal=1",
        [hash],
      );
      await f.sql.unsafe(
        "UPDATE panda_force_publication_snapshot_chunks SET ordinal=9999 WHERE snapshotId=? AND ordinal=1",
        [hash],
      );
      await expect(snapshots.get(hash)).rejects.toThrow("snapshotUnavailable");
      await f.sql.unsafe(
        "UPDATE panda_force_publication_snapshot_chunks SET ordinal=1 WHERE snapshotId=? AND ordinal=9999",
        [hash],
      );
      expect(await snapshots.get(hash)).toBe(payload);
      const nativePayload = JSON.stringify({ native: "chunk-bound".repeat(150000) }),
        nativeHash = digest(nativePayload);
      await expect(
        session.atomic(async () => {
          await snapshots.put(nativePayload);
          throw Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        await f.sql.unsafe("SELECT hash FROM panda_force_publication_snapshots WHERE hash=?", [nativeHash]),
      ).toHaveLength(0);
      expect(
        await f.sql.unsafe("SELECT ordinal FROM panda_force_publication_snapshot_chunks WHERE snapshotId=?", [
          nativeHash,
        ]),
      ).toHaveLength(0);
      expect(await snapshots.put(nativePayload)).toBe(nativeHash);
      expect(await snapshots.get(nativeHash)).toBe(nativePayload);
      const key = mysqlConnectionKey(f.root, first.connections, {});
      await expect(key.ready()).rejects.toThrow("keyUnavailable");
      await expect(access(key.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.dispose();
    }
  },
  180000,
);

guarded(
  "native account composition fences asynchronous ownership, callback replay and unknown refresh without opening SQLite",
  async () => {
    const f = await fixture();
    try {
      const storage = createMySQLPublicationPersistence(f.sql),
        project = randomUUID(),
        owner = "owner";
      let permitted = true,
        calls = 0,
        expires = 7200,
        block: Promise<void> | undefined,
        entered: (() => void) | undefined;
      const feature = await createMySQLPublicationConnections({
        storage: storage.connections,
        stateRoot: f.root,
        sourceRoots: () => [],
        requireProject: async (id) => {
          await Promise.resolve();
          if (!permitted || id !== project) throw Error("revoked");
        },
        env: {},
        providers: {
          x: (config) =>
            new XOAuthProvider(config, {
              request: async (url) => {
                calls++;
                if (url.endsWith("/token")) {
                  entered?.();
                  await block;
                  return {
                    token_type: "bearer",
                    access_token: "fixture-access",
                    refresh_token: "fixture-refresh",
                    expires_in: expires,
                    scope: "users.read tweet.read tweet.write offline.access",
                  };
                }
                return { data: { id: "12345", username: "fixture_user", name: "Fixture User" } };
              },
            }),
        },
      });
      const account = await feature.accounts.create(owner, {
        id: randomUUID(),
        projectId: project,
        name: "Fixture",
        provider: "x",
        application: {
          clientId: "fixture-client",
          callbackUrl: "https://example.com/api/publication-accounts/x/callback",
        },
      });
      const authorization = await feature.consent.start(owner, account.id),
        state = new URL(authorization.url).searchParams.get("state")!;
      let release!: () => void;
      block = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const completing = feature.consent.callback(owner, state, "fixture-code");
      await started;
      expect((await feature.consent.callback(owner, state, "fixture-code")).phase).toBe("exchanging");
      release();
      const complete = await completing;
      expect(complete.phase).toBe("complete");
      expect(calls).toBe(2);
      expect(await feature.consent.callback(owner, state, "replayed-code")).toEqual(complete);
      expect(calls).toBe(2);
      const current = await feature.accounts.detail(owner, account.id),
        token = await feature.accountTokens.access(owner, account.id, current.version, ["tweet.write"]);
      expect(token.accessToken).toBe("fixture-access");
      permitted = false;
      await expect(token.guard()).rejects.toThrow("revoked");
      permitted = true;
      expect((await feature.accounts.list(owner, project))[0]?.account?.id).toBe("12345");
      const socialSpace = randomUUID(),
        variantId = randomUUID(),
        sent: Record<string, unknown>[] = [];
      const source = {
        documentId: randomUUID(),
        revisionId: randomUUID(),
        sourceHash: digest("source"),
        variantId,
        variantDigest: digest("variant"),
        templateId: "technical",
        templateVersion: "1",
        formatterVersion: "2",
      };
      const social = createMySQLSocialPublicationFeature({
        storage,
        accounts: mysqlSocialAccounts(feature.accounts, feature.accountTokens),
        sources: {
          capture: async () => ({
            projectId: project,
            spaceId: socialSpace,
            source,
            media: [],
            content: { format: "x-thread", posts: ["first", "second"], postMedia: [[], []] },
          }),
          authorize: async () => async () => {
            await Promise.resolve();
            if (!permitted) throw Error("source-revoked");
          },
          space: async () => async () => {
            if (!permitted) throw Error("source-revoked");
          },
          async readImage() {
            throw Error("unused");
          },
          article() {
            throw Error("unused");
          },
        },
        transport: {
          async request(_path, access, body) {
            await access.guard();
            expect(
              await f.sql.unsafe("SELECT id FROM panda_force_publication_steps WHERE outcome='pending'"),
            ).toHaveLength(1);
            sent.push(JSON.parse(body!));
            return { data: { id: String(200 + sent.length), text: "confirmed" } };
          },
        },
      });
      try {
        const plan = await social.service.prepare(owner, { id: randomUUID(), variantId, connectionId: account.id });
        const command = {
          id: plan.plan.id,
          kind: plan.plan.kind,
          fingerprint: plan.plan.fingerprint,
          acceptPlatformCosts: true,
          acceptPlatformEligibility: true,
        };
        permitted = false;
        await expect(social.service.submit(owner, command)).rejects.toThrow("source-revoked");
        permitted = true;
        expect(sent).toHaveLength(0);
        expect((await storage.workflow("x-post").get(plan.plan.id)).confirmations).toHaveLength(0);
        await social.service.submit(owner, command);
        await social.idle();
        const complete = await social.service.detail(owner, "x-post", plan.plan.id);
        expect(complete.phase).toBe("completed");
        expect(complete.steps.map((step) => step.id)).toEqual([1, 2]);
        expect(sent).toEqual([{ text: "first" }, { text: "second", reply: { in_reply_to_tweet_id: "201" } }]);
        await social.service.submit(owner, command);
        await social.idle();
        expect(sent).toHaveLength(2);
      } finally {
        await social.stop();
      }
      const target = await feature.accounts.accessTarget(owner, account.id),
        binding = { ownerId: owner, connectionId: account.id, connectorId: "x" };
      const lease = await storage.connections.secrets.acquire(binding, target.credentialRevision);
      await storage.connections.secrets.dispatch(binding, lease);
      await storage.connections.secrets.release(binding, lease);
      await expect(feature.accountTokens.access(owner, account.id, current.version, ["tweet.write"])).rejects.toThrow(
        "refreshFailed",
      );
      expect(calls).toBe(2);
      const files = await readdir(f.root);
      expect(files.some((name) => name.endsWith(".sqlite"))).toBe(false);
      const publicText = JSON.stringify(await feature.accounts.detail(owner, account.id));
      expect(publicText).not.toContain("fixture-access");
      expect(publicText).not.toContain("fixture-refresh");
      const existingKey = await readFile(join(f.root, "config", "connection-key"));
      await createMySQLPublicationConnections({
        storage: storage.connections,
        stateRoot: f.root,
        sourceRoots: () => [],
        requireProject: () => {},
        env: {},
      });
      expect(await readFile(join(f.root, "config", "connection-key"))).toEqual(existingKey);
      const content = Buffer.from("<h1>Frozen native site</h1>"),
        spaceId = randomUUID(),
        build = {
          id: randomUUID(),
          site: { title: "Fixture", url: "https://example.com", basePath: "/", locale: "en" },
          engine: "hexo" as const,
          inputHash: digest("fixture"),
          sources: [],
          image: null,
        },
        artifact = {
          protocol: 1 as const,
          bytes: content.length,
          files: [{ path: "index.html", data: content.toString("base64"), sha256: digest(content) }],
        };
      const sites = await createMySQLSitePublicationFeature({
        storage,
        stateRoot: f.root,
        sourceRoots: () => [],
        requireProject: () => {},
        owner: () => owner,
        sources: {
          authorize: () => ({
            async assertCurrent() {
              if (!permitted) throw Error("revoked");
            },
            assertDestination() {},
          }),
          capture: async () => ({ projectId: project, spaceId, build, artifact }),
        },
        socialSources: {
          capture() {
            throw Error("unused");
          },
          authorize: () => () => {},
          space: () => () => {},
          async readImage() {
            throw Error("unused");
          },
          article() {
            throw Error("unused");
          },
        },
        env: {},
      });
      try {
        const connection = await sites.connections.create(owner, {
          id: randomUUID(),
          projectId: project,
          name: "Native site",
          connector: "local-site",
          root: "local",
          directory: "native",
          publicUrl: "https://example.com/",
        });
        const publication = await sites.service.prepare(owner, {
          id: randomUUID(),
          connectionId: connection.id,
          connectionVersion: connection.version,
          buildId: build.id,
        });
        permitted = false;
        await expect(sites.service.publish(owner, publication.plan.id, publication.plan.fingerprint)).rejects.toThrow(
          "revoked",
        );
        permitted = true;
        expect((await sites.service.detail(owner, publication.plan.id)).job.phase).toBe("prepared");
        await sites.service.publish(owner, publication.plan.id, publication.plan.fingerprint);
        await sites.idle();
        expect((await sites.service.detail(owner, publication.plan.id)).job.phase).toBe("published");
        expect(await readFile(join(f.root, "published", "native", "current", "index.html"), "utf8")).toBe(
          content.toString(),
        );
        expect(await f.sql.unsafe("SELECT hash FROM panda_force_publication_snapshots")).toHaveLength(0);
        expect((await readdir(f.root)).some((name) => name.endsWith(".sqlite"))).toBe(false);
      } finally {
        await sites.stop();
      }
    } finally {
      await f.dispose();
    }
  },
  180000,
);
