import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { documentOwnershipSQLFixture } from "../support/document-ownership-sql-fixture.js";
import { DocumentOwnershipApplication } from "../../src/server/documents/ownership/application.js";
import { authorizedLegacyDocumentRoutes } from "../../src/server/documents/integration/authorized-legacy-routes.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import type { Route } from "../../src/server/http/router.js";

for (const driver of ["sqlite", "mysql"] as const)
  test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `moved ${driver} global document/history/image HTTP endpoints require the actual current project; reader grants cannot save`,
    async () => {
      const sql = await documentOwnershipSQLFixture(driver),
        extra: Route[] = [],
        f = await projectFileApiFixture({ extraRoutes: extra });
      const read = new Set(["project-1"]),
        write = new Set<string>();
      try {
        extra.push(
          ...authorizedLegacyDocumentRoutes(sql.feature().routes, sql.feature(), async (context, project) => {
            if (!(context.req.method === "GET" ? read : write).has(project)) throw new DocumentError("notFound", 404);
          }),
        );
        const created = await f
            .application()
            .navigation.create("operator:test-user", {
              id: randomUUID(),
              projectId: "project-1",
              treeVersion: 0,
              parentId: null,
              title: "Original protected document",
              locale: "en",
            }),
          id = created.operation.documentId,
          image = await f.application().assets.upload(
            "operator:test-user",
            "project-1",
            id,
            "Original.png",
            randomUUID(),
            await sharp({ create: { width: 3, height: 3, channels: 3, background: "#406080" } })
              .png()
              .toBuffer(),
          ),
          original = await f.application().queries.detail("project-1", id),
          imageBytes = (await f.application().assets.content("project-1", image.id)).bytes,
          ownership = new DocumentOwnershipApplication({
            root: join(f.assetRoot, "ownership"),
            authorize: async (_owner, scope) =>
              scope.projectId === "project-2"
                ? sql.authorize(scope.projectId)
                : f.application().projectContent.authorize(scope.projectId),
            backend: async (_owner, scope) =>
              scope.projectId === "project-2"
                ? { kind: "sql", ...sql.services() }
                : { kind: "files", ...f.application().transfers },
            location: async (_owner, scope, doc) =>
              scope.projectId === "project-2"
                ? sql.services().location(scope.projectId, doc)
                : f.application().transfers.location(scope.projectId, doc),
          });
        await ownership.execute({
          owner: "operator:test-user",
          operationId: randomUUID(),
          fromProjectId: "project-1",
          toProjectId: "project-2",
          parentId: null,
          expected: {
            documentId: id,
            revision: 1,
            revisionId: original.revision.id,
            contentHash: original.document.contentHash,
          },
        });
        const current = await sql.feature().navigation.currentFromSource("project-2", id),
          paths = [
            "/api/documents/detail?id=" + id,
            "/api/documents/revisions?id=" + id,
            "/api/documents/revisions?id=" + id + "&revision=" + original.revision.id,
            "/api/document-assets?document=" + id,
            "/api/document-assets/content?id=" + image.id,
            "/api/document-languages?id=" + id,
            "/api/document-spaces/detail?id=" + current.document.spaceId,
            "/api/documents?space=" + current.document.spaceId,
          ];
        for (const path of paths) expect((await f.raw(path)).status).toBe(404);
        read.add("project-2");
        for (const path of paths) expect((await f.raw(path)).status).toBe(200);
        expect(
          new Uint8Array(await (await f.raw("/api/document-assets/content?id=" + image.id)).arrayBuffer()),
        ).toEqual(new Uint8Array(imageBytes));
        expect(
          (
            await f.call("/api/documents/detail?id=" + id, "PUT", {
              revision: 1,
              title: "Unauthorized edit",
              locale: "en",
              content: "Should not be saved",
            })
          ).status,
        ).toBe(404);
        expect((await sql.feature().service.detail(id)).document.revision).toBe(1);
        read.delete("project-2");
        for (const path of paths) expect((await f.raw(path)).status).toBe(404);
      } finally {
        await f.close();
        await sql.close();
      }
    },
    60000,
  );
