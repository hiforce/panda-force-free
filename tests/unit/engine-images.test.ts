import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { isAllowedBrowserRpcMethod } from "../../src/server/auth/security.js";
import { EngineImages } from "../../src/server/workspace/engine-images.js";
import { createLocalImagePresenter } from "../../src/server/workspace/image-presentation.js";

const token = (url: string) => new URL(url, "http://local").searchParams.get("token")!;
test("native image capabilities retrieve engine-private bytes once and survive temporary source removal", async () => {
  expect(isAllowedBrowserRpcMethod("fs/readFile")).toBe(false);
  expect(isAllowedBrowserRpcMethod("fs/getMetadata")).toBe(false);
  const dir = await mkdtemp(join(tmpdir(), "engine-images-"));
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#126d78" } })
    .png()
    .toBuffer();
  let reads = 0,
    available = true;
  const read = async (method: string) => {
    if (!available) throw Error("Source removed");
    if (method === "fs/getMetadata") return { isFile: true, isSymlink: false };
    reads++;
    return { dataBase64: bytes.toString("base64") };
  };
  try {
    const cache = new EngineImages(dir, ["/engine/work"], read, Date.now, "fixture-signing-key");
    const url = cache.reference("/engine/work/preview.png", "view-1")!;
    expect(cache.reference("/etc/password.png", "other")).toBeNull();
    const issued = token(url);
    const results = await Promise.all([cache.image(issued), cache.image(issued)]);
    expect(results[0]!.bytes).toEqual(bytes);
    expect(reads).toBe(1);
    const thumbnail = await cache.image(issued, true);
    expect(thumbnail.type).toBe("image/webp");
    expect((await sharp(thumbnail.bytes).metadata()).width).toBe(120);
    available = false;
    const restarted = new EngineImages(dir, ["/engine/work"], read, Date.now, "fixture-signing-key");
    expect((await restarted.image(issued)).bytes).toEqual(bytes);
    expect((await restarted.image(token(restarted.reference("/engine/work/preview.png", "view-1")!))).bytes).toEqual(
      bytes,
    );
    await expect(cache.image(issued + "tampered")).rejects.toThrow();
    const original = { type: "imageView", id: "view-1", imagePaths: ["/engine/work/preview.png"] };
    const projected = createLocalImagePresenter({
      allowedRoots: [],
      engineReference: (path: unknown, id: unknown) => cache.reference(path, id),
    })(original);
    expect(projected.imagePaths[0]).toBe(url);
    expect(original.imagePaths[0]).toBe("/engine/work/preview.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("image capabilities reject non-images, symbolic links and expired references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "engine-image-reject-"));
  let now = 1000;
  try {
    const bad = new EngineImages(
      dir,
      ["/engine"],
      async (method) =>
        method === "fs/getMetadata"
          ? { isFile: true, isSymlink: false }
          : { dataBase64: Buffer.from("private text").toString("base64") },
      () => now,
    );
    const url = token(bad.reference("/engine/secret.png", "view")!);
    await expect(bad.image(url)).rejects.toThrow("Unsupported image bytes");
    now = 8 * 86400000;
    await expect(bad.image(url)).rejects.toThrow("Expired");
    const symlink = new EngineImages(dir, ["/engine"], async () => ({ isFile: true, isSymlink: true }));
    await expect(symlink.image(token(symlink.reference("/engine/link.png", "view")!))).rejects.toThrow("unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
