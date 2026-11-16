import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { openDocumentDatabase } from "../../src/server/documents/database.js";
import { DocumentImageIngestion } from "../../src/server/documents/ingestion/images.js";
import { imageCandidates } from "../../src/server/documents/ingestion/image-paths.js";
import { documentImageSources } from "../../src/shared/documents/syntax/images.js";
import { documentPublicationSources } from "../../src/server/publishing/integration/document-source.js";
import { documentBuildSources } from "../../src/server/builds/integration/document-sources.js";
import { parseContent } from "../../src/server/publishing/content/parse.js";
import { buildImageReferences } from "../../src/server/builds/integration/references.js";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const png = (background: string) =>
  sharp({ create: { width: 12, height: 9, channels: 3, background } })
    .png()
    .toBuffer();
async function fixture(engine: "markdown" | "hexo" | "docusaurus" = "hexo") {
  const root = mkdtempSync(join(tmpdir(), "panda-ingestion-")),
    source = join(root, "source");
  const path =
    engine === "hexo" ? "source-en/_posts/article.md" : engine === "docusaurus" ? "docs/article.md" : "article.md";
  const image = engine === "docusaurus" ? "static/assets/diagram.png" : "assets/diagram.png";
  const content =
    engine === "hexo"
      ? '---\r\ntitle: Original\r\n---\r\n\r\n{% figure "/assets/diagram.png" "Diagram" 12 9 %}\r\nCaption **unchanged**.\r\n{% endfigure %}\r\n'
      : "# Original\n\n![Diagram](/assets/diagram.png)\n";
  const put = (path: string, data: string | Buffer) => {
    const full = join(source, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, data);
  };
  put(
    "package.json",
    JSON.stringify({
      dependencies:
        engine === "hexo" ? { hexo: "8.1.1" } : engine === "docusaurus" ? { "@docusaurus/core": "3.10.2" } : {},
    }),
  );
  put(path, content);
  put(image, await png("red"));
  const options = { stateRoot: join(root, "state"), allowedRoots: [root], requireProject: () => ({}) };
  const feature = createDocumentFeature(options);
  const space = await feature.service.createSpace({
    projectId: "project",
    code: "blog",
    name: "Blog",
    engine,
    sourceMode: "external",
    sourceRoot: source,
    locale: "en",
  });
  const current = () => feature.service.detail(feature.service.listDocuments(space.id, "", 0).documents[0]!.id);
  return {
    root,
    source,
    path,
    image,
    content,
    put,
    options,
    feature,
    space,
    current,
    close() {
      feature.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("image-only refresh creates immutable revisions and keeps original source and old publications", async () => {
  const f = await fixture();
  try {
    const first = await f.feature.service.importSource(f.space.id),
      old = f.current();
    expect(first.assets?.imported).toBe(1);
    expect(old.revision.content).toBe(f.content);
    expect(old.revision.contentHash).toBe(digest(f.content));
    expect(old.revision.resources).toHaveLength(1);
    const originalAsset = old.revision.resources![0]!;
    expect((await f.feature.assets.content(originalAsset.assetId)).asset.name).toBe("diagram.png");
    expect((await f.feature.service.importSource(f.space.id)).assets?.imported).toBe(0);
    expect(f.current().document.revision).toBe(1);
    f.put(f.image, await png("blue"));
    const changed = await f.feature.service.importSource(f.space.id),
      current = f.current();
    expect(changed.assets?.updatedDocuments).toBe(1);
    expect(current.document.revision).toBe(2);
    expect(current.revision.content).toBe(f.content);
    expect(current.revision.resources![0]!.assetId).not.toBe(originalAsset.assetId);
    expect(f.feature.service.documents.revision(old.document.id, old.revision.id).resources).toEqual(
      old.revision.resources,
    );
    expect(digest((await f.feature.assets.content(originalAsset.assetId)).bytes)).toBe(originalAsset.digest);
    expect((await f.feature.service.importSource(f.space.id)).assets?.updatedDocuments).toBe(0);
    expect(f.current().document.revision).toBe(2);
    expect(readFileSync(join(f.source, f.path), "utf8")).toBe(f.content);
    const bridge = documentPublicationSources(f.feature.service, f.feature.assets);
    const ir = parseContent(await bridge.sources.revision(old.document.id, old.revision.id));
    const figure = ir.blocks[0]!;
    expect(figure.kind).toBe("container");
    if (figure.kind !== "container") throw Error("Missing figure");
    expect(figure.image?.source).toBe(`/api/document-assets/content?id=${originalAsset.assetId}`);
    expect(ir.sourceHash).toBe(digest(f.content));
    expect(ir.issues).toEqual([]);
    expect(ir.source.slice(figure.span.start, figure.span.end)).toBe(figure.raw);
    const captured = await documentBuildSources({
      service: f.feature.service,
      assets: f.feature.assets,
      snapshots: f.feature.snapshots,
    }).capture({
      id: randomUUID(),
      spaceId: f.space.id,
      engine: "hexo",
      title: "Blog",
      url: "https://example.test",
      basePath: "/guide/",
      locale: "en",
    });
    expect(captured.input.assets).toHaveLength(1);
    expect(captured.input.documents[0]!.content).toContain(`{% figure "/assets/${old.document.id}/`);
    expect(captured.input.documents[0]!.content).toContain("Caption **unchanged**.");
    expect(captured.sources[0]!.revisionId).toBe(current.revision.id);
  } finally {
    f.close();
  }
});

test("drafts retain their images during source refresh and history restore recovers original resource bindings", async () => {
  const f = await fixture();
  try {
    await f.feature.service.importSource(f.space.id);
    const old = f.current();
    const draft = f.feature.service.saveDocument(old.document.id, {
      revision: 1,
      ...old.revision,
      title: "Local draft",
    });
    f.put(f.image, await png("blue"));
    f.put(f.path, f.content + "\nSource update");
    expect((await f.feature.service.importSource(f.space.id)).conflicts).toEqual([f.path]);
    expect(f.current().revision.resources).toEqual(old.revision.resources);
    const imported = await f.feature.ingestion.importImages(old.document.id, draft.document.revision);
    expect(imported.changed).toBe(true);
    expect(imported.detail.revision.title).toBe("Local draft");
    expect(imported.detail.revision.resources).not.toEqual(old.revision.resources);
    const restored = f.feature.service.saveDocument(old.document.id, {
      ...old.revision,
      revision: imported.detail.document.revision,
      restoreRevisionId: old.revision.id,
    });
    expect(restored.revision.resources).toEqual(old.revision.resources);
    expect(() =>
      f.feature.service.saveDocument(old.document.id, {
        ...old.revision,
        content: "Forged",
        revision: restored.document.revision,
        restoreRevisionId: old.revision.id,
      }),
    ).toThrow("invalidInput");
    await expect(f.feature.ingestion.importImages(old.document.id, 1)).rejects.toThrow("conflict");
    const other = f.feature.service.createDocument({
      spaceId: f.space.id,
      path: "other.md",
      title: "Other",
      content: "",
    });
    expect(() =>
      f.feature.service.saveDocument(other.document.id, {
        ...old.revision,
        revision: 1,
        restoreRevisionId: old.revision.id,
      }),
    ).toThrow("notFound");
  } finally {
    f.close();
  }
});

test("renamed articles retain identity while changed relative image locations get a new resource revision", async () => {
  const f = await fixture("markdown");
  try {
    f.put(f.path, "![Diagram](diagram.png)");
    f.put("diagram.png", await png("red"));
    await f.feature.service.importSource(f.space.id);
    const old = f.current();
    f.put("nested/diagram.png", await png("blue"));
    renameSync(join(f.source, f.path), join(f.source, "nested/article.md"));
    await f.feature.service.importSource(f.space.id);
    const next = f.current();
    expect(next.document.id).toBe(old.document.id);
    expect(next.document.path).toBe("nested/article.md");
    expect(next.document.revision).toBe(2);
    expect(next.revision.resources![0]!.sourcePath).toBe("nested/diagram.png");
    expect(next.revision.resources![0]!.digest).not.toBe(old.revision.resources![0]!.digest);
  } finally {
    f.close();
  }
});

test("Docusaurus static images are imported without executing MDX or project configuration", async () => {
  const f = await fixture("docusaurus");
  try {
    const content = "import Widget from './widget';\n\n![Diagram](pathname:///assets/diagram.png)\n\n<Widget />";
    f.put(f.path, content);
    await f.feature.service.importSource(f.space.id);
    expect(f.current().revision.content).toBe(content);
    expect(f.current().revision.resources![0]!.sourcePath).toBe("static/assets/diagram.png");
    expect((await f.feature.service.importSource(f.space.id)).assets?.imported).toBe(0);
  } finally {
    f.close();
  }
});

test("missing, ambiguous, remote, unsupported and escaped images produce explicit reports", async () => {
  const f = await fixture();
  try {
    f.put("source-en/assets/diagram.png", await png("blue"));
    symlinkSync("/etc/passwd", join(f.source, "assets/escape.png"));
    f.put(
      f.path,
      "![one](/assets/diagram.png)\n\n![two](missing.png)\n\n![three](https://example.invalid/never.png)\n\n![four](vector.svg)\n\n![five](/assets/escape.png)",
    );
    const result = await f.feature.service.importSource(f.space.id);
    expect(result.assets?.issues.map((issue) => issue.code)).toEqual([
      "imageAmbiguous",
      "imageMissing",
      "imageExternal",
      "imageUnsupported",
      "imageUnavailable",
    ]);
    expect(f.current().revision.resources).toEqual([]);
    expect(f.feature.assets.list(f.current().document.id)).toEqual([]);
    expect(imageCandidates("article.md", "../../etc/secret.png", "markdown")).toEqual([]);
    expect(imageCandidates("article.md", "/.env/secret.png", "markdown")).toEqual([]);
    expect(imageCandidates("article.md", "/assets/%2e%2e/%2e%2e/secret.png", "markdown")).toEqual([]);
  } finally {
    f.close();
  }
});

test("discovery respects code, references, tables and known nested Hexo containers", () => {
  const content =
    '```md\n![ignored](code.png)\n```\n\n`![ignored](inline.png)`\n\n{% abstract "Summary" %}\n{% figure "/assets/figure.png" "Diagram" %}\n![Nested](nested.png)\n{% endfigure %}\n{% endabstract %}\n\n| Image |\n| -- |\n| ![Cell][ref] |\n\n[ref]: table.png\n\n<img src="html.png">';
  expect(documentImageSources(content, "hexo")).toEqual(["/assets/figure.png", "nested.png", "table.png"]);
});

test("staging has bounded reference work and detects files changed before commit", async () => {
  const f = await fixture("markdown");
  try {
    const collector = new DocumentImageIngestion(f.feature.assets);
    const many = await collector.stage(
      f.source,
      f.path,
      Array.from({ length: 1000 }, (_, i) => `![x](missing-${i}.png)`).join("\n\n"),
      "markdown",
      { bytes: 0 },
    );
    expect(many.issues).toHaveLength(65);
    expect(many.issues[64]!.code).toBe("imageLimit");
    const staged = await collector.stage(f.source, f.path, f.content, "markdown", { bytes: 0 });
    f.put(f.image, await png("blue"));
    await expect(collector.verify(f.source, [staged.images])).rejects.toThrow("conflict");
    expect(f.feature.service.listDocuments(f.space.id, "", 0).total).toBe(0);
    expect(f.feature.persistence.query("SELECT * FROM document_assets").all()).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("failed ingestion transaction exposes neither partial documents nor resource ownership", async () => {
  const f = await fixture();
  try {
    f.feature.persistence.exec(
      "CREATE TRIGGER fail_binding BEFORE INSERT ON document_revision_assets BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END",
    );
    await expect(f.feature.service.importSource(f.space.id)).rejects.toThrow("simulated storage failure");
    for (const table of ["documents", "document_revisions", "document_assets", "document_revision_assets"])
      expect(f.feature.persistence.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
    f.feature.persistence.exec("DROP TRIGGER fail_binding");
    expect((await f.feature.service.importSource(f.space.id)).created).toBe(1);
  } finally {
    f.close();
  }
});

test("schema 2 migration is idempotent and retains revisions and owned assets", async () => {
  const f = await fixture();
  try {
    await f.feature.service.importSource(f.space.id);
    const old = f.current();
    const path = join(f.root, "legacy.sqlite");
    f.feature.persistence.exec(`VACUUM INTO '${path}'`);
    const previous = new Database(path);
    previous.exec(
      "DROP TABLE document_placement_events; DROP TABLE document_placements; DROP TABLE document_rich_revisions; DROP TABLE document_trash; DROP TABLE document_folders; DROP TABLE project_document_libraries; DROP TABLE document_site_profiles; DROP TABLE document_revision_assets; PRAGMA user_version=2",
    );
    previous.close();
    for (let index = 0; index < 2; index++) {
      const db = openDocumentDatabase(path);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(db.query("SELECT content FROM document_revisions WHERE id=?").get(old.revision.id)).toEqual({
        content: f.content,
      });
      expect(db.query("SELECT * FROM document_assets").all()).toHaveLength(1);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    }
  } finally {
    f.close();
  }
});

test("build rewrites image nodes rather than matching an address in alt text", () => {
  const id = randomUUID(),
    original = `/api/document-assets/content?id=${id}`;
  const rewritten = buildImageReferences(`![${original}](${original})`).rewrite(new Map([[id, "/assets/actual.png"]]));
  expect(rewritten).toBe(`![${original}](/assets/actual.png)`);
});

test("a source edit during staging aborts the whole import before creating revisions", async () => {
  const f = await fixture();
  try {
    const stage = f.feature.assets.stage.bind(f.feature.assets);
    f.feature.assets.stage = async (...args) => {
      const result = await stage(...args);
      f.put(f.path, f.content + "\nChanged during staging");
      return result;
    };
    await expect(f.feature.service.importSource(f.space.id)).rejects.toThrow("conflict");
    expect(f.feature.service.listDocuments(f.space.id, "", 0).total).toBe(0);
    expect(f.feature.persistence.query("SELECT * FROM document_assets").all()).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("concurrent blob writers publish complete bytes and reject a corrupted preexisting blob", async () => {
  const { storeDocumentBlob } = await import("../../src/server/documents/blob-store.js");
  const { readdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "panda-blob-writers-"));
  try {
    const data = await png("red"),
      hash = digest(data);
    await Promise.all(Array.from({ length: 8 }, () => storeDocumentBlob(root, hash, data)));
    expect(readdirSync(root)).toEqual([hash]);
    expect(readFileSync(join(root, hash))).toEqual(data);
    writeFileSync(join(root, hash), "corrupt bytes");
    await expect(storeDocumentBlob(root, hash, data)).rejects.toThrow("sourceUnavailable");
    expect(readdirSync(root)).toEqual([hash]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
