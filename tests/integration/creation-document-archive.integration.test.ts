import { creationDocumentArtifact } from "../../src/shared/creation/contracts.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { creationAppFixture } from "../support/creation-app.js";
import { documentOwnershipSQLFixture } from "../support/document-ownership-sql-fixture.js";
import { DocumentOwnershipApplication } from "../../src/server/documents/ownership/application.js";
import { ownershipCreationDocuments } from "../../src/server/creation/integration/ownership-documents.js";
import { creationDocumentArchive } from "../../src/server/creation/integration/document-archive.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import {
  projectCreationDocuments,
  creationDocumentImages,
} from "../../src/server/creation/integration/document-port.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { DocumentError } from "../../src/server/documents/errors.js";

for (const driver of ["files", "sqlite", "mysql"] as const)
  test.skipIf(driver === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `the actual creation tool archives its original into ${driver}; a restarted conversation edits the same document in its new project`,
    async () => {
      const sql = driver === "files" ? null : await documentOwnershipSQLFixture(driver);
      const f = await creationAppFixture({
        content(files, root) {
          files.grants.add("project-2");
          const ownership = new DocumentOwnershipApplication({
            root: join(root, "ownership"),
            authorize: async (owner, scope) => {
              if (owner !== "operator:test-user") throw new DocumentError("notFound", 404);
              if (sql && scope.projectId === "project-2") sql.authorize(scope.projectId);
              else await files.application().projectContent.authorize(scope.projectId);
            },
            backend: async (_owner, scope) =>
              scope.projectId === "project-2" && sql
                ? { kind: "sql", ...sql.services() }
                : { kind: "files", ...files.application().transfers },
            location: async (_owner, scope, document) =>
              scope.projectId === "project-2" && sql
                ? sql.services().location(scope.projectId, document)
                : files.application().transfers.location(scope.projectId, document),
          });
          const home = creationFileDocuments(files.application()),
            raw = sql
              ? projectCreationDocuments(
                  (project) => project !== "project-2",
                  {
                    ...home,
                    images: creationDocumentImages(
                      async (_owner, project) =>
                        project === "project-2"
                          ? { content: async (_project, id) => sql.feature().assets.content(id) }
                          : files.application().assets,
                      async (_owner, project) =>
                        project === "project-2"
                          ? sql.authorize(project)
                          : files.application().projectContent.authorize(project),
                    ),
                  },
                  sql.feature().navigation,
                  async (_owner, project) =>
                    project === "project-2"
                      ? sql.authorize(project)
                      : files.application().projectContent.authorize(project),
                )
              : home,
            documents = async () => raw;
          return {
            documents: ownershipCreationDocuments(home, ownership, documents),
            archive: creationDocumentArchive(ownership, documents),
            destinations: async () => ({
              projects: [{ id: "project-2", name: "Archive project" }],
              personalProjectId: "personal",
              nextOffset: null,
            }),
          };
        },
      });
      try {
        f.onRun(async (input, callbacks, scope) => {
          expect(input.tools.some((tool) => tool.name === "panda_documents_destinations")).toBe(true);
          const destinations = await callbacks.call({
            ...scope,
            callId: randomUUID(),
            name: "panda_documents_destinations",
            arguments: { search: "Archive" },
          });
          expect(JSON.parse(destinations.text).projects[0].id).toBe("project-2");
          await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
          const saved = await callbacks.call({
            ...scope,
            callId: randomUUID(),
            name: "panda_documents_create",
            arguments: {
              title: "Original archived document",
              body: richDocumentFromMarkdown("Preserve this original section."),
              archiveTo: { projectId: "project-2" },
            },
          });
          expect(saved.success).toBe(true);
        });
        const first = await f.create("Write this document and archive it into Archive project"),
          saved = await f.until(first.request.id, (task) => task.state === "succeeded" || Boolean(task.failure));
        expect(saved.failure).toBeNull();
        expect(creationDocumentArtifact(saved.artifact)?.location).toMatchObject({
          projectId: "project-2",
          revision: 1,
        });
        const id = creationDocumentArtifact(saved.artifact)!.documentId,
          filename = creationDocumentArtifact(saved.artifact)!.file!.path;
        expect(saved.document).toMatchObject({ documentId: id, projectId: "project-2" });
        expect(saved.documentStatus).toBe("available");
        expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
        expect(await readFile(filename, "utf8")).toContain("Preserve this original section");
        const original = sql
          ? await sql.feature().navigation.currentFromSource("project-2", id)
          : await f.files.application().queries.detail("project-2", id);
        const pixels = await sharp({ create: { width: 3, height: 3, channels: 3, background: "#408080" } })
            .png()
            .toBuffer(),
          image = sql
            ? await sql.feature().assets.upload(id, "Original.png", pixels)
            : await f.files
                .application()
                .assets.upload("operator:test-user", "project-2", id, "Original.png", randomUUID(), pixels),
          imageBytes = sql
            ? (await sql.feature().assets.content(image.id)).bytes
            : (await f.files.application().assets.content("project-2", image.id)).bytes,
          illustrated = richDocumentFromMarkdown("Preserve this original section.");
        illustrated.document.content!.push({
          type: "image",
          attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "Original diagram", title: "" },
        });
        if (sql)
          await sql.feature().service.saveDocument(id, {
            revision: 1,
            title: "Original archived document",
            locale: "en",
            body: illustrated,
          });
        else {
          const app = f.files.application(),
            opened = await app.queries.editor("project-2", id);
          await app.editor.autosave("operator:test-user", "project-2", id, {
            operationId: randomUUID(),
            version: opened.draft.version,
            baseRevisionId: opened.saved.revision.id,
            working: {
              title: "Original archived document",
              locale: "en",
              content: "",
              resources: [],
              body: illustrated,
            },
          });
          const draft = await app.queries.editor("project-2", id);
          await app.editor.save("operator:test-user", "project-2", id, {
            operationId: randomUUID(),
            draftVersion: draft.draft.version,
            revisionId: draft.saved.revision.id,
          });
        }
        await f.restart();
        expect((await f.task(saved.id)).document).toMatchObject({ projectId: "project-2", documentId: id });
        f.onRun(async (input, callbacks, scope) => {
          expect(input.prompt).toContain("Preserve this original section");
          expect(input.prompt).toContain(image.id);
          const revised = structuredClone(illustrated);
          revised.document.content!.push(...richDocumentFromMarkdown("New acceptance criteria.").document.content!);
          await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
          const result = await callbacks.call({
            ...scope,
            callId: randomUUID(),
            name: "panda_documents_create",
            arguments: {
              title: "Model rename must not replace the title",
              body: revised,
            },
          });
          expect(result.success).toBe(true);
        });
        const next = { taskId: saved.id, id: randomUUID(), prompt: "Add acceptance criteria to this same document." };
        const response = await f.files.call("/api/document-creations/follow-up", "POST", next);
        expect(response.status).toBe(202);
        const updated = await f.until(next.id, (task) => task.state === "succeeded" || Boolean(task.failure));
        expect(updated.failure).toBeNull();
        expect(updated.projectId).toBe("project-1");
        expect(updated.artifact).toMatchObject({
          projectId: "project-2",
          documentId: id,
          revision: 3,
          title: "Original archived document",
          file: { path: filename },
        });
        expect(updated.document).toMatchObject({ projectId: "project-2", documentId: id, revision: 3 });
        const current = sql
          ? await sql.feature().navigation.currentFromSource("project-2", id)
          : await f.files.application().queries.detail("project-2", id);
        expect(current.revision.content).toContain("New acceptance criteria");
        const historical = sql
          ? await sql.feature().service.documents.revision(id, original.revision.id)
          : await f.files.application().queries.revision("project-2", id, original.revision.id);
        expect(historical).toEqual(original.revision);
        const markdown = await readFile(filename, "utf8");
        expect(markdown).toContain("New acceptance criteria");
        const relative = markdown.match(/\]\((creation-assets-[a-f0-9-]+\/[a-f0-9]+\.png)\)/)?.[1];
        expect(relative).toBeTruthy();
        expect(new Uint8Array(await readFile(join(dirname(filename), relative!)))).toEqual(new Uint8Array(imageBytes));
        expect(JSON.stringify(current.revision.body)).toContain(image.id);
        expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
        if (sql) sql.grants.delete("project-2");
        else f.files.grants.delete("project-2");
        const inaccessible = await f.task(saved.id);
        expect(inaccessible.documentStatus).toBe("unavailable");
        expect(
          (
            await f.files.call("/api/document-creations/follow-up", "POST", {
              taskId: updated.id,
              id: randomUUID(),
              prompt: "Another edit",
            })
          ).status,
        ).toBe(404);
      } finally {
        await f.close();
        await sql?.close();
      }
    },
    60000,
  );
