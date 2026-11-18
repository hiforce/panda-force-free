import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalStorageConfiguration } from "../../src/server/object-storage/configuration.js";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";
import { OriginalObjectStorage } from "../../src/server/object-storage/originals.js";
import { PrivateS3Client, type S3Transport } from "../../src/server/object-storage/s3.js";
import { storageSha256 } from "../../src/server/object-storage/sigv4.js";
import type { OriginalScope } from "../../src/server/object-storage/original-codec.js";
import { objectStorageFixture } from "../support/object-storage-fixture.js";

const run = process.env.PANDA_FORCE_TEST_MINIO_IMAGE ? test : test.skip;
const scope = (): OriginalScope => ({ ownerId: randomUUID(), projectId: randomUUID(), assetId: "c-" + randomUUID() });
const resource = (bytes: Uint8Array, name = "source.png") => ({
  name,
  digest: storageSha256(bytes),
  size: bytes.length,
});

test("default local reads and reservations do not create storage state or allow anonymous remote reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-original-store-local-"));
  try {
    const objects = new OriginalObjectStorage(
        new OriginalStorageConfiguration(new PrivateStorageFiles(join(directory, "private"))),
        () => false,
      ),
      identity = scope();
    expect(await objects.hasHistory(identity)).toBe(false);
    expect(await objects.reserve(identity, "image", [resource(Buffer.from("local"))])).toMatchObject({
      remote: false,
      history: false,
    });
    expect(await readdir(directory)).toEqual([]);
    await expect(objects.read(identity, resource(Buffer.from("local")))).rejects.toMatchObject({
      code: "storageAuthenticationRequired",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

run(
  "real S3 original journal keeps frozen locations, independent copies and all original versions until permanent cleanup",
  async () => {
    const fixture = await objectStorageFixture();
    if (!fixture) throw new Error("No owned S3 fixture");
    const directory = await mkdtemp(join(tmpdir(), "panda-original-store-proof-"));
    let puts = 0,
      deletes = 0,
      denyDelete = false,
      dropAcknowledgement = false,
      denyHead = false;
    const transport: S3Transport = async (url, options) => {
      if (options.method === "PUT") puts++;
      if (options.method === "HEAD" && denyHead) return new Response(null, { status: 503 });
      if (options.method === "DELETE") {
        deletes++;
        if (denyDelete) return new Response(null, { status: 403 });
      }
      const response = await fetch(url, options);
      if (options.method === "PUT" && dropAcknowledgement) {
        dropAcknowledgement = false;
        await response.body?.cancel();
        throw new Error("Lost response after storage committed PUT");
      }
      return response;
    };
    class Configuration extends OriginalStorageConfiguration {
      override async client(id: string, digest?: string) {
        const value = await super.client(id, digest);
        return { ...value, client: new PrivateS3Client(value.profile, fixture!.credentials, transport) };
      }
    }
    try {
      const bucket = "panda-journal-" + randomUUID(),
        created = await fixture.request("PUT", "/" + bucket);
      expect(created.status).toBe(200);
      await created.body?.cancel();
      const files = new PrivateStorageFiles(join(directory, "private")),
        configuration = new Configuration(files);
      await configuration.save({
        revision: 0,
        operationId: randomUUID(),
        action: "configure",
        mode: "s3",
        kinds: ["image", "video"],
        profile: {
          ...fixture.connection(bucket),
          label: "Private originals",
          prefix: "own",
          credentials: fixture.credentials,
        },
      });
      let authenticated = true;
      const objects = new OriginalObjectStorage(configuration, () => authenticated),
        identity = scope(),
        copy = scope(),
        bytes = Buffer.from("First immutable image bytes"),
        extra = Buffer.from("Owned material bytes"),
        descriptor = resource(bytes),
        material = resource(extra, "material.png"),
        contents = [
          { digest: descriptor.digest, bytes },
          { digest: material.digest, bytes: extra },
        ];
      const unavailable = scope(),
        unavailablePlan = await objects.reserve(unavailable, "image", [descriptor]);
      denyHead = true;
      await expect(objects.upload(unavailablePlan, [{ digest: descriptor.digest, bytes }])).rejects.toMatchObject({
        code: "storageUnavailable",
      });
      expect(puts).toBe(0);
      denyHead = false;
      await objects.upload(unavailablePlan, [{ digest: descriptor.digest, bytes }]);
      expect(puts).toBe(1);
      const unavailableDelete = randomUUID();
      await objects.beginPurge(unavailable, unavailableDelete);
      expect(await objects.purge(unavailable, unavailableDelete, async () => {})).toEqual({ complete: true });
      puts = 0;
      deletes = 0;
      const plan = await objects.reserve(identity, "image", [descriptor, material]);
      expect(plan).toMatchObject({ remote: true, history: true });
      expect(puts).toBe(0);
      await objects.upload(plan, contents);
      expect(puts).toBe(2);
      await objects.upload(plan, contents);
      expect(puts).toBe(2);
      expect(await objects.read(identity, descriptor)).toEqual(bytes);
      expect(await objects.read(identity, descriptor, undefined, { start: 2, end: 6 })).toEqual(bytes.subarray(2, 7));
      const anonymous = await fetch(fixture.endpoint + "/" + bucket + "/" + plan.resources[0]!.intent.key);
      expect(anonymous.status).toBe(403);
      await anonymous.body?.cancel();
      authenticated = false;
      await expect(objects.read(identity, descriptor)).rejects.toMatchObject({ code: "storageAuthenticationRequired" });
      await expect(objects.reserve(scope(), "image", [descriptor])).rejects.toMatchObject({
        code: "storageAuthenticationRequired",
      });
      authenticated = true;
      const copied = await objects.reserve(copy, "image", [descriptor]);
      await objects.upload(copied, [{ digest: descriptor.digest, bytes }]);
      expect(copied.resources[0]!.intent.key).not.toBe(plan.resources[0]!.intent.key);
      const revised = Buffer.from("Revised image original"),
        revisedDescriptor = resource(revised);
      const revision = await objects.reserve(identity, "image", [revisedDescriptor]);
      await objects.upload(revision, [{ digest: revisedDescriptor.digest, bytes: revised }]);
      const current = await configuration.read();
      await configuration.save({
        revision: current.revision,
        operationId: randomUUID(),
        action: "configure",
        mode: "local",
        kinds: ["image"],
      });
      const reopened = new OriginalObjectStorage(
        new Configuration(new PrivateStorageFiles(join(directory, "private"))),
        () => true,
      );
      expect(await reopened.reserve(identity, "image", [descriptor])).toMatchObject({ remote: false, history: true });
      expect(await reopened.read(identity, descriptor)).toEqual(bytes);
      expect(await reopened.read(identity, revisedDescriptor)).toEqual(revised);
      expect(deletes).toBe(0);
      const operationId = randomUUID();
      await reopened.beginPurge(identity, operationId);
      await expect(
        reopened.purge(identity, operationId, async () => {
          throw new Error("Uncommitted project tombstone");
        }),
      ).rejects.toThrow("Uncommitted");
      expect(deletes).toBe(0);
      denyDelete = true;
      await expect(reopened.purge(identity, operationId, async () => {})).rejects.toMatchObject({
        code: "storageDenied",
      });
      expect(await objects.read(copy, descriptor)).toEqual(bytes);
      denyDelete = false;
      expect(await reopened.purge(identity, operationId, async () => {})).toEqual({ complete: true });
      for (const row of [...plan.resources, ...revision.resources]) {
        expect(
          await new PrivateS3Client(fixture.connection(bucket), fixture.credentials).head(row.intent.key, "null"),
        ).toBeNull();
      }
      expect(await objects.read(copy, descriptor)).toEqual(bytes);
      const beforeReplay = deletes;
      expect(await reopened.purge(identity, operationId, async () => {})).toEqual({ complete: true });
      expect(deletes).toBe(beforeReplay);
      await expect(reopened.reserve(identity, "image", [descriptor])).rejects.toMatchObject({
        code: "storageConflict",
      });

      const restoreConfig = await configuration.read();
      await configuration.save({
        revision: restoreConfig.revision,
        operationId: randomUUID(),
        action: "configure",
        mode: "s3",
        kinds: ["image"],
      });
      const lost = scope(),
        lostPlan = await objects.reserve(lost, "image", [descriptor]);
      dropAcknowledgement = true;
      await expect(objects.upload(lostPlan, [{ digest: descriptor.digest, bytes }])).rejects.toMatchObject({
        code: "storageUnavailable",
      });
      const lostPuts = puts;
      await reopened.upload(await reopened.reserve(lost, "image", [descriptor]), [
        { digest: descriptor.digest, bytes },
      ]);
      expect(puts).toBe(lostPuts);
      expect(await reopened.read(lost, descriptor)).toEqual(bytes);
      const lostDelete = randomUUID();
      await reopened.beginPurge(lost, lostDelete);
      expect(await reopened.purge(lost, lostDelete, async () => {})).toEqual({ complete: true });
      const missingBucket = "panda-created-later-" + randomUUID(),
        latestConfig = await configuration.read(),
        oldProfile = latestConfig.profiles.find((profile) => profile.id === latestConfig.activeProfileId)!;
      await configuration.save({
        revision: latestConfig.revision,
        operationId: randomUUID(),
        action: "configure",
        mode: "s3",
        kinds: ["image"],
        profile: { ...fixture.connection(missingBucket), id: oldProfile.id, label: "Created later", prefix: "" },
      });
      const missing = scope(),
        missingPlan = await objects.reserve(missing, "image", [descriptor]);
      await expect(objects.upload(missingPlan, [{ digest: descriptor.digest, bytes }])).rejects.toMatchObject({
        code: "storageUnavailable",
        status: 404,
      });
      const bucketCreated = await fixture.request("PUT", "/" + missingBucket);
      expect(bucketCreated.status).toBe(200);
      await bucketCreated.body?.cancel();
      const retriedPlan = await objects.reserve(missing, "image", [descriptor]);
      expect(retriedPlan.resources[0]!.intent.id).not.toBe(missingPlan.resources[0]!.intent.id);
      await objects.upload(retriedPlan, [{ digest: descriptor.digest, bytes }]);
      expect(await objects.read(missing, descriptor)).toEqual(bytes);
      const missingDelete = randomUUID();
      await objects.beginPurge(missing, missingDelete);
      expect(await objects.purge(missing, missingDelete, async () => {})).toEqual({ complete: true });
      expect(await objects.read(copy, descriptor)).toEqual(bytes);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);

run(
  "purge waits for an uncertain dispatch and a late stored result is cleaned without another PUT",
  async () => {
    const fixture = await objectStorageFixture();
    if (!fixture) throw new Error("No owned S3 fixture");
    const directory = await mkdtemp(join(tmpdir(), "panda-original-store-late-"));
    let entered!: () => void,
      release!: () => void,
      puts = 0;
    const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    class Configuration extends OriginalStorageConfiguration {
      override async client(id: string, digest?: string) {
        const value = await super.client(id, digest);
        return {
          ...value,
          client: new PrivateS3Client(value.profile, fixture!.credentials, async (url, options) => {
            if (options.method === "PUT") {
              puts++;
              entered();
              await gate;
            }
            return fetch(url, options);
          }),
        };
      }
    }
    try {
      const bucket = "panda-late-" + randomUUID(),
        response = await fixture.request("PUT", "/" + bucket);
      expect(response.status).toBe(200);
      await response.body?.cancel();
      const configuration = new Configuration(new PrivateStorageFiles(join(directory, "private")));
      await configuration.save({
        revision: 0,
        operationId: randomUUID(),
        action: "configure",
        mode: "s3",
        kinds: ["video"],
        profile: { ...fixture.connection(bucket), label: "Late result", prefix: "", credentials: fixture.credentials },
      });
      const objects = new OriginalObjectStorage(configuration, () => true),
        identity = scope(),
        bytes = Buffer.from("Late video original"),
        descriptor = resource(bytes, "source.mp4"),
        plan = await objects.reserve(identity, "video", [descriptor]),
        operationId = randomUUID(),
        contents = [{ digest: descriptor.digest, bytes }];
      const uploading = objects.upload(plan, contents).then(
        () => null,
        (error: unknown) => error,
      );
      await enteredPromise;
      await expect(objects.upload(plan, contents)).rejects.toMatchObject({ code: "storageUnavailable" });
      expect(puts).toBe(1);
      await objects.beginPurge(identity, operationId);
      expect(await objects.purge(identity, operationId, async () => {})).toEqual({ complete: false });
      release();
      expect(await uploading).toMatchObject({ code: "storageConflict" });
      const reopened = new OriginalObjectStorage(
        new Configuration(new PrivateStorageFiles(join(directory, "private"))),
        () => false,
      );
      // The committed permanent-deletion capability survives session loss; it cannot create a new upload.
      expect(await reopened.purge(identity, operationId, async () => {})).toEqual({ complete: true });
      expect(puts).toBe(1);
      expect(
        await new PrivateS3Client(fixture.connection(bucket), fixture.credentials).head(
          plan.resources[0]!.intent.key,
          "null",
        ),
      ).toBeNull();
    } finally {
      release?.();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
