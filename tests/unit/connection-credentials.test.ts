import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";
import { FileCredentialKey, initializeCredentialKey } from "../../src/server/connections/credentials/file-key.js";
import { CredentialRepository } from "../../src/server/connections/credentials/repository.js";
import { ConnectionVault } from "../../src/server/connections/credentials/vault.js";

test("authenticated credential envelopes survive reload and reject tampering or another owner, connection or connector", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-credential-cipher-")),
    path = join(root, "keys", "credential.key");
  try {
    await Promise.all([initializeCredentialKey(path), initializeCredentialKey(path)]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const original = await readFile(path);
    await initializeCredentialKey(path);
    expect(await readFile(path)).toEqual(original);
    const cipher = new CredentialCipher(new FileCredentialKey(path));
    const scope = { connectionId: randomUUID(), connectorId: "x", ownerId: "account-a" };
    const value = { accessToken: "synthetic-token", refreshToken: "synthetic-refresh" };
    const first = await cipher.seal(scope, value),
      second = await cipher.seal(scope, value);
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain("synthetic-token");
    expect(await new CredentialCipher(new FileCredentialKey(path)).open(scope, first)).toEqual(value);
    for (const changed of [
      { ...scope, connectionId: randomUUID() },
      { ...scope, connectorId: "sftp" },
      { ...scope, ownerId: "account-b" },
    ])
      await expect(cipher.open(changed, first)).rejects.toThrow("unreadableCredential");
    await expect(cipher.seal(scope, { token: "a".repeat(65536) })).rejects.toThrow("invalidCredential");
    const bytes = Buffer.from(first.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 1;
    await expect(cipher.open(scope, { ...first, ciphertext: bytes.toString("base64") })).rejects.toThrow(
      "unreadableCredential",
    );
    await writeFile(path, randomBytes(32).toString("hex"));
    await expect(cipher.open(scope, first)).rejects.toThrow("keyUnavailable");
    await writeFile(path, "invalid key");
    await expect(cipher.seal(scope, value)).rejects.toThrow("keyUnavailable");
    await rm(path);
    await expect(cipher.open(scope, first)).rejects.toThrow("keyUnavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault persistence contains only ciphertext and enforces owner identity and stale-write protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-credential-store-")),
    file = join(root, "vault.sqlite"),
    key = join(root, "vault.key");
  await initializeCredentialKey(key);
  let db = new Database(file);
  const scope = { connectionId: randomUUID(), connectorId: "x", ownerId: "user-a" };
  const cipher = new CredentialCipher(new FileCredentialKey(key));
  const credential = { accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret" };
  try {
    let vault = new ConnectionVault(new CredentialRepository(db), cipher);
    expect((await vault.write(scope, credential, 0)).revision).toBe(1);
    expect(vault.metadata(scope)).toEqual({ revision: 1, updatedAt: expect.any(Number), refreshState: "ready" });
    await expect(vault.read({ ...scope, ownerId: "user-b" })).rejects.toThrow("credentialMissing");
    await expect(vault.write(scope, credential, 0)).rejects.toThrow("credentialConflict");
    db.close();
    expect((await readFile(file)).includes(Buffer.from(credential.accessToken))).toBe(false);
    expect((await readFile(file)).includes(Buffer.from(credential.refreshToken))).toBe(false);
    db = new Database(file);
    vault = new ConnectionVault(new CredentialRepository(db), cipher);
    expect(await vault.read(scope)).toEqual({ revision: 1, credential });
    expect((await vault.write(scope, { accessToken: "replacement" }, 1)).revision).toBe(2);
    expect(() => vault.remove(scope, 1)).toThrow("credentialConflict");
    vault.remove(scope, 2);
    await expect(vault.read(scope)).rejects.toThrow("credentialMissing");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh leases fence two database owners and prevent late refresh results overwriting newer credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-refresh-fence-")),
    file = join(root, "vault.sqlite"),
    key = join(root, "vault.key");
  await initializeCredentialKey(key);
  const dbA = new Database(file),
    dbB = new Database(file);
  let now = 1000;
  const a = new CredentialRepository(dbA, () => now),
    b = new CredentialRepository(dbB, () => now);
  const scope = { connectionId: randomUUID(), connectorId: "x", ownerId: "owner" };
  const cipher = new CredentialCipher(new FileCredentialKey(key)),
    vault = new ConnectionVault(a, cipher);
  try {
    await vault.write(scope, { token: "first" }, 0);
    const leaseA = a.acquire(scope, 1, 1000);
    expect(() => b.acquire(scope, 1)).toThrow("refreshBusy");
    now = 2001;
    const leaseB = b.acquire(scope, 1);
    const replacement = await cipher.seal(scope, { token: "renewed" });
    expect(() => a.put(scope, 1, replacement, leaseA)).toThrow("credentialConflict");
    a.release(scope, leaseA);
    expect(() => a.acquire(scope, 1)).toThrow("refreshBusy");
    expect(b.put(scope, 1, replacement, leaseB).revision).toBe(2);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const refreshing = vault.refresh(scope, 2, async () => {
      started();
      await blocked;
      return { token: "stale refresh" };
    });
    await exchangeStarted;
    await vault.write(scope, { token: "manual replacement" }, 2);
    unblock();
    await expect(refreshing).rejects.toThrow("credentialConflict");
    expect((await vault.read(scope)).credential).toEqual({ token: "manual replacement" });
    await expect(
      vault.refresh(scope, 3, async () => {
        throw Error("private platform response");
      }),
    ).rejects.toThrow("refreshFailed");
    expect(vault.metadata(scope).refreshState).toBe("uncertain");
    await expect(vault.read(scope)).rejects.toThrow("refreshFailed");
    let retried = false;
    await expect(
      vault.refresh(scope, 3, async () => {
        retried = true;
        return { token: "fresh" };
      }),
    ).rejects.toThrow("refreshFailed");
    expect(retried).toBe(false);
    await vault.write(scope, { token: "reauthorized" }, 3);
    expect((await vault.refresh(scope, 4, async (value) => ({ ...value, token: "fresh" }))).revision).toBe(5);
  } finally {
    dbA.close();
    dbB.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("a dispatched refresh survives a crash and cannot be taken over or read as valid credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-refresh-restart-")),
    file = join(root, "vault.sqlite"),
    key = join(root, "vault.key");
  await initializeCredentialKey(key);
  let db = new Database(file),
    now = 1000;
  const scope = { connectionId: randomUUID(), connectorId: "x", ownerId: "owner" },
    cipher = new CredentialCipher(new FileCredentialKey(key));
  try {
    let repository = new CredentialRepository(db, () => now),
      vault = new ConnectionVault(repository, cipher);
    await vault.write(scope, { token: "fixture-before-rotation" }, 0);
    const lease = repository.acquire(scope, 1, 1000);
    repository.dispatch(scope, lease);
    await expect(vault.read(scope)).rejects.toThrow("refreshBusy");
    expect(() => repository.dispatch(scope, lease)).toThrow("credentialConflict");
    db.close();
    now = 2001;
    db = new Database(file);
    repository = new CredentialRepository(db, () => now);
    vault = new ConnectionVault(repository, cipher);
    expect(vault.metadata(scope).refreshState).toBe("uncertain");
    expect(() => repository.acquire(scope, 1)).toThrow("refreshFailed");
    await expect(vault.read(scope)).rejects.toThrow("refreshFailed");
    repository.release(scope, lease);
    expect(() => repository.acquire(scope, 1)).toThrow("refreshFailed");
    await expect(vault.write(scope, { token: "wrong-revision" }, 0)).rejects.toThrow("credentialConflict");
    await vault.write(scope, { token: "explicit-reauthorization" }, 1);
    expect(vault.metadata(scope).refreshState).toBe("ready");
    const late = await cipher.seal(scope, { token: "late-rotation" });
    expect(() => repository.put(scope, 1, late, lease)).toThrow("credentialConflict");
    expect((await vault.read(scope)).credential.token).toBe("explicit-reauthorization");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("credential migration preserves ciphertext and treats an old outstanding refresh as uncertain", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE publication_credential_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
      INSERT INTO publication_credential_schema VALUES(1,1);
      CREATE TABLE publication_credentials(connectionId TEXT PRIMARY KEY,connectorId TEXT,ownerId TEXT,
        revision INTEGER,envelope TEXT,updatedAt INTEGER,leaseOwner TEXT,leaseFence INTEGER,leaseUntil INTEGER);
      INSERT INTO publication_credentials VALUES('fixture','x','owner',7,'{"fixture":"ciphertext"}',10,'old-process',4,11);
      INSERT INTO publication_credentials VALUES('ready','x','owner',2,'{"fixture":"other"}',10,NULL,0,0);`);
    const store = new CredentialRepository(db, () => 12),
      scope = { connectionId: "fixture", connectorId: "x", ownerId: "owner" };
    expect(store.get(scope)).toEqual({
      metadata: { revision: 7, updatedAt: 10, refreshState: "uncertain" },
      envelope: { fixture: "ciphertext" },
    });
    expect(store.get({ ...scope, connectionId: "ready" }).metadata.refreshState).toBe("ready");
    expect(() => store.acquire(scope, 7)).toThrow("refreshFailed");
    new CredentialRepository(db, () => 12);
    expect(store.get(scope).metadata.revision).toBe(7);
  } finally {
    db.close();
  }
});

test("vault reads do not release old secrets when refresh or reauthorization overlaps decryption", async () => {
  const db = new Database(":memory:"),
    store = new CredentialRepository(db),
    scope = { connectionId: randomUUID(), connectorId: "x", ownerId: "owner" },
    cipher = new CredentialCipher({ load: async () => ({ id: "fixture", bytes: Buffer.alloc(32, 7) }) });
  let unblock!: () => void, started!: () => void;
  let pending = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  const vault = new ConnectionVault(store, {
    seal: (binding, value) => cipher.seal(binding, value),
    open: async (binding, envelope) => {
      const value = await cipher.open(binding, envelope);
      started();
      await pending;
      return value;
    },
  });
  try {
    await vault.write(scope, { token: "old-fixture" }, 0);
    const reading = vault.read(scope);
    await opening;
    const lease = store.acquire(scope, 1);
    store.dispatch(scope, lease);
    unblock();
    await expect(reading).rejects.toThrow("refreshBusy");
    store.release(scope, lease);
    await vault.write(scope, { token: "new-fixture" }, 1);
    pending = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    const otherRead = vault.read(scope);
    await opening;
    await vault.write(scope, { token: "replacement-fixture" }, 2);
    unblock();
    await expect(otherRead).rejects.toThrow("credentialConflict");
  } finally {
    db.close();
  }
});
