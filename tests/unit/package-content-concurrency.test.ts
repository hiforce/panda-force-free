import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FilePackageContent } from "../../src/server/packages/content-store.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("competing immutable inserts remain readable while winner temporary links are removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-link-race-")),
    codec = {
      maxBytes: 32768,
      encode: async (value: string) => Buffer.from(value),
      decode: async (bytes: Uint8Array) => Buffer.from(bytes).toString(),
      digest,
    },
    stores = Array.from({ length: 8 }, () => new FilePackageContent(root, codec));
  try {
    for (let index = 0; index < 50; index++) {
      const value = "Concurrent immutable record " + index + "x".repeat(16384),
        results = await Promise.all(stores.map((store) => store.insert(value)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await stores[0]!.read(digest(value))).toBe(value);
    }
    const value = "Original immutable source";
    await stores[0]!.put(value);
    await writeFile(join(root, digest(value) + ".json"), "Changed immutable source");
    await expect(stores[0]!.read(digest(value))).rejects.toThrow("contentUnavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
