import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { auditPrincipal } from "../../src/server/auth/audit-principal.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import type { RichDocumentBody } from "../../src/shared/documents/rich-body.js";
import { captureSourceProject } from "../../src/server/builds/integration/source-project.js";
import { compatiblePlacementLocale } from "../../src/server/documents/placements/service.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-placement-test-"));
  const open = () =>
    createDocumentFeature({
      stateRoot: root,
      allowedRoots: [root],
      requireProject: (id) => {
        if (!["project", "other"].includes(id)) throw new DocumentError("notFound", 404);
      },
    });
  let feature = open();
  const source = feature.library.create("project", { title: "One original", folder: "Guides", locale: "en" });
  const target = await feature.service.createSpace({
    projectId: "project",
    code: "blog",
    name: "Blog",
    engine: "hexo",
    sourceMode: "managed",
    locale: "en",
  });
  return {
    root,
    source,
    target,
    get feature() {
      return feature;
    },
    reopen() {
      feature.close();
      feature = open();
    },
    async close() {
      feature.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const input = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  documentId: f.source.document.id,
  spaceId: f.target.id,
  path: "posts/start.md",
  locale: "en",
  metadata: {},
  ...extra,
});

test("one original is referenced by two publication spaces without copying source, revisions, files or images", async () => {
  const f = await fixture();
  try {
    const before = f.feature.service.detail(f.source.document.id);
    const image = await f.feature.assets.upload(
      before.document.id,
      "Original image.png",
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    );
    const handbook = await f.feature.service.createSpace({
      projectId: "project",
      code: "handbook",
      name: "Handbook",
      engine: "docusaurus",
      sourceMode: "managed",
      locale: "en",
    });
    const first = f.feature.placements.create(input(f), "test-owner"),
      second = f.feature.placements.create(
        input(f, {
          spaceId: handbook.id,
          path: "guide/start.md",
          metadata: { title: "Handbook edition", tags: ["guide"] },
        }),
        "test-owner",
      );
    expect(first.documentId).toBe(second.documentId);
    expect(first.id).not.toBe(second.id);
    expect(f.feature.service.detail(before.document.id)).toEqual(before);
    expect(f.feature.persistence.query("SELECT count(*) AS count FROM documents").get()).toEqual({ count: 1 });
    expect(f.feature.persistence.query("SELECT count(*) AS count FROM document_assets").get()).toEqual({ count: 1 });
    expect((await f.feature.assets.content(image.id)).asset.name).toBe("Original image.png");
    expect(await readdir(f.target.sourceRoot)).toEqual([]);
    expect(await readdir(handbook.sourceRoot)).toEqual([]);
    expect(f.feature.placements.listForDocument(before.document.id)).toHaveLength(2);
    expect(() => f.feature.placements.create(input(f, { path: "another-path.md" }), "test-owner")).toThrow(
      "placementAlreadyLinked",
    );
    expect(f.feature.service.spaces.get(f.target.id).version).toBe(2);
    f.reopen();
    expect(f.feature.placements.get(first.id)).toEqual(first);
    expect(f.feature.placements.get(second.id)).toEqual(second);
    expect(f.feature.service.detail(before.document.id).revision.body).toEqual(before.revision.body);
  } finally {
    await f.close();
  }
});

test("lost configuration replies are idempotent, optimistic edits conflict and audit versions are immutable", async () => {
  const f = await fixture();
  try {
    const value = input(f),
      placed = f.feature.placements.create(value, "operator-one");
    expect(f.feature.placements.create(value, "operator-two")).toEqual(placed);
    expect(f.feature.placements.history(placed.id)).toHaveLength(1);
    const edit = { ...value, path: "guides/start.md", version: 1, metadata: { description: "Reviewed text" } };
    const updated = f.feature.placements.update(placed.id, edit, "operator-two");
    expect(updated.version).toBe(2);
    expect(f.feature.placements.update(placed.id, edit, "operator-two")).toEqual(updated);
    expect(() => f.feature.placements.update(placed.id, { ...edit, path: "other.md" }, "operator-one")).toThrow(
      "conflict",
    );
    const deleted = f.feature.placements.remove(placed.id, 2, "operator-two");
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.version).toBe(3);
    expect(f.feature.placements.remove(placed.id, 2, "operator-two")).toEqual(deleted);
    expect(f.feature.placements.listForSpace(f.target.id)).toEqual([]);
    expect(f.feature.service.spaces.get(f.target.id).version).toBe(4);
    const history = f.feature.placements.history(placed.id);
    expect(history.map((value) => value.operation)).toEqual(["remove", "update", "create"]);
    expect(history[2]!.placement.path).toBe("posts/start.md");
    expect(history[2]!.actor).toBe("operator-one");
    expect(() => f.feature.placements.create(value, "operator-one")).toThrow("conflict");
    const replacement = f.feature.placements.create(input(f, { path: deleted.path }), "operator-one");
    expect(replacement.id).not.toBe(placed.id);
  } finally {
    await f.close();
  }
});

test("destination path, project, language and immutable revision ownership are checked atomically", async () => {
  const f = await fixture();
  try {
    const other = await f.feature.service.createSpace({
      projectId: "other",
      code: "other",
      name: "Other project",
      engine: "hexo",
      sourceMode: "managed",
      locale: "en",
    });
    expect(() => f.feature.placements.create(input(f, { spaceId: other.id }), "owner")).toThrow("notFound");
    expect(() => f.feature.placements.create(input(f, { spaceId: f.source.document.spaceId }), "owner")).toThrow(
      "invalidPlacementTarget",
    );
    expect(() => f.feature.placements.create(input(f, { path: "../escape.md" }), "owner")).toThrow("invalidInput");
    expect(() => f.feature.placements.create(input(f, { locale: "zh" }), "owner")).toThrow("placementLocaleMismatch");
    expect(() =>
      f.feature.placements.create(input(f, { metadata: { api_key: "must-not-be-config" } }), "owner"),
    ).toThrow("invalidPlacementMetadata");
    expect(() => f.feature.placements.create(input(f, { spaceVersion: 99 }), "owner")).toThrow("spaceConflict");
    const unrelated = f.feature.library.create("project", { title: "Another source", locale: "en" });
    expect(() => f.feature.placements.create(input(f, { revisionId: unrelated.revision.id }), "owner")).toThrow(
      "notFound",
    );
    expect(f.feature.placements.listForSpace(f.target.id)).toEqual([]);
    expect(f.feature.service.spaces.get(f.target.id).version).toBe(1);
    const owned = f.feature.service.createDocument({
      spaceId: f.target.id,
      path: "POSTS/Start.md",
      title: "Existing",
      locale: "en",
      content: "Existing content",
    });
    expect(() => f.feature.placements.create(input(f), "owner")).toThrow("placementPathConflict");
    expect(f.feature.service.detail(owned.document.id).revision.content).toBe("Existing content");
  } finally {
    await f.close();
  }
});

test("revision pinning and language edition aliases select the original version without translating or mutating it", async () => {
  const f = await fixture();
  try {
    const old = f.source.revision;
    f.feature.service.saveDocument(f.source.document.id, {
      revision: 1,
      title: "New language",
      locale: "zh-CN",
      body: old.body,
    });
    const pinned = f.feature.placements.create(input(f, { revisionId: old.id }), "owner");
    expect(pinned.revisionId).toBe(old.id);
    expect(() => f.feature.placements.create(input(f, { path: "latest.md" }), "owner")).toThrow(
      "placementLocaleMismatch",
    );
    const latest = f.feature.placements.create(input(f, { path: "latest.md", locale: "zh" }), "owner");
    expect(latest.revisionId).toBeNull();
    expect(latest.locale).toBe("zh");
    expect(f.feature.service.detail(f.source.document.id).revision.locale).toBe("zh-CN");
    f.feature.library.trash("project", { id: f.source.document.id, revision: 2 });
    expect(() => f.feature.placements.update(latest.id, { ...latest, version: 1 }, "owner")).toThrow("notFound");
    expect(f.feature.placements.remove(latest.id, 1, "owner").deletedAt).not.toBeNull();
    expect(f.feature.placements.history(pinned.id)[0]!.placement.revisionId).toBe(old.id);
  } finally {
    await f.close();
  }
});

test("migration from a genuine schema5 copy preserves rich bodies and all prior document rows", async () => {
  const f = await fixture();
  try {
    const before = f.feature.service.detail(f.source.document.id),
      path = join(f.root, "legacy.sqlite");
    f.feature.persistence.exec(`VACUUM INTO '${path}'`);
    const legacy = new Database(path);
    legacy.exec("DROP TABLE document_placement_events;DROP TABLE document_placements;PRAGMA user_version=5");
    legacy.close();
    const { openDocumentDatabase } = await import("../../src/server/documents/database.js");
    for (let pass = 0; pass < 2; pass++) {
      const migrated = openDocumentDatabase(path);
      expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(
        migrated.query("SELECT body FROM document_rich_revisions WHERE revisionId=?").get(before.revision.id),
      ).toEqual(
        f.feature.persistence
          .query("SELECT body FROM document_rich_revisions WHERE revisionId=?")
          .get(before.revision.id),
      );
      expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
      migrated.close();
    }
  } finally {
    await f.close();
  }
});

test("audit principals are stable scoped references and never contain account claims", () => {
  expect(auditPrincipal(undefined)).toBe("local-access");
  const first = auditPrincipal({ uuid: "private-user", tenantId: "private-tenant", name: "Never store this" });
  expect(first).toBe(auditPrincipal({ tenantId: "private-tenant", uuid: "private-user" }));
  expect(first).not.toContain("private-user");
  expect(first).not.toContain("Never store");
  expect(first).not.toBe(auditPrincipal({ uuid: "private-user", tenantId: "another-tenant" }));
  expect(() => auditPrincipal({ uuid: "missing-tenant" })).toThrow();
});

test("edition aliases preserve language and writing script rather than pretending to translate a source", () => {
  expect(compatiblePlacementLocale("en-US", "en-GB")).toBe(true);
  expect(compatiblePlacementLocale("zh-CN", "zh")).toBe(true);
  expect(compatiblePlacementLocale("zh-CN", "zh-TW")).toBe(false);
  expect(compatiblePlacementLocale("sr-Latn", "sr-Cyrl")).toBe(false);
  expect(compatiblePlacementLocale("en", "fr")).toBe(false);
});

test("publication snapshots follow latest or pin a revision while preserving original rich content and destination provenance", async () => {
  const f = await fixture();
  try {
    const first = f.feature.service.saveDocument(f.source.document.id, {
      revision: 1,
      title: "First source",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { textAlign: "center" },
              content: [{ type: "text", text: "One original", marks: [{ type: "underline" }] }],
            },
          ],
        },
      },
    });
    const p = f.feature.placements.create(input(f, { metadata: { title: "Blog heading", tags: ["blog"] } }), "owner");
    const handbook = await f.feature.service.createSpace({
      projectId: "project",
      code: "handbook",
      name: "Handbook",
      engine: "docusaurus",
      sourceMode: "managed",
      locale: "en",
    });
    const h = f.feature.placements.create(
      input(f, { spaceId: handbook.id, revisionId: first.revision.id, path: "guide.md" }),
      "owner",
    );
    const second = f.feature.service.saveDocument(first.document.id, {
      revision: 2,
      title: "Second source",
      locale: "en",
      body: {
        ...first.revision.body!,
        document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Latest text" }] }] },
      },
    });
    const limits = { documents: 500, bytes: 16 * 1024 * 1024 },
      latest = f.feature.snapshots.capture(f.target.id, "en", limits),
      pinned = f.feature.snapshots.capture(handbook.id, "en", limits);
    expect(latest.documents[0]!.revision.id).toBe(second.revision.id);
    expect(pinned.documents[0]!.revision.id).toBe(first.revision.id);
    expect(latest.documents[0]!.document.spaceId).toBe(f.source.document.spaceId);
    expect(latest.documents[0]!.document.path).toBe(f.source.document.path);
    expect(latest.documents[0]!.path).toBe("posts/start.md");
    expect(latest.documents[0]!.engine).toBe("markdown");
    const sources = documentBuildSources({
      service: f.feature.service,
      assets: f.feature.assets,
      snapshots: f.feature.snapshots,
    });
    const request = {
      id: randomUUID(),
      spaceId: f.target.id,
      engine: "hexo" as const,
      locale: "en",
      title: "Blog",
      url: "https://example.test",
      basePath: "/",
    };
    const captured = await sources.capture(request),
      jobs = new SiteBuildRepository(f.feature.persistence);
    jobs.create(request, captured.input, captured.sources);
    expect(captured.input.documents[0]).toMatchObject({
      path: p.path,
      title: "Blog heading",
      metadata: { tags: ["blog"], date: new Date(second.revision.createdAt).toISOString() },
    });
    expect(captured.sources[0]).toMatchObject({
      id: second.document.id,
      revisionId: second.revision.id,
      contentHash: second.revision.contentHash,
      sourcePath: f.source.document.path,
      placement: { id: p.id, version: 1 },
    });
    const html = await sources.capture({ ...request, id: randomUUID(), spaceId: handbook.id, engine: "docusaurus" });
    expect(html.input.documents[0]!.content).toContain("<u>");
    expect(html.input.documents[0]!.content).toContain('textAlign:"center"');
    f.feature.placements.remove(p.id, p.version, "owner");
    f.feature.library.trash("project", { id: second.document.id, revision: second.document.revision });
    expect(jobs.input(request.id)).toEqual(captured.input);
    expect(() => f.feature.snapshots.capture(handbook.id, "en", limits)).toThrow("placementSourceUnavailable");
    expect(f.feature.placements.get(h.id).revisionId).toBe(first.revision.id);
    expect(pinned.documents[0]!.revision.body).toEqual(first.revision.body);
  } finally {
    await f.close();
  }
});

test("snapshot budgets are checked before loading rich bodies, and path or language changes cannot silently omit a link", async () => {
  const f = await fixture();
  try {
    const source = f.feature.service.saveDocument(f.source.document.id, {
      revision: 1,
      title: "Rich",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved content" }] }] },
      },
    });
    f.feature.placements.create(input(f), "owner");
    const repository = f.feature.service.documents,
      revision = repository.revision.bind(repository);
    repository.revision = () => {
      throw new Error("body materialized before budget check");
    };
    expect(() => f.feature.snapshots.capture(f.target.id, "en", { documents: 500, bytes: 10 })).toThrow("tooLarge");
    repository.revision = revision;
    f.feature.service.createDocument({
      spaceId: f.target.id,
      path: "POSTS/start.md",
      title: "Conflicting destination",
      locale: "en",
      content: "A different original",
    });
    expect(() => f.feature.snapshots.capture(f.target.id, "en", { documents: 500, bytes: 1_000_000 })).toThrow(
      "placementPathConflict",
    );
    expect(() => f.feature.snapshots.capture(f.target.id, "en", { documents: 1, bytes: 1_000_000 })).toThrow(
      "tooLarge",
    );
    f.feature.service.saveDocument(source.document.id, {
      revision: 2,
      title: "Language changed",
      locale: "zh-CN",
      body: source.revision.body,
    });
    expect(() => f.feature.snapshots.capture(f.target.id, "en", { documents: 500, bytes: 1_000_000 })).toThrow(
      "placementLocaleMismatch",
    );
  } finally {
    await f.close();
  }
});

test("rich build images keep source ownership and bytes while concurrent placement edits invalidate only the new capture", async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
      asset = await f.feature.assets.upload(f.source.document.id, "My upload.png", bytes);
    const body: RichDocumentBody = {
      schema: 1,
      format: "richtext",
      document: {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: "/api/document-assets/content?id=" + asset.id, alt: "Original <image>", width: 2, height: 2 },
          },
        ],
      },
    };
    const source = f.feature.service.saveDocument(f.source.document.id, {
      revision: 1,
      title: "With image",
      locale: "en",
      body,
    });
    const placement = f.feature.placements.create(input(f), "owner");
    const sources = documentBuildSources({
      service: f.feature.service,
      assets: f.feature.assets,
      snapshots: f.feature.snapshots,
    });
    const request = {
      id: randomUUID(),
      spaceId: f.target.id,
      engine: "hexo" as const,
      locale: "en",
      title: "Blog",
      url: "https://example.test",
      basePath: "/blog/",
    };
    const captured = await sources.capture(request);
    expect(captured.input.assets[0]!.data).toBe(bytes.toString("base64"));
    expect(captured.input.documents[0]!.content).toContain('width="2"');
    expect(captured.input.documents[0]!.content).toContain('alt="Original &lt;image&gt;"');
    expect(captured.input.documents[0]!.content).toContain("/blog/assets/" + source.document.id);
    expect(captured.input.documents[0]!.content).not.toContain("/api/document-assets");
    const stale = documentBuildSources({
      service: f.feature.service,
      assets: f.feature.assets,
      snapshots: f.feature.snapshots,
      captureTheme: async (theme) => {
        f.feature.placements.update(placement.id, { ...placement, version: 1, path: "changed.md" }, "owner");
        const { freezeBuildTheme } = await import("../../src/shared/builds/theme.js");
        return freezeBuildTheme(theme);
      },
    });
    await expect(stale.capture({ ...request, id: randomUUID() })).rejects.toThrow("spaceSettingsChanged");
    expect(f.feature.service.detail(source.document.id)).toEqual(source);
    expect(captured.sources[0]!.placement!.version).toBe(1);
    expect(captured.input.documents[0]!.path).toBe(placement.path);
  } finally {
    await f.close();
  }
});

test("a source-WebP destination derives rich images inside its build without replacing original PNG blobs or losing cover ownership", async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "green" } })
        .png()
        .toBuffer(),
      asset = await f.feature.assets.upload(f.source.document.id, "Original diagram.png", bytes),
      src = "/api/document-assets/content?id=" + asset.id;
    const saved = f.feature.service.saveDocument(f.source.document.id, {
      revision: 1,
      title: "Image source",
      locale: "en",
      body: {
        schema: 1,
        format: "richtext",
        document: { type: "doc", content: [{ type: "image", attrs: { src, alt: "Diagram" } }] },
      },
    });
    f.feature.profiles.save(
      f.target.id,
      {
        schema: 1,
        engine: "hexo",
        imageMode: "source-webp",
        localizedImages: {},
        resources: [],
        editions: { en: { title: "Blog", url: "https://example.test", basePath: "/guide/", config: {} } },
      },
      f.target.version,
    );
    const profile = (await f.feature.profiles.capture(f.target.id, "en"))!;
    const records = [
      { id: saved.document.id, path: "source/_posts/diagram.md", revision: saved.revision, metadata: { cover: src } },
    ];
    const capture = await captureSourceProject(profile, records, f.feature.assets),
      file = capture.project.files[0]!;
    expect(capture.project.files).toHaveLength(1);
    expect(file.path).toEndWith("/Original diagram.webp");
    expect(file.publish).toBe(true);
    expect((await sharp(Buffer.from(file.data, "base64")).metadata()).format).toBe("webp");
    expect(capture.documents.get(saved.document.id)!.metadata.cover).toBe(
      capture.documents.get(saved.document.id)!.urls.get(asset.id)!,
    );
    expect(capture.documents.get(saved.document.id)!.metadata.cover).not.toContain("/api/");
    expect(await f.feature.assets.content(asset.id)).toEqual({ asset, bytes });
    expect(f.feature.service.detail(saved.document.id)).toEqual(saved);
    expect(f.feature.persistence.query("SELECT count(*) AS count FROM document_assets").get()).toEqual({ count: 1 });
    const repeat = await captureSourceProject(profile, records, f.feature.assets);
    expect(repeat.project).toEqual(capture.project);
    const other = f.feature.library.create("project", { title: "Other source", locale: "en" }),
      foreign = await f.feature.assets.upload(other.document.id, "Foreign.png", bytes);
    await expect(
      captureSourceProject(
        profile,
        [{ ...records[0]!, metadata: { cover: "/api/document-assets/content?id=" + foreign.id } }],
        f.feature.assets,
      ),
    ).rejects.toThrow("assetUnavailable");
  } finally {
    await f.close();
  }
});

test("portable legacy Markdown still builds with either engine while engine-specific tags require adaptation", async () => {
  const f = await fixture();
  try {
    const own = f.feature.service.createDocument({
      spaceId: f.target.id,
      path: "portable.md",
      title: "Portable legacy source",
      locale: "en",
      content: 'Plain Markdown.\n\n```text\n{% figure "example.png" %}\n```',
    });
    const sources = documentBuildSources({
      service: f.feature.service,
      assets: f.feature.assets,
      snapshots: f.feature.snapshots,
    });
    const request = {
      id: randomUUID(),
      spaceId: f.target.id,
      engine: "docusaurus" as const,
      locale: "en",
      title: "Legacy source",
      url: "https://example.test",
      basePath: "/",
    };
    expect((await sources.capture(request)).input.documents[0]!.content).toContain("Plain Markdown.");
    f.feature.service.saveDocument(own.document.id, {
      revision: 1,
      title: own.revision.title,
      locale: "en",
      content: '{% abstract "Overview" %}\nSemantic content.\n{% endabstract %}',
    });
    await expect(sources.capture({ ...request, id: randomUUID() })).rejects.toThrow("unsupportedSourceSyntax");
    expect(
      (await sources.capture({ ...request, id: randomUUID(), engine: "hexo" })).input.documents[0]!.content,
    ).toContain("{% abstract");
  } finally {
    await f.close();
  }
});
