import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";

test("document API requires authentication, checks origin and persists optimistic revisions across restart", async () => {
  const fixture = await createAppFixture();
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const res =
      path === "/api/projects" && method === "POST"
        ? Response.json(fixture.legacyProject(body), { status: 201 })
        : await fetch(fixture.base + path, {
            method,
            headers: { ...fixture.headers, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: res.status, body: await res.json() };
  };
  try {
    expect((await fetch(fixture.base + "/api/document-spaces?project=absent")).status).toBe(401);
    const catalog = (await call("/api/projects")).body;
    const { body: created } = await call("/api/projects", "POST", {
      name: "Documentation",
      code: "docs",
      revision: catalog.revision,
    });
    const projectId = created.projects[0].id;
    const input = {
      projectId,
      code: "handbook",
      name: "Handbook",
      engine: "markdown",
      sourceMode: "managed",
      locale: "en",
    };
    expect([401, 403]).toContain(
      (await call("/api/document-spaces", "POST", input, { origin: "https://untrusted.example" })).status,
    );
    expect((await call("/api/document-spaces", "POST", { ...input, projectId: "missing" })).status).toBe(404);
    const spaceResult = await call("/api/document-spaces", "POST", input);
    expect(spaceResult.status).toBe(201);
    const space = spaceResult.body.space;
    const docResult = await call("/api/documents", "POST", {
      spaceId: space.id,
      path: "guide/hello.md",
      title: "Hello",
      content: "# Original",
    });
    expect(docResult.status).toBe(201);
    const id = docResult.body.document.id;
    const save = { revision: 1, title: "Updated", content: "# Updated", locale: "en" };
    const results = await Promise.all([
      call("/api/documents/detail?id=" + id, "PUT", save),
      call("/api/documents/detail?id=" + id, "PUT", save),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.messageId).toBe("documents.conflict");
    expect((await call("/api/documents?space=" + space.id + "&search=Updated")).body.documents[0].id).toBe(id);
    expect((await call("/api/documents?space=" + space.id + "&offset=NaN")).status).toBe(400);
    expect((await call("/api/documents/detail?id=" + id, "DELETE")).status).toBe(405);
    await fixture.stop();
    await fixture.start();
    const current = await call("/api/documents/detail?id=" + id);
    expect(current.body.revision.content).toBe("# Updated");
    expect(current.body.document.revision).toBe(2);
    const history = (await call("/api/documents/revisions?id=" + id)).body.revisions;
    expect(history).toHaveLength(2);
    const original = (await call("/api/documents/revisions?id=" + id + "&revision=" + history[1].id)).body.revision;
    expect(original.content).toBe("# Original");
    expect(fixture.calls().some((c: { method?: string }) => c.method === "turn/start")).toBe(false);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

test("source image import is authenticated, origin-protected and revision-checked", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { default: sharp } = await import("sharp");
  const root = await mkdtemp(join(tmpdir(), "panda-ingestion-api-"));
  const fixture = await createAppFixture({ workspaceDirectory: root });
  async function call(path: string, body?: unknown, headers: Record<string, string> = fixture.headers) {
    if (path === "/api/projects" && body !== undefined)
      return Response.json(fixture.legacyProject(body), { status: 201 });
    return fetch(fixture.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  try {
    await mkdir(join(root, "assets"));
    const content = "# Article\n\n![Diagram](assets/diagram.png)";
    await writeFile(join(root, "article.md"), content);
    const image = await sharp({ create: { width: 10, height: 8, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    await writeFile(join(root, "assets/diagram.png"), image);
    const catalog = await (await call("/api/projects")).json();
    const created = await (
      await call("/api/projects", { name: "Imported documents", code: "source-images", revision: catalog.revision })
    ).json();
    const project = created.projects.find((entry: { code: string }) => entry.code === "source-images");
    const { space } = await (
      await call("/api/document-spaces", {
        projectId: project.id,
        name: "Source",
        code: "source",
        engine: "markdown",
        sourceMode: "external",
        sourceRoot: root,
      })
    ).json();
    expect((await call("/api/document-spaces/import", { spaceId: space.id })).status).toBe(200);
    const page = await (await call("/api/documents?space=" + space.id)).json();
    const record = page.documents.find((entry: { path: string }) => entry.path === "article.md");
    const input = { id: record.id, revision: record.revision };
    expect((await call("/api/documents/import-assets", input, {})).status).toBe(401);
    expect(
      (await call("/api/documents/import-assets", input, { ...fixture.headers, Origin: "https://outside.test" }))
        .status,
    ).toBe(401);
    expect((await call("/api/documents/import-assets", { ...input, revision: 0 })).status).toBe(400);
    const response = await call("/api/documents/import-assets", input);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.changed).toBe(false);
    expect(result.detail.revision.content).toBe(content);
    const assetUrl = "/api/document-assets/content?id=" + result.detail.revision.resources[0].assetId;
    expect((await fetch(fixture.base + assetUrl)).status).toBe(401);
    const asset = await call(assetUrl);
    expect(asset.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(image);
    const replacement = await sharp({ create: { width: 10, height: 8, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    await writeFile(join(root, "assets/diagram.png"), replacement);
    const updated = await (await call("/api/documents/import-assets", input)).json();
    expect(updated.detail.document.revision).toBe(record.revision + 1);
    expect((await call("/api/documents/import-assets", input)).status).toBe(409);
    expect(Buffer.from(await (await call(assetUrl)).arrayBuffer())).toEqual(image);
  } finally {
    await fixture.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
