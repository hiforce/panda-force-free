import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

test("project-first publication links are authenticated, durable and frozen independently from the original", async () => {
  const fixture = await createSiteBuildFixture(),
    app = fixture.app;
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(fixture.app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...app.headers, "Content-Type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(app.base + "/api/document-placements?space=missing")).status).toBe(401);
    const catalog = (await call("/api/projects")).body,
      project = (
        await call("/api/projects", "POST", {
          code: "publication-links",
          name: "Publication links",
          revision: catalog.revision,
        })
      ).body.projects[0];
    const original = await call("/api/project-documents", "POST", {
      projectId: project.id,
      title: "Write before choosing a channel",
      folder: "Guides",
      locale: "en",
    });
    expect(original.status).toBe(201);
    const rich = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "First saved rich original", marks: [{ type: "underline" }] }],
          },
        ],
      },
    };
    const saved = (
      await call("/api/documents/detail?id=" + original.body.document.id, "PUT", {
        revision: 1,
        title: "Original title",
        locale: "en",
        body: rich,
      })
    ).body;
    const space = (
      await call("/api/document-spaces", "POST", {
        projectId: project.id,
        name: "Later website",
        code: "later-site",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      })
    ).body.space;
    const input = {
      id: randomUUID(),
      documentId: saved.document.id,
      spaceId: space.id,
      path: "guides/first.md",
      locale: "en",
      metadata: { title: "Website title" },
    };
    expect([401, 403]).toContain(
      (await call("/api/document-placements", "POST", input, { origin: "https://untrusted.example" })).status,
    );
    const first = await call("/api/document-placements", "POST", input);
    expect(first.status).toBe(201);
    expect(first.body.placement.version).toBe(1);
    expect((await call("/api/document-placements", "POST", input)).body).toEqual(first.body);
    expect((await call("/api/document-placements?document=" + saved.document.id)).body.placements).toHaveLength(1);
    expect((await call("/api/document-placements?document=" + saved.document.id + "&space=" + space.id)).status).toBe(
      400,
    );
    fixture.hold();
    const request = {
      id: randomUUID(),
      spaceId: space.id,
      engine: "hexo",
      locale: "en",
      title: "Linked site",
      url: "https://example.test",
      basePath: "/",
    };
    const build = await call("/api/site-builds", "POST", request);
    expect(build.status).toBe(202);
    expect(build.body.build.sources[0]).toMatchObject({
      id: saved.document.id,
      path: input.path,
      sourcePath: saved.document.path,
      revisionId: saved.revision.id,
      placement: { id: input.id, version: 1 },
    });
    await waitFor(() => fixture.inputs.has(request.id));
    expect(fixture.inputs.get(request.id).documents[0].title).toBe("Website title");
    expect(fixture.inputs.get(request.id).documents[0].content).toContain("<u>First saved rich original</u>");
    const edit = { ...input, version: 1, path: "guides/reviewed.md" };
    expect((await call("/api/document-placements/detail?id=" + input.id, "PUT", edit)).body.placement.version).toBe(2);
    expect((await call("/api/document-placements/detail?id=" + input.id, "PUT", edit)).body.placement.version).toBe(2);
    expect(
      (await call("/api/document-placements/detail?id=" + input.id, "PUT", { ...edit, path: "conflicting.md" })).status,
    ).toBe(409);
    await app.stop();
    await app.start();
    const events = (await call("/api/document-placements/history?id=" + input.id)).body.events;
    expect(events.map((event: { operation: string }) => event.operation)).toEqual(["update", "create"]);
    expect(events.every((event: { actor: string }) => event.actor === "local-access")).toBe(true);
    const retained = (await call("/api/documents/detail?id=" + saved.document.id)).body;
    expect(retained.document.spaceId).toBe(saved.document.spaceId);
    expect(retained.revision.body).toEqual(saved.revision.body);
    expect(
      (
        await call("/api/project-documents/trash", "DELETE", {
          projectId: project.id,
          id: saved.document.id,
          revision: 2,
        })
      ).status,
    ).toBe(200);
    const blocked = await call("/api/site-builds", "POST", { ...request, id: randomUUID() });
    expect(blocked.status).toBe(409);
    expect(blocked.body.messageId).toBe("builds.placementSourceUnavailable");
    expect((await call("/api/site-builds/detail?id=" + request.id)).body.build.sources[0].revisionId).toBe(
      saved.revision.id,
    );
    expect(
      (await call("/api/document-placements/detail?id=" + input.id, "DELETE", { version: 2 })).body.placement.deletedAt,
    ).not.toBeNull();
    expect((await call("/api/document-placements?space=" + space.id)).body.placements).toEqual([]);
  } finally {
    await fixture.dispose();
  }
}, 40_000);
