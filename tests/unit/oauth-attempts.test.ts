import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthAttempts, oauthStateHash, type OAuthAttempt } from "../../src/server/connections/oauth/attempts.js";
import { createPkce } from "../../src/server/connections/oauth/pkce.js";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";

const target = () => ({
  ownerId: "fixture-owner",
  projectId: randomUUID(),
  connectionId: randomUUID(),
  connectionVersion: 1,
  providerId: "x",
  configuration: "a".repeat(64),
});
const cipher = () => new CredentialCipher({ load: async () => ({ id: "fixture-key", bytes: Buffer.alloc(32, 3) }) });
const binding = (attempt: OAuthAttempt) => ({
  connectionId: attempt.id,
  connectorId: "oauth",
  ownerId: attempt.ownerId,
});

test("OAuth state is owner-bound, hashed and single use across two processes and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "panda-oauth-attempt-")),
    path = join(root, "state.sqlite");
  let a = new Database(path),
    b = new Database(path);
  const crypto = cipher(),
    pkce = createPkce();
  try {
    let first = new OAuthAttempts(a),
      second = new OAuthAttempts(b);
    const attempt = first.reserve(target());
    const sealed = await crypto.seal(binding(attempt), { verifier: pkce.verifier });
    first.prepare(attempt.ownerId, attempt.id, pkce.state, sealed, () => {});
    const raw = readFileSync(path);
    expect(raw.includes(Buffer.from(pkce.state))).toBe(false);
    expect(raw.includes(Buffer.from(pkce.verifier))).toBe(false);
    expect(raw.includes(Buffer.from(oauthStateHash(pkce.state)))).toBe(true);
    expect(() => second.claim("different-owner", pkce.state, () => {})).toThrow("authorizationExpired");
    let validations = 0;
    const claimed = first.claim(attempt.ownerId, pkce.state, (value) => {
      validations++;
      expect(value.configuration).toBe(attempt.configuration);
    });
    expect((await crypto.open(binding(attempt), claimed.secret)).verifier).toBe(pkce.verifier);
    expect(validations).toBe(1);
    expect(() => second.claim(attempt.ownerId, pkce.state, () => {})).toThrow("authorizationConsumed");
    expect(
      a.query<{ secret: string | null }, []>("SELECT secret FROM publication_oauth_attempts").get()!.secret,
    ).toBeNull();
    a.close();
    b.close();
    a = new Database(path);
    b = new Database(path);
    first = new OAuthAttempts(a);
    second = new OAuthAttempts(b);
    expect(first.status(attempt.ownerId, attempt.id).phase).toBe("exchanging");
    expect(() => second.claim(attempt.ownerId, pkce.state, () => {})).toThrow("authorizationConsumed");
    first.abandon(attempt.ownerId, attempt.id);
    expect(() => second.stage(attempt.ownerId, attempt.id, sealed, () => {})).toThrow("authorizationConsumed");
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("encrypted tokens can resume read-only identity verification and account acceptance commits atomically", async () => {
  const db = new Database(":memory:"),
    store = new OAuthAttempts(db),
    crypto = cipher(),
    pkce = createPkce();
  try {
    db.exec("CREATE TABLE fixture_accounts(id TEXT PRIMARY KEY,version INTEGER)");
    const attempt = store.reserve(target()),
      sealed = await crypto.seal(binding(attempt), { verifier: pkce.verifier });
    store.prepare(attempt.ownerId, attempt.id, pkce.state, sealed, () => {});
    expect(() =>
      store.claim(attempt.ownerId, pkce.state, () => {
        throw Error("configurationChanged");
      }),
    ).toThrow("configurationChanged");
    expect(store.status(attempt.ownerId, attempt.id).phase).toBe("prepared");
    store.claim(attempt.ownerId, pkce.state, () => {});
    const tokens = await crypto.seal(binding(attempt), { accessToken: "fixture-token" });
    store.stage(attempt.ownerId, attempt.id, tokens, () => {});
    expect(() => store.stage(attempt.ownerId, attempt.id, tokens, () => {})).toThrow("authorizationConsumed");
    const restored = new OAuthAttempts(db).pending(attempt.ownerId, attempt.id);
    expect((await crypto.open(binding(attempt), restored.secret)).accessToken).toBe("fixture-token");
    expect(() =>
      store.complete(attempt.ownerId, attempt.id, (value) => {
        db.query("INSERT INTO fixture_accounts VALUES(?,2)").run(value.connectionId);
        throw Error("configurationChanged");
      }),
    ).toThrow("configurationChanged");
    expect(db.query("SELECT * FROM fixture_accounts").all()).toHaveLength(0);
    expect(store.status(attempt.ownerId, attempt.id).phase).toBe("verifying");
    const accepted = store.complete(attempt.ownerId, attempt.id, (value) => {
      db.query("INSERT INTO fixture_accounts VALUES(?,2)").run(value.connectionId);
      return { id: value.connectionId, version: 2 };
    });
    expect(accepted.id).toBe(attempt.connectionId);
    expect(store.status(attempt.ownerId, attempt.id).phase).toBe("complete");
    expect(db.query("SELECT * FROM fixture_accounts").all()).toHaveLength(1);
    expect(() => store.complete(attempt.ownerId, attempt.id, () => accepted)).toThrow("authorizationConsumed");
    expect(() => store.pending(attempt.ownerId, attempt.id)).toThrow("authorizationConsumed");
    expect(
      db.query<{ secret: string | null }, []>("SELECT secret FROM publication_oauth_attempts").get()!.secret,
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("consent attempts expire, reject stale configurations before token staging, and bound retained ciphertext", async () => {
  const db = new Database(":memory:"),
    crypto = cipher();
  let now = 1000;
  const store = new OAuthAttempts(db, () => now);
  try {
    const scope = target(),
      attempt = store.reserve(scope),
      pkce = createPkce(),
      secret = await crypto.seal(binding(attempt), { verifier: pkce.verifier });
    store.prepare(attempt.ownerId, attempt.id, pkce.state, secret, () => {});
    store.claim(scope.ownerId, pkce.state, () => {});
    expect(() =>
      store.stage(scope.ownerId, attempt.id, secret, () => {
        throw Error("configurationChanged");
      }),
    ).toThrow("configurationChanged");
    expect(store.status(scope.ownerId, attempt.id).phase).toBe("exchanging");
    for (let i = 0; i < 9; i++) {
      const next = store.reserve(scope),
        keys = createPkce();
      store.prepare(
        next.ownerId,
        next.id,
        keys.state,
        await crypto.seal(binding(next), { verifier: keys.verifier }),
        () => {},
      );
    }
    expect(() => store.reserve(scope)).toThrow("authorizationRateLimited");
    now += 600001;
    expect(() => store.stage(scope.ownerId, attempt.id, secret, () => {})).toThrow("authorizationExpired");
    const next = store.reserve(scope),
      keys = createPkce();
    store.prepare(
      next.ownerId,
      next.id,
      keys.state,
      await crypto.seal(binding(next), { verifier: keys.verifier }),
      () => {},
    );
    expect(db.query("SELECT * FROM publication_oauth_attempts").all()).toHaveLength(1);
    expect(() => store.status(scope.ownerId, attempt.id)).toThrow("authorizationExpired");
    expect(() => store.claim(scope.ownerId, "malformed-state", () => {})).toThrow("invalidOAuthInput");
  } finally {
    db.close();
  }
});

test("reservation order wins even when an earlier encryption completes later in the same millisecond", async () => {
  const db = new Database(":memory:"),
    store = new OAuthAttempts(db, () => 1000),
    crypto = cipher(),
    scope = target();
  try {
    const first = store.reserve(scope),
      second = store.reserve(scope),
      earlier = createPkce(),
      later = createPkce();
    expect(first.createdAt).toBe(second.createdAt);
    const olderSecret = await crypto.seal(binding(first), { verifier: earlier.verifier });
    expect(() => store.prepare(first.ownerId, first.id, earlier.state, olderSecret, () => {})).toThrow(
      "authorizationConsumed",
    );
    const currentSecret = await crypto.seal(binding(second), { verifier: later.verifier });
    store.prepare(second.ownerId, second.id, later.state, currentSecret, () => {});
    expect(store.lookup(second.ownerId, later.state).id).toBe(second.id);
    expect(store.status(first.ownerId, first.id).phase).toBe("failed");
    expect(store.claim(second.ownerId, later.state, () => {}).attempt.id).toBe(second.id);
  } finally {
    db.close();
  }
});
