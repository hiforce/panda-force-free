import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { projectCreationDocuments } from "../../src/server/creation/integration/document-port.js";
import { FileCreationDocumentOutput } from "../../src/server/creation/integration/document-output.js";
import type { CreationTaskSpec } from "../../src/server/creation/contracts.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

test("AI creation appends to existing document storage with durable replay, concurrent manual changes and retained original revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-existing-creation-")),
    files = await projectFileApiFixture();
  const open = () =>
    createDocumentFeature({
      stateRoot: root,
      allowedRoots: [root],
      requireProject: (id) => {
        if (id !== "existing-project") throw new DocumentError("notFound", 404);
      },
    });
  let feature = open(),
    authorized = true,
    prepared = 0;
  const documents = () =>
    projectCreationDocuments(
      (project) => project === "project-1",
      files.application().navigation,
      feature.navigation,
      () => {
        if (!authorized) throw new DocumentError("notFound", 404);
      },
    );
  try {
    const parent = feature.navigation.create("owner", {
      id: randomUUID(),
      projectId: "existing-project",
      treeVersion: 0,
      parentId: null,
      title: "Keep this document",
      locale: "en",
    });
    const old = feature.service.detail(parent.operation.documentId);
    const input = {
      id: randomUUID(),
      projectId: "existing-project",
      minimumTreeVersion: parent.tree.version,
      parentId: parent.operation.documentId,
      title: "Generated result",
      locale: "en",
    };
    const source = {
      identity: "immutable-output:abc",
      async prepare() {
        prepared++;
        return { body: richDocumentFromMarkdown("Generated content"), images: [] };
      },
    };
    feature.navigation.create("owner", {
      id: randomUUID(),
      projectId: "existing-project",
      treeVersion: parent.tree.version,
      parentId: null,
      title: "A concurrent manual document",
      locale: "en",
    });
    const created = await documents().appendFromSource("owner", input, source);
    expect(created.tree.nodes).toHaveLength(3);
    expect(created.tree.nodes.find((row) => row.documentId === created.operation.documentId)?.parentId).toBe(
      parent.operation.documentId,
    );
    expect(feature.service.detail(created.operation.documentId).revision.content).toContain("Generated content");
    expect(feature.service.detail(parent.operation.documentId)).toEqual(old);
    feature.close();
    feature = open();
    const replay = await documents().appendFromSource("owner", input, {
      ...source,
      prepare: async () => {
        throw Error("Replay must not prepare an already committed output");
      },
    });
    expect(replay.operation).toEqual(created.operation);
    expect(replay.tree.nodes).toHaveLength(3);
    expect(prepared).toBe(1);
    await expect(documents().appendFromSource("other-owner", input, source)).rejects.toThrow();
    await expect(documents().appendFromSource("owner", { ...input, title: "Changed request" }, source)).rejects.toThrow(
      "conflict",
    );
    await expect(
      documents().appendFromSource("owner", { ...input, id: randomUUID(), parentId: "missing-parent" }, source),
    ).rejects.toThrow("notFound");
    expect(feature.navigation.tree("existing-project").nodes).toHaveLength(3);
    await expect(
      documents().appendFromSource(
        "owner",
        { ...input, id: randomUUID() },
        {
          ...source,
          prepare: async () => {
            authorized = false;
            return source.prepare();
          },
        },
      ),
    ).rejects.toThrow("notFound");
    expect(feature.navigation.tree("existing-project").nodes).toHaveLength(3);
    authorized = true;
    const output = new FileCreationDocumentOutput(join(root, "outputs"), documents(), true);
    const spec: CreationTaskSpec = {
      schema: 1,
      id: randomUUID(),
      operationId: randomUUID(),
      owner: "owner",
      projectId: "existing-project",
      kind: "document",
      inputDigest: "a".repeat(64),
      skillCaptureId: null,
      target: { treeVersion: created.tree.version, parentId: null, locale: "en" },
    };
    const digest = await output.stage({
      title: "Actual generated artifact",
      body: richDocumentFromMarkdown("Saved through the same artifact adapter."),
    });
    const artifact = await output.commit(spec, digest);
    expect((await output.commit(spec, digest)).documentId).toBe(artifact.documentId);
    expect(feature.navigation.tree("existing-project").nodes).toHaveLength(4);
    expect(feature.service.detail(parent.operation.documentId)).toEqual(old);
    expect((await documents().tree("project-1")).projectId).toBe("project-1");
  } finally {
    feature.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
