import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { CreativeAssetCovers } from "../../src/server/creative/assets/covers.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import type { FileCreativeAssetReader } from "../../src/server/creative/assets/reader.js";
import type { CreativeAsset } from "../../src/shared/creative/assets.js";
type Options = NonNullable<Parameters<FileCreativeAssetReader["resource"]>[2]>;
async function fixture(color = "#168c9b") {
  const bytes = await sharp({ create: { width: 1400, height: 900, channels: 3, background: color } })
    .png()
    .toBuffer();
  const asset: CreativeAsset = {
    schema: 1,
    id: "image",
    project: "personal",
    kind: "image",
    title: "Actual original",
    locale: "en",
    version: "a".repeat(64),
    previousVersion: null,
    state: "saved",
    source: { name: "original.png", size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") },
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const state = { gets: 0, denied: false, afterRead: () => {} };
  const reader = {
    resource: async (_project: string, _id: string, options: Options = {}) => {
      if (state.denied || asset.state !== "saved") throw new DocumentError("notFound", 404);
      if (options.version !== asset.version) throw new DocumentError("conflict", 409);
      const selection = options.select?.(asset, asset.source);
      if (selection?.head) return { asset, resource: asset.source, bytes: undefined };
      state.gets++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      state.afterRead();
      return { asset, resource: asset.source, bytes };
    },
  } satisfies Pick<FileCreativeAssetReader, "resource">;
  return { reader, asset, state };
}
test("parallel thumbnail requests transfer an original once and warm reads reauthorize without storage IO", async () => {
  const f = await fixture(),
    covers = new CreativeAssetCovers(),
    signal = new AbortController().signal;
  const values = await Promise.all(
    Array.from({ length: 6 }, () => covers.read("alice", f.reader, "personal", "image", f.asset.version, signal)),
  );
  expect(f.state.gets).toBe(1);
  for (const value of values) {
    const metadata = await sharp(value.bytes).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBeLessThanOrEqual(512);
    expect(metadata.height).toBeLessThanOrEqual(320);
    expect(value.width).toBe(1400);
    expect(value.height).toBe(900);
  }
  await covers.read("alice", f.reader, "personal", "image", f.asset.version, signal);
  expect(f.state.gets).toBe(1);
  f.state.denied = true;
  await expect(covers.read("alice", f.reader, "personal", "image", f.asset.version, signal)).rejects.toMatchObject({
    status: 404,
  });
  f.state.denied = false;
  f.asset.state = "trashed";
  await expect(covers.read("alice", f.reader, "personal", "image", f.asset.version, signal)).rejects.toMatchObject({
    status: 404,
  });
});
test("owners and versions cannot borrow cached covers and authority is checked again after rendering", async () => {
  const f = await fixture(),
    covers = new CreativeAssetCovers(),
    signal = new AbortController().signal;
  await covers.read("alice", f.reader, "personal", "image", f.asset.version, signal);
  await covers.read("bob", f.reader, "personal", "image", f.asset.version, signal);
  expect(f.state.gets).toBe(2);
  f.asset.version = "b".repeat(64);
  await expect(covers.read("alice", f.reader, "personal", "image", "a".repeat(64), signal)).rejects.toMatchObject({
    status: 409,
  });
  f.state.afterRead = () => {
    f.state.denied = true;
  };
  await expect(covers.read("alice", f.reader, "personal", "image", f.asset.version, signal)).rejects.toMatchObject({
    status: 404,
  });
});
test("one cancelled observer cannot cancel another valid wait for the same protected cover", async () => {
  const f = await fixture(),
    covers = new CreativeAssetCovers(),
    first = new AbortController(),
    second = new AbortController();
  const a = covers.read("alice", f.reader, "personal", "image", f.asset.version, first.signal),
    b = covers.read("alice", f.reader, "personal", "image", f.asset.version, second.signal);
  void a.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2));
  first.abort();
  await expect(a).rejects.toMatchObject({ status: 503 });
  expect((await b).width).toBe(1400);
  expect(f.state.gets).toBe(1);
});
