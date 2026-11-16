import { test, expect } from "bun:test";
import { internalExecutionSkill } from "../../src/shared/skills/presentation.js";
import { skillTemplateSource } from "../../src/server/templates/integration/skill-source.js";
import { builtinWritingPack, builtinDocumentCreationPack } from "../../src/server/skills/builtin/writing.js";
import { builtinEssentialsPack } from "../../src/server/skills/builtin/essentials.js";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import type { InstalledSkillPack } from "../../src/shared/skills/registry.js";
import type { VerifiedSkillPack } from "../../src/shared/skills/contracts.js";
import { creationSkillCover, type CreationSkillEntry } from "../../src/client/creation/skill-views.js";
import { managedCover } from "../../src/client/templates/covers.js";
function installed(pack: VerifiedSkillPack, builtin = true): InstalledSkillPack {
  return {
    id: pack.manifest.id,
    version: pack.manifest.version,
    digest: pack.digest,
    manifest: pack.manifest,
    origin: builtin
      ? { kind: "builtin", id: pack.manifest.id }
      : { kind: "upload", name: "Writing Kit.zip", sha256: pack.digest },
    installedAt: 1,
    installedBy: "owner",
    removed: false,
    active: true,
    exports: pack.manifest.skills.map((s) => ({ id: s.id, enabled: true })),
    grants: ["project.documents.create"],
  };
}
test("internal execution scaffolds are excluded by trusted origin and identity, not the Writing name or workflow role", async () => {
  const base = installed(await builtinDocumentCreationPack());
  expect(internalExecutionSkill(base, base.manifest.skills[0]!)).toBe(true);
  expect(
    internalExecutionSkill(
      { ...base, origin: { kind: "upload", name: "Customer.zip", sha256: base.digest } },
      base.manifest.skills[0]!,
    ),
  ).toBe(false);
  const customer = installed((await nativeSkillPackage()).pack, false);
  expect(internalExecutionSkill(customer, customer.manifest.skills[0]!)).toBe(false);
  const packs = [installed(await builtinWritingPack()), base, installed(await builtinEssentialsPack()), customer];
  const source = await skillTemplateSource(() => ({ revision: 1, packages: packs, nextCursor: null })).read();
  expect(source.revision).toBe("skill-library-v2:1");
  expect(source.templates).toHaveLength(21);
  expect(
    source.templates.some(
      (t) =>
        t.reference.registry === "skills" &&
        ["panda-force.writing", "panda-force.document-creation"].includes(t.reference.packageId),
    ),
  ).toBe(false);
  expect(
    source.templates.find(
      (t) =>
        t.reference.registry === "skills" &&
        t.reference.packageId === customer.id &&
        t.reference.exportId === "writing",
    )?.templateType,
  ).toBe("panda.creation-workflow");
});
test("creation and library use identical authored covers and private raster references", async () => {
  const pack = installed(await builtinEssentialsPack());
  const source = await skillTemplateSource(() => ({ revision: 1, packages: [pack], nextCursor: null })).read();
  const definition = pack.manifest.skills[0]!;
  const entry: CreationSkillEntry = {
    reference: { packageId: pack.id, version: pack.version, digest: pack.digest, id: definition.id, parameters: {} },
    definition,
    name: pack.manifest.name,
    origin: pack.origin,
    publisher: pack.manifest.publisher.name,
    license: pack.manifest.license.expression,
    enabled: true,
    visible: true,
  };
  expect(creationSkillCover(entry)).toBe(managedCover(source.templates[0]!));
  const custom = { ...entry, definition: { ...definition, cover: { path: "cover.png", alt: { en: "Custom cover" } } } };
  const html = creationSkillCover(custom);
  expect(html).toContain("/api/skill-packs/cover?");
  expect(html).toContain("digest=" + pack.digest);
  expect(html).toContain("exportId=" + definition.id);
  expect(html).not.toContain("cover.png");
});
