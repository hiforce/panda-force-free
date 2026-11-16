import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SocialAccountRepository } from "../../src/server/connections/accounts/repository.js";
import { SocialAccountService } from "../../src/server/connections/accounts/service.js";
import { AccountTokens } from "../../src/server/connections/accounts/tokens.js";
import { CredentialRepository } from "../../src/server/connections/credentials/repository.js";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";
import type { OAuthTokens } from "../../src/server/connections/oauth/ports.js";

async function fixture(ttl = 30000) {
  const db = new Database(":memory:"),
    owner = "fixture-owner",
    id = randomUUID(),
    projectId = randomUUID(),
    binding = { ownerId: owner, connectionId: id, connectorId: "x" };
  let now = Date.now(),
    calls = 0,
    refresh = async (): Promise<OAuthTokens> => ({
      accessToken: "fixture-new-access",
      refreshToken: "fixture-new-refresh",
      expiresAt: now + 7200000,
      scopes: ["users.read", "tweet.write"],
    });
  const secrets = new CredentialRepository(db, () => now),
    cipher = new CredentialCipher({ load: async () => ({ id: "fixture", bytes: Buffer.alloc(32, 7) }) });
  const accounts = new SocialAccountService(
    new SocialAccountRepository(db),
    secrets,
    cipher,
    {
      x: () => ({
        configuration: "a".repeat(64),
        authorize: () => "https://example.com",
        exchange: async () => {
          throw Error("No consent exchange expected");
        },
        refresh: async () => {
          calls++;
          return refresh();
        },
        identity: async () => ({ id: "12345", username: "fixture_user", name: "Fixture" }),
      }),
    },
    () => {},
  );
  await accounts.create(owner, {
    id,
    projectId,
    name: "Fixture",
    provider: "x",
    application: { clientId: "fixture", callbackUrl: "https://example.com/callback" },
  });
  const tokens = {
    accessToken: "fixture-old-access",
    refreshToken: "fixture-old-refresh",
    expiresAt: now + ttl,
    scopes: ["users.read", "tweet.write"],
  };
  accounts.accept({
    attempt: {
      ...accounts.current(owner, id),
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + 600000,
      phase: "verifying",
    },
    account: { id: "12345", username: "fixture_user", name: "Fixture" },
    grant: tokens,
    credential: await cipher.seal(binding, { ...tokens, accountId: "12345" }),
  });
  return {
    db,
    owner,
    id,
    binding,
    accounts,
    secrets,
    cipher,
    tokens: () => new AccountTokens(accounts, secrets, cipher, () => now),
    set(fn: typeof refresh) {
      refresh = fn;
    },
    get calls() {
      return calls;
    },
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

test("valid access checks scopes and account version, and guards reject subsequent disconnect", async () => {
  const f = await fixture(7200000);
  try {
    const token = await f.tokens().access(f.owner, f.id, 2, ["tweet.write"]);
    expect(token.accessToken).toBe("fixture-old-access");
    expect(f.calls).toBe(0);
    await expect(f.tokens().access(f.owner, f.id, 1, ["tweet.write"])).rejects.toThrow("credentialConflict");
    await expect(f.tokens().access(f.owner, f.id, 2, ["media.write"])).rejects.toThrow("authorizationRejected");
    await f.accounts.disconnect(f.owner, f.id, 2);
    expect(() => token.guard()).toThrow("authorizationRejected");
  } finally {
    f.db.close();
  }
});
test("routine refresh atomically advances credential metadata while retaining the authorized connection version", async () => {
  const f = await fixture();
  try {
    const token = await f.tokens().access(f.owner, f.id, 2, ["tweet.write"]);
    expect(token.accessToken).toBe("fixture-new-access");
    expect(f.calls).toBe(1);
    const account = f.accounts.detail(f.owner, f.id);
    expect(account.version).toBe(2);
    expect(account.grant?.credentialRevision).toBe(2);
    expect(account.grant?.expiresAt).toBe(f.now + 7200000);
    expect(f.secrets.get(f.binding).metadata.refreshState).toBe("ready");
    expect((await f.tokens().access(f.owner, f.id, 2, ["tweet.write"])).accessToken).toBe("fixture-new-access");
    expect(f.calls).toBe(1);
    token.guard();
    f.advance(7200001);
    expect(() => token.guard()).toThrow("authorizationExpired");
  } finally {
    f.db.close();
  }
});
test("competing refreshes send one request and a manual disconnect fences a late response", async () => {
  const f = await fixture();
  try {
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    f.set(async () => {
      entered();
      await wait;
      return { accessToken: "late", expiresAt: f.now + 7200000, scopes: ["users.read", "tweet.write"] };
    });
    const first = f.tokens().access(f.owner, f.id, 2, ["tweet.write"]);
    await started;
    expect(f.accounts.detail(f.owner, f.id).authorizationState).toBe("refreshing");
    await expect(f.tokens().access(f.owner, f.id, 2, ["tweet.write"])).rejects.toThrow("refreshBusy");
    expect(f.calls).toBe(1);
    await f.accounts.disconnect(f.owner, f.id, 2);
    release();
    await expect(first).rejects.toThrow("authorizationRejected");
    const saved = f.secrets.get(f.binding);
    expect(saved.metadata.revision).toBe(2);
    expect(await f.cipher.open(f.binding, saved.envelope)).toEqual({ kind: "disconnected" });
  } finally {
    f.db.close();
  }
});
test("unknown refresh outcomes and failed metadata commits cannot replay the refresh or expose old access tokens", async () => {
  for (const failure of ["network", "storage"]) {
    const f = await fixture();
    try {
      if (failure === "network")
        f.set(async () => {
          throw Error("Fixture lost refresh response");
        });
      else
        f.db.exec(
          "CREATE TRIGGER fixture_fail_grant BEFORE UPDATE ON publication_accounts BEGIN SELECT RAISE(ABORT,'Fixture grant failure'); END;",
        );
      await expect(f.tokens().access(f.owner, f.id, 2, ["tweet.write"])).rejects.toThrow();
      expect(f.accounts.detail(f.owner, f.id).grant?.credentialRevision).toBe(1);
      expect(f.secrets.get(f.binding).metadata.refreshState).toBe("uncertain");
      await expect(f.tokens().access(f.owner, f.id, 2, ["tweet.write"])).rejects.toThrow("refreshFailed");
      expect(f.calls).toBe(1);
      expect(f.accounts.detail(f.owner, f.id).authorizationState).toBe("reauthorizationRequired");
      if (failure === "storage") f.db.exec("DROP TRIGGER fixture_fail_grant");
      const tokens = {
        accessToken: "fixture-reauthorized",
        refreshToken: "fixture-renewed-refresh",
        expiresAt: f.now + 7200000,
        scopes: ["users.read", "tweet.write"],
      };
      f.accounts.accept({
        attempt: {
          ...f.accounts.current(f.owner, f.id),
          id: randomUUID(),
          createdAt: f.now,
          expiresAt: f.now + 600000,
          phase: "verifying",
        },
        account: { id: "12345", username: "fixture_user", name: "Fixture" },
        grant: tokens,
        credential: await f.cipher.seal(f.binding, { ...tokens, accountId: "12345" }),
      });
      const account = f.accounts.detail(f.owner, f.id);
      expect(account.authorizationState).toBe("ready");
      expect(account.version).toBe(3);
      expect(f.accounts.list(f.owner, account.projectId)[0]?.authorizationState).toBe("ready");
      expect(JSON.stringify(account)).not.toContain("fixture-reauthorized");
      expect((await f.tokens().access(f.owner, f.id, 3, ["tweet.write"])).accessToken).toBe("fixture-reauthorized");
      expect(f.calls).toBe(1);
    } finally {
      f.db.close();
    }
  }
});
test("changed refresh scopes invalidate plans and expired credentials cannot be returned", async () => {
  const f = await fixture();
  try {
    f.set(async () => ({ accessToken: "reduced", expiresAt: f.now + 7200000, scopes: ["users.read"] }));
    await expect(f.tokens().access(f.owner, f.id, 2, ["tweet.write"])).rejects.toThrow("credentialConflict");
    expect(f.accounts.detail(f.owner, f.id).version).toBe(3);
    expect(f.accounts.detail(f.owner, f.id).grant?.scopes).toEqual(["users.read"]);
    await expect(f.tokens().access(f.owner, f.id, 3, ["tweet.write"])).rejects.toThrow("authorizationRejected");
  } finally {
    f.db.close();
  }
});
