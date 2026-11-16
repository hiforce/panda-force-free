import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { FileDocumentAssets } from "../../src/server/documents/files/assets.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";

const listPath = "/api/project-documents/assets?project=project-1&document=doc-1",
  imagePath = (id: string) => "/api/project-documents/assets/content?project=project-1&id=" + id,
  uploadPath = (operationId: string, name = "diagram.png") =>
    listPath + "&operationId=" + operationId + "&name=" + encodeURIComponent(name),
  png = () =>
    sharp({ create: { width: 4, height: 3, channels: 3, background: "#40a080" } })
      .png()
      .toBuffer();

test.concurrent(
  "file uploads persist original image bytes outside Git and replay their immutable metadata after restart",
  async () => {
    const f = await projectFileApiFixture();
    try {
      expect((await f.call(listPath)).body.assets).toEqual([]);
      expect(await readdir(f.assetRoot)).toEqual([]);
      const bytes = await png(),
        id = randomUUID(),
        first = await f.raw(uploadPath(id), "POST", bytes),
        asset = (await first.json()).asset;
      expect(first.status).toBe(201);
      expect(asset).toMatchObject({
        id,
        documentId: "doc-1",
        name: "diagram.png",
        mime: "image/png",
        width: 4,
        height: 3,
        size: bytes.length,
      });
      expect(await readFile(join(f.assetRoot, "projects", "project-1", "blobs", asset.digest))).toEqual(bytes);
      const response = await f.raw(imagePath(id));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      const head = await f.snapshots.head();
      f.reopen();
      const replay = await f.raw(uploadPath(id), "POST", bytes);
      expect((await replay.json()).asset).toEqual(asset);
      expect(await f.snapshots.head()).toBe(head);
      const duplicate = await f.raw(uploadPath(randomUUID(), "second.png"), "POST", bytes);
      expect(duplicate.status).toBe(201);
      expect((await f.call(listPath)).body.assets).toHaveLength(2);
      expect(await readdir(join(f.assetRoot, "projects", "project-1", "blobs"))).toEqual([asset.digest]);
      for (const entry of await f.snapshots.entries(await f.snapshots.head())) {
        expect(entry.path.startsWith("blobs/")).toBe(false);
        expect((await f.snapshots.content(entry.blob)).includes(bytes)).toBe(false);
      }
      const latest = await f.snapshots.head();
      expect((await f.raw(uploadPath(id, "changed.png"), "POST", bytes)).status).toBe(409);
      f.actor("operator:other");
      expect((await f.raw(uploadPath(id), "POST", bytes)).status).toBe(409);
      expect(await f.snapshots.head()).toBe(latest);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "saved rich image references retain historical bytes and document ownership across later edits",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const bytes = await png(),
        id = randomUUID();
      expect((await f.raw(uploadPath(id), "POST", bytes)).status).toBe(201);
      const body = emptyRichBody();
      body.document.content = [
        { type: "image", attrs: { src: "/api/document-assets/content?id=" + id, alt: "Diagram", title: "" } },
      ];
      const editor = "/api/project-documents/editor?project=project-1&id=doc-1",
        savedPath = "/api/project-documents/checkpoints?project=project-1&id=doc-1";
      expect(
        (
          await f.call(editor, "PUT", {
            operationId: "image-draft",
            version: 0,
            baseRevisionId: f.detail.revision.id,
            working: { title: "With image", locale: "en", body },
          })
        ).status,
      ).toBe(200);
      const saved = await f.call(savedPath, "POST", {
        operationId: "image-save",
        revisionId: f.detail.revision.id,
        draftVersion: 1,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.detail.revision.body).toEqual(body);
      const noImage = emptyRichBody();
      expect(
        (
          await f.call(editor, "PUT", {
            operationId: "without-image-draft",
            version: 1,
            baseRevisionId: saved.body.detail.revision.id,
            working: { title: "Later", locale: "en", body: noImage },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await f.call(savedPath, "POST", {
            operationId: "without-image-save",
            revisionId: saved.body.detail.revision.id,
            draftVersion: 2,
          })
        ).status,
      ).toBe(200);
      expect((await f.project.documents.revision("doc-1", saved.body.detail.revision.id)).body).toEqual(body);
      expect(Buffer.from(await (await f.raw(imagePath(id))).arrayBuffer())).toEqual(bytes);
      expect((await f.call(listPath)).body.assets).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file image requests enforce origin and grants, reject invalid bytes, and do not initialize storage on reads",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const bytes = await png(),
        id = randomUUID(),
        head = await f.snapshots.head();
      expect((await fetch(f.base + imagePath(id))).status).toBe(401);
      expect((await f.raw(uploadPath(id), "POST", bytes, { origin: "https://untrusted.example" })).status).toBe(403);
      expect((await f.raw(uploadPath(id), "POST", Buffer.from("not an image"))).status).toBe(400);
      expect((await f.raw(uploadPath(id, "../outside.png"), "POST", bytes)).status).toBe(400);
      expect((await f.raw(uploadPath("not-a-uuid"), "POST", bytes)).status).toBe(400);
      expect((await f.raw(imagePath(id))).status).toBe(404);
      expect(await readdir(f.assetRoot)).toEqual([]);
      expect(await f.snapshots.head()).toBe(head);
      expect((await f.raw(uploadPath(id), "POST", bytes)).status).toBe(201);
      f.grants.delete("project-1");
      expect((await f.raw(imagePath(id))).status).toBe(404);
      expect((await f.call(listPath)).status).toBe(404);
      expect((await f.raw(uploadPath(randomUUID()), "POST", bytes)).status).toBe(404);
      f.grants.add("project-1");
      const current = (await f.project.documents.get("doc-1")).document;
      await f.project.navigation.put(
        {
          spaceId: "space-1",
          version: 0,
          nodes: [],
          trash: [{ documentId: current.id, deletedAt: 100, parentId: null, position: null, operationId: null }],
          origins: [],
          lastOperation: null,
        },
        null,
        "trash-image-owner",
        { name: "Test", email: "test@example.test" },
      );
      expect((await f.raw(imagePath(id))).status).toBe(404);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "missing or corrupt asset storage fails closed without replacing immutable bytes or creating read-time directories",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const bytes = await png(),
        id = randomUUID(),
        created = await f.raw(uploadPath(id), "POST", bytes),
        asset = (await created.json()).asset,
        blob = join(f.assetRoot, "projects", "project-1", "blobs", asset.digest),
        head = await f.snapshots.head();
      await writeFile(blob, Buffer.alloc(bytes.length));
      expect((await f.raw(imagePath(id))).status).toBe(503);
      expect((await f.raw(uploadPath(id), "POST", bytes)).status).toBe(503);
      expect(await readFile(blob)).toEqual(Buffer.alloc(bytes.length));
      expect(await f.snapshots.head()).toBe(head);
      await writeFile(blob, bytes);
      await rm(join(f.assetRoot, "projects"), { recursive: true });
      f.reopen();
      expect((await f.raw(imagePath(id))).status).toBe(503);
      expect(await readdir(f.assetRoot)).toEqual([]);
      const overlap = new FileDocumentAssets(new DocumentFileProjects(f.root, () => {}), f.root);
      await expect(overlap.upload("test", "project-1", "doc-1", "test.png", randomUUID(), bytes)).rejects.toMatchObject(
        { code: "unavailable" },
      );
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);
