import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DocumentOwnershipRecord } from "../../src/shared/documents/ownership.js";
import {
  encodeDocumentOwnership,
  decodeDocumentOwnership,
  projectDocumentOwnershipFile,
} from "../../src/server/project-content/ownership-file.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

test("incoming and moved originals stay hidden and cannot be restored into a second active document", async () => {
  const f = await projectFileApiFixture();
  try {
    const app = f.application(),
      created = await app.navigation.create("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Preserved source",
        locale: "en",
      }),
      id = created.operation.documentId,
      revision = (await app.queries.detail("project-1", id)).revision;
    await app.navigation.trash("owner", {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: created.tree.version,
      documentId: id,
      revision: 1,
    });
    const value: DocumentOwnershipRecord = {
      schema: 1,
      documentId: id,
      rootDocumentId: id,
      lineageId: randomUUID(),
      operationId: randomUUID(),
      manifestHash: "a".repeat(64),
      kind: "outgoing",
      from: { projectId: "project-1" },
      to: { projectId: "personal", personalOwnerHash: "b".repeat(64) },
    };
    const save = async (record: DocumentOwnershipRecord) =>
      app.projectContent.write("project-1", (project) =>
        project.coordinator.mutate({
          operationId: randomUUID(),
          author: { name: "Ownership operation", email: "ownership@example.test" },
          message: "Record document ownership state",
          changes: [{ path: projectDocumentOwnershipFile(id), content: encodeDocumentOwnership(record) }],
        }),
      );
    await save(value);
    const restore = async () =>
      app.navigation.restore("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: (await app.navigation.tree("project-1")).version,
        documentId: id,
        toRoot: true,
      });
    expect((await app.navigation.trashPage("project-1")).documents).toHaveLength(0);
    await expect(restore()).rejects.toMatchObject({ code: "notFound" });
    await expect(app.queries.detail("project-1", id)).rejects.toMatchObject({ code: "notFound" });
    const incoming: DocumentOwnershipRecord = { ...value, kind: "incoming", from: value.to, to: value.from };
    await save(incoming);
    expect((await app.navigation.trashPage("project-1")).documents).toHaveLength(0);
    await expect(restore()).rejects.toMatchObject({ code: "notFound" });
    await save({ ...incoming, kind: "active" });
    expect((await app.navigation.trashPage("project-1")).documents).toHaveLength(1);
    await restore();
    expect((await app.navigation.tree("project-1")).nodes).toHaveLength(1);
    expect((await app.queries.detail("project-1", id)).revision).toEqual(revision);
    expect(await app.queries.revisions("project-1", id)).toHaveLength(1);
    expect(decodeDocumentOwnership(encodeDocumentOwnership(incoming))).toEqual(incoming);
    expect(() => decodeDocumentOwnership(JSON.stringify({ ...incoming, to: { projectId: "personal" } }))).toThrow(
      "invalidFile",
    );
    expect(() =>
      decodeDocumentOwnership(
        JSON.stringify({ ...incoming, to: { projectId: "project-1", personalOwnerHash: "b".repeat(64) } }),
      ),
    ).toThrow("invalidFile");
  } finally {
    await f.close();
  }
}, 60000);
