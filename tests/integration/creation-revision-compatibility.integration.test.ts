import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { createMySQLDocumentFeature } from "../../src/server/documents/mysql-feature.js";
import { documentRevisionReference } from "../../src/server/documents/navigation/revision-source.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDocumentsModule } from "../../src/server/database/modules/documents.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { creationAppFixture } from "../support/creation-app.js";
import { FileCreationInputs } from "../../src/server/creation/integration/input-codec.js";
import { FileCreationDocumentOutput } from "../../src/server/creation/integration/document-output.js";
import { creationFileDocuments } from "../../src/server/creation/integration/file-document-revisions.js";
import { openCreationDatabase } from "../../src/server/creation/storage/database.js";
import { creationArtifact } from "../../src/server/creation/validation.js";
import { CreationTaskRepository } from "../../src/server/creation/storage/repository.js";

for (const backend of ["sqlite", "mysql"] as const)
  test.skipIf(backend === "mysql" && !process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
    `${backend} stored document continuation replays its original receipt after a later edit and rechecks authority before commit`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "creation-revisions-")),
        mysql = backend === "mysql" ? await isolatedMySQLDatabase("revisions") : null;
      if (mysql)
        await new DatabaseRegistry().register(mysqlDocumentsModule).upgrade(new MySQLSchemaConnection(mysql.sql));
      const feature = mysql
        ? createMySQLDocumentFeature({ sql: mysql.sql, stateRoot: root, allowedRoots: [root], requireProject() {} })
        : createDocumentFeature({ stateRoot: root, allowedRoots: [root], requireProject() {} });
      try {
        const original = await feature.navigation.create("owner", {
          id: randomUUID(),
          projectId: "project",
          treeVersion: 0,
          parentId: null,
          title: "Manual title",
          locale: "en",
        });
        const id = original.operation.documentId,
          base = documentRevisionReference(await feature.service.detail(id));
        const request = { id: randomUUID(), projectId: "project", base },
          body = richDocumentFromMarkdown("New requirements");
        const source = { identity: "immutable-revision-output", prepare: async () => ({ body, images: [] }) };
        const saved = await feature.navigation.reviseFromSource("owner", request, source);
        expect(saved.operation).toMatchObject({ documentId: id, sourceRevision: { version: 2 } });
        await feature.service.saveDocument(id, {
          revision: 2,
          title: "Later manual title",
          locale: "en",
          body: richDocumentFromMarkdown("Later manual changes"),
        });
        const replay = await feature.navigation.reviseFromSource("owner", request, {
          ...source,
          prepare: async () => {
            throw Error("Replay must skip preparation");
          },
        });
        expect(replay.operation).toEqual(saved.operation);
        expect((await feature.service.detail(id)).revision.content).toContain("Later manual changes");
        await expect(
          feature.navigation.reviseFromSource("owner", { ...request, id: randomUUID() }, source),
        ).rejects.toMatchObject({ code: "conflict" });
        const fresh = {
          ...request,
          id: randomUUID(),
          base: documentRevisionReference(await feature.service.detail(id)),
        };
        let authorized = true;
        await expect(
          feature.navigation.reviseFromSource(
            "owner",
            fresh,
            {
              ...source,
              prepare: async () => {
                authorized = false;
                return source.prepare();
              },
            },
            () => {
              if (!authorized) throw Error("Access revoked");
            },
          ),
        ).rejects.toThrow("Access revoked");
        expect((await feature.service.detail(id)).document.revision).toBe(3);
        expect((await feature.navigation.tree("project")).nodes).toHaveLength(1);
      } finally {
        if ("close" in feature) feature.close();
        await mysql?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );

test("old queued continuations freeze one document target before an uncertain write and refuse stale source upgrades", async () => {
  const f = await creationAppFixture(),
    db = openCreationDatabase(join(f.root, "creation", "tasks.sqlite"));
  try {
    const first = await f.create("Original"),
      view = await f.until(first.request.id, (task) => task.state === "succeeded"),
      repository = new CreationTaskRepository(db),
      parent = repository.get("operator:test-user", view.id);
    const inputs = new FileCreationInputs(join(f.root, "creation", "inputs")),
      snapshot = await inputs.read(parent.spec),
      port = creationFileDocuments(f.files.application());
    const previous = (await port.revisions!.read(parent.spec.owner, parent.spec.projectId, parent.artifact!.documentId))
      .document;
    const legacy = { ...parent.spec, id: randomUUID(), operationId: randomUUID(), previousTaskId: parent.spec.id };
    legacy.target = { ...legacy.target, treeVersion: 1 };
    legacy.skillCaptureId = legacy.id;
    legacy.inputDigest = await inputs.put({
      ...snapshot,
      taskId: legacy.id,
      skills: { ...snapshot.skills, id: legacy.id },
      previous: { prompt: snapshot.prompt, document: previous },
    });
    const open = () => new FileCreationDocumentOutput(join(f.root, "compat-outputs"), port, true, inputs, repository);
    const digest = await open().stage(
      { title: "Ignored rename", body: richDocumentFromMarkdown("Updated legacy continuation") },
      legacy,
    );
    const result = await open().commit(legacy, digest);
    expect(result).toMatchObject({ documentId: parent.artifact!.documentId, revision: 2 });
    expect(creationArtifact(result, legacy)).toEqual(result);
    const application = f.files.application(),
      current = await application.queries.editor("project-1", result.documentId);
    await application.changes.apply(parent.spec.owner, "project-1", result.documentId, {
      operationId: randomUUID(),
      expectedRevisionId: current.saved.revision.id,
      expectedVersion: 2,
      expectedContentHash: current.saved.document.contentHash,
      intentHash: "b".repeat(64),
      content: {
        title: "Latest manual title",
        locale: "en",
        content: "",
        body: richDocumentFromMarkdown("Latest manual content"),
        resources: [],
      },
    });
    expect(await open().commit(legacy, digest)).toEqual(result);
    expect((await application.queries.detail("project-1", result.documentId)).document.revision).toBe(3);
    const stale = { ...legacy, id: randomUUID(), operationId: randomUUID() };
    stale.skillCaptureId = stale.id;
    stale.inputDigest = await inputs.put({
      ...snapshot,
      taskId: stale.id,
      skills: { ...snapshot.skills, id: stale.id },
      previous: { prompt: snapshot.prompt, document: previous },
    });
    await expect(
      open().stage({ title: "Stale", body: richDocumentFromMarkdown("Stale content") }, stale),
    ).rejects.toMatchObject({ failure: "targetChanged" });
    expect((await application.navigation.tree("project-1")).nodes).toHaveLength(1);
  } finally {
    db.close();
    await f.close();
  }
}, 60000);
