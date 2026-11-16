import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocumentFeature } from "../../src/server/documents/feature.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";

function fixture() {
  const root = createTemporaryDirectory("panda-documents-", { preferMemory: true });
  const options = {
    stateRoot: join(root, "state"),
    allowedRoots: [root],
    requireProject: (id: string) => {
      if (id !== "project-a") throw new DocumentError("notFound", 404);
    },
  };
  return { root, options };
}
const managed = {
  projectId: "project-a",
  code: "handbook",
  name: "Handbook",
  engine: "markdown",
  sourceMode: "managed",
  locale: "en",
};
test("document revisions survive restart and stale writers cannot replace current drafts", async () => {
  const { root, options } = fixture();
  let feature = createDocumentFeature(options);
  const peer = createDocumentFeature(options);
  try {
    const space = await feature.service.createSpace(managed);
    const first = feature.service.createDocument({
      spaceId: space.id,
      path: "guide/start.md",
      title: "Start",
      locale: "en",
      content: "# Original\n\nKeep this.",
    });
    const saved = peer.service.saveDocument(first.document.id, {
      revision: 1,
      title: "Updated",
      locale: "en",
      content: "# Updated",
    });
    expect(saved.document.revision).toBe(2);
    expect(() =>
      feature.service.saveDocument(first.document.id, {
        revision: 1,
        title: "Stale",
        locale: "en",
        content: "Stale content",
      }),
    ).toThrow("conflict");
    expect(feature.service.documents.revision(first.document.id, first.revision.id).content).toContain("Original");
    feature.close();
    feature = createDocumentFeature(options);
    expect(feature.service.detail(first.document.id)).toEqual(saved);
    expect(feature.service.listDocuments(space.id, "START", 0).total).toBe(1);
    expect(feature.service.documents.revisions(first.document.id)).toHaveLength(2);
    await expect(feature.service.createSpace({ ...managed, code: "HANDBOOK" })).rejects.toThrow("duplicate");
  } finally {
    feature.close();
    peer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("Hexo ingestion is read-only, skips symlinks and preserves drafts on source refresh", async () => {
  const { root, options } = fixture(),
    feature = createDocumentFeature(options),
    source = join(root, "blog");
  mkdirSync(join(source, "source-zh", "_posts"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { hexo: "8.1.1" }, scripts: { build: "exit 99" } }),
  );
  const file = join(source, "source-zh", "_posts", "hello.md"),
    original = "---\ntitle: 你好\n---\n\n{% thesis %}\nKeep semantic tags.\n{% endthesis %}";
  writeFileSync(file, original);
  symlinkSync("/etc/passwd", join(source, "source-zh", "_posts", "escape.md"));
  try {
    const space = await feature.service.createSpace({
      ...managed,
      sourceMode: "external",
      engine: "hexo",
      sourceRoot: source,
    });
    const scan = await feature.service.importSource(space.id);
    expect(scan.created).toBe(1);
    expect(scan.skipped).toContain("source-zh/_posts/escape.md");
    const doc = feature.service.listDocuments(space.id, "", 0).documents[0]!;
    expect(doc.locale).toBe("zh-CN");
    expect(feature.service.detail(doc.id).revision.content).toBe(original);
    feature.service.saveDocument(doc.id, { revision: 1, title: "My edited title", locale: "zh-CN", content: original });
    expect(readFileSync(file, "utf8")).toBe(original);
    writeFileSync(file, original + "\nSource update.");
    const refresh = await feature.service.importSource(space.id);
    expect(refresh.conflicts).toEqual([doc.path]);
    expect(feature.service.detail(doc.id).document.title).toBe("My edited title");
    expect(feature.service.detail(doc.id).revision.content).toBe(original);
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("unmodified imports update without duplicating document identity", async () => {
  const { root, options } = fixture(),
    feature = createDocumentFeature(options),
    source = join(root, "manual");
  mkdirSync(source);
  const path = join(source, "intro.md");
  writeFileSync(path, "# First");
  try {
    const space = await feature.service.createSpace({ ...managed, sourceMode: "external", sourceRoot: source });
    await feature.service.importSource(space.id);
    const first = feature.service.listDocuments(space.id, "", 0).documents[0]!;
    expect((await feature.service.importSource(space.id)).unchanged).toBe(1);
    writeFileSync(path, "# Second");
    expect((await feature.service.importSource(space.id)).updated).toBe(1);
    const current = feature.service.listDocuments(space.id, "", 0).documents[0]!;
    expect(current.id).toBe(first.id);
    expect(current.revision).toBe(2);
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("document paths, allowed roots and project membership are validated", async () => {
  const { root, options } = fixture(),
    feature = createDocumentFeature(options);
  try {
    await expect(feature.service.createSpace({ ...managed, projectId: "missing" })).rejects.toThrow("notFound");
    await expect(feature.service.sources.inspect("/etc")).rejects.toThrow("outsideRoots");
    symlinkSync("/etc", join(root, "escape"));
    await expect(feature.service.sources.inspect(join(root, "escape"))).rejects.toThrow("outsideRoots");
    const space = await feature.service.createSpace(managed);
    for (const path of ["../secret.md", "/outside.md", "safe/../../file.md", ".env.md", "foo\\bar.md"]) {
      expect(() => feature.service.createDocument({ spaceId: space.id, path, title: "A", content: "Text" })).toThrow(
        "invalidInput",
      );
    }
    expect(() =>
      feature.service.createDocument({
        spaceId: space.id,
        path: "large.md",
        title: "A",
        content: "x".repeat(3 * 1024 * 1024),
      }),
    ).toThrow("tooLarge");
    expect(() => feature.service.listDocuments(space.id, "", -1)).toThrow("invalidInput");
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unambiguous source renames preserve document identity and independent drafts", async () => {
  const { root, options } = fixture(),
    feature = createDocumentFeature(options);
  const source = join(root, "source");
  mkdirSync(source);
  const original = join(source, "before.md");
  writeFileSync(original, "# Same content");
  try {
    const space = await feature.service.createSpace({ ...managed, sourceMode: "external", sourceRoot: source });
    await feature.service.importSource(space.id);
    const first = feature.service.listDocuments(space.id, "", 0).documents[0]!;
    feature.service.saveDocument(first.id, {
      title: "Independent title",
      content: "# Independent draft",
      locale: "en",
      revision: 1,
    });
    rmSync(original);
    mkdirSync(join(source, "guides"));
    writeFileSync(join(source, "guides", "renamed.md"), "# Same content");
    await feature.service.importSource(space.id);
    const page = feature.service.listDocuments(space.id, "", 0);
    expect(page.total).toBe(1);
    expect(page.documents[0]!.id).toBe(first.id);
    expect(page.documents[0]!.path).toBe("guides/renamed.md");
    expect(feature.service.detail(first.id).revision.content).toBe("# Independent draft");
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("language groups preserve identity, enforce one locale and unlink the original group owner", async () => {
  const { root, options } = fixture(),
    feature = createDocumentFeature(options);
  try {
    const space = await feature.service.createSpace(managed);
    const en = feature.service.createDocument({
      spaceId: space.id,
      path: "en.md",
      title: "English",
      locale: "en",
      content: "Original",
    });
    const zh = feature.service.createDocument({
      spaceId: space.id,
      path: "zh.md",
      title: "中文",
      locale: "zh-CN",
      content: "原稿",
    });
    const duplicate = feature.service.createDocument({
      spaceId: space.id,
      path: "en2.md",
      title: "Another",
      locale: "en",
      content: "Another",
    });
    expect(feature.languages.link(en.document.id, zh.document.id)).toHaveLength(2);
    expect(() => feature.languages.link(en.document.id, duplicate.document.id)).toThrow("languageConflict");
    expect(() =>
      feature.service.saveDocument(zh.document.id, { revision: 1, title: "Chinese", content: "Text", locale: "EN" }),
    ).toThrow("languageConflict");
    expect(feature.service.detail(zh.document.id).document.revision).toBe(1);
    expect(feature.languages.unlink(en.document.id).map((d) => d.id)).toEqual([en.document.id]);
    expect(feature.languages.list(zh.document.id).map((d) => d.id)).toEqual([zh.document.id]);
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document image assets keep original filenames, require valid bytes and remain addressable across restart", async () => {
  const { root, options } = fixture();
  let feature = createDocumentFeature(options);
  try {
    const space = await feature.service.createSpace(managed);
    const doc = feature.service.createDocument({ spaceId: space.id, path: "a.md", title: "A", content: "" });
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const asset = await feature.assets.upload(doc.document.id, "original name.png", png);
    expect(asset.name).toBe("original name.png");
    expect(asset.width).toBe(20);
    expect(asset.mime).toBe("image/png");
    await expect(
      feature.assets.upload(doc.document.id, "spoof.png", Buffer.from('<svg onload="alert(1)"/>')),
    ).rejects.toThrow("invalidImage");
    await expect(feature.assets.upload(doc.document.id, "../escape.png", png)).rejects.toThrow("invalidInput");
    await expect(feature.assets.upload("missing", "original.png", png)).rejects.toThrow("notFound");
    feature.close();
    feature = createDocumentFeature(options);
    expect(feature.assets.list(doc.document.id)[0]!.id).toBe(asset.id);
    expect((await feature.assets.content(asset.id)).bytes).toEqual(png);
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docusaurus ingestion retains MDX and never runs project hooks", async () => {
  const { root, options } = fixture(),
    feature = createDocumentFeature(options);
  const source = join(root, "site");
  mkdirSync(join(source, "docs"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { "@docusaurus/core": "3.10.2" }, scripts: { build: "touch should-not-exist" } }),
  );
  const mdx = "import Card from './Card';\n\n# Handbook\n\n<Card secret={process.env.SECRET} />";
  writeFileSync(join(source, "docs", "hello.mdx"), mdx);
  try {
    const inspection = await feature.service.sources.inspect(source);
    expect(inspection.engine).toBe("docusaurus");
    expect(inspection.sourceDirectories).toEqual(["docs"]);
    const space = await feature.service.createSpace({
      ...managed,
      engine: "docusaurus",
      sourceMode: "external",
      sourceRoot: source,
    });
    expect((await feature.service.importSource(space.id)).created).toBe(1);
    const record = feature.service.listDocuments(space.id, "", 0).documents[0]!;
    expect(feature.service.detail(record.id).revision.content).toBe(mdx);
    expect(readFileSync(join(source, "docs", "hello.mdx"), "utf8")).toBe(mdx);
    expect(() => readFileSync(join(source, "should-not-exist"))).toThrow();
  } finally {
    feature.close();
    rmSync(root, { recursive: true, force: true });
  }
});
