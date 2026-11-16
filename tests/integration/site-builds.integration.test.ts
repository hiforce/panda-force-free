import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

test("site build routes freeze saved revisions and owned images, survive restart, and keep output private", async () => {
  const f = await createSiteBuildFixture(),
    app = f.app;
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(f.app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
            method,
            headers: { ...app.headers, "Content-Type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(app.base + "/api/site-builds/availability")).status).toBe(401);
    expect((await call("/api/site-builds/availability")).body.state).toBe("ready");
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", { code: "builds", name: "Builds", revision: catalog.revision })
    ).body.projects[0];
    const space = (
      await call("/api/document-spaces", "POST", {
        projectId: project.id,
        name: "Site",
        code: "site",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      })
    ).body.space;
    const source = (
      await call("/api/documents", "POST", {
        spaceId: space.id,
        path: "hello.md",
        title: "Hello",
        locale: "en",
        content: "Saved text.",
      })
    ).body;
    const picture = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    const upload = await fetch(
      app.base +
        "/api/document-assets?" +
        new URLSearchParams({ document: source.document.id, name: "original image.png" }),
      { method: "POST", headers: app.headers, body: picture },
    );
    const asset = (await upload.json()).asset;
    const saved = (
      await call("/api/documents/detail?id=" + source.document.id, "PUT", {
        revision: 1,
        title: "Hello",
        locale: "en",
        content: `Saved text.\n\n![Original](/api/document-assets/content?id=${asset.id})`,
      })
    ).body;
    await call("/api/documents", "POST", {
      spaceId: space.id,
      path: "chinese.md",
      title: "中文",
      locale: "zh-CN",
      content: "中文版本",
    });
    const request = {
      id: randomUUID(),
      spaceId: space.id,
      engine: "hexo",
      title: "Fixture site",
      locale: "en",
      url: "https://example.com",
      basePath: "/docs/",
    };
    expect([401, 403]).toContain(
      (await call("/api/site-builds", "POST", request, { origin: "https://untrusted.example" })).status,
    );
    expect((await call("/api/site-builds", "POST", { ...request, image: "untrusted:image" })).status).toBe(400);
    f.hold();
    const created = await call("/api/site-builds", "POST", request);
    expect(created.status).toBe(202);
    expect(created.body.build.sources[0].revisionId).toBe(saved.revision.id);
    await waitFor(() => f.jobs.has(request.id));
    const docusaurusId = randomUUID();
    expect(
      (await call("/api/site-builds", "POST", { ...request, id: docusaurusId, engine: "docusaurus" })).status,
    ).toBe(202);
    await waitFor(() => f.inputs.has(docusaurusId));
    expect(f.inputs.get(docusaurusId).documents[0].content).toContain("pathname:///docs/assets/");
    expect(f.inputs.get(docusaurusId).documents[0].content).toContain("original%20image.png");
    await call("/api/documents/detail?id=" + source.document.id, "PUT", {
      revision: 2,
      title: "Later title",
      locale: "en",
      content: "Changed after snapshot.",
    });
    const captured = f.inputs.get(request.id);
    expect(captured.documents).toHaveLength(1);
    expect(captured.documents[0].content).toContain("Saved text.");
    expect(captured.documents[0].content).toContain("original%20image.png");
    expect(captured.assets[0].path.endsWith("/original image.png")).toBe(true);
    expect(Buffer.from(captured.assets[0].data, "base64")).toEqual(picture);
    expect((await call("/api/site-builds", "POST", request)).body.build.id).toBe(request.id);
    await app.stop();
    await app.start();
    f.finish();
    await waitFor(
      async () => (await call("/api/site-builds/detail?id=" + request.id)).body.build.phase === "completed",
    );
    const finished = (await call("/api/site-builds/detail?id=" + request.id)).body;
    expect(finished.logs).toContain("Fixture build completed");
    expect(finished.build.sources[0].revisionId).toBe(saved.revision.id);
    const preview = await fetch(app.base + `/api/site-builds/preview/${request.id}/index.html`, {
      headers: app.headers,
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-security-policy")).toContain("sandbox;");
    expect(await preview.text()).not.toContain("parent.__unsafeBuild");
    expect((await fetch(app.base + `/api/site-builds/preview/${request.id}/index.html`)).status).toBe(401);
    const downloaded = await fetch(app.base + `/api/site-builds/download?id=${request.id}`, { headers: app.headers });
    expect(downloaded.headers.get("content-disposition")).toContain("attachment;");
    const files = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
    expect(files["index.html"]).toBeDefined();
    expect(files["assets/" + captured.assets[0].path]).toEqual(new Uint8Array(picture));
    const unsupported = (
      await call("/api/documents", "POST", {
        spaceId: space.id,
        path: "component.mdx",
        title: "MDX",
        locale: "en",
        content: "# Component",
      })
    ).body;
    const invalidBuild = await call("/api/site-builds", "POST", { ...request, id: randomUUID() });
    expect(invalidBuild.status).toBe(400);
    expect(invalidBuild.body.messageId).toBe("builds.unsupportedDocumentPath");
    expect(
      (
        await call("/api/documents/detail?id=" + unsupported.document.id, "PUT", {
          revision: 1,
          title: "MDX",
          locale: "zh-CN",
          content: "# Component",
        })
      ).status,
    ).toBe(200);
    const others = (
      await call("/api/documents", "POST", {
        spaceId: space.id,
        path: "foreign.md",
        title: "Foreign reference",
        locale: "en",
        content: `![Foreign](/api/document-assets/content?id=${asset.id})`,
      })
    ).body;
    expect((await call("/api/site-builds", "POST", { ...request, id: randomUUID() })).status).toBe(404);
    expect((await call("/api/documents/detail?id=" + others.document.id)).status).toBe(200);
    expect(app.calls().some((entry: { method?: string }) => entry.method === "turn/start")).toBe(false);
  } finally {
    await f.dispose();
  }
}, 40_000);
