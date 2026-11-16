import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { idaasContentFixture, contentFixtureOwner } from "../support/idaas-content-fixture.mjs";

test("authenticated project creators receive durable content access without granting another account", async () => {
  const f = await idaasContentFixture();
  try {
    const alice = await f.login("alice"),
      bob = await f.login("bob");
    const before = await (await f.api(alice, "/api/projects")).json();
    const body = {
      code: "creator-project",
      name: "Creator project",
      revision: before.revision,
      operationId: randomUUID(),
      owner: contentFixtureOwner("bob"),
    };
    const created = await f.api(alice, "/api/projects", body);
    expect(created.status).toBe(201);
    const project = (await created.json()).projects.find((p: { code: string }) => p.code === body.code);
    const tree = await f.api(alice, "/api/project-document-tree?project=" + project.id);
    expect(tree.status).toBe(200);
    expect((await tree.json()).nodes).toEqual([]);
    const capabilities = await f.api(alice, "/api/creative-assets/capabilities?project=" + project.id);
    expect(capabilities.status).toBe(200);
    expect((await capabilities.json()).contribute).toBe(true);
    expect((await f.api(alice, "/api/creative-assets?project=" + project.id)).status).toBe(200);
    const access = await (await f.api(alice, "/api/content-access")).json();
    expect(access.administrator).toBe(false);
    expect(access.projects).toEqual([{ id: project.id, name: body.name, role: "contributor" }]);
    expect((await f.api(alice, "/api/content-access/grants?project=" + project.id)).status).toBe(403);
    for (const path of [
      "/api/project-document-tree?project=",
      "/api/creative-assets/capabilities?project=",
      "/api/creative-assets?project=",
    ])
      expect((await f.api(bob, path + project.id)).status).toBe(404);
    const retry = await f.api(alice, "/api/projects", body);
    expect(retry.status).toBe(201);
    expect((await retry.json()).projects).toHaveLength(1);
    expect((await f.api(bob, "/api/projects", body)).status).toBe(409);
    const current = await (await f.api(alice, "/api/project-document-tree?project=" + project.id)).json();
    const document = await f.api(alice, "/api/project-document-tree/documents", {
      id: randomUUID(),
      projectId: project.id,
      treeVersion: current.version,
      title: "Creator document",
      locale: "en",
      parentId: null,
    });
    expect(document.status).toBe(201);
    const documentId = (await document.json()).operation.documentId;
    const editorPath = "/api/project-documents/editor?" + new URLSearchParams({ project: project.id, id: documentId });
    expect((await f.api(bob, editorPath)).status).toBe(404);
    const admin = await f.login("admin");
    const grants = await (await f.api(admin, "/api/content-access/grants?project=" + project.id)).json();
    const downgraded = await f.api(
      admin,
      "/api/content-access/grants",
      { project: project.id, owner: contentFixtureOwner("alice"), role: "reader", revision: grants.revision },
      "PUT",
    );
    expect(downgraded.status).toBe(200);
    expect((await f.api(alice, editorPath)).status).toBe(200);
    expect((await f.api(alice, "/api/projects", body)).status).toBe(201);
    const readOnly = await (await f.api(alice, "/api/content-access")).json();
    expect(readOnly.projects[0].role).toBe("reader");
    const readOnlyTree = await (await f.api(alice, "/api/project-document-tree?project=" + project.id)).json();
    expect(
      (
        await f.api(alice, "/api/project-document-tree/documents", {
          id: randomUUID(),
          projectId: project.id,
          treeVersion: readOnlyTree.version,
          title: "Denied write",
          locale: "en",
          parentId: null,
        })
      ).status,
    ).toBe(404);
    await f.stop();
    await f.start();
    const restartedAlice = await f.login("alice"),
      restartedBob = await f.login("bob");
    expect((await f.api(restartedAlice, "/api/project-document-tree?project=" + project.id)).status).toBe(200);
    expect((await f.api(restartedBob, "/api/project-document-tree?project=" + project.id)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);
