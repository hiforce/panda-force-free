import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";

test("theme and template catalogs enforce authentication, compatibility and exact revisions", async () => {
  const fixture = await createAppFixture();
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(fixture.legacyProject(body), { status: 201 })
        : await fetch(fixture.base + path, {
            method,
            headers: { ...fixture.headers, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(fixture.base + "/api/document-themes")).status).toBe(401);
    expect((await fetch(fixture.base + "/api/publication-templates")).status).toBe(401);
    const themes = await call("/api/document-themes?engine=hexo");
    expect(themes.status).toBe(200);
    expect(themes.body.themes).toHaveLength(2);
    expect((await call("/api/document-themes?engine=unknown")).status).toBe(400);
    const catalog = await call("/api/projects");
    const project = (
      await call("/api/projects", { name: "Catalog", code: "catalog", revision: catalog.body.revision })
    ).body.projects.find((item: { code: string }) => item.code === "catalog");
    const input = {
      projectId: project.id,
      name: "Blog",
      code: "blog",
      engine: "hexo",
      sourceMode: "managed",
      locale: "en",
    };
    expect((await call("/api/document-spaces", { ...input, theme: "panda.missing@1.0.0" })).body.messageId).toBe(
      "documents.unknownTheme",
    );
    const created = await call("/api/document-spaces", input);
    const space = created.body.space;
    expect(
      (await call("/api/document-spaces/theme", { id: space.id, version: 1, theme: "panda.handbook@1.0.0" }, "PUT"))
        .status,
    ).toBe(400);
    const saved = await call(
      "/api/document-spaces/theme",
      { id: space.id, version: 1, theme: "panda.journal@1.0.0" },
      "PUT",
    );
    expect(saved.status).toBe(200);
    expect(saved.body.space.version).toBe(2);
    const conflict = await call("/api/document-spaces/theme", { id: space.id, version: 1, theme: "default" }, "PUT");
    expect(conflict.status).toBe(409);
    expect(conflict.body.messageId).toBe("documents.spaceConflict");
    expect((await call("/api/document-spaces/detail?id=" + space.id)).body.space.theme).toBe("panda.journal@1.0.0");
    const document = await call("/api/documents", {
      spaceId: space.id,
      path: "article.md",
      title: "Article",
      locale: "en",
      content: "A clear source.",
    });
    const templates = await call("/api/publication-templates");
    expect(templates.body.templates).toHaveLength(3);
    const request = {
      documentId: document.body.document.id,
      revisionId: document.body.revision.id,
      format: "html",
      mode: "format",
      templateId: "technical",
    };
    const stale = await call("/api/publication-variants", { ...request, templateVersion: "2" });
    expect(stale.status).toBe(409);
    expect(stale.body.messageId).toBe("publishing.staleTemplate");
    const prepared = await call("/api/publication-variants", { ...request, templateVersion: "1" });
    expect(prepared.status).toBe(201);
    expect(prepared.body.variant.templateSnapshot.id).toBe("technical");
    expect(prepared.body.variant.templateDigest).toMatch(/^[a-f0-9]{64}$/);
    await fixture.stop();
    await fixture.start();
    expect((await call("/api/document-spaces/detail?id=" + space.id)).body.space.theme).toBe("panda.journal@1.0.0");
    const restored = await call("/api/publication-variants/detail?id=" + prepared.body.variant.id);
    expect(restored.body.digest).toBe(prepared.body.digest);
  } finally {
    await fixture.dispose();
  }
}, 30000);
