import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { createPortableTemplates } from "../../src/server/templates/integration/portable-feature.js";
import { documentTemplateCreationRoutes } from "../../src/server/templates/integration/document-creation-routes.js";
import { DocumentTemplateAuthoring } from "../../src/server/templates/authoring/document.js";
import { createPortableTemplateTypes, templateDocumentCodec } from "../../src/server/templates/integration/types.js";
import { emptyDocumentTemplate } from "../../src/shared/templates/authoring/defaults.js";
import { contentSha256 } from "../../src/shared/packages/digest.js";
import { exportPortableTemplates } from "../../src/shared/templates/portable/bundle.js";
import { PortableTemplateSource } from "../../src/server/templates/portable/source.js";
import { richBodyImageIds } from "../../src/shared/documents/rich-body.js";

async function fixture() {
  const files = await projectFileApiFixture(),
    actor = "operator:test-user",
    stateRoot = join(files.assetRoot, "template-state");
  let templates = createPortableTemplates({ stateRoot, owner: () => actor });
  const bind = () =>
    files
      .application()
      .routes.push(
        ...templates.routes,
        ...documentTemplateCreationRoutes(templates.documents, files.application().navigation, () => actor),
      );
  bind();
  const parent = await files.application().navigation.create(actor, {
    id: randomUUID(),
    projectId: "project-1",
    treeVersion: 0,
    parentId: null,
    title: "Parent document",
    locale: "en",
  });
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#6688aa" } })
      .png()
      .toBuffer(),
    image = {
      id: randomUUID(),
      path: "images/sample.png",
      sha256: await contentSha256(bytes),
      bytes: bytes.length,
      mediaType: "image/png" as const,
      width: 12,
      height: 8,
    },
    definition = emptyDocumentTemplate("example.project-article");
  definition.parameters = [{ id: "topic", label: { en: "Topic" }, required: true, type: "text" }];
  definition.contentSlots = [{ id: "body", kind: "rich-text", default: "Default body" }];
  definition.images = [image];
  definition.body.document.content = [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "{{topic}}" }] },
    { type: "paragraph", content: [{ type: "text", text: "{{body}}" }] },
    { type: "image", attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "Shared template image" } },
  ];
  const verified = await new DocumentTemplateAuthoring(createPortableTemplateTypes(), templateDocumentCodec).create(
      definition,
      { read: async () => bytes },
    ),
    source = await PortableTemplateSource.read(await exportPortableTemplates([verified]), "article.json"),
    review = await templates.installation.review(source),
    installed = await templates.installation.install(
      source,
      {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        selected: review.selected,
        reviewHash: review.reviewHash,
      },
      actor,
    ),
    ref = { id: verified.manifest.id, version: verified.manifest.version, digest: verified.digest };
  return {
    ...files,
    bytes,
    image,
    ref,
    installed,
    parentId: parent.operation.documentId,
    templates: () => templates,
    restart() {
      templates.close();
      templates = createPortableTemplates({ stateRoot, owner: () => actor });
      files.reopen();
      bind();
    },
    async close() {
      templates.close();
      await files.close();
    },
  };
}

test("template creation atomically saves native rich source, owned images and a tree receipt; retries survive disable and restart", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshots.head(),
      tree = await f.application().navigation.tree("project-1"),
      command = {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: tree.version,
        parentId: f.parentId,
        title: "Created from template",
        locale: "en",
        template: f.ref,
        values: { topic: "A literal <tag>", body: "- First\n- Second" },
      },
      result = await f.call("/api/project-documents/from-template", "POST", command);
    expect(result.status).toBe(201);
    const id = result.body.operation.documentId as string,
      head = await f.snapshots.head(),
      detail = await f.application().queries.detail("project-1", id),
      imageIds = richBodyImageIds(detail.revision.body!);
    expect(await f.snapshots.parent(head)).toBe(before);
    expect(result.body.tree.nodes.find((node: { documentId: string }) => node.documentId === id).parentId).toBe(
      f.parentId,
    );
    expect(detail.revision.content).toContain("First");
    expect(detail.revision.body!.document.content!.map((node) => node.type)).toEqual([
      "heading",
      "bulletList",
      "image",
    ]);
    expect(imageIds).toHaveLength(1);
    expect(imageIds[0]).not.toBe(f.image.id);
    const asset = await f.application().assets.content("project-1", imageIds[0]!);
    expect(asset.asset.documentId).toBe(id);
    expect(asset.bytes).toEqual(f.bytes);
    const entries = await f.snapshots.entries(head);
    expect(entries.some((entry) => entry.path.startsWith("asset-records/"))).toBe(true);
    for (const entry of entries) expect(await f.snapshots.content(entry.blob)).not.toEqual(f.bytes);
    const current = f.templates().inspection.detail(f.ref.id, f.ref.version, f.ref.digest);
    f.templates().inspection.state(
      f.ref.id,
      f.ref.version,
      f.ref.digest,
      "disable",
      current.revision,
      "operator:test-user",
    );
    f.restart();
    const replay = await f.call("/api/project-documents/from-template", "POST", command);
    expect(replay.status).toBe(201);
    expect(replay.body.operation).toEqual(result.body.operation);
    expect(await f.snapshots.head()).toBe(head);
    expect((await f.application().assets.content("project-1", imageIds[0]!)).bytes).toEqual(f.bytes);
    expect(
      (
        await f.call("/api/project-documents/from-template", "POST", {
          ...command,
          values: { ...command.values, topic: "Changed" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call("/api/project-documents/from-template", "POST", {
          ...command,
          id: randomUUID(),
          treeVersion: replay.body.tree.version,
        })
      ).status,
    ).toBe(403);
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    await f.close();
  }
}, 30000);

test("invalid template inputs, stale topology, foreign origins and unavailable projects never create partial documents", async () => {
  const f = await fixture();
  try {
    const tree = await f.application().navigation.tree("project-1"),
      before = await f.snapshots.head(),
      command = {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: tree.version,
        parentId: null,
        title: "Invalid attempt",
        locale: "en",
        template: f.ref,
        values: {},
      };
    expect((await f.call("/api/project-documents/from-template", "POST", command)).status).toBe(400);
    expect(
      (
        await f.call("/api/project-documents/from-template", "POST", {
          ...command,
          values: { topic: "Valid" },
          treeVersion: tree.version + 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call(
          "/api/project-documents/from-template",
          "POST",
          { ...command, values: { topic: "Valid" } },
          { origin: "https://foreign.test" },
        )
      ).status,
    ).toBe(403);
    f.grants.clear();
    expect(
      (await f.call("/api/project-documents/from-template", "POST", { ...command, values: { topic: "Valid" } })).status,
    ).toBe(404);
    expect(await f.snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);
