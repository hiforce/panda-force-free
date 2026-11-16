import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAppFixture } from "../support/app-fixture.mjs";

test("document tree routes enforce authentication, origin, versions and replay across a real application restart", async () => {
  const app = await createAppFixture();
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...app.headers, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  const treePath = (project: string) => "/api/project-document-tree?project=" + project;
  try {
    expect((await fetch(app.base + treePath("missing"))).status).toBe(401);
    expect(
      (await fetch(app.base + "/api/project-document-tree/documents", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect((await call("/api/auth/setup", "POST", { username: "tree-owner" })).status).toBe(200);
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", { code: "tree-project", name: "Tree project", revision: catalog.revision })
    ).body.projects.find((entry: { code: string }) => entry.code === "tree-project");
    expect((await call(treePath(project.id))).body).toEqual({ projectId: project.id, version: 0, nodes: [] });
    const create = { id: randomUUID(), projectId: project.id, treeVersion: 0, title: "Original", locale: "en" };
    expect([401, 403]).toContain(
      (await call("/api/project-document-tree/documents", "POST", create, { origin: "https://untrusted.example" }))
        .status,
    );
    expect((await call("/api/project-document-tree/documents", "POST", { ...create, command: "ignored" })).status).toBe(
      400,
    );
    const created = await call("/api/project-document-tree/documents", "POST", create);
    expect(created.status).toBe(201);
    const id = created.body.operation.documentId;
    const child = await call("/api/project-document-tree/documents", "POST", {
      ...create,
      id: randomUUID(),
      title: "Child",
      treeVersion: 1,
      parentId: id,
    });
    expect(child.status).toBe(201);
    const childId = child.body.operation.documentId;
    const stale = await call("/api/project-document-tree/actions", "POST", {
      action: "move",
      id: randomUUID(),
      projectId: project.id,
      treeVersion: 1,
      documentId: childId,
      target: { kind: "root" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("navigationConflict");
    expect(typeof stale.body.error).toBe("string");
    expect(stale.body.messageId).toBe("documents.navigationConflict");
    expect(stale.body.error).not.toBe("documents.navigationConflict");
    const move = {
      action: "move",
      id: randomUUID(),
      projectId: project.id,
      treeVersion: 2,
      documentId: id,
      target: { kind: "inside", documentId: childId },
    };
    const cycle = await call("/api/project-document-tree/actions", "POST", move);
    expect(cycle.status).toBe(400);
    expect(cycle.body.code).toBe("invalidTreeMove");
    const rename = await call("/api/project-document-tree/actions", "POST", {
      action: "rename",
      id: randomUUID(),
      projectId: project.id,
      treeVersion: 2,
      documentId: id,
      revision: 1,
      title: "Renamed",
    });
    expect(rename.status).toBe(200);
    const original = (await call("/api/documents/detail?id=" + id)).body;
    expect(original.document.revision).toBe(2);
    const trash = {
      action: "trash",
      id: randomUUID(),
      projectId: project.id,
      treeVersion: 3,
      documentId: id,
      revision: 2,
    };
    const deleted = await call("/api/project-document-tree/actions", "POST", trash);
    expect(deleted.status).toBe(200);
    expect(deleted.body.operation.affectedDocumentIds).toEqual([id, childId]);
    expect((await call("/api/documents/detail?id=" + childId)).status).toBe(404);
    expect(
      (await call("/api/project-document-tree/trash?project=" + project.id)).body.documents.map(
        (item: { document: { id: string }; subtreeCount: number }) => [item.document.id, item.subtreeCount],
      ),
    ).toEqual([[id, 2]]);
    await app.stop();
    await app.start();
    expect((await call("/api/project-document-tree/actions", "POST", trash)).body.operation).toEqual(
      deleted.body.operation,
    );
    const restored = await call("/api/project-document-tree/actions", "POST", {
      action: "restore",
      id: randomUUID(),
      projectId: project.id,
      treeVersion: 4,
      documentId: id,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.tree.nodes.find((node: { documentId: string }) => node.documentId === childId).parentId).toBe(
      id,
    );
    expect((await call("/api/documents/detail?id=" + id)).body).toEqual(original);
    const replay = await call("/api/project-document-tree/documents", "POST", create);
    expect(replay.body.operation).toEqual(created.body.operation);
    expect(replay.body.tree.nodes).toHaveLength(2);
    expect(replay.body.tree.version).toBe(5);
    expect(
      (await call("/api/project-document-tree/documents", "POST", { ...create, title: "Changed replay" })).status,
    ).toBe(409);
    expect((await call("/api/project-document-tree/actions", "POST", { action: "publish", ...create })).status).toBe(
      400,
    );
    expect(
      (await call("/api/project-document-tree/actions", "POST", { ...move, padding: "x".repeat(9000) })).status,
    ).toBe(413);
    expect(
      (
        await call("/api/project-document-tree/documents", "POST", {
          ...create,
          body: "x".repeat(2 * 1024 * 1024 + 32768),
        })
      ).status,
    ).toBe(413);
    expect((await call(treePath("missing"))).status).toBe(404);
    expect(app.calls().some((entry: { method?: string }) => entry.method === "turn/start")).toBe(false);
  } finally {
    await app.dispose();
  }
}, 30_000);
