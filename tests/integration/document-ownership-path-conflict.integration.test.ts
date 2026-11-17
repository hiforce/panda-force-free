import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DocumentOwnershipMove } from "../../src/server/documents/ownership/move.js";
import { freezeOwnershipPlan } from "../../src/server/documents/ownership/plan.js";
import { documentOwnershipSQLFixture } from "../support/document-ownership-sql-fixture.js";

for (const driver of ["sqlite", "mysql"] as const)
  test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${driver} detects an occupied archive path before removing the active source`,
    async () => {
      const f = await documentOwnershipSQLFixture(driver);
      try {
        const app = f.feature(),
          created = await app.navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Original",
            locale: "en",
          }),
          id = created.operation.documentId,
          original = await app.navigation.currentFromSource("project-1", id),
          target = await app.library.ensure("project-2", "en"),
          occupied = await app.service.createDocument({
            spaceId: target.id,
            path: id + ".md",
            title: "Keep this independent document",
            locale: "en",
            content: "An existing unrelated file",
          }),
          transfers = f.services(),
          snapshot = await transfers.source.capture("project-1", id),
          plan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            transfers.source.inventory(snapshot),
          );
        await expect(
          new DocumentOwnershipMove(transfers.source, transfers.removal, transfers.target, async (_owner, scope) =>
            f.authorize(scope.projectId),
          ).execute(plan, snapshot),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await app.navigation.tree("project-1")).nodes.some((node) => node.documentId === id)).toBe(true);
        expect(await app.navigation.currentFromSource("project-1", id)).toEqual(original);
        expect((await app.service.detail(occupied.document.id)).revision.content).toBe("An existing unrelated file");
      } finally {
        await f.close();
      }
    },
    60000,
  );
