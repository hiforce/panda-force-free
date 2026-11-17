import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DocumentOwnershipApplication } from "../../src/server/documents/ownership/application.js";
import type { DocumentOwnershipApplicationOptions } from "../../src/server/documents/ownership/application-contracts.js";
import type { DocumentOwnershipTarget } from "../../src/server/documents/ownership/move.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { documentOwnershipSQLFixture } from "../support/document-ownership-sql-fixture.js";

for (const driver of ["files", "sqlite", "mysql"] as const)
  for (const interruption of ["staged", "removed", "activated"] as const)
    test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
      `application admission resumes ${interruption} into ${driver} and resolves the original conversation location without opening writers`,
      async () => {
        const files = await projectFileApiFixture(),
          sql = driver === "files" ? null : await documentOwnershipSQLFixture(driver);
        files.grants.add("personal");
        files.grants.add("project-2");
        try {
          const created = await files.application().navigation.create("owner", {
              id: randomUUID(),
              projectId: "personal",
              treeVersion: 0,
              parentId: null,
              title: "One original document",
              locale: "en",
            }),
            id = created.operation.documentId,
            original = await files.application().queries.detail("personal", id),
            request = {
              owner: "owner",
              operationId: randomUUID(),
              fromProjectId: "personal",
              toProjectId: "project-2",
              parentId: null,
              expected: {
                documentId: id,
                revision: original.document.revision,
                revisionId: original.revision.id,
                contentHash: original.document.contentHash,
              },
            };
          let interrupt = true,
            writes = 0;
          const options: DocumentOwnershipApplicationOptions = {
            root: join(files.assetRoot, "ownership-admissions"),
            authorize: async (owner, scope) => {
              if (owner !== "owner") throw new DocumentError("notFound", 404);
              if (scope.projectId === "personal" || !sql)
                await files.application().projectContent.authorize(scope.projectId);
              else sql.authorize(scope.projectId);
            },
            location: async (_owner, scope, document) =>
              scope.projectId === "personal" || !sql
                ? files.application().transfers.location(scope.projectId, document)
                : sql.feature().transfers.location(scope.projectId, document),
            backend: async (_owner, scope) => {
              writes++;
              const services =
                scope.projectId === "personal" || !sql
                  ? { kind: "files" as const, ...files.application().transfers }
                  : { kind: "sql" as const, ...sql.feature().transfers };
              const target = services.target;
              const checked: DocumentOwnershipTarget = {
                receipt: (...args) => target.receipt(...args),
                stage: async (...args) => {
                  await target.stage(...args);
                  if (interrupt && interruption === "staged") throw Error("Simulated lost connection after staging");
                },
                verify: (...args) => target.verify(...args),
                activate: async (...args) => {
                  if (interrupt && interruption === "removed") throw Error("Simulated lost connection after removal");
                  const receipt = await target.activate(...args);
                  if (interrupt && interruption === "activated")
                    throw Error("Simulated lost activation acknowledgment");
                  return receipt;
                },
              };
              return { ...services, target: checked };
            },
          };
          const application = new DocumentOwnershipApplication(options);
          expect(await application.locate("owner", "personal", id)).toEqual({ projectId: "personal", documentId: id });
          expect(writes).toBe(0);
          await expect(application.execute(request)).rejects.toThrow("Simulated lost");
          await expect(application.prepare({ ...request, toProjectId: "project-3" })).rejects.toMatchObject({
            code: "notFound",
          });
          await expect(application.prepare({ ...request, parentId: randomUUID() })).rejects.toMatchObject({
            code: "conflict",
          });
          files.reopen();
          sql?.reopen();
          interrupt = false;
          const restarted = new DocumentOwnershipApplication(options),
            receipt = await restarted.execute(request);
          expect(receipt).toMatchObject({ projectId: "project-2", documentId: id, revision: 1 });
          expect(await restarted.execute(request)).toEqual(receipt);
          const beforeRead = writes;
          expect(await restarted.locate("owner", "personal", id)).toEqual({ projectId: "project-2", documentId: id });
          expect(writes).toBe(beforeRead);
          expect((await files.application().navigation.tree("personal")).nodes).toHaveLength(0);
          const destination = sql
            ? await sql.feature().navigation.currentFromSource("project-2", id)
            : await files.application().queries.detail("project-2", id);
          expect(destination.revision.id).toBe(original.revision.id);
          if (sql) sql.grants.delete("project-2");
          else files.grants.delete("project-2");
          await expect(restarted.locate("owner", "personal", id)).rejects.toMatchObject({ code: "notFound" });
          await expect(restarted.execute(request)).rejects.toMatchObject({ code: "notFound" });
          await expect(restarted.locate("other", "personal", id)).rejects.toMatchObject({ code: "notFound" });
        } finally {
          await sql?.close();
          await files.close();
        }
      },
      60000,
    );
