import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";

// Exercise the real authenticated router and persistence, independently of editor or publication engines.
test("project writing APIs protect ownership, preserve rich revision conflicts and survive process restart", async () => {
  const app = await createAppFixture();
  async function call(path: string, method = "GET", input?: unknown, headers: Record<string, string> = app.headers) {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(input), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...headers, "content-type": "application/json" },
            ...(input ? { body: JSON.stringify(input) } : {}),
          });
    return { status: response.status, body: await response.json() };
  }
  try {
    expect((await fetch(app.base + "/api/project-documents?project=absent")).status).toBe(401);
    const catalog = (await call("/api/projects")).body;
    const result = await call("/api/projects", "POST", {
      name: "Knowledge",
      code: "knowledge",
      revision: catalog.revision,
    });
    const projectId = result.body.projects.find((entry: { code: string }) => entry.code === "knowledge").id;
    expect((await call("/api/project-documents?project=" + projectId)).body).toEqual({ library: null, folders: [] });
    expect([401, 403]).toContain(
      (
        await call(
          "/api/project-documents/folders",
          "POST",
          { projectId, path: "Notes" },
          { ...app.headers, origin: "https://untrusted.example" },
        )
      ).status,
    );
    expect((await call("/api/project-documents/folders", "POST", { projectId, path: "../escape" })).status).toBe(400);
    expect((await call("/api/project-documents/folders", "POST", { projectId, path: "Notes" })).status).toBe(200);
    const created = await call("/api/project-documents", "POST", {
      projectId,
      folder: "Notes",
      title: "The source",
      locale: "en",
    });
    expect(created.status).toBe(201);
    const id = created.body.document.id;
    const body = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Keep this format", marks: [{ type: "underline" }] }] },
        ],
      },
    };
    const input = { revision: 1, title: "The source", locale: "en", body };
    const race = await Promise.all([
      call("/api/documents/detail?id=" + id, "PUT", input),
      call("/api/documents/detail?id=" + id, "PUT", input),
    ]);
    expect(race.map((result) => result.status).sort()).toEqual([200, 409]);
    const revision = race.find((result) => result.status === 200)!.body.revision;
    expect(revision.body).toEqual(body);
    expect(
      (
        await call("/api/documents/detail?id=" + id, "PUT", {
          ...input,
          revision: 2,
          body: { ...body, document: { type: "script" } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("/api/project-documents/location", "PUT", { projectId: "missing", id, revision: 2, folder: "" }))
        .status,
    ).toBe(404);
    expect((await call("/api/project-documents/trash", "DELETE", { projectId, id, revision: 2 })).status).toBe(200);
    expect((await call("/api/documents/detail?id=" + id)).status).toBe(404);
    await app.stop();
    await app.start();
    expect(
      (await call("/api/project-documents/trash?project=" + projectId)).body.documents.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual([id]);
    const restored = await call("/api/project-documents/trash", "POST", { projectId, id });
    expect(restored.body.revision.id).toBe(revision.id);
    expect(restored.body.revision.body).toEqual(body);
    const original = await call("/api/documents/detail?id=" + id, "PUT", {
      revision: 2,
      title: created.body.revision.title,
      locale: created.body.revision.locale,
      body: created.body.revision.body,
      restoreRevisionId: created.body.revision.id,
    });
    expect(original.status).toBe(200);
    expect(original.body.revision.body.document.content).toEqual([{ type: "paragraph" }]);
    expect((await call("/api/documents/revisions?id=" + id)).body.revisions).toHaveLength(3);
    expect(app.calls().some((call: { method?: string }) => call.method === "turn/start")).toBe(false);
  } finally {
    await app.dispose();
  }
}, 30_000);
