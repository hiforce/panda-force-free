import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authoredMarkdown } from "../../src/server/creation/integration/authored-markdown.js";
import { CreationAuthoredFiles } from "../../src/server/creation/integration/authored-files.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";

test("portable Markdown rewrites only owned image nodes and preserves literal IDs, code, structure and existing titles", () => {
  const id = randomUUID(),
    src = "/api/document-assets/content?id=" + id,
    body = richDocumentFromMarkdown(
      "# 需求文档\n\n保留文字 " +
        src +
        "\n\n```text\n" +
        src +
        "\n```\n\n![示意图](" +
        src +
        ")\n\n| 字段 | 必填 |\n| --- | --- |\n| 尺码 | 是 |\n",
    ),
    original = structuredClone(body),
    imagePath = "creation-assets-" + randomUUID() + "/" + "a".repeat(64) + ".png";
  const result = authoredMarkdown("需求文档", body, new Map([[id, imagePath]]));
  expect(result.match(/# 需求文档/g)).toHaveLength(1);
  expect(result).toContain("![示意图](" + imagePath + ")");
  expect(result.split(src)).toHaveLength(3);
  expect(result).toContain("```text");
  expect(result).toContain("尺码");
  expect(body).toEqual(original);
  expect(() => authoredMarkdown("需求文档", body)).toThrow("invalidOutput");
  expect(() => authoredMarkdown("需求文档", body, new Map([[id, "https://outside.invalid/image.png"]]))).toThrow(
    "invalidOutput",
  );
  expect(authoredMarkdown("追加标题", richDocumentFromMarkdown("## 正文\n\n内容"))).toStartWith(
    "# 追加标题\n\n## 正文",
  );
});
test("owned companion images preserve frozen original bytes and reject arbitrary names, formats and text masquerading as images", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-image-files-")),
    cwd = join(root, "workspace");
  await mkdir(cwd);
  try {
    const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jND8AAAAASUVORK5CYII=",
        "base64",
      ),
      original = Buffer.from(bytes),
      name = createHash("sha256").update(bytes).digest("hex") + ".png",
      files = new CreationAuthoredFiles(join(root, "state")),
      directory = { path: cwd, verify: async () => {} },
      id = randomUUID();
    const pending = files.writeImage("owner", id, directory, name, bytes);
    bytes.fill(0);
    await pending;
    expect(await readFile(join(cwd, name))).toEqual(original);
    await new CreationAuthoredFiles(join(root, "state")).writeImage("owner", id, directory, name, original);
    expect(await readdir(cwd)).toEqual([name]);
    await expect(files.writeImage("owner", randomUUID(), directory, "../escape.png", original)).rejects.toThrow(
      "invalidInput",
    );
    await expect(files.writeImage("owner", randomUUID(), directory, name, Buffer.from("Text"))).rejects.toThrow(
      "invalidInput",
    );
    await expect(files.write("owner", randomUUID(), directory, name, "Not an image")).rejects.toThrow("invalidInput");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
