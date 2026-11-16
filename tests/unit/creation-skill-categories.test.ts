import { expect, test } from "bun:test";
import { builtinEssentialsPack } from "../../src/server/skills/builtin/essentials.js";
import { defaultSkillWorkspace } from "../../src/shared/skill-workspace.js";
import { templateLineageKey } from "../../src/shared/templates/catalog.js";
import { creationSkillInCategory } from "../../src/client/creation/skill-categories.js";
import { creationSkillReference, type CreationSkillEntry } from "../../src/client/creation/skill-views.js";

test("configured categories use defaults until explicit assignments replace them across versions", async () => {
  const pack = await builtinEssentialsPack(),
    manifest = pack.manifest;
  const entry: CreationSkillEntry = {
    reference: {
      packageId: manifest.id,
      version: manifest.version,
      digest: pack.digest,
      id: "research-digest",
      parameters: {},
    },
    definition: manifest.skills.find((value) => value.id === "research-digest")!,
    name: manifest.name,
    origin: { kind: "builtin", id: manifest.id },
    publisher: manifest.publisher.name,
    license: manifest.license.expression,
    enabled: true,
    visible: true,
  };
  expect(entry.definition.outputTypes).toContain("document");
  expect(creationSkillInCategory(entry, "writing", null)).toBe(false);
  expect(creationSkillInCategory(entry, "research", defaultSkillWorkspace())).toBe(true);
  expect(creationSkillInCategory(entry, "all", null)).toBe(true);
  const workspace = defaultSkillWorkspace(),
    category = "custom-00000000-0000-0000-0000-000000000001";
  workspace.categories.push({
    id: category,
    name: { en: "My picks", "zh-CN": "我的常用" },
    builtin: false,
    icon: "folder",
  });
  workspace.assignments[templateLineageKey(creationSkillReference(entry.reference))] = [category, "writing", "missing"];
  expect(creationSkillInCategory(entry, category, workspace)).toBe(true);
  workspace.assignmentOverrides = [templateLineageKey(creationSkillReference(entry.reference))];
  expect(creationSkillInCategory(entry, "writing", workspace)).toBe(true);
  expect(creationSkillInCategory(entry, "research", workspace)).toBe(false);
  expect(creationSkillInCategory(entry, "missing", workspace)).toBe(false);
  expect(
    creationSkillInCategory(
      { ...entry, reference: { ...entry.reference, version: "2.0.0", digest: "a".repeat(64) } },
      category,
      workspace,
    ),
  ).toBe(true);
  expect(
    creationSkillInCategory({ ...entry, reference: { ...entry.reference, id: "software-prd" } }, category, workspace),
  ).toBe(false);
  workspace.categories = workspace.categories.filter((value) => value.id !== category);
  expect(creationSkillInCategory(entry, category, workspace)).toBe(false);
});
