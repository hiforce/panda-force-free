import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

test("file website publishing survives application restart and deleted builds without changing saved source identity", async () => {
  const fixture = await createSiteBuildFixture(),
    app = fixture.app;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(app.base + path, {
      method,
      headers: { ...app.headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await call("/api/auth/setup", "POST", { username: "file-publisher" })).status).toBe(200);
    const catalogState = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", {
        code: "file-publisher",
        name: "Disposable file publishing",
        revision: catalogState.revision,
      })
    ).body.projects[0];
    const catalogPath = join(app.dir, "panda-state/data/projects.sqlite"),
      catalog = new ProjectCatalog(catalogPath);
    try {
      new ProjectDocumentStorage(catalog.db).bindFiles(project.id);
    } finally {
      catalog.close();
    }
    const created = await call("/api/project-document-tree/documents", "POST", {
      id: randomUUID(),
      projectId: project.id,
      treeVersion: 0,
      parentId: null,
      title: "Saved original",
      locale: "en",
    });
    expect(created.status).toBe(201);
    const documentId = created.body.operation.documentId,
      query = new URLSearchParams({ project: project.id, id: documentId }),
      opened = (await call("/api/project-documents/editor?" + query)).body;
    const drafted = await call("/api/project-documents/editor?" + query, "PUT", {
      operationId: randomUUID(),
      version: opened.draft.version,
      baseRevisionId: opened.draft.baseRevisionId,
      working: {
        ...opened.working,
        body: {
          schema: 1,
          format: "richtext",
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Saved canonical publication." }] }],
          },
        },
      },
    });
    expect(drafted.status).toBe(200);
    const checkpoint = (
      await call("/api/project-documents/checkpoints?" + query, "POST", {
        operationId: randomUUID(),
        revisionId: opened.saved.revision.id,
        draftVersion: drafted.body.receipt.version,
      })
    ).body.detail;
    const configured = await call("/api/project-document-spaces", "POST", {
      operationId: randomUUID(),
      projectId: project.id,
      code: "site",
      name: "File website",
      engine: "hexo",
      sourceMode: "managed",
      locale: "en",
      theme: "default",
    });
    expect(configured.status).toBe(201);
    const space = configured.body.space;
    expect(
      (
        await call("/api/project-document-placements?project=" + project.id, "POST", {
          operationId: randomUUID(),
          id: randomUUID(),
          documentId,
          spaceId: space.id,
          spaceVersion: space.version,
          path: "posts/original.md",
          locale: "en",
          revisionId: checkpoint.revision.id,
          metadata: {},
        })
      ).status,
    ).toBe(201);
    const buildId = randomUUID();
    expect(
      (
        await call("/api/site-builds", "POST", {
          id: buildId,
          projectId: project.id,
          spaceId: space.id,
          engine: "hexo",
          title: "Saved original",
          locale: "en",
          url: "https://example.test",
          basePath: "/",
        })
      ).status,
    ).toBe(202);
    const build = await waitFor(async () => {
      const record = (await call("/api/site-builds/detail?id=" + buildId)).body.build;
      return record.phase === "completed" ? record : false;
    });
    const input = fixture.inputs.get(buildId)!;
    expect(input.documents[0].content).toContain("Saved canonical publication");
    expect(build.sources[0].revisionId).toBe(checkpoint.revision.id);
    expect(build.sourceSnapshot.commit).toMatch(/^[a-f0-9]{40}$/);
    const roots = (await call("/api/publication-connections/roots")).body.roots,
      connection = (
        await call("/api/publication-connections", "POST", {
          id: randomUUID(),
          projectId: project.id,
          connector: "local-site",
          root: roots[0].id,
          directory: "file-site",
          name: "Disposable destination",
          publicUrl: "https://example.test/",
        })
      ).body.connection;
    const request = {
      id: randomUUID(),
      projectId: project.id,
      buildId,
      connectionId: connection.id,
      connectionVersion: connection.version,
    };
    expect((await call("/api/site-publications", "POST", { ...request, projectId: randomUUID() })).status).toBe(404);
    const prepared = await call("/api/site-publications", "POST", request);
    expect(prepared.status).toBe(201);
    const plan = prepared.body.publication.plan;
    expect(plan.sourceProjectId).toBe(project.id);
    expect(plan.build.sourceSnapshot).toEqual(build.sourceSnapshot);
    expect(plan.build.sources).toEqual(build.sources);
    expect(await readdir(roots[0].path)).toEqual([]);
    expect((await call("/api/site-publications?space=" + space.id)).status).toBe(404);
    const latest = (await call("/api/project-documents/editor?" + query)).body;
    expect(
      (
        await call("/api/project-documents/editor?" + query, "PUT", {
          operationId: randomUUID(),
          version: latest.draft.version,
          baseRevisionId: latest.draft.baseRevisionId,
          working: { ...latest.working, title: "Unpublished newer draft" },
        })
      ).status,
    ).toBe(200);
    expect((await call("/api/site-builds/detail?id=" + buildId, "DELETE")).status).toBe(200);
    await app.stop();
    await app.start();
    expect((await call("/api/site-builds/detail?id=" + buildId)).status).toBe(404);
    expect((await call("/api/site-publications/detail?id=" + plan.id)).body.publication.plan).toEqual(plan);
    expect((await call("/api/site-publications", "POST", request)).body.publication.plan).toEqual(plan);
    expect(
      (await call("/api/site-publications/publish", "POST", { id: plan.id, fingerprint: "0".repeat(64) })).status,
    ).toBe(409);
    expect(
      (await call("/api/site-publications/publish", "POST", { id: plan.id, fingerprint: plan.fingerprint })).status,
    ).toBe(202);
    const published = await waitFor(async () => {
      const record = (await call("/api/site-publications/detail?id=" + plan.id)).body.publication;
      return record.job.phase === "published" ? record : false;
    });
    expect(published.plan).toEqual(plan);
    expect(await readFile(join(roots[0].path, "file-site/current/index.html"), "utf8")).toContain("Fixture website");
    expect(await readdir(join(roots[0].path, "file-site/releases"))).toEqual([plan.id]);
    expect((await call("/api/project-documents/editor?" + query)).body.working.title).toBe("Unpublished newer draft");
    expect(
      (
        await call("/api/publication-connections/detail?id=" + connection.id, "PUT", {
          version: connection.version,
          name: connection.name,
          publicUrl: connection.publicUrl,
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/site-publications/publish", "POST", { id: plan.id, fingerprint: plan.fingerprint })).body
        .publication.job.receipt,
    ).toEqual(published.job.receipt);
    const historyQuery = new URLSearchParams({ project: project.id, space: space.id });
    expect((await call("/api/site-publications?" + historyQuery)).body.publications).toHaveLength(1);
    const reopened = new ProjectCatalog(catalogPath);
    try {
      reopened.db.query("DELETE FROM project_document_storage WHERE project_id=?").run(project.id);
    } finally {
      reopened.close();
    }
    expect((await call("/api/site-publications/detail?id=" + plan.id)).status).toBe(404);
    expect((await call("/api/site-publications?" + historyQuery)).status).toBe(404);
  } finally {
    await fixture.dispose();
  }
}, 30000);
