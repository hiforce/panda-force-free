import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicationConnections } from "../../src/server/connections/integration/feature.js";
import { sftpInput, sftpCredential } from "../../src/server/connections/adapters/sftp-input.js";
import { sftpLimits } from "../../src/server/connections/integration/config.js";
import { SftpSites } from "../../src/server/remote-files/site.js";
import { RemoteFileError } from "../../src/shared/connections/remote-files.js";
import { sftpPublicationFixture } from "../support/sftp-publication-fixture.js";

test("SFTP credentials stay encrypted, versioned and owner-bound across reopen; missing keys fail closed", async () => {
  const f = await sftpPublicationFixture();
  try {
    expect(f.connection.credentialRevision).toBe(1);
    const prepared = await f.prepare();
    const updated = await f.credentials.write(f.owner, f.connection.id, {
      version: 2,
      credential: { method: "password", password: "rotated-fixture-secret" },
    });
    expect(updated.version).toBe(3);
    expect(updated.credentialRevision).toBe(2);
    await expect(f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint)).rejects.toThrow(
      "connectionChanged",
    );
    await expect(
      f.credentials.write(f.owner, f.connection.id, {
        version: 2,
        credential: { method: "password", password: "stale" },
      }),
    ).rejects.toThrow("conflict");
    await expect(f.credentials.read("other", updated)).rejects.toThrow("notFound");
    const stored = f.db.query<{ envelope: string }, []>("SELECT envelope FROM publication_credentials").get()!;
    expect(stored.envelope).not.toContain("rotated-fixture-secret");
    expect(JSON.stringify(f.connections.list(f.owner, f.projectId))).not.toContain("rotated-fixture-secret");
    expect(readFileSync(join(f.root, "state.sqlite")).includes(Buffer.from("rotated-fixture-secret"))).toBe(false);
    const reopened = createPublicationConnections({
      db: f.db,
      stateRoot: join(f.root, "state"),
      sourceRoots: () => [],
      requireProject: () => {},
      env: {},
      remoteSites: f.sites,
    });
    expect(await reopened.credentials.read(f.owner, updated)).toEqual({
      method: "password",
      password: "rotated-fixture-secret",
    });
    const key = join(f.root, "state/config/connection-key");
    rmSync(key);
    await expect(reopened.credentials.read(f.owner, updated)).rejects.toThrow("keyUnavailable");
    await expect(
      reopened.credentials.write(f.owner, updated.id, {
        version: 3,
        credential: { method: "password", password: "new-secret" },
      }),
    ).rejects.toThrow("keyUnavailable");
    expect(existsSync(key)).toBe(false);
    expect(f.connections.owned(f.owner, updated.id).connection.version).toBe(3);
  } finally {
    f.dispose();
  }
});

test("concurrent credential replacement cannot diverge public and secret versions", async () => {
  const f = await sftpPublicationFixture();
  try {
    const results = await Promise.allSettled(
      ["one", "two"].map((password) =>
        f.credentials.write(f.owner, f.connection.id, { version: 2, credential: { method: "password", password } }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = f.connections.owned(f.owner, f.connection.id).connection;
    expect(saved.version).toBe(3);
    expect(saved.credentialRevision).toBe(2);
    const password = (await f.credentials.read(f.owner, saved)).password;
    if (typeof password !== "string") throw new Error("Expected a decrypted password string");
    expect(["one", "two"]).toContain(password);
  } finally {
    f.dispose();
  }
});

test("connection policy rejects unpinned hosts, unsafe directories and hidden credential fields", async () => {
  const f = await sftpPublicationFixture();
  try {
    expect(sftpInput({ ...f.input, host: "EXAMPLE.TEST" }).host).toBe("example.test");
    for (const value of ["", "MD5:abc", "SHA256:" + "A".repeat(42) + "B"])
      expect(() => sftpInput({ ...f.input, hostKey: value })).toThrow();
    for (const directory of ["/", "/var/../html", "relative", "/a//b"])
      expect(() => sftpInput({ ...f.input, directory })).toThrow("invalidPath");
    expect(() => sftpInput({ ...f.input, password: "hidden" })).toThrow("invalidInput");
    expect(() => sftpCredential({ method: "password", password: "fixture", privateKey: "extra" })).toThrow(
      "invalidCredential",
    );
    expect(() => sftpCredential({ method: "privateKey", privateKey: "not-a-key" })).toThrow("invalidCredential");
    expect(() => sftpCredential({ method: "password", password: "bad\0value" })).toThrow("invalidCredential");
    const created = await f.connections.create(f.owner, { ...f.input, id: randomUUID(), directory: "/another" });
    expect(() => f.connections.assertReady(f.owner, created.id)).toThrow("credentialMissing");
    await expect(
      f.connections.create(f.owner, { ...f.input, id: randomUUID(), directory: "/website/sub" }),
    ).rejects.toThrow("targetInUse");
    expect(sftpLimits({ PANDA_FORCE_SFTP_SESSION_TIMEOUT_SECONDS: "1200" }).sessionMs).toBe(1200000);
    expect(() => sftpLimits({ PANDA_FORCE_SFTP_OPERATION_TIMEOUT_SECONDS: "0" })).toThrow(
      "PANDA_FORCE_SFTP_OPERATION_TIMEOUT_SECONDS",
    );
  } finally {
    f.dispose();
  }
});

test("remote target probes refuse existing files, symlink ancestors and unsupported atomic replacement", async () => {
  const f = await sftpPublicationFixture();
  try {
    const sites = new SftpSites({ connect: async () => f.files });
    await f.files.mkdir("/existing", 0o755);
    await f.files.write("/existing/keep.txt", new Uint8Array([7]), 0o600);
    const existing = await sites.connect({ ...f.input, directory: "/existing" }, {});
    await expect(existing.probe()).rejects.toThrow("invalidRemotePath");
    expect(await f.files.read("/existing/keep.txt", 1)).toEqual(new Uint8Array([7]));
    await f.files.symlink("existing", "/linked");
    const linked = await sites.connect({ ...f.input, directory: "/linked/sub" }, {});
    await expect(linked.probe()).rejects.toThrow("invalidRemotePath");
    f.fault((operation, _path, stage) => {
      if (operation === "atomicRename" && stage === "before") throw new RemoteFileError("unsupported");
    });
    await expect(f.connections.test(f.owner, f.connection.id, f.connection.version)).rejects.toThrow("unsupported");
    expect((await f.files.list("/website")).map((entry) => entry.name)).toEqual([".panda-site.json"]);
    f.fault(() => {});
    expect((await f.connections.test(f.owner, f.connection.id, f.connection.version)).atomicSwitch).toBe(true);
  } finally {
    f.dispose();
  }
}, 15000);
