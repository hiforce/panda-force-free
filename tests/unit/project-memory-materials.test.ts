import { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { test, expect } from "bun:test";
import { zipSync } from "fflate";
import { openMemoryFrames, sealMemoryFrames } from "../../src/server/project-memory/pmf-frames.js";
import {
  prepareMemoryMaterials,
  openMemoryMaterials,
  type MemoryMaterialManifest,
} from "../../src/server/project-memory/pmf-materials.js";
import { createMemoryArchive } from "../../src/server/project-memory/portability.js";
import { pmfFrameBytes, pmfHeaderBytes, pmfTagBytes } from "../../src/shared/project-memory/pmf-envelope.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const key = (bytes: Buffer) =>
  privateDecrypt(
    {
      key: pair.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    bytes.subarray(36, 420),
  );
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const reader = (file: Buffer) => async (offset: number, length: number) => file.subarray(offset, offset + length);
const collect = async (source: AsyncIterable<Uint8Array>) => {
  const content: Uint8Array[] = [];
  for await (const bytes of source) content.push(bytes);
  return Buffer.concat(content);
};

test("segmented PMF authenticates order, length and last frame and reads only touched ranges", async () => {
  const original = randomBytes(pmfFrameBytes * 2 + 31);
  const archive = await collect(
    sealMemoryFrames(
      pair.publicKey,
      (async function* () {
        yield original;
      })(),
    ),
  );
  const requests: number[] = [];
  const secret = key(archive);
  const decoded = await openMemoryFrames(
    archive.length,
    async (offset, length) => {
      requests.push(length);
      return reader(archive)(offset, length);
    },
    secret,
  );
  expect(await decoded.read(pmfFrameBytes - 2, 4)).toEqual(original.subarray(pmfFrameBytes - 2, pmfFrameBytes + 2));
  expect(requests).toEqual([pmfHeaderBytes, pmfFrameBytes + pmfTagBytes, pmfFrameBytes + pmfTagBytes]);
  decoded.close();
  const truncated = archive.subarray(0, archive.length - 31 - pmfTagBytes);
  const invalid = await openMemoryFrames(truncated.length, reader(truncated), secret);
  await expect(invalid.read(pmfFrameBytes, 1)).rejects.toMatchObject({
    messageId: "projects.memoryPackageUnlockFailed",
  });
  invalid.close();
  const span = pmfFrameBytes + pmfTagBytes;
  const reordered = Buffer.concat([
    archive.subarray(0, pmfHeaderBytes),
    archive.subarray(pmfHeaderBytes + span, pmfHeaderBytes + span * 2),
    archive.subarray(pmfHeaderBytes, pmfHeaderBytes + span),
    archive.subarray(pmfHeaderBytes + 2 * span),
  ]);
  const swapped = await openMemoryFrames(reordered.length, reader(reordered), secret);
  await expect(swapped.read(0, 1)).rejects.toMatchObject({ messageId: "projects.memoryPackageUnlockFailed" });
  swapped.close();
});

test("v2 ZIP validates linked original data, deduplicates bytes and preserves anchors", async () => {
  const native = randomBytes(8 * pmfFrameBytes);
  const digest = sha(native);
  const material = { digest, size: native.length, name: "section.png" };
  const manifest: MemoryMaterialManifest = {
    version: 2,
    memory: createMemoryArchive([{ key: "slope", scope: "site", values: ["2 percent"] }], Date.now()),
    materials: [
      {
        id: "section",
        version: "a12",
        title: "Section",
        kind: "image",
        files: [material],
        anchors: [
          { key: "slope", scope: "site", location: { kind: "image", x: 0.1, y: 0.2, width: 0.5, height: 0.3 } },
        ],
      },
      { id: "plan", version: "a13", title: "Plan", kind: "document", files: [material] },
    ],
  };
  let reads = 0;
  const writer = prepareMemoryMaterials(manifest, async function* () {
    reads++;
    for (let offset = 0; offset < native.length; offset += 128 * 1024)
      yield native.subarray(offset, offset + 128 * 1024);
  });
  const sealed = await collect(writer(pair.publicKey));
  expect(reads).toBe(1);
  const opened = await openMemoryMaterials(sealed.length, reader(sealed), key(sealed));
  expect(opened.memory).toEqual(manifest.memory);
  expect(opened.materials).toEqual(manifest.materials);
  expect(await collect(opened.file(digest))).toEqual(native);
  opened.close();
  const changed = Buffer.from(sealed);
  changed[pmfHeaderBytes + pmfFrameBytes * 4] ^= 1;
  const tampered = await openMemoryMaterials(changed.length, reader(changed), key(sealed));
  await expect(tampered.verify()).rejects.toMatchObject({ messageId: "projects.memoryPackageUnlockFailed" });
  tampered.close();

  const wrong = zipSync(
    { "manifest.json": Buffer.from(JSON.stringify(manifest)), ["assets/" + digest]: Buffer.alloc(native.length) },
    { level: 0 },
  );
  const wrongSeal = await collect(
    sealMemoryFrames(
      pair.publicKey,
      (async function* () {
        yield wrong;
      })(),
    ),
  );
  const mismatched = await openMemoryMaterials(wrongSeal.length, reader(wrongSeal), key(wrongSeal));
  await expect(mismatched.verify()).rejects.toMatchObject({ messageId: "projects.memoryPackageInvalid" });
  mismatched.close();
});
