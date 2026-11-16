import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { localizedPresentation, localizedText } from "../../src/shared/presentation/localized.js";
import { presentationText } from "../../src/shared/presentation/labels.js";
import { validateSkillManifest } from "../../src/shared/skills/manifest.js";
import { RasterCoverRenderer } from "../../src/server/media/raster-cover.js";

const manifest = () => JSON.parse(readFileSync("tests/fixtures/skill-packs/writing-kit/panda-skills.json", "utf8"));
test("metadata falls back independently and preserves description-only translations", () => {
  const label = localizedPresentation(
    { en: "PRD writer", zh: "需求写作" },
    { en: "English brief", "fr-CA": "Résumé", zh: "中文简介" },
  );
  const t = (() => "") as Parameters<typeof presentationText>[0];
  expect(presentationText(t, label, "description", "fr-CA")).toBe("Résumé");
  expect(presentationText(t, label, "name", "fr-CA")).toBe("PRD writer");
  expect(presentationText(t, label, "description", "zh-Hant-TW")).toBe("中文简介");
  expect(localizedText({ en: "English", "zh-CN": "简体" }, "zh-TW")).toBe("English");
  expect(localizedText({ en: "English", "fr-CA": "Français" }, "FR-ca")).toBe("Français");
});
test("optional localized covers remain declared raster resources and do not invalidate old skill packages", () => {
  expect(validateSkillManifest(manifest()).skills[1]!.cover).toBeUndefined();
  const value = manifest();
  value.skills[1].cover = { path: "artwork/cover.webp", alt: { en: "A PRD", "zh-CN": "需求说明" } };
  value.skills[1].readme = { en: "An introduction.", "zh-CN": "技能介绍。" };
  expect(() => validateSkillManifest(value)).toThrow();
  value.files.push("artwork/cover.webp");
  expect(validateSkillManifest(value).skills[1]!.cover?.alt["zh-CN"]).toBe("需求说明");
  value.skills[1].cover.path = "https://untrusted.invalid/cover.webp";
  expect(() => validateSkillManifest(value)).toThrow();
  value.files.push("artwork/cover.svg");
  value.skills[1].cover.path = "artwork/cover.svg";
  expect(() => validateSkillManifest(value)).toThrow();
});
test("cover rendering decodes raster content and returns detached bounded derivatives", async () => {
  const renderer = new RasterCoverRenderer();
  const original = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#dfe6ef" } })
    .png()
    .toBuffer();
  const cover = await renderer.render(original),
    checked = await sharp(cover).metadata();
  expect([checked.format, checked.width, checked.height]).toEqual(["webp", 960, 600]);
  const saved = new Uint8Array(cover);
  cover.fill(0);
  expect(new Uint8Array(await renderer.render(original))).toEqual(saved);
  await expect(
    renderer.render(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')),
  ).rejects.toThrow();
  await expect(renderer.render(new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow();
  await expect(renderer.render(new TextEncoder().encode("<!doctype html><h1>Not an image</h1>"))).rejects.toThrow();
});

test("a cold gallery queues distinct covers within bounded decode concurrency", async () => {
  const renderer = new RasterCoverRenderer();
  const inputs = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      sharp({ create: { width: 16, height: 16, channels: 3, background: { r: index * 20, g: 100, b: 80 } } })
        .png()
        .toBuffer(),
    ),
  );
  const result = await Promise.all(inputs.map((input) => renderer.render(input)));
  expect(result.length).toBe(12);
  for (const image of result) expect((await sharp(image).metadata()).width).toBe(960);
});
