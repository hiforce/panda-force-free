import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, symlink, truncate, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PublicationVariantFiles, VARIANT_FILE_LIMIT } from "../../src/server/publishing/variant-files.js";
import { parseContent } from "../../src/server/publishing/content/parse.js";
import { transformContent } from "../../src/server/publishing/variant-transform.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import { builtinChannelTemplates } from "../../src/shared/presentation/templates.js";

function content() {
  const ir = parseContent({
    projectId: "project",
    commit: "a".repeat(40),
    documentId: "doc",
    revisionId: "rev",
    title: "Title",
    locale: "en",
    content: "An immutable source.",
    engine: "markdown",
  });
  return {
    variant: transformContent(ir, "html", builtinChannelTemplates.resolve("technical"), builtinFormats().get("html")!),
    ir,
  };
}
test.concurrent(
  "variant files publish complete immutable bytes concurrently, survive reopening and refuse corrupt replacements",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-variant-files-"));
    try {
      const files = new PublicationVariantFiles(join(root, "artifacts")),
        data = content(),
        [first, second] = await Promise.all([files.put(data), files.put(data)]);
      expect(first).toBe(second);
      expect(await new PublicationVariantFiles(join(root, "artifacts")).read(first)).toEqual(data);
      const path = join(root, "artifacts", first + ".json");
      await writeFile(path, "corrupt");
      await expect(files.read(first)).rejects.toMatchObject({ status: 503 });
      await expect(files.put(data)).rejects.toMatchObject({ status: 503 });
      expect(await readFile(path, "utf8")).toBe("corrupt");
      await rm(path);
      const outside = join(root, "outside");
      await writeFile(outside, "private text");
      await symlink(outside, path);
      await expect(files.read(first)).rejects.toMatchObject({ status: 503 });
      expect(await readFile(outside, "utf8")).toBe("private text");
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
test.concurrent(
  "variant file reads do not create missing roots and enforce byte budgets before accepting sparse or oversized data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-variant-limits-"));
    try {
      const path = join(root, "missing"),
        files = new PublicationVariantFiles(path),
        data = content();
      await expect(files.read("a".repeat(64))).rejects.toMatchObject({ status: 503 });
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        files.put({ ...data, variant: { ...data.variant, title: "x".repeat(VARIANT_FILE_LIMIT) } }),
      ).rejects.toMatchObject({ status: 413 });
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      const digest = await files.put(data),
        file = join(path, digest + ".json");
      await truncate(file, VARIANT_FILE_LIMIT + 1);
      await expect(files.read(digest)).rejects.toMatchObject({ status: 503 });
      expect((await lstat(file)).size).toBe(VARIANT_FILE_LIMIT + 1);
      const alias = join(root, "alias");
      await symlink(path, alias);
      await expect(new PublicationVariantFiles(alias).read(digest)).rejects.toMatchObject({ status: 503 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
