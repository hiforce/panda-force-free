import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { memoryPackageChunkBytes, memoryPackageUploadMaxBytes } from "../../src/shared/project-memory/archive.js";
import { pmfHeaderBytes, pmfTagBytes } from "../../src/shared/project-memory/pmf-envelope.js";
import { createMemoryArchive } from "../../src/server/project-memory/portability.js";
import { decodeMemoryPackage, encodeMemoryPackage, sealMemoryPackage } from "../../src/server/project-memory/pmf.js";
import { memoryPackageUploads } from "../../src/server/project-memory/pmf-uploads.js";

const manifest = createMemoryArchive([{ key: "cache-ttl", scope: "release", values: ["24 hours"] }], Date.now());
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const encoded = encodeMemoryPackage(manifest, pair.publicKey);
const contentKey = (file: Buffer) =>
  privateDecrypt(
    {
      key: pair.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    file.subarray(36, 420),
  );
const key = contentKey(encoded);
const decode = (file: Buffer, unlock = key) =>
  decodeMemoryPackage(file.length, async (offset, length) => file.subarray(offset, offset + length), unlock);

test("PMF checks the independent ZIP layout and UTF-8 manifest before returning data", async () => {
  expect(await decode(encoded)).toEqual(manifest);
  await expect(decode(Buffer.from(JSON.stringify(manifest)))).rejects.toMatchObject({
    messageId: "projects.memoryPackageInvalid",
  });
  const zip = Buffer.from(zipSync({ "manifest.json": Buffer.from(JSON.stringify(manifest)) }, { level: 0 }));
  await expect(decode(zip)).rejects.toMatchObject({ messageId: "projects.memoryPackageInvalid" });
  const mislabeled = Buffer.concat([encoded.subarray(0, pmfHeaderBytes), zip, Buffer.alloc(pmfTagBytes)]);
  await expect(decode(mislabeled)).rejects.toMatchObject({ messageId: "projects.memoryPackageUnlockFailed" });
  expect(encoded.includes(Buffer.from("24 hours"))).toBe(false);
  await expect(decode(encoded, randomBytes(32))).rejects.toMatchObject({
    messageId: "projects.memoryPackageUnlockFailed",
  });
  const changed = Buffer.from(encoded);
  changed[45] = changed[45]! ^ 1;
  await expect(decode(changed)).rejects.toMatchObject({ messageId: "projects.memoryPackageUnlockFailed" });
  const wrong = sealMemoryPackage(pair.publicKey, zipSync({ "wrong.json": Buffer.from("{}") }));
  await expect(decode(wrong, contentKey(wrong))).rejects.toMatchObject({ messageId: "projects.memoryPackageInvalid" });
});

test("PMF retries use the verified disk offset and are scoped to their owner and project", async () => {
  const uploads = memoryPackageUploads();
  await expect(uploads.start("owner", "one", "memory.json", encoded.length)).rejects.toMatchObject({
    messageId: "projects.memoryPackageInvalid",
  });
  await expect(uploads.start("owner", "one", "memory.pmf", memoryPackageUploadMaxBytes + 1)).rejects.toMatchObject({
    status: 413,
  });
  const { id } = await uploads.start("owner", "one", "memory.PMF", encoded.length);
  try {
    expect(() => uploads.status("other", "one", id)).toThrow();
    expect(() => uploads.status("owner", "two", id)).toThrow();
    await expect(uploads.read("owner", "one", id)).rejects.toMatchObject({ status: 409 });
    await expect(uploads.append("owner", "one", id, 0, async () => encoded.subarray(0, -1))).rejects.toMatchObject({
      status: 400,
    });
    expect(uploads.status("owner", "one", id).offset).toBe(0);
    expect(await uploads.append("owner", "one", id, 0, async () => encoded)).toEqual({ id, offset: encoded.length });
    await expect(uploads.append("owner", "one", id, 0, async () => encoded)).rejects.toMatchObject({ status: 409 });
    await expect(uploads.read("owner", "one", id)).rejects.toMatchObject({
      messageId: "projects.memoryPackageUnlockFailed",
    });
    await expect(uploads.read("owner", "one", id, randomBytes(32))).rejects.toMatchObject({
      messageId: "projects.memoryPackageUnlockFailed",
    });
    expect(await uploads.read("owner", "one", id, key)).toEqual(manifest);
    expect(await uploads.read("owner", "one", id)).toEqual(manifest);
  } finally {
    await uploads.discard("owner", "one", id);
  }
  expect(() => uploads.status("owner", "one", id)).toThrow();
});

test("multi-chunk uploads are staged, but v1 refuses attachments without reading their payload", async () => {
  const uploads = memoryPackageUploads();
  const large = sealMemoryPackage(
    pair.publicKey,
    zipSync(
      {
        "manifest.json": Buffer.from(JSON.stringify(manifest)),
        "assets/drawing.png": new Uint8Array(2 * memoryPackageChunkBytes + 1024),
      },
      { level: 0 },
    ),
  );
  const { id } = await uploads.start("owner", "one", "building.pmf", large.length);
  for (let offset = 0; offset < large.length; offset += memoryPackageChunkBytes) {
    const chunk = large.subarray(offset, offset + memoryPackageChunkBytes);
    expect((await uploads.append("owner", "one", id, offset, async () => chunk)).offset).toBe(offset + chunk.length);
  }
  const unlock = contentKey(large);
  await expect(uploads.read("owner", "one", id, unlock)).rejects.toMatchObject({
    messageId: "projects.memoryPackageUnsupported",
  });
  expect(() => uploads.status("owner", "one", id)).toThrow();
  const reads: number[] = [];
  await expect(
    decodeMemoryPackage(
      large.length,
      async (offset, length) => {
        reads.push(length);
        return large.subarray(offset, offset + length);
      },
      unlock,
    ),
  ).rejects.toMatchObject({ messageId: "projects.memoryPackageUnsupported" });
  expect(reads).toEqual([]);
});

test("closing an active PMF upload withdraws access while the in-flight write releases the file", async () => {
  const uploads = memoryPackageUploads();
  const { id } = await uploads.start("owner", "one", "building.pmf", encoded.length);
  const bytes = Promise.withResolvers<Buffer>();
  const pending = uploads.append("owner", "one", id, 0, () => bytes.promise);
  await uploads.discard("owner", "one", id);
  expect(() => uploads.status("owner", "one", id)).toThrow();
  bytes.resolve(encoded);
  await pending;
  expect(() => uploads.status("owner", "one", id)).toThrow();
});

test("encrypted browser backups require their passphrase and restore the original RSA identity", async () => {
  const { createEncryptionKey, restoreEncryptionKey, unlockEncryptionKey } =
    await import("../../src/client/encryption-keys/key-store.js");
  const passphrase = "test-only recovery passphrase";
  const backup = await createEncryptionKey("First key", passphrase);
  await expect(restoreEncryptionKey(backup, "incorrect passphrase")).rejects.toThrow();
  await expect(restoreEncryptionKey({ ...backup, name: "Modified" }, passphrase)).rejects.toThrow();
  expect(await restoreEncryptionKey(backup, passphrase)).toEqual(backup);
  const privateKey = await unlockEncryptionKey(backup, passphrase);
  expect(privateKey.extractable).toBe(false);
  const other = await createEncryptionKey("Second key", passphrase);
  expect(other.fingerprint).not.toEqual(backup.fingerprint);
});
