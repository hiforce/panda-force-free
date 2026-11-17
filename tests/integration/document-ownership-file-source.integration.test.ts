import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { FileDocumentOwnershipSource } from "../../src/server/documents/ownership/file-source.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";

test("ownership source captures the full subtree, immutable originals and owned image bytes without blocking unrelated edits", async () => {
  const f = await projectFileApiFixture();
  try {
    const app = f.application(),
      root = await app.navigation.create("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Root",
        locale: "en",
      }),
      id = root.operation.documentId;
    const child = await app.navigation.create("owner", {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: root.tree.version,
      parentId: id,
      title: "Child",
      locale: "en",
    });
    const bytes = await sharp({ create: { width: 3, height: 4, channels: 3, background: "#408080" } })
        .png()
        .toBuffer(),
      imageId = randomUUID();
    await app.assets.upload("owner", "project-1", id, "original.png", imageId, bytes);
    const source = new FileDocumentOwnershipSource(app.projectContent, f.assetRoot),
      snapshot = await source.capture("project-1", id);
    expect(snapshot.nodes.map((node) => node.documentId).sort()).toEqual([id, child.operation.documentId].sort());
    expect(snapshot.versions).toHaveLength(2);
    expect(snapshot.assets).toHaveLength(1);
    expect((await source.image(snapshot, imageId)).bytes).toEqual(bytes);
    await expect(source.image(snapshot, randomUUID())).rejects.toMatchObject({ code: "notFound" });
    const before = await source.version(
      snapshot,
      id,
      snapshot.nodes.find((node) => node.documentId === id)!.document.revisionId,
    );
    await app.navigation.create("owner", {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: child.tree.version,
      parentId: null,
      title: "Unrelated",
      locale: "en",
    });
    await source.assertCurrent(snapshot);
    const opened = await app.queries.editor("project-1", id);
    await app.editor.autosave("owner", "project-1", id, {
      operationId: randomUUID(),
      version: opened.draft.version,
      baseRevisionId: opened.saved.revision.id,
      working: {
        title: "Edited later",
        locale: "en",
        content: "",
        resources: [],
        body: richDocumentFromMarkdown("Later manual content"),
      },
    });
    await expect(source.capture("project-1", id)).rejects.toMatchObject({ code: "workingCopyChanged" });
    const draft = await app.queries.editor("project-1", id);
    await app.editor.save("owner", "project-1", id, {
      operationId: randomUUID(),
      draftVersion: draft.draft.version,
      revisionId: draft.saved.revision.id,
    });
    await expect(source.assertCurrent(snapshot)).rejects.toMatchObject({ code: "conflict" });
    expect(await source.version(snapshot, id, before.revision.id)).toEqual(before);
    expect((await app.queries.detail("project-1", id)).revision.content).toContain("Later manual content");
    f.grants.delete("project-1");
    await expect(source.image(snapshot, imageId)).rejects.toMatchObject({ code: "notFound" });
    await expect(source.version(snapshot, id, before.revision.id)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 60000);
