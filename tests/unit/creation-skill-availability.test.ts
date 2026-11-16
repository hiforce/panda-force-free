import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { builtinEssentialsPack } from "../../src/server/skills/builtin/essentials.js";
import {
  creationSkillOptions,
  selectedCreationSkill,
  type CreationSkillEntry,
} from "../../src/client/creation/skill-views.js";
import type { Translate } from "../../src/shared/i18n/messages.js";
import type { InstalledSkillPack } from "../../src/shared/skills/registry.js";
import { availableInstalledSkill } from "../../src/shared/skills/availability.js";

const t = ((key: string) => key) as Translate;

test("use eligibility rejects inactive, removed, disabled, unapproved and unentitled skills", async () => {
  const verified = await builtinEssentialsPack(),
    skill = verified.manifest.skills[0]!,
    pack: InstalledSkillPack = {
      id: verified.manifest.id,
      version: verified.manifest.version,
      digest: verified.digest,
      manifest: verified.manifest,
      origin: { kind: "builtin", id: verified.manifest.id },
      installedAt: 1,
      installedBy: "owner",
      removed: false,
      active: true,
      exports: [{ id: skill.id, enabled: true }],
      grants: [...skill.capabilities],
    };
  expect(availableInstalledSkill(pack, skill)).toBe(true);
  expect(availableInstalledSkill({ ...pack, active: false }, skill)).toBe(false);
  expect(availableInstalledSkill({ ...pack, removed: true }, skill)).toBe(false);
  expect(availableInstalledSkill({ ...pack, exports: [{ id: skill.id, enabled: false }] }, skill)).toBe(false);
  expect(availableInstalledSkill({ ...pack, exports: [] }, skill)).toBe(false);
  expect(
    availableInstalledSkill({ ...pack, grants: [] }, { ...skill, capabilities: ["project.documents.create"] }),
  ).toBe(false);
  expect(
    availableInstalledSkill(pack, { ...skill, entitlement: { issuer: "https://vendor.example", product: "paid" } }),
  ).toBe(false);
});

test("document skill candidates omit unavailable versions in all, search and category views without changing entry indexes", async () => {
  const pack = await builtinEssentialsPack(),
    definition = pack.manifest.skills[0]!,
    entry: CreationSkillEntry = {
      reference: {
        packageId: pack.manifest.id,
        version: "1.0.2",
        digest: pack.digest,
        id: definition.id,
        parameters: {},
      },
      definition,
      name: pack.manifest.name,
      origin: { kind: "builtin", id: pack.manifest.id },
      publisher: pack.manifest.publisher.name,
      license: pack.manifest.license.expression,
      visible: true,
      enabled: true,
    },
    entries: CreationSkillEntry[] = [
      { ...entry, reference: { ...entry.reference, version: "1.0.0" }, enabled: false },
      { ...entry, reference: { ...entry.reference, version: "1.0.1" }, enabled: false },
      entry,
      { ...entry, reference: { ...entry.reference, packageId: "private.scaffold" }, visible: false },
    ],
    previous = Object.getOwnPropertyDescriptor(globalThis, "document"),
    dom = new JSDOM('<html lang="en"></html>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  try {
    for (const [query, category] of [
      ["", undefined],
      [definition.id, undefined],
      ["", () => true],
      [definition.id, () => true],
    ] as const) {
      const html = creationSkillOptions(t, entries, [], query, false, category),
        rendered = JSDOM.fragment(html);
      expect(rendered.querySelectorAll(".creation-skill-option")).toHaveLength(1);
      expect(rendered.querySelector("[data-skill-action=add]")?.getAttribute("data-index")).toBe("2");
      expect(html).not.toContain("v1.0.0");
      expect(html).not.toContain("v1.0.1");
      expect(html).not.toContain("private.scaffold");
      expect(html).not.toContain("creation.skillUnavailable");
    }
    const selected = entries[0]!;
    const html = selectedCreationSkill(t, selected.reference, 0, 1, selected, "", false);
    expect(html).toContain("creation.skillUnavailable");
    expect(html).toContain('data-skill-action="remove"');
    expect(creationSkillOptions(t, [selected], [], "", false)).toContain("creation.noSkills");
    expect(creationSkillOptions(t, [selected], [], "", true)).toContain("creation.loadingSkill");
    expect(creationSkillOptions(t, [selected], [], definition.id, false)).toContain("creation.noSkillMatches");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});
