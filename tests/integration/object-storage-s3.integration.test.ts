import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrivateS3Client } from "../../src/server/object-storage/s3.js";
import { storageSha256 } from "../../src/server/object-storage/sigv4.js";
import { objectStorageFixture } from "../support/object-storage-fixture.js";

const run = process.env.PANDA_FORCE_TEST_MINIO_IMAGE ? test : test.skip;
run(
  "actual private S3 conditional writes, ranges, exact version cleanup and unacknowledged upload recovery",
  async () => {
    const fixture = await objectStorageFixture();
    if (!fixture) throw new Error("Owned fixture was not configured");
    try {
      const bucket = "panda-proof-" + randomUUID(),
        connection = fixture.connection(bucket),
        client = new PrivateS3Client(connection, fixture.credentials),
        bytes = Buffer.from("A complete private original 中文"),
        key = "installation/owner/project/asset/source",
        intent = randomUUID();
      const created = await fixture.request("PUT", "/" + bucket);
      expect(created.status).toBe(200);
      await created.body?.cancel();
      const written = await client.put(key, bytes, intent);
      expect(written.state).toBe("written");
      const original = await client.head(key);
      expect(original).toMatchObject({
        digest: storageSha256(bytes),
        size: bytes.length,
        intentId: intent,
        versionId: "null",
      });
      if (!original) throw new Error("Original not found");
      expect(await client.put(key, Buffer.from("must not replace"), intent)).toEqual({ state: "exists" });
      expect(await client.get(key, original)).toEqual(bytes);
      expect(await client.get(key, original, undefined, { start: 2, end: 5 })).toEqual(bytes.subarray(2, 6));
      const anonymous = await fetch(fixture.endpoint + "/" + bucket + "/" + key);
      expect(anonymous.status).toBe(403);
      await anonymous.body?.cancel();
      const wrong = new PrivateS3Client(connection, { accessKeyId: "wrong-fixture", secretAccessKey: "wrong-private" });
      await expect(wrong.head(key)).rejects.toMatchObject({ code: "storageDenied" });
      const enabled = await fixture.request(
        "PUT",
        "/" + bucket + "?versioning=",
        Buffer.from(
          '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
        ),
        { "content-type": "application/xml" },
      );
      expect(enabled.status).toBe(200);
      await enabled.body?.cancel();
      await client.delete(key, original);
      expect(await client.head(key, "null")).toBeNull();
      const next = await client.put(key, bytes, intent);
      expect(next.state).toBe("written");
      const versioned = await client.head(key);
      if (!versioned) throw new Error("Missing versioned original");
      expect(versioned.versionId).not.toBe("null");
      const foreignBytes = Buffer.from("Another independently written version"),
        foreignIntent = randomUUID();
      const foreign = await fixture.request("PUT", "/" + bucket + "/" + key, foreignBytes, {
        "x-amz-meta-panda-digest": storageSha256(foreignBytes),
        "x-amz-meta-panda-intent": foreignIntent,
      });
      expect(foreign.status).toBe(200);
      const foreignVersion = foreign.headers.get("x-amz-version-id");
      if (!foreignVersion) throw new Error("Other version has no receipt");
      expect(foreignVersion).not.toBe(versioned.versionId);
      await foreign.body?.cancel();
      expect(await client.get(key, versioned)).toEqual(bytes);
      await client.delete(key, versioned);
      expect(await client.head(key, versioned.versionId)).toBeNull();
      const surviving = await client.head(key);
      expect(surviving?.versionId).toBe(foreignVersion);
      expect(surviving?.intentId).toBe(foreignIntent);
      if (!surviving) throw new Error("Other version was removed");
      expect(await client.get(key, surviving)).toEqual(foreignBytes);
      let dispatches = 0;
      const uncertain = new PrivateS3Client(connection, fixture.credentials, async (url, options) => {
        const response = await fetch(url, options);
        if (options.method === "PUT" && dispatches++ === 0) {
          await response.body?.cancel();
          throw new Error("Simulated lost acknowledgement after write");
        }
        return response;
      });
      const secondKey = key + "-unacknowledged",
        secondIntent = randomUUID();
      await expect(uncertain.put(secondKey, bytes, secondIntent)).rejects.toMatchObject({
        code: "storageUnavailable",
        retryable: true,
      });
      const recovered = await client.head(secondKey);
      expect(recovered?.intentId).toBe(secondIntent);
      expect(await client.put(secondKey, bytes, secondIntent)).toEqual({ state: "exists" });
      if (!recovered) throw new Error("Unacknowledged write was lost");
      expect(await client.get(secondKey, recovered)).toEqual(bytes);
      const deniedDelete = new PrivateS3Client(connection, fixture.credentials, async (url, options) =>
        options.method === "DELETE" ? new Response(null, { status: 403 }) : fetch(url, options),
      );
      await expect(deniedDelete.delete(secondKey, recovered)).rejects.toMatchObject({ code: "storageDenied" });
      expect(await client.get(secondKey, recovered)).toEqual(bytes);
      await client.delete(secondKey, recovered);
      expect(await client.head(secondKey, recovered.versionId)).toBeNull();
    } finally {
      await fixture.close();
    }
  },
  60000,
);

run(
  "stored provider changes preserve old S3 originals and credential repair uses the same frozen location",
  async () => {
    const { mkdtemp, rm } = await import("node:fs/promises"),
      { tmpdir } = await import("node:os"),
      { join } = await import("node:path"),
      { PrivateStorageFiles } = await import("../../src/server/object-storage/private-files.js"),
      { OriginalStorageConfiguration } = await import("../../src/server/object-storage/configuration.js");
    const fixture = await objectStorageFixture();
    if (!fixture) throw new Error("Owned fixture was not configured");
    const directory = await mkdtemp(join(tmpdir(), "panda-s3-configured-proof-"));
    try {
      const bucket = "panda-config-" + randomUUID(),
        otherBucket = "panda-config-" + randomUUID();
      for (const name of [bucket, otherBucket]) {
        const response = await fixture.request("PUT", "/" + name);
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
      const config = new OriginalStorageConfiguration(new PrivateStorageFiles(join(directory, "private"))),
        original = Buffer.from("Original retained across provider and key changes"),
        key = "owned-project/own-asset/original",
        independentWriter = new PrivateS3Client(fixture.connection(bucket), fixture.credentials);
      expect((await independentWriter.put(key, original, randomUUID())).state).toBe("written");
      const receipt = await independentWriter.head(key);
      if (!receipt) throw new Error("Original not found");
      // Invalid saved keys model an old credential that no longer authenticates; the object already exists independently.
      const first = await config.save({
        action: "configure",
        revision: 0,
        operationId: randomUUID(),
        mode: "s3",
        kinds: ["image"],
        profile: {
          ...fixture.connection(bucket),
          label: "Private originals",
          prefix: "retained",
          credentials: { accessKeyId: "invalid-old-key", secretAccessKey: "invalid-old-secret" },
        },
      });
      const profile = first.settings.profiles[0]!,
        old = await config.client(profile.id);
      await expect(old.client.head(key, receipt.versionId)).rejects.toMatchObject({ code: "storageDenied" });
      await config.save({
        action: "credentials",
        revision: 1,
        operationId: randomUUID(),
        profileId: profile.id,
        credentialRevision: 1,
        credentials: fixture.credentials,
      });
      expect(await (await config.client(profile.id, old.digest)).client.get(key, receipt)).toEqual(original);
      const next = await config.save({
        action: "configure",
        revision: 2,
        operationId: randomUUID(),
        mode: "s3",
        kinds: ["image"],
        profile: { ...fixture.connection(otherBucket), id: profile.id, label: "New originals", prefix: "new" },
      });
      expect(next.settings.activeProfileId).not.toBe(profile.id);
      expect(await config.writeTarget("video")).toBeNull();
      const target = await config.writeTarget("image");
      if (!target) throw new Error("No selected target");
      const uploaded = await target.client.put("new/owned-project/another-asset", original, randomUUID());
      expect(uploaded.state).toBe("written");
      expect(await independentWriter.head("new/owned-project/another-asset")).toBeNull();
      await config.save({
        action: "configure",
        revision: 3,
        operationId: randomUUID(),
        mode: "local",
        kinds: ["image"],
      });
      expect(await config.writeTarget("image")).toBeNull();
      const restarted = new OriginalStorageConfiguration(new PrivateStorageFiles(join(directory, "private")));
      expect(await (await restarted.client(profile.id, old.digest)).client.get(key, receipt)).toEqual(original);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
