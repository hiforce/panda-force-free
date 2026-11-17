import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DocumentAsset } from "../../src/shared/documents/contracts.js";
import { SQLDocumentOwnershipImages } from "../../src/server/documents/ownership/sql-images.js";
const bytes = new Uint8Array([1, 2, 3]),
  asset: DocumentAsset = {
    id: randomUUID(),
    documentId: randomUUID(),
    name: "Original.png",
    mime: "image/png",
    digest: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    width: 1,
    height: 1,
    alt: "",
    createdAt: 1,
  };
test("ownership image storage preserves exact original bytes and refuses an altered digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownership-images-"));
  try {
    const images = new SQLDocumentOwnershipImages(join(root, "blobs"));
    await images.write(asset, bytes);
    expect(await images.read(asset)).toEqual(bytes);
    await writeFile(join(root, "blobs", asset.digest), new Uint8Array([9, 8, 7]));
    await expect(images.read(asset)).rejects.toMatchObject({ code: "sourceUnavailable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("ownership image storage rejects symlinked roots and leaves foreign files untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownership-image-links-"));
  try {
    await mkdir(join(root, "foreign"));
    await symlink(join(root, "foreign"), join(root, "blobs"));
    const images = new SQLDocumentOwnershipImages(join(root, "blobs"));
    await expect(images.write(asset, bytes)).rejects.toMatchObject({ code: "sourceUnavailable" });
    await expect(images.read(asset)).rejects.toMatchObject({ code: "sourceUnavailable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("ownership image storage refuses a symlinked blob and detects replacement of its open root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ownership-image-leaf-"));
  try {
    await mkdir(join(root, "blobs"));
    await writeFile(join(root, "foreign.png"), bytes);
    await symlink(join(root, "foreign.png"), join(root, "blobs", asset.digest));
    const images = new SQLDocumentOwnershipImages(join(root, "blobs"));
    await expect(images.write(asset, bytes)).rejects.toMatchObject({ code: "sourceUnavailable" });
    await expect(images.read(asset)).rejects.toBeDefined();
    expect(new Uint8Array(await readFile(join(root, "foreign.png")))).toEqual(bytes);
    await rename(join(root, "blobs"), join(root, "retained"));
    await mkdir(join(root, "blobs"));
    await expect(images.write(asset, bytes)).rejects.toMatchObject({ code: "sourceUnavailable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
