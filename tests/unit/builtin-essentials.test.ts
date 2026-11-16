import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { builtinEssentialsPack, essentialSkills } from "../../src/server/skills/builtin/essentials.js";
import { builtinDocumentCreationPack } from "../../src/server/skills/builtin/writing.js";
import { seedBuiltinPack } from "../../src/server/skills/builtin/seed.js";
import { composeSkills } from "../../src/shared/skills/composition.js";
import { openSkillDatabase } from "../../src/server/skills/storage/database.js";
import { SqliteSkillRegistry } from "../../src/server/skills/storage/repository.js";
import { FileSkillBundles } from "../../src/server/skills/storage/bundles.js";
import { SkillCatalog } from "../../src/server/skills/catalog/service.js";
import { skillTemplateSource } from "../../src/server/templates/integration/skill-source.js";
import { TemplateCatalog } from "../../src/server/templates/catalog.js";
import { encodeSkillBundle, decodeSkillBundle } from "../../src/server/skills/storage/codec.js";

test("curated guides compose with the document workflow without granting tools or claiming rendered outputs", async () => {
  const pack = await builtinEssentialsPack(),
    workflow = await builtinDocumentCreationPack();
  const roundtrip = await decodeSkillBundle(encodeSkillBundle(pack));
  expect(pack.manifest.skills).toHaveLength(18);
  expect(roundtrip.digest).toBe(pack.digest);
  expect(new Set(pack.manifest.skills.map((s) => s.category)).size).toBe(6);
  const bodies = new Set();
  for (const skill of pack.manifest.skills) {
    expect(skill.name.en).toBeTruthy();
    expect(skill.name["zh-CN"]).toBeTruthy();
    expect(skill.description.en).toBeTruthy();
    expect(skill.readme?.["zh-CN"]).toContain("交付物：可编辑文档");
    const content = pack.text(skill.instructions);
    bodies.add(content);
    expect(content).toContain("## Quality review");
    expect(content).toContain("actual save receipt");
    const composed = composeSkills(
      [
        { pack: workflow, id: "writing", parameters: {} },
        { pack, id: skill.id, parameters: { audience: "Product team", depth: "concise" } },
      ],
      {
        applicationVersion: "0.0.16",
        outputType: "document",
        available: new Set(["project.documents.create"]),
        granted: new Set(["project.documents.create"]),
        entitled: new Set(),
      },
    );
    expect(composed.capabilities).toEqual(["project.documents.create"]);
    expect(composed.skills[1]!.parameters).toEqual({ audience: "Product team", depth: "concise" });
    expect(composed.skills[1]!.instructions).toBe(content);
    expect(roundtrip.text(skill.instructions)).toBe(content);
  }
  expect(bodies.size).toBe(18);
  expect(essentialSkills.find((s) => s.id === "meeting-notes")!.checks.join(" ")).toContain(
    "decision without evidence",
  );
  expect(pack.text("guides/software-prd.md")).toContain("stable requirement IDs");
});

test("one-time seeding survives concurrent starts, user disable/remove and durable reopen; categories remain distinct from output types", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-essentials-")),
    path = join(root, "skills.sqlite"),
    pack = await builtinEssentialsPack();
  let db = openSkillDatabase(path);
  try {
    let registry = new SqliteSkillRegistry(db),
      bundles = new FileSkillBundles(join(root, "bundles")),
      catalog = new SkillCatalog(registry, bundles, "0.0.16");
    await Promise.all([seedBuiltinPack(registry, catalog, pack), seedBuiltinPack(registry, catalog, pack)]);
    expect(registry.revision()).toBe(1);
    const installed = registry.get(pack.manifest.id, "1.0.0")!;
    expect(installed.grants).toEqual([]);
    expect(installed.exports.filter((e) => e.enabled)).toHaveLength(18);
    const directory = new TemplateCatalog([skillTemplateSource((cursor, limit) => catalog.list(cursor, limit))]);
    for (const category of ["writing", "research", "slides", "image", "web", "video"] as const) {
      const page = await directory.list({ section: category, registry: "skills" });
      expect(page.total).toBe(essentialSkills.filter((s) => s.category === category).length);
      expect(page.templates.every((item) => item.categories.includes(category))).toBe(true);
      expect(page.templates.every((item) => item.compatibility.outputs.includes("document"))).toBe(true);
    }
    await catalog.setExports(
      {
        operationId: randomUUID(),
        id: pack.manifest.id,
        version: "1.0.0",
        expectedRevision: registry.revision(),
        exports: installed.exports.map((e) => ({ ...e, enabled: e.id !== "software-prd" })),
      },
      "owner:test",
    );
    await seedBuiltinPack(registry, catalog, pack);
    expect(registry.get(pack.manifest.id, "1.0.0")!.exports.find((e) => e.id === "software-prd")!.enabled).toBe(false);
    await catalog.remove(
      { operationId: randomUUID(), id: pack.manifest.id, version: "1.0.0", expectedRevision: registry.revision() },
      "owner:test",
    );
    const revision = registry.revision();
    db.close();
    db = openSkillDatabase(path);
    registry = new SqliteSkillRegistry(db);
    bundles = new FileSkillBundles(join(root, "bundles"));
    catalog = new SkillCatalog(registry, bundles, "0.0.16");
    await seedBuiltinPack(registry, catalog, pack);
    expect(registry.revision()).toBe(revision);
    expect(registry.get(pack.manifest.id, "1.0.0")!.removed).toBe(true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrading an existing installation adds the collection while preserving the established workflow", async () => {
  const { seedBuiltinWriting } = await import("../../src/server/skills/builtin/seed.js");
  const root = await mkdtemp(join(tmpdir(), "panda-essentials-upgrade-")),
    path = join(root, "skills.sqlite");
  let db = openSkillDatabase(path);
  try {
    let registry = new SqliteSkillRegistry(db),
      bundles = new FileSkillBundles(join(root, "bundles")),
      catalog = new SkillCatalog(registry, bundles, "0.0.16");
    await seedBuiltinWriting(registry, catalog);
    const prior = registry.get("panda-force.document-creation", "1.0.0")!;
    expect(registry.known("panda-force.essentials")).toBe(false);
    db.close();
    db = openSkillDatabase(path);
    registry = new SqliteSkillRegistry(db);
    bundles = new FileSkillBundles(join(root, "bundles"));
    catalog = new SkillCatalog(registry, bundles, "0.0.16");
    await seedBuiltinWriting(registry, catalog);
    await seedBuiltinPack(registry, catalog, await builtinEssentialsPack());
    expect(registry.get("panda-force.document-creation", "1.0.0")).toEqual(prior);
    expect(registry.get("panda-force.essentials", "1.0.0")!.exports.filter((e) => e.enabled)).toHaveLength(18);
    expect(registry.revision()).toBe(3);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
