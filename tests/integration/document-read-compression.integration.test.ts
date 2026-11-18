import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";
import { authorizedLegacyDocumentRoutes } from "../../src/server/documents/integration/authorized-legacy-routes.js";
import type { Route } from "../../src/server/http/router.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { documentOwnershipSQLFixture } from "../support/document-ownership-sql-fixture.js";

const body = emptyRichBody();
body.document.content = Array.from({ length: 100 }, (_, index) => ({
  type: "paragraph",
  content: [{ type: "text", text: `${index}: Document 中文 香港 臺灣 🙂 ` + "Editable content. ".repeat(25) }],
}));

async function equivalentRead(f: Awaited<ReturnType<typeof projectFileApiFixture>>, path: string) {
  const plain = await f.raw(path, "GET", undefined, { "accept-encoding": "identity" }),
    original = await plain.json(),
    compressed = await f.raw(path, "GET", undefined, { "accept-encoding": "gzip" });
  expect(plain.status).toBe(200);
  expect(compressed.status).toBe(200);
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(compressed.headers.get("content-encoding")).toBe("gzip");
  expect(compressed.headers.get("cache-control")).toBe("no-store");
  expect(compressed.headers.get("vary")).toContain("Accept-Encoding");
  expect(Number(compressed.headers.get("content-length"))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(original)) / 2,
  );
  expect(await compressed.json()).toEqual(original);
  const refused = await f.raw(path, "GET", undefined, { "accept-encoding": "gzip;q=0, *;q=1" });
  expect(refused.headers.get("content-encoding")).toBeNull();
  expect(await refused.json()).toEqual(original);
  return original;
}

test("file document reads compress complete working copies and trees without advancing versions or grants", async () => {
  const f = await projectFileApiFixture();
  try {
    let tree = await f.application().navigation.tree("project-1");
    for (let index = 0; index < 4; index++) {
      const created = await f.application().navigation.create("operator:test-user", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: tree.version,
        title: `Document ${index} 中文 香港 臺灣`,
        locale: "en",
      });
      tree = created.tree;
    }
    const path = "/api/project-documents/editor?project=project-1&id=doc-1";
    expect(
      (
        await f.call(path, "PUT", {
          operationId: randomUUID(),
          version: 0,
          baseRevisionId: f.detail.revision.id,
          working: { title: "Complete working document", locale: "en", content: "", resources: [], body },
        })
      ).status,
    ).toBe(200);
    const head = await f.snapshots.head(),
      snapshot = await equivalentRead(f, path);
    expect(snapshot.working.body).toEqual(body);
    expect(snapshot.draft).toMatchObject({ version: 1, dirty: true, stale: false });
    expect(await equivalentRead(f, "/api/project-document-tree?project=project-1")).toEqual(tree);
    expect(await f.snapshots.head()).toBe(head);
    f.grants.delete("project-1");
    const denied = await f.raw(path, "GET", undefined, { "accept-encoding": "gzip" });
    expect(denied.status).toBe(404);
    expect(await denied.json()).not.toHaveProperty("working");
  } finally {
    await f.close();
  }
}, 30000);

for (const driver of ["sqlite", "mysql"] as const)
  test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${driver} document reads compress exact rich sources and retain current project authorization`,
    async () => {
      const sql = await documentOwnershipSQLFixture(driver),
        extra: Route[] = [],
        f = await projectFileApiFixture({ extraRoutes: extra });
      try {
        extra.push(
          ...authorizedLegacyDocumentRoutes(sql.feature().routes, sql.feature(), async (_context, project) => {
            sql.authorize(project);
          }),
        );
        const created = await sql.feature().navigation.create("operator:test-user", {
            id: randomUUID(),
            projectId: "project-2",
            treeVersion: 0,
            title: "Protected document",
            locale: "en",
          }),
          id = created.operation.documentId,
          detail = await sql.feature().service.saveDocument(id, {
            revision: 1,
            title: "Protected document",
            locale: "en",
            content: "",
            body,
          }),
          path = "/api/documents/detail?id=" + id;
        expect(await equivalentRead(f, path)).toEqual(detail);
        expect((await sql.feature().service.detail(id)).document.revision).toBe(2);
        sql.grants.delete("project-2");
        const denied = await f.raw(path, "GET", undefined, { "accept-encoding": "gzip" });
        expect(denied.status).toBe(404);
        expect(await denied.json()).not.toHaveProperty("revision");
      } finally {
        await f.close();
        await sql.close();
      }
    },
    30000,
  );
