import { creationDocumentArtifact } from "../../src/shared/creation/contracts.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DocumentOwnershipApplication } from "../../src/server/documents/ownership/application.js";
import { creationDocumentArchive } from "../../src/server/creation/integration/document-archive.js";
import { ownershipCreationDocuments } from "../../src/server/creation/integration/ownership-documents.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { creationAppFixture } from "../support/creation-app.js";
import type { DocumentOwnershipTarget } from "../../src/server/documents/ownership/move.js";

test("a partial archive keeps the creation goal active; fresh services resume the same primary after source removal without another engine run", async () => {
  let blocked = true;
  const ready = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>(),
    f = await creationAppFixture({
      content(files, root) {
        files.grants.add("project-2");
        const ownership = new DocumentOwnershipApplication({
            root: join(root, "ownership"),
            authorize: async (_owner, scope) => files.application().projectContent.authorize(scope.projectId),
            location: async (_owner, scope, id) => files.application().transfers.location(scope.projectId, id),
            backend: async () => {
              const services = files.application().transfers;
              const target: DocumentOwnershipTarget = services.target;
              return {
                kind: "files",
                ...services,
                target: {
                  receipt: (...args) => target.receipt(...args),
                  stage: (...args) => target.stage(...args),
                  verify: (...args) => target.verify(...args),
                  activate: async (...args) => {
                    if (blocked) throw Error("Simulated archive activation interruption");
                    return target.activate(...args);
                  },
                },
              };
            },
          }),
          home = creationFileDocuments(files.application()),
          documents = async () => home;
        return {
          documents: ownershipCreationDocuments(home, ownership, documents),
          archive: creationDocumentArchive(ownership, documents),
          destinations: async () => ({
            projects: [{ id: "project-2", name: "Target" }],
            personalProjectId: "personal",
            nextOffset: null,
          }),
        };
      },
    });
  try {
    f.onRun(async (_input, callbacks, scope) => {
      ready.resolve();
      await proceed.promise;
      await callbacks.call({ ...scope, callId: randomUUID(), name: "panda_creation_context", arguments: {} });
      await callbacks.call({
        ...scope,
        callId: randomUUID(),
        name: "panda_documents_create",
        arguments: {
          title: "Original primary",
          body: richDocumentFromMarkdown("A complete original document"),
          archiveTo: { projectId: "project-2" },
        },
      });
    });
    const first = await f.create("Write and archive the document");
    await ready.promise;
    expect(
      (
        await f.files.call("/api/document-creations/goal", "POST", {
          taskId: first.request.id,
          id: randomUUID(),
          action: "create",
          objective: "Save and archive the actual original document",
        })
      ).status,
    ).toBe(200);
    proceed.resolve();
    const interrupted = await f.until(first.request.id, (task) => Boolean(task.failure));
    expect(interrupted.state).toBe("committing");
    expect(interrupted.artifact).toBeNull();
    expect(interrupted.failure).toBe("writeUnavailable");
    expect(interrupted.goal?.status).not.toBe("completed");
    expect(interrupted.documentStatus).toBe("unavailable");
    expect((await f.files.application().navigation.tree("project-1")).nodes).toHaveLength(0);
    expect((await f.files.application().navigation.tree("project-2")).nodes).toHaveLength(0);
    await f.restart();
    expect((await f.task(first.request.id)).goal?.status).not.toBe("completed");
    blocked = false;
    expect(
      (await f.files.call("/api/document-creations/retry", "POST", { id: first.request.id, operationId: randomUUID() }))
        .status,
    ).toBe(200);
    const completed = await f.until(first.request.id, (task) => task.state === "succeeded");
    expect(completed.goal?.status).toBe("completed");
    expect(completed.documentStatus).toBe("available");
    expect(creationDocumentArtifact(completed.artifact)?.location?.projectId).toBe("project-2");
    expect(f.runs()).toBe(1);
    expect((await f.files.application().navigation.tree("project-2")).nodes).toHaveLength(1);
    expect(
      (
        await f.files
          .application()
          .queries.detail("project-2", creationDocumentArtifact(completed.artifact)!.documentId)
      ).document.revision,
    ).toBe(1);
  } finally {
    proceed.resolve();
    await f.close();
  }
}, 60000);
