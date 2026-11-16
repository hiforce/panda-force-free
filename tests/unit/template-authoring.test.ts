import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPortableTemplateDatabase } from "../../src/server/templates/storage/database.js";
import { SqlitePortableTemplates } from "../../src/server/templates/storage/registry.js";
import { SqliteTemplateDrafts } from "../../src/server/templates/storage/drafts.js";
import { FilePortableTemplates } from "../../src/server/templates/storage/content.js";
import { PortableTemplateInstallation } from "../../src/server/templates/portable/installation.js";
import { TemplateDraftAuthoring } from "../../src/server/templates/authoring/service.js";
import { DocumentTemplateAuthoring } from "../../src/server/templates/authoring/document.js";
import { createPortableTemplateTypes, templateDocumentCodec } from "../../src/server/templates/integration/types.js";
import { emptyDocumentTemplate } from "../../src/shared/templates/authoring/defaults.js";
import { PortableTemplateSource } from "../../src/server/templates/portable/source.js";
import { exportPortableTemplates, parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";
import { portableFixture, fixtureBytes } from "../support/portable-templates.js";
import sharp from "sharp";
import { TemplateDraftImages } from "../../src/server/templates/authoring/images.js";
import { SqliteTemplateImages, FileTemplateImages } from "../../src/server/templates/storage/images.js";
import { templateImageDecoder, templateImageResources } from "../../src/server/templates/integration/images.js";
import { verifyPortableTemplateResources } from "../../src/shared/templates/portable/resources.js";
import { contentSha256 } from "../../src/shared/packages/digest.js";
import { reviewPortableTemplates } from "../../src/server/templates/portable/review.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-template-authoring-")),
    path = join(root, "registry.sqlite"),
    content = new FilePortableTemplates(join(root, "content"));
  let db = openPortableTemplateDatabase(path);
  const services = () => {
    const store = new SqlitePortableTemplates(db),
      drafts = new SqliteTemplateDrafts(db),
      types = createPortableTemplateTypes(),
      installation = new PortableTemplateInstallation(store, content, types),
      adapter = new DocumentTemplateAuthoring(types, templateDocumentCodec);
    const images = new TemplateDraftImages(
      drafts,
      new SqliteTemplateImages(db),
      new FileTemplateImages(join(root, "images")),
      templateImageDecoder(),
    );
    return {
      store,
      drafts,
      types,
      installation,
      adapter,
      images,
      service: new TemplateDraftAuthoring(drafts, content, store, installation, [adapter], images),
    };
  };
  return {
    root,
    content,
    get db() {
      return db;
    },
    services,
    restart() {
      db.close();
      db = openPortableTemplateDatabase(path);
      return services();
    },
    async dispose() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const create = (id = randomUUID()) => ({
  operationId: randomUUID(),
  id,
  expectedRevision: 0,
  templateType: "panda.document-template",
  definition: emptyDocumentTemplate("custom.article"),
});

test("rich template drafts keep marks, structure and instructions in immutable files and recover owned generations after restart", async () => {
  const f = await fixture();
  try {
    let { service } = f.services();
    const command = create();
    command.definition.body = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { textAlign: "center" },
            content: [{ type: "text", text: "Reusable text", marks: [{ type: "bold" }, { type: "underline" }] }],
          },
        ],
      },
    };
    command.definition.instructions = "Preserve evidence and cite original sources.";
    const created = await service.execute("owner-a", "create", command);
    expect(created.current!.draft.revision).toBe(1);
    expect(created.current!.definition.body.document.content![0]!.content![0]!.marks).toEqual([
      { type: "bold" },
      { type: "underline" },
    ]);
    expect(service.list("owner-b").drafts).toEqual([]);
    await expect(service.detail("owner-b", command.id)).rejects.toThrow("draftNotFound");
    ({ service } = f.restart());
    expect((await service.detail("owner-a", command.id)).definition).toEqual(created.current!.definition);
    const stored = f.db.query<{ manifest: string }, []>("SELECT manifest FROM portable_template_drafts").get()!
      .manifest;
    expect(stored).not.toContain("Reusable text");
    expect(stored).not.toContain(command.definition.instructions);
    expect(await readdir(join(f.root, "content"))).toEqual([created.current!.draft.digest + ".json"]);
    expect((await service.execute("owner-a", "create", command)).acknowledgement).toEqual(created.acknowledgement);
  } finally {
    await f.dispose();
  }
});

test("save retries and tombstones cannot overwrite a newer generation or resurrect a removed draft", async () => {
  const f = await fixture();
  try {
    const { service } = f.services(),
      command = create(),
      first = await service.execute("owner", "create", command);
    const definition = structuredClone(first.current!.definition);
    definition.name = { en: "New draft title" };
    const save = { operationId: randomUUID(), id: command.id, expectedRevision: 1, definition };
    const changed = await service.execute("owner", "save", save);
    expect(changed.current!.draft.revision).toBe(2);
    const replay = await service.execute("owner", "create", command);
    expect(replay.acknowledgement.revision).toBe(1);
    expect(replay.current!.draft.revision).toBe(2);
    await expect(service.execute("owner", "save", { ...save, operationId: randomUUID() })).rejects.toThrow(
      "draftConflict",
    );
    await expect(service.execute("owner", "save", { ...save, definition: first.current!.definition })).rejects.toThrow(
      "operationConflict",
    );
    const removed = await service.execute("owner", "remove", {
      operationId: randomUUID(),
      id: command.id,
      expectedRevision: 2,
    });
    expect(removed.current).toBeNull();
    expect(service.list("owner").drafts).toEqual([]);
    expect((await service.execute("owner", "save", save)).current).toBeNull();
    await expect(service.detail("owner", command.id)).rejects.toThrow("draftNotFound");
  } finally {
    await f.dispose();
  }
});

test("publishing binds an exact draft revision, preserves local provenance and replays after further editing or removal", async () => {
  const f = await fixture();
  try {
    const { service, store, types } = f.services(),
      command = create(),
      created = await service.execute("owner", "create", command),
      draft = created.current!.draft;
    const review = await service.review("owner", draft.id, draft.revision, draft.digest);
    const approval = {
      operationId: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      selected: review.selected,
    };
    const released = await service.publish("owner", draft.id, draft.revision, draft.digest, approval);
    expect(released.current.templates[0]!.origin).toMatchObject({
      kind: "authoring",
      draftId: draft.id,
      revision: 1,
      digest: draft.digest,
    });
    const template = await f.content.read(draft.digest),
      exported = await parsePortableTemplateBundle(exportPortableTemplates([template]));
    expect(exported.templates[0]!.digest).toBe(draft.digest);
    expect(types.prepare(exported.templates[0]!).model).toMatchObject({ kind: "document", syntax: "richtext" });
    await service.execute("owner", "save", {
      operationId: randomUUID(),
      id: draft.id,
      expectedRevision: 1,
      definition: { ...created.current!.definition, instructions: "New instructions" },
    });
    expect((await service.publish("owner", draft.id, draft.revision, draft.digest, approval)).receipt).toEqual(
      released.receipt,
    );
    await expect(service.review("owner", draft.id, 1, draft.digest)).rejects.toThrow("draftConflict");
    await expect(
      service.publish("owner", draft.id, 1, draft.digest, {
        ...approval,
        operationId: randomUUID(),
        expectedRevision: store.snapshot().revision,
      }),
    ).rejects.toThrow();
    await service.execute("owner", "remove", { operationId: randomUUID(), id: draft.id, expectedRevision: 2 });
    expect((await service.publish("owner", draft.id, draft.revision, draft.digest, approval)).receipt).toEqual(
      released.receipt,
    );
    await expect(service.publish("other", draft.id, draft.revision, draft.digest, approval)).rejects.toThrow(
      "draftNotFound",
    );
  } finally {
    await f.dispose();
  }
});

test("forking a Markdown template creates a new rich version with the full original license and leaves installed bytes unchanged", async () => {
  const f = await fixture();
  try {
    const { service, installation, store } = f.services(),
      source = await PortableTemplateSource.read(fixtureBytes(await portableFixture()), "examples.json"),
      review = await installation.review(source, ["example.article-outline@1.0.0"]);
    await installation.install(
      source,
      {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
      "owner",
    );
    const original = store.snapshot().templates[0]!,
      reference = {
        registry: "portable",
        kind: "template",
        id: original.id,
        version: original.version,
        digest: original.digest,
      };
    const fork = await service.execute("owner", "fork", {
      operationId: randomUUID(),
      id: randomUUID(),
      expectedRevision: 0,
      reference,
    });
    expect(fork.current!.definition.version).toBe("1.0.1");
    expect(fork.current!.definition.license.text).toContain("MIT License");
    expect(JSON.stringify(fork.current!.definition.body)).toContain("{{title}}");
    expect(fork.current!.draft.manifest.payload.format).toBe("panda.rich-document-layout/v1");
    expect(store.snapshot().templates[0]!.digest).toBe(original.digest);
    expect((await f.content.read(original.digest)).readManifest()).toEqual(
      source.library.templates.find((item) => item.manifest.id === original.id)!.readManifest(),
    );
  } finally {
    await f.dispose();
  }
});

test("strict host validation rejects invalid rich grammar and unbound project assets before a draft write", async () => {
  const f = await fixture();
  try {
    const { service } = f.services();
    for (const node of [
      {
        type: "image",
        attrs: { src: "/api/document-assets/content?id=" + randomUUID(), alt: "private project image" },
      },
      { type: "paragraph", content: [{ type: "heading", attrs: { level: 1 } }] },
    ]) {
      const input = create();
      input.definition.body.document.content = [node];
      await expect(service.execute("owner", "create", input)).rejects.toThrow();
    }
    expect(service.list("owner").drafts).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("owned image uploads leave editor generations unchanged and rich templates export independent binary resources", async () => {
  const f = await fixture();
  try {
    let { service, images, types } = f.services();
    const command = create(),
      created = (await service.execute("owner", "create", command)).current!;
    const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#345678" } })
      .png()
      .toBuffer();
    const image = await images.upload("owner", command.id, bytes);
    expect(await images.upload("owner", command.id, bytes)).toEqual(image);
    expect((await service.detail("owner", command.id)).draft.revision).toBe(1);
    expect((await service.image("owner", command.id, image.id)).bytes).toEqual(new Uint8Array(bytes));
    await expect(images.content("another-owner", command.id, image.id)).rejects.toThrow("draftNotFound");
    const other = (await service.execute("owner", "create", create())).current!;
    await expect(images.content("owner", other.draft.id, image.id)).rejects.toThrow("draftNotFound");
    const definition = structuredClone(created.definition);
    definition.images = [image];
    definition.body.document.content = [
      { type: "paragraph", content: [{ type: "text", text: "Editable illustration" }] },
      {
        type: "image",
        attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "A reusable image", width: 8, height: 6 },
      },
    ];
    const save = { operationId: randomUUID(), id: command.id, expectedRevision: 1, definition };
    const saved = (await service.execute("owner", "save", save)).current!;
    const template = await f.content.read(saved.draft.digest),
      raw = template.text(template.manifest.payload.path);
    expect(raw).toContain("template-asset:" + image.id);
    expect(raw).not.toContain("/api/document-assets");
    expect(template.read(image.path)).toEqual(new Uint8Array(bytes));
    const exported = await parsePortableTemplateBundle(exportPortableTemplates([template]));
    expect(exported.templates[0]!.read(image.path)).toEqual(new Uint8Array(bytes));
    expect(types.prepare(exported.templates[0]!).model).toMatchObject({ syntax: "richtext", images: [image] });
    ({ service, images, types } = f.restart());
    expect((await service.detail("owner", command.id)).definition.images).toEqual([image]);
    const tampered = structuredClone(definition);
    tampered.images = [{ ...image, width: 9 }];
    await expect(
      service.execute("owner", "save", {
        ...save,
        operationId: randomUUID(),
        expectedRevision: 2,
        definition: tampered,
      }),
    ).rejects.toThrow("invalidInput");
    await expect(
      images.upload("owner", command.id, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).rejects.toThrow("invalidInput");
    const review = await service.review("owner", command.id, 2, saved.draft.digest);
    await service.publish("owner", command.id, 2, saved.draft.digest, {
      operationId: randomUUID(),
      expectedRevision: review.revision,
      reviewHash: review.reviewHash,
      selected: review.selected,
    });
    const fork = (
      await service.execute("owner", "fork", {
        operationId: randomUUID(),
        id: randomUUID(),
        expectedRevision: 0,
        reference: {
          registry: "portable",
          kind: "template",
          id: template.manifest.id,
          version: template.manifest.version,
          digest: template.digest,
        },
      })
    ).current!;
    await rm(join(f.root, "images"), { recursive: true, force: true });
    expect((await service.image("owner", fork.draft.id, image.id)).bytes).toEqual(new Uint8Array(bytes));
    expect((await service.execute("owner", "save", save)).acknowledgement.revision).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("version one registry migration preserves installed versions and receipts while enabling owned drafts", async () => {
  const f = await fixture();
  try {
    const { installation, store } = f.services(),
      upload = await PortableTemplateSource.read(fixtureBytes(await portableFixture()), "existing.json");
    const review = await installation.review(upload, ["example.article-outline@1.0.0"]),
      approval = {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      };
    const installed = await installation.install(upload, approval, "owner"),
      before = store.snapshot();
    f.db.exec(
      "DROP TABLE portable_template_draft_images; DROP TABLE portable_template_draft_operations; DROP TABLE portable_template_draft_revisions; DROP TABLE portable_template_drafts; PRAGMA user_version=1;",
    );
    const migrated = f.restart();
    expect(migrated.store.snapshot()).toEqual(before);
    expect((await migrated.installation.install(upload, approval, "owner")).receipt).toEqual(installed.receipt);
    expect((await migrated.service.execute("owner", "create", create())).current!.draft.revision).toBe(1);
    expect(f.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(4);
  } finally {
    await f.dispose();
  }
});

test("a draft changed during final installation IO cannot publish the stale revision", async () => {
  const f = await fixture();
  try {
    const { service, drafts, store, types, adapter } = f.services();
    const created = (await service.execute("owner", "create", create())).current!,
      draft = created.draft;
    let changed = false;
    const raced = new PortableTemplateInstallation(
      store,
      {
        read: (digest) => f.content.read(digest),
        async put(template) {
          await f.content.put(template);
          if (!changed) {
            changed = true;
            await service.execute("owner", "save", {
              operationId: randomUUID(),
              id: draft.id,
              expectedRevision: draft.revision,
              definition: { ...created.definition, instructions: "Changed while publication was writing content." },
            });
          }
        },
      },
      types,
    );
    const publishing = new TemplateDraftAuthoring(drafts, f.content, store, raced, [adapter]);
    const review = await publishing.review("owner", draft.id, draft.revision, draft.digest);
    await expect(
      publishing.publish("owner", draft.id, draft.revision, draft.digest, {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      }),
    ).rejects.toThrow("draftConflict");
    expect(store.snapshot().templates).toEqual([]);
    expect((await service.detail("owner", draft.id)).draft.revision).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("selected image resources require actual raster proof while unrelated templates remain importable", async () => {
  const f = await fixture();
  try {
    const { types, store, adapter } = f.services(),
      base = await adapter.create(emptyDocumentTemplate("example.image-resource"));
    const badBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      sha256 = await contentSha256(badBytes),
      image = {
        id: randomUUID(),
        path: "images/example.png",
        sha256,
        bytes: badBytes.length,
        mediaType: "image/png",
        width: 1,
        height: 1,
      };
    const payload = new TextEncoder().encode(
      JSON.stringify({
        body: {
          schema: 1,
          format: "richtext",
          document: { type: "doc", content: [{ type: "image", attrs: { src: "template-asset:" + image.id } }] },
        },
        images: [image],
        contentSlots: [],
        instructions: "",
      }),
    );
    const files = base.manifest.files.map((file) =>
      file.path === base.manifest.payload.path
        ? { ...file, bytes: payload.length, sha256: "0".repeat(64) }
        : { ...file },
    );
    files.find((file) => file.path === base.manifest.payload.path)!.sha256 = await contentSha256(payload);
    files.push({ path: image.path, bytes: image.bytes, sha256, mediaType: image.mediaType });
    const manifest = { ...base.manifest, files },
      bad = await verifyPortableTemplateResources(
        new TextEncoder().encode(JSON.stringify(manifest)),
        files.map((file) => ({
          path: file.path,
          bytes:
            file.path === image.path ? badBytes : file.path === manifest.payload.path ? payload : base.read(file.path),
        })),
      );
    const good = await adapter.create(emptyDocumentTemplate("example.text-only")),
      source = await PortableTemplateSource.read(exportPortableTemplates([bad, good]), "mixed-images.json"),
      installed = new PortableTemplateInstallation(
        store,
        f.content,
        types,
        templateImageResources(types, templateImageDecoder()),
      );
    const review = await installed.review(source, ["example.text-only@1.0.0"]);
    await installed.install(
      source,
      {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
      "owner",
    );
    expect(store.snapshot().templates.map((template) => template.id)).toEqual(["example.text-only"]);
    await expect(installed.review(source, ["example.image-resource@1.0.0"])).rejects.toThrow("invalidInput");
    const forged = await reviewPortableTemplates(source, store.snapshot(), types, ["example.image-resource@1.0.0"]);
    await expect(
      installed.install(
        source,
        {
          operationId: randomUUID(),
          expectedRevision: forged.revision,
          reviewHash: forged.reviewHash,
          selected: forged.selected,
        },
        "owner",
      ),
    ).rejects.toThrow("invalidInput");
    expect(store.snapshot().templates.map((template) => template.id)).toEqual(["example.text-only"]);
  } finally {
    await f.dispose();
  }
});

test("validated image metadata cannot be poisoned by consumers and remains usable by a full image gallery", async () => {
  const decoder = templateImageDecoder(),
    bytes = await sharp({ create: { width: 5, height: 4, channels: 3, background: "#234567" } })
      .png()
      .toBuffer();
  const first = await decoder.decode(bytes);
  first.image.width = 100;
  first.bytes.fill(0);
  const results = await Promise.all(Array.from({ length: 64 }, () => decoder.decode(bytes)));
  expect(results.every((result) => result.image.width === 5 && result.image.height === 4)).toBe(true);
  expect(results.every((result) => Buffer.from(result.bytes).equals(bytes))).toBe(true);
  expect(results[0]!.bytes).not.toBe(results[1]!.bytes);
});
