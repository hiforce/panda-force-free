import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ownershipSQLInsert } from "../../src/server/documents/ownership/sql-batch.js";
import { stableJson } from "../../src/shared/stable-json.js";
import { DocumentOwnershipMove } from "../../src/server/documents/ownership/move.js";
import { freezeOwnershipPlan } from "../../src/server/documents/ownership/plan.js";
import { FileDocumentOwnershipSource } from "../../src/server/documents/ownership/file-source.js";
import { FileDocumentOwnershipRemoval } from "../../src/server/documents/ownership/file-source-removal.js";
import { FileDocumentOwnershipTarget } from "../../src/server/documents/ownership/file-target.js";
import { richDocumentFromMarkdown, richDocumentInput } from "../../src/server/documents/rich-codec.js";
import { documentOwnershipSQLFixture } from "../support/document-ownership-sql-fixture.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

for (const driver of ["sqlite", "mysql"] as const) {
  const run = test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE);
  run(
    `${driver} ownership transfer moves the original subtree, every revision and original image; return and old replay keep later edits`,
    async () => {
      const f = await documentOwnershipSQLFixture(driver);
      try {
        const app = f.feature(),
          root = await app.navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Original",
            locale: "en",
          }),
          id = root.operation.documentId;
        const child = await app.navigation.create("owner", {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: root.tree.version,
          parentId: id,
          title: "Child",
          locale: "en",
        });
        const bytes = await sharp({ create: { width: 3, height: 4, channels: 3, background: "#408080" } })
            .png()
            .toBuffer(),
          image = await app.assets.upload(id, "Original.png", bytes);
        for (let version = 1; version < 121; version++)
          await app.service.saveDocument(id, {
            revision: version,
            title: "Original",
            locale: "en",
            body: richDocumentFromMarkdown("Historical " + version),
          });
        const s = f.services(),
          snapshot = await s.source.capture("project-1", id),
          inventory = s.source.inventory(snapshot),
          plan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            inventory,
          ),
          move = new DocumentOwnershipMove(s.source, s.removal, s.target, async (_owner, scope) =>
            f.authorize(scope.projectId),
          );
        expect(inventory.revisions.filter((row) => row.documentId === id)).toHaveLength(121);
        const receipt = await move.execute(plan, snapshot);
        expect(receipt).toMatchObject({ documentId: id, projectId: "project-2", revision: 121 });
        expect((await app.navigation.tree("project-1")).nodes).toHaveLength(0);
        expect((await app.navigation.trashPage("project-1")).documents).toHaveLength(0);
        const moved = await app.navigation.currentFromSource("project-2", id);
        expect(moved.document.id).toBe(id);
        expect(moved.revision.id).toBe(
          snapshot.inventory.nodes.find((row) => row.documentId === id)!.document.revisionId,
        );
        expect(
          (await app.navigation.tree("project-2")).nodes.find((row) => row.documentId === child.operation.documentId)!
            .parentId,
        ).toBe(id);
        expect((await app.assets.content(image.id)).bytes).toEqual(bytes);
        await app.service.saveDocument(id, {
          revision: 121,
          title: "Later title",
          locale: "en",
          body: richDocumentFromMarkdown("Later body"),
        });
        f.reopen();
        const restarted = f.services(),
          again = new DocumentOwnershipMove(
            restarted.source,
            restarted.removal,
            restarted.target,
            async (_owner, scope) => f.authorize(scope.projectId),
          );
        expect(await again.execute(plan, snapshot)).toEqual(receipt);
        const back = await restarted.source.capture("project-2", id),
          backPlan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-2" },
            { projectId: "project-1" },
            null,
            restarted.source.inventory(back),
          );
        await again.execute(backPlan, back);
        expect((await f.feature().navigation.tree("project-2")).nodes).toHaveLength(0);
        expect((await f.feature().navigation.currentFromSource("project-1", id)).revision.title).toBe("Later title");
        expect(await again.execute(plan, snapshot)).toEqual(receipt);
        expect((await f.feature().assets.content(image.id)).bytes).toEqual(bytes);
      } finally {
        await f.close();
      }
    },
    60000,
  );
  run(
    `${driver} and native ownership adapters preserve identity, rich source and images across three moves`,
    async () => {
      const sql = await documentOwnershipSQLFixture(driver),
        native = await projectFileApiFixture();
      try {
        const app = native.application(),
          created = await app.navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Native original",
            locale: "en",
          }),
          id = created.operation.documentId,
          bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#408080" } })
            .png()
            .toBuffer(),
          imageId = randomUUID();
        await app.assets.upload("owner", "project-1", id, "Native original.png", imageId, bytes);
        const saved = await app.queries.detail("project-1", id),
          originals = [saved.revision];
        let fileSource = new FileDocumentOwnershipSource(app.projectContent, native.assetRoot),
          fileRemove = new FileDocumentOwnershipRemoval(app.projectContent),
          fileTarget = new FileDocumentOwnershipTarget(app.projectContent, native.assetRoot),
          s = sql.services();
        const snapshot = await fileSource.capture("project-1", id),
          plan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            fileSource.inventory(snapshot),
          );
        const first = await new DocumentOwnershipMove(fileSource, fileRemove, s.target, async () => {}).execute(
          plan,
          snapshot,
        );
        expect(first.documentId).toBe(id);
        expect((await sql.feature().assets.content(imageId)).bytes).toEqual(bytes);
        const body = richDocumentFromMarkdown("Second version");
        body.document.content!.push({ type: "image", attrs: { src: "/api/document-assets/content?id=" + imageId } });
        const resource = {
          source: "images/original.png",
          sourcePath: "assets/original.png",
          assetId: imageId,
          digest: (await sql.feature().assets.content(imageId)).asset.digest,
        };
        await sql.feature().service.documents.save(
          id,
          1,
          {
            title: "Same document",
            locale: "en",
            body,
            content: richDocumentInput(body).content,
          },
          undefined,
          [resource],
        );
        const second = await s.source.capture("project-2", id),
          back = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-2" },
            { projectId: "project-1" },
            null,
            s.source.inventory(second),
          );
        await new DocumentOwnershipMove(s.source, s.removal, fileTarget, async () => {}).execute(back, second);
        expect((await app.queries.detail("project-1", id)).revision.title).toBe("Same document");
        expect((await app.queries.detail("project-1", id)).revision.resources).toEqual([resource]);
        expect((await app.assets.content("project-1", imageId)).bytes).toEqual(bytes);
        expect(await app.queries.revisions("project-1", id)).toHaveLength(2);
        expect((await app.queries.revision("project-1", id, originals[0]!.id)).id).toBe(originals[0]!.id);
        const third = await fileSource.capture("project-1", id),
          thirdPlan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            fileSource.inventory(third),
          );
        await new DocumentOwnershipMove(fileSource, fileRemove, s.target, async () => {}).execute(thirdPlan, third);
        expect((await sql.feature().navigation.currentFromSource("project-2", id)).document.revision).toBe(2);
        expect((await sql.feature().navigation.currentFromSource("project-2", id)).revision.resources).toEqual([
          resource,
        ]);
        expect((await sql.feature().assets.content(imageId)).bytes).toEqual(bytes);
        expect(
          await new DocumentOwnershipMove(fileSource, fileRemove, s.target, async () => {}).execute(plan, snapshot),
        ).toEqual(first);
        expect((await app.navigation.tree("project-1")).nodes).toHaveLength(0);
      } finally {
        await sql.close();
        await native.close();
      }
    },
    60000,
  );
  run(
    `${driver} source edits stop a transfer before removal and leave the new source active`,
    async () => {
      const f = await documentOwnershipSQLFixture(driver);
      try {
        const created = await f.feature().navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Original",
            locale: "en",
          }),
          id = created.operation.documentId,
          s = f.services(),
          snapshot = await s.source.capture("project-1", id),
          plan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            s.source.inventory(snapshot),
          );
        await expect(
          new DocumentOwnershipMove(
            s.source,
            s.removal,
            s.target,
            async (_owner, scope) => f.authorize(scope.projectId),
            async (step) => {
              if (step === "staged")
                await f.feature().service.saveDocument(id, {
                  revision: 1,
                  title: "Concurrent title",
                  locale: "en",
                  body: richDocumentFromMarkdown("New source body"),
                });
            },
          ).execute(plan, snapshot),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await f.feature().navigation.currentFromSource("project-1", id)).revision.title).toBe(
          "Concurrent title",
        );
        expect((await f.feature().navigation.tree("project-2")).nodes).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
    60000,
  );
  run(
    `${driver} activation rollback preserves immutable originals and resumes without a partial target`,
    async () => {
      const f = await documentOwnershipSQLFixture(driver);
      try {
        const created = await f.feature().navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Original",
            locale: "en",
          }),
          id = created.operation.documentId,
          s = f.services(),
          snapshot = await s.source.capture("project-1", id),
          plan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            s.source.inventory(snapshot),
          ),
          commit = s.batch.commit;
        s.batch.commit = async (checks, changes) => {
          if (
            changes.some(
              (row) =>
                row.sql.includes("document_tree_operations") && String(row.values[0]).startsWith("ownership-activate-"),
            )
          ) {
            const operation = changes.find((row) => row.sql.includes("document_tree_operations"))!;
            return commit(checks, [...changes, operation]);
          }
          return commit(checks, changes);
        };
        await expect(
          new DocumentOwnershipMove(s.source, s.removal, s.target, async () => {}).execute(plan, snapshot),
        ).rejects.toBeDefined();
        expect((await f.feature().navigation.tree("project-1")).nodes).toHaveLength(0);
        expect((await f.feature().navigation.tree("project-2")).nodes).toHaveLength(0);
        expect((await f.feature().service.documents.record(id)).spaceId).toBe(
          snapshot.inventory.nodes[0]!.document.spaceId,
        );
        expect(
          (await f.feature().service.documents.revision(id, snapshot.inventory.nodes[0]!.document.revisionId)).title,
        ).toBe("Original");
        s.batch.commit = commit;
        const restarted = f.services();
        await new DocumentOwnershipMove(restarted.source, restarted.removal, restarted.target, async () => {}).execute(
          plan,
          snapshot,
        );
        expect((await f.feature().navigation.currentFromSource("project-2", id)).document.id).toBe(id);
      } finally {
        await f.close();
      }
    },
    60000,
  );
  for (const phase of ["staged", "removed"] as const)
    run(
      `${driver} target permission revoked after ${phase} prevents activation and resumes after access returns`,
      async () => {
        const f = await documentOwnershipSQLFixture(driver);
        try {
          const created = await f.feature().navigation.create("owner", {
              id: randomUUID(),
              projectId: "project-1",
              treeVersion: 0,
              parentId: null,
              title: "Original",
              locale: "en",
            }),
            id = created.operation.documentId,
            s = f.services(),
            snapshot = await s.source.capture("project-1", id),
            plan = freezeOwnershipPlan(
              "owner",
              randomUUID(),
              { projectId: "project-1" },
              { projectId: "project-2" },
              null,
              s.source.inventory(snapshot),
            );
          await expect(
            new DocumentOwnershipMove(
              s.source,
              s.removal,
              s.target,
              async (_owner, scope) => f.authorize(scope.projectId),
              async (step) => {
                if (step === phase) f.grants.delete("project-2");
              },
            ).execute(plan, snapshot),
          ).rejects.toMatchObject({ code: "notFound" });
          f.grants.add("project-2");
          expect((await f.feature().navigation.tree("project-2")).nodes).toHaveLength(0);
          const fresh = f.services();
          await new DocumentOwnershipMove(fresh.source, fresh.removal, fresh.target, async (_owner, scope) =>
            f.authorize(scope.projectId),
          ).execute(plan, snapshot);
          expect((await f.feature().navigation.currentFromSource("project-2", id)).document.id).toBe(id);
        } finally {
          await f.close();
        }
      },
      60000,
    );
  run(
    `${driver} refuses an unknown target document even when its identity and body match the original`,
    async () => {
      const f = await documentOwnershipSQLFixture(driver),
        native = await projectFileApiFixture();
      try {
        const app = native.application(),
          created = await app.navigation.create("owner", {
            id: randomUUID(),
            projectId: "project-1",
            treeVersion: 0,
            parentId: null,
            title: "Same title",
            locale: "en",
          }),
          id = created.operation.documentId,
          original = await app.queries.detail("project-1", id),
          s = f.services(),
          space = await f.feature().library.ensure("project-2", "en"),
          document = { ...original.document, spaceId: space.id },
          { body, resources: _resources, ...revision } = original.revision;
        await s.batch.commit(
          [],
          [
            ownershipSQLInsert(s.batch, "documents", {
              ...document,
              ...(s.batch.mysql
                ? { pathHash: new Bun.CryptoHasher("sha256").update(document.path).digest("hex") }
                : {}),
            }),
            ownershipSQLInsert(s.batch, "document_revisions", { ...revision }),
            ...(body
              ? [
                  ownershipSQLInsert(s.batch, "document_rich_revisions", {
                    revisionId: revision.id,
                    body: stableJson(body),
                  }),
                ]
              : []),
          ],
        );
        await f.feature().navigation.tree("project-2");
        const source = new FileDocumentOwnershipSource(app.projectContent, native.assetRoot),
          snapshot = await source.capture("project-1", id),
          plan = freezeOwnershipPlan(
            "owner",
            randomUUID(),
            { projectId: "project-1" },
            { projectId: "project-2" },
            null,
            source.inventory(snapshot),
          );
        await expect(
          new DocumentOwnershipMove(
            source,
            new FileDocumentOwnershipRemoval(app.projectContent),
            s.target,
            async () => {},
          ).execute(plan, snapshot),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await app.queries.detail("project-1", id)).revision.id).toBe(original.revision.id);
        expect((await f.feature().navigation.currentFromSource("project-2", id)).revision.id).toBe(
          original.revision.id,
        );
        expect(await f.feature().ownership.forDocument(id)).toBeNull();
      } finally {
        await f.close();
        await native.close();
      }
    },
    60000,
  );
  for (const phase of ["staged", "removed", "activated"] as const)
    run(
      `${driver} ownership resumes after ${phase} with fresh adapters and no second active placement`,
      async () => {
        const f = await documentOwnershipSQLFixture(driver);
        try {
          const created = await f.feature().navigation.create("owner", {
              id: randomUUID(),
              projectId: "project-1",
              treeVersion: 0,
              parentId: null,
              title: "Resume",
              locale: "en",
            }),
            id = created.operation.documentId,
            s = f.services(),
            snapshot = await s.source.capture("project-1", id),
            plan = freezeOwnershipPlan(
              "owner",
              randomUUID(),
              { projectId: "project-1" },
              { projectId: "project-2" },
              null,
              s.source.inventory(snapshot),
            );
          await expect(
            new DocumentOwnershipMove(
              s.source,
              s.removal,
              s.target,
              async () => {},
              async (step) => {
                if (step === phase) throw Error("Lost acknowledgment");
              },
            ).execute(plan, snapshot),
          ).rejects.toThrow("Lost acknowledgment");
          const active =
            (await f.feature().navigation.tree("project-1")).nodes.length +
            (await f.feature().navigation.tree("project-2")).nodes.length;
          expect(active).toBeLessThanOrEqual(1);
          f.reopen();
          const next = f.services();
          const result = await new DocumentOwnershipMove(
            next.source,
            next.removal,
            next.target,
            async () => {},
          ).execute(plan, snapshot);
          expect(result.documentId).toBe(id);
          expect((await f.feature().navigation.tree("project-1")).nodes).toHaveLength(0);
          expect((await f.feature().navigation.tree("project-2")).nodes).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
      60000,
    );
}
