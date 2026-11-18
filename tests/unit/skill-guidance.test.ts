import { creationDeliveryInstructions } from "../../src/server/creation/delivery-instructions.js";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { composeSkills } from "../../src/shared/skills/composition.js";
import { decodeSkillComposition } from "../../src/shared/skills/capture-codec.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { SKILL_CAPABILITIES } from "../../src/shared/skills/contracts.js";

async function pack(change?: (manifest: any) => void) {
  const root = new URL("../fixtures/skill-packs/writing-kit/", import.meta.url),
    raw = new Uint8Array(await readFile(new URL("panda-skills.json", root))),
    manifest = JSON.parse(new TextDecoder().decode(raw));
  const resources = await Promise.all(
    manifest.files.map(async (path: string) => ({ path, bytes: new Uint8Array(await readFile(new URL(path, root))) })),
  );
  change?.(manifest);
  return verifySkillResources(change ? new TextEncoder().encode(JSON.stringify(manifest)) : raw, resources);
}
const authority = {
  applicationVersion: "0.0.21",
  outputType: "image" as const,
  available: new Set(SKILL_CAPABILITIES),
  granted: new Set(SKILL_CAPABILITIES),
  entitled: new Set<string>(),
  guidanceOnly: true,
};

test("application guidance preserves immutable planning content without claiming the package renders the final artifact", async () => {
  const p = await pack(),
    before = p.readManifest(),
    selection = { pack: p, id: "blog-outline", parameters: { audience: "Readers" } },
    compiled = composeSkills([selection], authority);
  expect(compiled.mode).toBe("guidance");
  expect(compiled.outputType).toBe("image");
  expect(compiled.skills[0]!.instructions).toBe(
    p.text(p.manifest.skills.find((s) => s.id === "blog-outline")!.instructions),
  );
  expect(compiled.capabilities).not.toContain("generate.image");
  expect(p.readManifest()).toEqual(before);
  expect(p.manifest.skills[1]!.outputTypes).toEqual(["document"]);
  expect(decodeSkillComposition(compiled)).toEqual(compiled);
  expect(() => composeSkills([selection], { ...authority, guidanceOnly: false, workflowRequired: false })).toThrow(
    "incompatibleOutput",
  );
});

test("guidance does not bypass grants, compatibility, entitlements, role or constraint conflicts", async () => {
  const p = await pack(),
    workflow = { pack: p, id: "writing", parameters: {} };
  expect(() => composeSkills([workflow], { ...authority, granted: new Set() })).toThrow("capabilityUnavailable");
  expect(() => composeSkills([workflow], { ...authority, available: new Set() })).toThrow("capabilityUnavailable");
  const restricted = await pack((manifest) => {
    manifest.requires.pandaForce = { min: "0.0.20" };
  });
  expect(() =>
    composeSkills([{ ...workflow, pack: restricted }], { ...authority, applicationVersion: "0.0.1" }),
  ).toThrow();
  const other = await pack((manifest) => {
    manifest.id = "example.other-kit";
  });
  expect(() => composeSkills([workflow, { ...workflow, pack: other }], authority)).toThrow("workflowRequired");
  const conflict = await pack((manifest) => {
    manifest.skills[0].composition.constraints.brand = "a";
    manifest.skills[1].composition.constraints.brand = "b";
  });
  expect(() =>
    composeSkills(
      [
        { pack: conflict, id: "writing", parameters: {} },
        { pack: conflict, id: "blog-outline", parameters: { audience: "Readers" } },
      ],
      authority,
    ),
  ).toThrow("conflictingConstraints");
  const paid = await pack((manifest) => {
    manifest.skills[2].entitlement = { issuer: "https://issuer.example", product: "voice-pro" };
  });
  expect(() => composeSkills([{ pack: paid, id: "brand-voice", parameters: {} }], authority)).toThrow(
    "entitlementRequired",
  );
  expect(() => composeSkills([workflow, workflow], authority)).toThrow("duplicateSkill");
  expect(() => decodeSkillComposition({ ...composeSkills([], authority), mode: "renderer" })).toThrow();
});

test("an empty skill selection is explicit application guidance, while legacy workflows keep their validation", () => {
  const compiled = composeSkills([], authority);
  expect(compiled.skills).toEqual([]);
  expect(compiled.capabilities).toEqual([]);
  expect(decodeSkillComposition(compiled)).toEqual(compiled);
  expect(() => decodeSkillComposition({ ...compiled, mode: undefined })).toThrow();
  expect(() => composeSkills([], { ...authority, guidanceOnly: false })).toThrow("workflowRequired");
});

test("application delivery instructions keep final artifact choice above planning text", () => {
  for (const kind of ["image", "slides", "video", "web"] as const) {
    const text = creationDeliveryInstructions(kind);
    expect(text).toContain("final artifact type: " + kind);
    expect(text).toContain("Never silently replace");
    expect(text).toContain("panda_artifacts_save");
    expect(text).toContain("actual saved artifact receipt");
    expect(text).not.toContain("can save editable documents only");
  }
});
