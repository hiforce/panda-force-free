import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalImage } from "../src/server/workspace/images.js";
import { createImageThumbnailCache } from "../src/server/workspace/image-thumbnails.js";
import sharp from "sharp";

describe("local agent image boundary", () => {
  test("resolves absolute, relative and file URL image references inside an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-image-"));
    const image = join(root, "preview.png");
    try {
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const canonicalImage = realpathSync(image);
      expect(resolveLocalImage(image, { cwd: root, home: root, allowedRoots: [root] })).toMatchObject({ path: canonicalImage, contentType: "image/png", size: 4 });
      expect(resolveLocalImage("./preview.png", { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalImage);
      expect(resolveLocalImage(new URL(`file://${image}`).href, { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalImage);
      const clipboardImage = join(root, "剪贴板截图");
      writeFileSync(clipboardImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(resolveLocalImage(clipboardImage, { home: root, allowedRoots: [root] })).toMatchObject({ path: realpathSync(clipboardImage), contentType: "image/png" });
      writeFileSync(join(root, "原照片.jpg"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(resolveLocalImage(join(root, "原照片.jpg"), { home: root, allowedRoots: [root] }).contentType).toBe("image/png");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects paths outside the boundary, symbolic links, non-images and oversized files", () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-image-root-"));
    const outside = mkdtempSync(join(tmpdir(), "panda-force-image-outside-"));
    try {
      const outsideImage = join(outside, "outside.png");
      writeFileSync(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(join(root, "notes.txt"), "not an image");
      writeFileSync(join(root, "large.png"), Buffer.alloc(8));
      symlinkSync(outsideImage, join(root, "linked.png"));

      expect(() => resolveLocalImage(outsideImage, { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalImage(join(root, "linked.png"), { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalImage(join(root, "notes.txt"), { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalImage(join(root, "large.png"), { cwd: root, home: root, allowedRoots: [root], maxBytes: 4 })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("local image activity thumbnails", () => {
  test("compresses large images without changing the original and refreshes replaced files", async () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-thumbnail-"));
    const path = join(root, "原始身份照.png");
    const thumbnail = createImageThumbnailCache();
    const resolveImage = () => resolveLocalImage(path, { home: root, allowedRoots: [root] });
    try {
      const original = await sharp({ create: { width: 2400, height: 1600, channels: 4, background: "#cc886680" } }).png().toBuffer();
      writeFileSync(path, original);
      const image = resolveImage();
      const [first, duplicate] = await Promise.all([thumbnail(image), thumbnail(image)]);
      expect(first).toBe(duplicate);
      expect(await thumbnail(resolveImage())).toBe(first);
      expect(await sharp(first).metadata()).toMatchObject({ format: "webp", width: 640, height: 427, hasAlpha: true });
      expect(first.length).toBeLessThan(original.length);
      expect(readFileSync(path)).toEqual(original);
      const replacement = await sharp({ create: { width: 120, height: 80, channels: 4, background: "#33669980" } }).png().toBuffer();
      writeFileSync(path, replacement);
      const refreshed = await thumbnail(resolveImage());
      expect(refreshed).not.toEqual(first);
      expect(await sharp(refreshed).metadata()).toMatchObject({ format: "webp", width: 120, height: 80 });
      expect(readFileSync(path)).toEqual(replacement);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not retain decode failures after an image is repaired", async () => {
    const root = mkdtempSync(join(tmpdir(), "panda-force-thumbnail-invalid-"));
    const path = join(root, "damaged.png");
    const thumbnail = createImageThumbnailCache();
    const resolveImage = () => resolveLocalImage(path, { home: root, allowedRoots: [root] });
    try {
      writeFileSync(path, "not an image");
      await expect(thumbnail(resolveImage())).rejects.toThrow();
      writeFileSync(path, await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).png().toBuffer());
      expect(await sharp(await thumbnail(resolveImage())).metadata()).toMatchObject({ width: 20, height: 10, format: "webp" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
