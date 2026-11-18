import { expect, test } from "bun:test";
import { creativeText } from "../../src/server/creative/assets/text.js";
import {
  creativeFilePreview,
  creativeImportKind,
  creativeKindMatchesName,
} from "../../src/shared/creative/file-types.js";

test("passive online formats are separate from executable originals and arbitrary extension names", () => {
  for (const name of ["code.html", "script.svg", "archive.zip", "payload.__proto__", "payload.constructor", "unknown"])
    expect(creativeFilePreview(name).kind).toBe("download");
  expect(creativeImportKind("payload.constructor")).toBe("file");
  expect(creativeImportKind("picture.PNG")).toBe("image");
  expect(creativeFilePreview("report.PDF")).toEqual({ kind: "pdf", mime: "application/pdf" });
  expect(creativeFilePreview("original.XML")).toEqual({ kind: "text", mime: "text/plain; charset=utf-8" });
  expect(creativeKindMatchesName("image", "active.svg")).toBe(false);
  expect(creativeKindMatchesName("video", "clip.html")).toBe(false);
  expect(creativeKindMatchesName("file", "original.docx")).toBe(true);
});

test("large text previews stay bounded without modifying original text or splitting a surrogate pair", async () => {
  const bytes = Buffer.from("a".repeat(32767) + "🌏" + "完整内容".repeat(20000)),
    original = Buffer.from(bytes),
    preview = await creativeText("file", "notes.txt", bytes);
  expect(preview.text.length).toBeLessThanOrEqual(32768);
  expect(/[\uD800-\uDBFF]$/.test(preview.text)).toBe(false);
  expect(preview.previewTruncated).toBe(true);
  expect(bytes).toEqual(original);
});
