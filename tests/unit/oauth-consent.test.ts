import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";
import { CredentialRepository } from "../../src/server/connections/credentials/repository.js";
import { ConnectionVault } from "../../src/server/connections/credentials/vault.js";
import { OAuthAttempts, type OAuthAttemptTarget } from "../../src/server/connections/oauth/attempts.js";
import { OAuthConsent } from "../../src/server/connections/oauth/service.js";
import { OAuthError } from "../../src/server/connections/oauth/errors.js";
import type { OAuthProvider } from "../../src/server/connections/oauth/ports.js";

function fixture() {
  const db = new Database(":memory:"),
    cipher = new CredentialCipher({ load: async () => ({ id: "fixture", bytes: Buffer.alloc(32, 4) }) }),
    attempts = new OAuthAttempts(db),
    secrets = new CredentialRepository(db),
    vault = new ConnectionVault(secrets, cipher);
  const target: OAuthAttemptTarget = {
    ownerId: "fixture-owner",
    projectId: randomUUID(),
    connectionId: randomUUID(),
    connectionVersion: 1,
    providerId: "x",
    configuration: "b".repeat(64),
  };
  db.exec("CREATE TABLE fixture_connection(id TEXT PRIMARY KEY,record TEXT,account TEXT)");
  db.query("INSERT INTO fixture_connection VALUES(?,?,NULL)").run(target.connectionId, JSON.stringify(target));
  let exchanges = 0,
    identities = 0,
    accepts = 0,
    beforeExchange = async () => {},
    beforeIdentity = async () => {};
  const provider: OAuthProvider = {
    configuration: target.configuration,
    authorize: (state, challenge) =>
      "https://x.com/i/oauth2/authorize?" + new URLSearchParams({ state, code_challenge: challenge }),
    exchange: async (code, verifier) => {
      exchanges++;
      expect(code).toBe("fixture-code");
      expect(verifier).toHaveLength(43);
      await beforeExchange();
      return {
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 7200000,
        scopes: ["users.read", "tweet.write"],
      };
    },
    refresh: async () => {
      throw Error("Unexpected refresh during consent");
    },
    identity: async () => {
      identities++;
      await beforeIdentity();
      return { id: "12345", username: "fixture_user", name: "Fixture User" };
    },
  };
  const current = (owner: string, connection: string) => {
    const row = db
      .query<{ record: string }, [string]>("SELECT record FROM fixture_connection WHERE id=?")
      .get(connection);
    if (!row) throw new OAuthError("authorizationRejected");
    const value = JSON.parse(row.record) as OAuthAttemptTarget;
    if (value.ownerId !== owner) throw new OAuthError("authorizationRejected");
    return { target: value, provider };
  };
  const service = new OAuthConsent(attempts, cipher, {
    current: (owner, connection) => current(owner, connection).target,
    provider: async () => provider,
    accept: ({ attempt, account, credential }) => {
      accepts++;
      const value = current(attempt.ownerId, attempt.connectionId).target;
      if (value.connectionVersion !== attempt.connectionVersion) throw new OAuthError("authorizationRejected");
      secrets.put(
        { ownerId: value.ownerId, connectionId: value.connectionId, connectorId: value.providerId },
        0,
        credential,
      );
      value.connectionVersion++;
      db.query("UPDATE fixture_connection SET record=?,account=? WHERE id=?").run(
        JSON.stringify(value),
        account.id,
        value.connectionId,
      );
      return { id: value.connectionId, version: value.connectionVersion };
    },
  });
  return {
    db,
    target,
    attempts,
    service,
    vault,
    get counts() {
      return { exchanges, identities, accepts };
    },
    exchange(fn: () => Promise<void>) {
      beforeExchange = fn;
    },
    identity(fn: () => Promise<void>) {
      beforeIdentity = fn;
    },
    bump() {
      const value = current(target.ownerId, target.connectionId).target;
      value.connectionVersion++;
      db.query("UPDATE fixture_connection SET record=? WHERE id=?").run(JSON.stringify(value), value.connectionId);
    },
  };
}

test("OAuth binds only the verified account, keeps secrets off responses and treats callback refresh as status", async () => {
  const f = fixture();
  try {
    const start = await f.service.start(f.target.ownerId, f.target.connectionId),
      state = new URL(start.url).searchParams.get("state")!;
    expect(f.counts).toEqual({ exchanges: 0, identities: 0, accepts: 0 });
    await expect(f.service.callback("another-owner", state, "fixture-code")).rejects.toThrow("authorizationExpired");
    const result = await f.service.callback(f.target.ownerId, state, "fixture-code");
    expect(result.phase).toBe("complete");
    expect(f.counts).toEqual({ exchanges: 1, identities: 1, accepts: 1 });
    expect(JSON.stringify(result)).not.toContain("fixture-access");
    expect(await f.service.callback(f.target.ownerId, state, "ignored-replay-code")).toEqual(result);
    expect(f.counts).toEqual({ exchanges: 1, identities: 1, accepts: 1 });
    const credential = await f.vault.read({
      ownerId: f.target.ownerId,
      connectionId: f.target.connectionId,
      connectorId: "x",
    });
    expect(credential.credential.accountId).toBe("12345");
    expect(credential.credential.accessToken).toBe("fixture-access");
    expect(
      f.db.query<{ secret: string | null }, []>("SELECT secret FROM publication_oauth_attempts").get()!.secret,
    ).toBeNull();
  } finally {
    f.db.close();
  }
});

test("failed identity reads can resume without repeating the token exchange", async () => {
  const f = fixture();
  try {
    const start = await f.service.start(f.target.ownerId, f.target.connectionId),
      state = new URL(start.url).searchParams.get("state")!;
    f.identity(async () => {
      throw new OAuthError("authorizationUnavailable");
    });
    await expect(f.service.callback(f.target.ownerId, state, "fixture-code")).rejects.toThrow(
      "authorizationUnavailable",
    );
    expect(f.service.status(f.target.ownerId, start.id).phase).toBe("verifying");
    expect(f.counts).toEqual({ exchanges: 1, identities: 1, accepts: 0 });
    f.identity(async () => {});
    expect((await f.service.verify(f.target.ownerId, start.id)).phase).toBe("complete");
    expect(f.counts).toEqual({ exchanges: 1, identities: 2, accepts: 1 });
  } finally {
    f.db.close();
  }
});

test("overlapping callbacks do not exchange twice and configuration changes fence acceptance", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    const start = await f.service.start(f.target.ownerId, f.target.connectionId),
      state = new URL(start.url).searchParams.get("state")!;
    f.exchange(async () => {
      entered();
      await blocked;
    });
    const first = f.service.callback(f.target.ownerId, state, "fixture-code");
    await started;
    expect((await f.service.callback(f.target.ownerId, state, "fixture-code")).phase).toBe("exchanging");
    f.bump();
    release();
    await expect(first).rejects.toThrow("authorizationRejected");
    expect(f.service.status(f.target.ownerId, start.id).phase).toBe("failed");
    expect(f.counts).toEqual({ exchanges: 1, identities: 0, accepts: 0 });
    expect((await f.service.callback(f.target.ownerId, state, "fixture-code")).phase).toBe("failed");
    expect(f.counts.exchanges).toBe(1);
  } finally {
    f.db.close();
  }
});

test("unknown exchanges and explicit denial never create an account connection", async () => {
  const f = fixture();
  try {
    const denied = await f.service.start(f.target.ownerId, f.target.connectionId),
      denialState = new URL(denied.url).searchParams.get("state")!;
    expect(f.service.decline(f.target.ownerId, denialState).phase).toBe("failed");
    expect((await f.service.callback(f.target.ownerId, denialState, "fixture-code")).phase).toBe("failed");
    expect(f.counts.exchanges).toBe(0);
    const pending = await f.service.start(f.target.ownerId, f.target.connectionId),
      state = new URL(pending.url).searchParams.get("state")!;
    f.exchange(async () => {
      throw new OAuthError("authorizationUnavailable");
    });
    await expect(f.service.callback(f.target.ownerId, state, "fixture-code")).rejects.toThrow(
      "authorizationUnavailable",
    );
    expect(f.service.status(f.target.ownerId, pending.id).phase).toBe("failed");
    expect(f.counts).toEqual({ exchanges: 1, identities: 0, accepts: 0 });
  } finally {
    f.db.close();
  }
});

test("fresh consent supersedes an older response and overlapping identity verification accepts once", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    const old = await f.service.start(f.target.ownerId, f.target.connectionId),
      state = new URL(old.url).searchParams.get("state")!;
    f.exchange(async () => {
      entered();
      await blocked;
    });
    const first = f.service.callback(f.target.ownerId, state, "fixture-code");
    await started;
    const fresh = await f.service.start(f.target.ownerId, f.target.connectionId),
      nextState = new URL(fresh.url).searchParams.get("state")!;
    expect(f.service.status(f.target.ownerId, old.id).phase).toBe("failed");
    release();
    await expect(first).rejects.toThrow("authorizationConsumed");
    expect(f.counts.accepts).toBe(0);
    let identityEntered!: () => void, identityRelease!: () => void;
    const identityStarted = new Promise<void>((resolve) => {
      identityEntered = resolve;
    });
    const identityBlocked = new Promise<void>((resolve) => {
      identityRelease = resolve;
    });
    f.exchange(async () => {});
    f.identity(async () => {
      identityEntered();
      await identityBlocked;
    });
    const completing = f.service.callback(f.target.ownerId, nextState, "fixture-code");
    await identityStarted;
    const overlapping = f.service.verify(f.target.ownerId, fresh.id);
    identityRelease();
    const results = await Promise.all([completing, overlapping]);
    expect(results.every((result) => result.phase === "complete")).toBe(true);
    expect(f.counts.accepts).toBe(1);
    expect(f.counts.exchanges).toBe(2);
  } finally {
    f.db.close();
  }
});
