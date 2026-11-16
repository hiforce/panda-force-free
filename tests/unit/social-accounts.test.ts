import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SocialAccountRepository } from "../../src/server/connections/accounts/repository.js";
import { SocialAccountService } from "../../src/server/connections/accounts/service.js";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";
import { CredentialRepository } from "../../src/server/connections/credentials/repository.js";
import { ConnectionVault } from "../../src/server/connections/credentials/vault.js";
import { OAuthAttempts } from "../../src/server/connections/oauth/attempts.js";
import { OAuthConsent } from "../../src/server/connections/oauth/service.js";
import { XOAuthProvider } from "../../src/server/connections/adapters/x/oauth.js";
import { connectionKey } from "../../src/server/connections/integration/key-provider.js";

function fixture(db = new Database(":memory:")) {
  const owner = "fixture-owner",
    project = randomUUID(),
    records = new SocialAccountRepository(db),
    secrets = new CredentialRepository(db),
    attempts = new OAuthAttempts(db);
  const cipher = new CredentialCipher({ load: async () => ({ id: "fixture", bytes: Buffer.alloc(32, 8) }) });
  let account = "12345",
    requests = 0,
    permitted = true,
    identityWait = async () => {};
  const service = new SocialAccountService(
    records,
    secrets,
    cipher,
    {
      x: (config) =>
        new XOAuthProvider(config, {
          request: async (url) => {
            requests++;
            if (url.endsWith("/token"))
              return {
                token_type: "bearer",
                access_token: "fixture-access-secret",
                refresh_token: "fixture-refresh-secret",
                expires_in: 7200,
                scope: "users.read tweet.write offline.access",
              };
            await identityWait();
            return { data: { id: account, username: "fixture_user", name: "Fixture User" } };
          },
        }),
    },
    (actor, id) => {
      if (actor !== owner || id !== project || !permitted) throw Error("Project access denied");
    },
  );
  const consent = new OAuthConsent(attempts, cipher, service);
  const input = {
    id: randomUUID(),
    projectId: project,
    name: "X fixture",
    provider: "x",
    application: {
      clientId: "fixture-client",
      clientSecret: "fixture-application-secret",
      callbackUrl: "https://example.com/api/publication-accounts/x/callback",
    },
  };
  return {
    db,
    owner,
    project,
    records,
    secrets,
    attempts,
    cipher,
    service,
    consent,
    input,
    vault: new ConnectionVault(secrets, cipher),
    binding: { ownerId: owner, connectionId: input.id, connectorId: "x" },
    account(value: string) {
      account = value;
    },
    denied() {
      permitted = false;
    },
    wait(fn: () => Promise<void>) {
      identityWait = fn;
    },
    get requests() {
      return requests;
    },
  };
}
async function authorize(f: ReturnType<typeof fixture>) {
  const start = await f.consent.start(f.owner, f.input.id);
  return f.consent.callback(f.owner, new URL(start.url).searchParams.get("state")!, "fixture-code");
}

test("social account configuration is encrypted, owner scoped, idempotent and has no directory identity", async () => {
  const f = fixture();
  try {
    const first = await f.service.create(f.owner, f.input);
    expect(first.application.confidential).toBe(true);
    expect(JSON.stringify(first)).not.toContain("fixture-application-secret");
    expect(await f.service.create(f.owner, f.input)).toEqual(first);
    expect(f.requests).toBe(0);
    expect(() => f.service.detail("another-owner", first.id)).toThrow("notFound");
    expect(() => f.service.list(f.owner, randomUUID())).toThrow("Project access denied");
    expect(f.service.list(f.owner, f.project)).toHaveLength(1);
    expect((await f.service.create(f.owner, { ...f.input, id: randomUUID() })).id).not.toBe(first.id);
    expect(JSON.stringify(f.db.query("SELECT * FROM publication_accounts").all())).not.toContain(
      "fixture-application-secret",
    );
    await expect(f.service.create(f.owner, { ...f.input, ownerId: "foreign" })).rejects.toThrow("invalidInput");
    await expect(
      f.service.update(f.owner, first.id, { version: 1, name: "Changed", enabled: true, account: { id: "1" } }),
    ).rejects.toThrow("invalidInput");
    await expect(f.service.update(f.owner, first.id, { version: 2, name: "Changed", enabled: true })).rejects.toThrow(
      "conflict",
    );
  } finally {
    f.db.close();
  }
});
test("verified identity and credentials commit atomically and reauthorization cannot change the platform account", async () => {
  const f = fixture();
  try {
    await f.service.create(f.owner, f.input);
    expect((await authorize(f)).phase).toBe("complete");
    const connection = f.service.detail(f.owner, f.input.id);
    expect(connection.account?.id).toBe("12345");
    expect(connection.grant?.credentialRevision).toBe(1);
    expect(connection.grant?.scopes).toContain("tweet.write");
    expect(connection.grant?.scopes).not.toContain("article.write");
    expect(JSON.stringify(connection)).not.toContain("fixture-access-secret");
    const saved = await f.vault.read(f.binding);
    expect(saved.credential.accountId).toBe("12345");
    f.account("98765");
    await expect(authorize(f)).rejects.toThrow("targetChanged");
    expect(f.service.detail(f.owner, f.input.id)).toEqual(connection);
    expect(await f.vault.read(f.binding)).toEqual(saved);
    f.account("12345");
    expect((await authorize(f)).phase).toBe("complete");
    expect(f.service.detail(f.owner, f.input.id).grant?.credentialRevision).toBe(2);
  } finally {
    f.db.close();
  }
});
test("configuration rotation invalidates the grant, erases old tokens and fences late identity results", async () => {
  const f = fixture();
  try {
    await f.service.create(f.owner, f.input);
    await authorize(f);
    const pending = await f.consent.start(f.owner, f.input.id);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    f.wait(async () => {
      entered();
      await wait;
    });
    const callback = f.consent.callback(f.owner, new URL(pending.url).searchParams.get("state")!, "fixture-code");
    await ready;
    const changed = await f.service.update(f.owner, f.input.id, {
      version: 2,
      name: "Rotated",
      enabled: true,
      application: { ...f.input.application, clientSecret: "fixture-new-secret" },
    });
    expect(changed.grant).toBeUndefined();
    expect(changed.account?.id).toBe("12345");
    expect((await f.vault.read(f.binding)).credential).toEqual({ kind: "disconnected" });
    release();
    await expect(callback).rejects.toThrow("authorizationRejected");
    expect(f.service.detail(f.owner, f.input.id)).toEqual(changed);
    f.wait(async () => {});
    await authorize(f);
    expect(f.service.detail(f.owner, f.input.id).grant?.credentialRevision).toBe(3);
  } finally {
    f.db.close();
  }
});
test("disabling an account erases tokens, keeps identity and prevents consent until explicitly enabled", async () => {
  const f = fixture();
  try {
    await f.service.create(f.owner, f.input);
    await authorize(f);
    const pending = await f.consent.start(f.owner, f.input.id);
    const disabled = await f.service.disconnect(f.owner, f.input.id, 2);
    expect(disabled.enabled).toBe(false);
    expect(disabled.grant).toBeUndefined();
    expect((await f.vault.read(f.binding)).credential).toEqual({ kind: "disconnected" });
    await expect(f.consent.start(f.owner, f.input.id)).rejects.toThrow("authorizationRejected");
    await expect(f.consent.callback(f.owner, new URL(pending.url).searchParams.get("state")!, "code")).rejects.toThrow(
      "authorizationRejected",
    );
    await f.service.update(f.owner, f.input.id, { version: 3, name: disabled.name, enabled: true });
    await authorize(f);
    expect(f.service.detail(f.owner, f.input.id).grant?.credentialRevision).toBe(3);
    f.denied();
    await expect(f.consent.start(f.owner, f.input.id)).rejects.toThrow("Project access denied");
  } finally {
    f.db.close();
  }
});
test("the encryption key cannot be regenerated when only saved OAuth applications or attempts contain ciphertext", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-account-key-")),
    db = new Database(":memory:");
  try {
    const secrets = new CredentialRepository(db),
      records = new SocialAccountRepository(db),
      attempts = new OAuthAttempts(db);
    const key = connectionKey(
        root,
        { count: () => secrets.count() + records.encryptedCount() + attempts.encryptedCount() },
        {},
      ),
      cipher = new CredentialCipher(key.provider);
    const target = {
      ownerId: "fixture",
      projectId: randomUUID(),
      connectionId: randomUUID(),
      connectionVersion: 1,
      providerId: "x",
      configuration: "a".repeat(64),
    };
    const attempt = attempts.reserve(target);
    const secret = await cipher.seal(
      { ownerId: "fixture", connectionId: attempt.id, connectorId: "oauth" },
      { kind: "pkce", verifier: "fixture" },
    );
    attempts.prepare("fixture", attempt.id, "a".repeat(43), secret, () => {});
    expect(secrets.count()).toBe(0);
    expect(attempts.encryptedCount()).toBe(1);
    await rm(key.path);
    await expect(key.provider.load()).rejects.toThrow("keyUnavailable");
    await expect(readFile(key.path)).rejects.toThrow();
    attempts.abandon("fixture", attempt.id);
    expect(attempts.encryptedCount()).toBe(0);
    const service = new SocialAccountService(
      records,
      secrets,
      cipher,
      {
        x: (config) =>
          new XOAuthProvider(config, {
            request: async () => {
              throw Error("No requests expected");
            },
          }),
      },
      () => {},
    );
    await service.create("fixture", {
      id: randomUUID(),
      projectId: target.projectId,
      name: "Fixture",
      provider: "x",
      application: {
        clientId: "fixture-client",
        callbackUrl: "http://localhost:8899/api/publication-accounts/x/callback",
      },
    });
    expect(records.encryptedCount()).toBe(1);
    await rm(key.path);
    await expect(key.provider.load()).rejects.toThrow("keyUnavailable");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an account persistence failure rolls back both credentials and consent completion", async () => {
  const f = fixture();
  try {
    await f.service.create(f.owner, f.input);
    const start = await f.consent.start(f.owner, f.input.id);
    f.db.exec(
      "CREATE TRIGGER fixture_reject_account BEFORE UPDATE ON publication_accounts BEGIN SELECT RAISE(ABORT,'Fixture write failure'); END;",
    );
    await expect(
      f.consent.callback(f.owner, new URL(start.url).searchParams.get("state")!, "fixture-code"),
    ).rejects.toThrow("Fixture write failure");
    expect(f.secrets.count()).toBe(0);
    expect(f.service.detail(f.owner, f.input.id).account).toBeUndefined();
    expect(f.consent.status(f.owner, start.id).phase).toBe("verifying");
    f.db.exec("DROP TRIGGER fixture_reject_account");
    expect((await f.consent.verify(f.owner, start.id)).phase).toBe("complete");
    expect(f.requests).toBe(3);
    expect(f.secrets.count()).toBe(1);
  } finally {
    f.db.close();
  }
});
