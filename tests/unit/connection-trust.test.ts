import { expect, test } from "bun:test";
import { createSitePublicationFeature } from "../../src/server/delivery/integration/feature.js";
import { RemoteFileError } from "../../src/shared/connections/remote-files.js";
import { sftpPublicationFixture } from "../support/sftp-publication-fixture.js";

const pin = (byte: number) => "SHA256:" + Buffer.alloc(32, byte).toString("base64").replace(/=$/, "");

test("host trust rotation retains ownership, invalidates plans and needs successful current-version verification", async () => {
  const f = await sftpPublicationFixture();
  try {
    const prepared = await f.prepare();
    const original = f.connections.owned(f.owner, f.connection.id);
    expect(() => f.trust.replace("other", f.connection.id, { version: 2, hostKey: pin(2) })).toThrow("notFound");
    expect(() => f.trust.replace(f.owner, f.connection.id, { version: 2, hostKey: "MD5:bad" })).toThrow(
      "invalidHostKey",
    );
    expect(() =>
      f.trust.replace(f.owner, f.connection.id, { version: 2, hostKey: pin(2), host: "other.test" }),
    ).toThrow("invalidInput");
    const rotated = f.trust.replace(f.owner, f.connection.id, { version: 2, hostKey: pin(2) });
    expect(rotated.version).toBe(3);
    expect(rotated.trustPending).toBe(true);
    expect(rotated.credentialRevision).toBe(1);
    expect(f.connections.owned(f.owner, rotated.id).targetPath).toBe(original.targetPath);
    await expect(f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint)).rejects.toThrow();
    expect(() => f.connections.assertReady(f.owner, rotated.id)).toThrow("trustUnverified");
    expect(() => f.trust.replace(f.owner, rotated.id, { version: 2, hostKey: pin(3) })).toThrow("conflict");
    f.fault((operation, _path, stage) => {
      if (operation === "mkdir" && stage === "before") throw new RemoteFileError("permissionDenied");
    });
    await expect(f.connections.test(f.owner, rotated.id, 3)).rejects.toThrow("permissionDenied");
    expect(f.connections.owned(f.owner, rotated.id).connection.trustPending).toBe(true);
    f.fault(() => {});
    const result = await f.connections.test(f.owner, rotated.id, 3);
    expect(result.connection.trustPending).toBe(false);
    expect(result.connection.version).toBe(3);
    expect(() => f.connections.assertReady(f.owner, rotated.id)).not.toThrow();
    await expect(f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint)).rejects.toThrow(
      "connectionChanged",
    );
    expect(await f.credentials.read(f.owner, result.connection)).toEqual({
      method: "password",
      password: "disposable-fixture-password",
    });
  } finally {
    f.dispose();
  }
}, 15000);

test("a late successful probe cannot verify a newer host fingerprint", async () => {
  const f = await sftpPublicationFixture();
  try {
    f.trust.replace(f.owner, f.connection.id, { version: 2, hostKey: pin(2) });
    let rotated = false;
    f.fault((operation, _path, stage) => {
      if (!rotated && operation === "rmdir" && stage === "after") {
        rotated = true;
        f.trust.replace(f.owner, f.connection.id, { version: 3, hostKey: pin(3) });
      }
    });
    await expect(f.connections.test(f.owner, f.connection.id, 3)).rejects.toThrow("conflict");
    const current = f.connections.owned(f.owner, f.connection.id).connection;
    expect(current.version).toBe(4);
    expect(current.trustPending).toBe(true);
    expect(current.connector === "sftp-site" && current.hostKey).toBe(pin(3));
  } finally {
    f.dispose();
  }
}, 15000);

test("uncertain activation recovery connects with the current explicit pin without replaying publication", async () => {
  const f = await sftpPublicationFixture();
  let feature: ReturnType<typeof createSitePublicationFeature> | undefined;
  try {
    const prepared = await f.prepare();
    f.fault((operation, _path, stage) => {
      if (
        operation === "atomicRename" &&
        _path.endsWith("/current") &&
        !_path.includes(".panda-probe-") &&
        stage === "after"
      )
        throw new RemoteFileError("disconnected");
    });
    await f.service.publish(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    await f.run();
    expect(f.store.get(prepared.plan.id).job.phase).toBe("needsAttention");
    f.fault(() => {});
    f.trust.replace(f.owner, f.connection.id, { version: 2, hostKey: pin(2) });
    const usedPins: string[] = [];
    let switched = false;
    f.fault((operation) => {
      if (operation === "atomicRename") switched = true;
    });
    feature = createSitePublicationFeature({
      db: f.db,
      stateRoot: f.root + "/state",
      env: {},
      sourceRoots: () => [],
      requireProject: () => {},
      owner: () => f.owner,
      sources: {
        authorize: () => ({ assertCurrent() {}, assertDestination() {} }),
        capture: async () => ({ projectId: f.projectId, spaceId: f.spaceId, build: f.build, artifact: f.artifact }),
      },
      socialSources: {
        capture() {
          throw new Error("Unexpected social source capture");
        },
        assert() {
          throw new Error("Unexpected social source authorization");
        },
        space() {
          throw new Error("Unexpected social space access");
        },
        async readImage() {
          throw new Error("Unexpected social image read");
        },
        article() {
          throw new Error("Unexpected social article adaptation");
        },
      },
      remoteSites: {
        connect: async (connection, credential) => {
          usedPins.push(connection.hostKey);
          return f.sites.connect(connection, credential);
        },
      },
    });
    await Bun.sleep(0);
    await feature.service.recover(f.owner, prepared.plan.id, prepared.plan.fingerprint);
    await feature.stop();
    expect(f.store.get(prepared.plan.id).job.phase).toBe("published");
    expect(usedPins).toEqual([pin(2)]);
    expect(switched).toBe(false);
  } finally {
    await feature?.stop();
    f.dispose();
  }
}, 20000);
