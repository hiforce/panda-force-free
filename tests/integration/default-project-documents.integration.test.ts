import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import sharp from "sharp";
import { createAppFixture } from "../support/app-fixture.mjs";
import { findOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { projectGit } from "../../src/server/project-content/git/process.js";

test("new HTTP projects default to file documents, preserve Git versions and separate images across restart", async () => {
  const f = await createAppFixture();
  const call = async (path: string, data?: unknown, method = data === undefined ? "GET" : "POST") => {
    const response = await fetch(f.base + path, {
      method,
      headers: { ...f.headers, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  try {
    await call("/api/auth/setup", { username: "document-owner" });
    const before = await call("/api/projects"),
      input = { code: "new-default", name: "New file project", revision: before.revision, operationId: randomUUID() },
      created = await call("/api/projects", input),
      project = created.projects.find((item: { code: string }) => item.code === input.code);
    expect((await call("/api/projects", input)).projects).toHaveLength(1);
    const scope = new URLSearchParams({ project: project.id });
    expect((await call("/api/project-document-tree?" + scope)).nodes).toEqual([]);
    const tree = await call("/api/project-document-tree/documents", {
        id: randomUUID(),
        projectId: project.id,
        treeVersion: 0,
        parentId: null,
        title: "A saved source",
        locale: "en",
      }),
      id = tree.operation.documentId,
      query = new URLSearchParams({ project: project.id, id }),
      opened = await call("/api/project-documents/editor?" + query),
      bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#425ee8" } })
        .png()
        .toBuffer();
    const upload = await fetch(
      f.base +
        "/api/project-documents/assets?" +
        new URLSearchParams({ project: project.id, document: id, name: "Original.png", operationId: randomUUID() }),
      { method: "POST", headers: { ...f.headers, "content-type": "application/octet-stream" }, body: bytes },
    );
    expect(upload.status).toBe(201);
    const asset = (await upload.json()).asset;
    const draft = await call(
      "/api/project-documents/editor?" + query,
      {
        operationId: randomUUID(),
        version: opened.draft.version,
        baseRevisionId: opened.draft.baseRevisionId,
        working: {
          ...opened.working,
          title: "Saved on disk",
          body: {
            schema: 1,
            format: "richtext",
            document: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "One original remains editable." }] },
                {
                  type: "image",
                  attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Original diagram" },
                },
              ],
            },
          },
        },
      },
      "PUT",
    );
    const saved = await call("/api/project-documents/checkpoints?" + query, {
        operationId: randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: draft.receipt.version,
      }),
      original = await call("/api/project-documents/source?" + query + "&revision=" + saved.detail.revision.id);
    expect(original.document.revision).toBe(2);
    expect(original.revision.title).toBe("Saved on disk");
    expect(original.document.id).toBe(id);
    expect(original.revision).toEqual(saved.detail.revision);
    expect(saved.commit).toMatch(/^[a-f0-9]{40}$/);
    const foreign = (
      await call("/api/projects", { code: "other-default", name: "Another project", revision: created.revision })
    ).projects.find((item: { code: string }) => item.code === "other-default");
    expect(
      (
        await fetch(f.base + "/api/project-documents/source?" + new URLSearchParams({ project: foreign.id, id }), {
          headers: f.headers,
        })
      ).status,
    ).toBe(404);
    const legacy = await fetch(f.base + "/api/documents/detail?id=" + id, { headers: f.headers });
    expect(legacy.status).toBe(404);
    const db = new Database(join(f.dir, "panda-state/data/documents.sqlite"), { readonly: true });
    try {
      expect(
        db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM documents WHERE id=?").get(id)!.count,
      ).toBe(0);
    } finally {
      db.close();
    }
    const owned = await findOwnedProjectDirectory(join(f.dir, "panda-state/data/document-content"), project.id);
    expect(owned).not.toBeNull();
    const tracked = (
      await projectGit(owned!.directory, ["ls-tree", "-r", "--name-only", "refs/heads/content"])
    ).toString();
    expect(tracked).not.toMatch(/\.png$/m);
    expect((await projectGit(owned!.directory, ["rev-parse", "refs/heads/content"])).toString().trim()).toBe(
      saved.commit,
    );
    await f.stop();
    await f.start();
    const retained = await call("/api/project-documents/source?" + query + "&revision=" + original.revision.id);
    expect(retained).toEqual(original);
    const image = await fetch(
      f.base + "/api/project-documents/assets/content?" + new URLSearchParams({ project: project.id, id: asset.id }),
      { headers: f.headers },
    );
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect((await call("/api/project-documents/revisions?" + query)).revisions).toHaveLength(2);
    expect(
      (await call("/api/project-documents/revisions?" + query + "&revision=" + opened.saved.revision.id)).revision,
    ).toEqual(opened.saved.revision);
  } finally {
    await f.dispose();
  }
}, 30000);
