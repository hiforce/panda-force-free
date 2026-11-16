import { createHash } from "node:crypto";
import type { SkillRegistryStore } from "../ports.js";
import type { SkillCatalog } from "../catalog/service.js";
import { SkillRegistryError } from "../errors.js";
import { builtinWritingPack, builtinDocumentCreationPack } from "./writing.js";
import type { VerifiedSkillPack } from "../../../shared/skills/contracts.js";
export async function seedBuiltinWriting(registry: SkillRegistryStore, catalog: SkillCatalog): Promise<void> {
  await seedBuiltinPack(registry, catalog, await builtinWritingPack(), ["writing"]);
  await seedBuiltinPack(registry, catalog, await builtinDocumentCreationPack(), ["writing"]);
}
export async function seedBuiltinPack(
  registry: SkillRegistryStore,
  catalog: SkillCatalog,
  pack: VerifiedSkillPack,
  selected = pack.manifest.skills.map((skill) => skill.id),
) {
  // Prior installation, removal and activation choices survive application restarts and upgrades.
  if (await registry.known(pack.manifest.id)) return;
  const hex = createHash("sha256")
      .update("PandaForce builtin skill " + pack.digest)
      .digest("hex"),
    id =
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-5" +
      hex.slice(13, 16) +
      "-a" +
      hex.slice(17, 20) +
      "-" +
      hex.slice(20, 32),
    origin = { kind: "builtin", id: pack.manifest.id };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await registry.known(pack.manifest.id)) return;
    const review = await catalog.review(pack, origin, selected);
    try {
      await catalog.install(
        pack,
        origin,
        {
          id,
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
          capabilities: review.capabilities,
        },
        "system:builtin-skills",
      );
      return;
    } catch (error) {
      if (await registry.known(pack.manifest.id)) return;
      if (
        !(error instanceof SkillRegistryError) ||
        !["registryConflict", "reviewChanged"].includes(error.code) ||
        attempt === 2
      )
        throw error;
    }
  }
}
