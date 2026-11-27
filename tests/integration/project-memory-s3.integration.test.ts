import { expect, test } from "bun:test";
import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ContentAccessError } from "../../src/server/content-access/contracts.js";
import type { HarnessMetadata } from "../../src/server/harness/ports.js";
import { MySQLHarnessMetadata } from "../../src/server/harness/storage/mysql.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlHarnessModule } from "../../src/server/database/modules/harness.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { OriginalStorageConfiguration } from "../../src/server/object-storage/configuration.js";
import { PrivateStorageFiles } from "../../src/server/object-storage/private-files.js";
import { PrivateS3Client, type S3Transport } from "../../src/server/object-storage/s3.js";
import { s3MultipartPartBytes } from "../../src/server/object-storage/multipart.js";
import { RemoteMemoryPackages } from "../../src/server/project-memory/pmf-remote.js";
import { encodeMemoryPackage, sealMemoryPackage } from "../../src/server/project-memory/pmf.js";
import { createMemoryArchive } from "../../src/server/project-memory/portability.js";
import { objectStorageFixture } from "../support/object-storage-fixture.js";

for (const backend of ["SQLite", "MySQL"]) {
  const run =
    process.env.PANDA_FORCE_TEST_MINIO_IMAGE && (backend === "SQLite" || process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)
      ? test
      : test.skip;
  run(
    backend + " recovers S3 .pmf offsets and frozen object versions and erases discarded uploads",
    async () => {
      const mysql = backend === "MySQL" ? await isolatedMySQLDatabase("pmfs") : undefined;
      const fixture = await objectStorageFixture().catch(async (error) => {
        await mysql?.close();
        throw error;
      });
      if (!fixture) {
        await mysql?.close();
        throw new Error("No owned S3 fixture");
      }
      const root = await mkdtemp(join(tmpdir(), "panda-memory-s3-"));
      const bucket = "panda-memory-" + randomUUID();
      const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const manifest = createMemoryArchive([{ key: "cache", scope: "release", values: ["48 hours"] }], Date.now());
      const packed = encodeMemoryPackage(manifest, pair.publicKey);
      const key = privateDecrypt(
        { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        packed.subarray(36, 420),
      );
      let clock = Date.now();
      const openMetadata = (): HarnessMetadata =>
        mysql ? new MySQLHarnessMetadata(mysql.sql) : new SQLiteHarnessMetadata(join(root, "harness.sqlite"));
      let metadata = openMetadata();
      let dropCompletion = false;
      let dropPart = false;
      let revoked = false;
      let readParts = 0;
      let completedKey = "";
      const transport: S3Transport = async (url, options) => {
        const response = await fetch(url, options);
        if (options.method === "GET" && response.status === 206) readParts++;
        if (options.method === "PUT" && url.searchParams.has("partNumber") && dropPart) {
          dropPart = false;
          await response.body?.cancel();
          throw new Error("Uploaded part but did not receive the response");
        }
        if (options.method === "POST" && url.searchParams.has("uploadId")) {
          completedKey = decodeURIComponent(url.pathname);
          if (dropCompletion) {
            dropCompletion = false;
            await response.text();
            throw new Error("Completed the object but did not receive the response");
          }
        }
        return response;
      };
      class Configuration extends OriginalStorageConfiguration {
        override async client(id: string, digest?: string) {
          const value = await super.client(id, digest);
          return { ...value, client: new PrivateS3Client(value.profile, fixture!.credentials, transport) };
        }
      }
      const config = new Configuration(new PrivateStorageFiles(join(root, "private")));
      const open = () =>
        new RemoteMemoryPackages(
          metadata,
          config,
          async () => {
            if (revoked) throw new ContentAccessError("forbidden");
          },
          () => clock,
        );
      let packages = open();
      const restart = async () => {
        await packages.close();
        await metadata.close();
        metadata = openMetadata();
        packages = open();
      };
      try {
        if (mysql)
          await new DatabaseRegistry().register(mysqlHarnessModule).upgrade(new MySQLSchemaConnection(mysql.sql));
        expect((await fixture.request("PUT", "/" + bucket)).status).toBe(200);
        expect(
          (
            await fixture.request(
              "PUT",
              "/" + bucket + "?versioning",
              Buffer.from(
                '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
              ),
              { "content-type": "application/xml" },
            )
          ).status,
        ).toBe(200);
        expect(await packages.available()).toBe(false);
        await config.save({
          revision: 0,
          operationId: randomUUID(),
          action: "configure",
          mode: "s3",
          kinds: ["project-memory-package"],
          profile: {
            ...fixture.connection(bucket),
            label: "PMF test",
            prefix: "owned",
            credentials: fixture.credentials,
          },
        });
        expect(await packages.available()).toBe(true);
        expect(await config.writeTarget("image")).toBeNull();

        const large = sealMemoryPackage(
          pair.publicKey,
          zipSync(
            {
              "manifest.json": Buffer.from(JSON.stringify(manifest)),
              "assets/page.png": new Uint8Array(s3MultipartPartBytes + 1024),
            },
            { level: 0 },
          ),
        );
        const admitted = (await packages.startUpload("one", "project", "large.pmf", large.length))!;
        dropPart = true;
        await expect(
          packages.append("one", "project", admitted.id, 0, large.subarray(0, s3MultipartPartBytes)),
        ).rejects.toThrow();
        expect((await packages.status("one", "project", admitted.id))?.offset).toBe(0);
        expect(await packages.status("other", "project", admitted.id)).toBeNull();
        expect(await packages.status("one", "second", admitted.id)).toBeNull();
        await restart();
        const conflicting = Buffer.from(large.subarray(0, s3MultipartPartBytes));
        conflicting[500] ^= 1;
        await expect(packages.append("one", "project", admitted.id, 0, conflicting)).rejects.toMatchObject({
          status: 409,
        });
        expect(
          (await packages.append("one", "project", admitted.id, 0, large.subarray(0, s3MultipartPartBytes))).offset,
        ).toBe(s3MultipartPartBytes);
        expect(
          (
            await packages.append(
              "one",
              "project",
              admitted.id,
              s3MultipartPartBytes,
              large.subarray(s3MultipartPartBytes),
            )
          ).state,
        ).toBe("queued");
        dropCompletion = true;
        await packages.processPending();
        expect((await packages.status("one", "project", admitted.id))?.state).toBe("queued");
        await restart();
        clock += 5000;
        await packages.processPending();
        expect(await packages.status("one", "project", admitted.id)).toMatchObject({
          state: "checking",
          checkedBytes: 0,
        });
        const otherMetadata = mysql ? openMetadata() : metadata;
        const other = new RemoteMemoryPackages(
          otherMetadata,
          config,
          async () => {},
          () => clock,
        );
        try {
          await Promise.all([packages.processPending(), other.processPending()]);
        } finally {
          await other.close();
          if (otherMetadata !== metadata) await otherMetadata.close();
        }
        expect(await packages.status("one", "project", admitted.id)).toMatchObject({
          state: "checking",
          checkedBytes: s3MultipartPartBytes,
        });
        await restart();
        await packages.processPending();
        expect(await packages.status("one", "project", admitted.id)).toMatchObject({
          state: "failed",
          unsupported: true,
          checkedBytes: large.length,
        });
        expect(readParts).toBe(2);
        expect((await fetch(fixture.endpoint + completedKey)).status).toBe(403);
        await expect(packages.read("one", "project", admitted.id, key)).rejects.toMatchObject({
          messageId: "projects.memoryPackageUnsupported",
        });
        await packages.discard("one", "project", admitted.id);
        await packages.processPending();
        expect((await fixture.request("HEAD", completedKey)).status).toBe(404);

        const small = (await packages.startUpload("one", "project", "memory.pmf", packed.length))!;
        await packages.append("one", "project", small.id, 0, packed);
        await packages.processPending();
        await packages.processPending();
        await restart();
        const staged = await packages.read("one", "project", small.id, key);
        expect(staged?.manifest).toEqual(manifest);
        await packages.discard("one", "project", small.id);
        await expect(metadata.transaction((tx) => staged!.assertCurrent(tx))).rejects.toMatchObject({ status: 409 });
        await packages.processPending();

        const forbidden = (await packages.startUpload("one", "project", "revoked.pmf", packed.length))!;
        await packages.append("one", "project", forbidden.id, 0, packed);
        revoked = true;
        await packages.processPending();
        await packages.processPending();
        expect(await packages.list("one", "project")).toEqual([]);
      } finally {
        await packages.close();
        await metadata.close();
        await rm(root, { recursive: true, force: true });
        await fixture.close();
        await mysql?.close();
      }
    },
    120_000,
  );
}
