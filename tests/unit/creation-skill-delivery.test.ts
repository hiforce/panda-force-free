import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { builtinEssentialsPack } from "../../src/server/skills/builtin/essentials.js";
import { creationSkillDelivery, creationSkillDeliveryNotice } from "../../src/client/creation/skill-delivery.js";
import { serverTranslator } from "../../src/server/i18n/messages.js";

test("media categories disclose their immutable document output in every supported locale", async () => {
  const pack = await builtinEssentialsPack(),
    digest = pack.digest,
    manifest = pack.readManifest(),
    entries = pack.manifest.skills.filter((skill) => ["image", "slides", "video", "web"].includes(skill.category));
  expect(entries).toHaveLength(8);
  for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"] as const) {
    const t = serverTranslator(locale);
    for (const skill of entries) {
      const description = creationSkillDelivery(t, skill),
        notice = JSDOM.fragment(creationSkillDeliveryNotice(t, skill));
      expect(description).toBeTruthy();
      expect(description).not.toContain("creation.");
      expect(notice.querySelector(".creation-skill-delivery")?.textContent).toBe(description);
    }
  }
  expect(pack.digest).toBe(digest);
  expect(pack.readManifest()).toEqual(manifest);
});

test("output declarations take precedence over category labels for uploaded and future rendered skills", async () => {
  const pack = await builtinEssentialsPack(),
    t = serverTranslator("en"),
    skill = pack.manifest.skills.find((item) => item.id === "science-illustration")!;
  expect(creationSkillDelivery(t, { ...skill, id: "custom-upload", name: { en: "Custom" } })).toBeTruthy();
  expect(creationSkillDelivery(t, { ...skill, outputTypes: ["image"] })).toBe("");
  expect(creationSkillDelivery(t, { ...skill, outputTypes: ["image", "document"] })).toBe("");
  expect(creationSkillDelivery(t, { ...skill, category: "writing" })).toBe("");
  expect(creationSkillDelivery(t, { ...skill, category: "research" })).toBe("");
});
