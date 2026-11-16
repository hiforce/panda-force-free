import { readFile } from "node:fs/promises";
import type { SkillPackManifest } from "../../src/shared/skills/contracts.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { encodeSkillBundle } from "../../src/server/skills/storage/codec.js";

export async function nativeSkillPackage(id = "example.writing-kit", version = "1.0.0") {
  const source = new URL("../fixtures/skill-packs/writing-kit/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("panda-skills.json", source), "utf8")) as SkillPackManifest;
  manifest.id = id;
  manifest.version = version;
  const pack = await verifySkillResources(
    new TextEncoder().encode(JSON.stringify(manifest)),
    await Promise.all(
      manifest.files.map(async (path) => ({ path, bytes: new Uint8Array(await readFile(new URL(path, source))) })),
    ),
  );
  return { pack, content: new TextDecoder().decode(encodeSkillBundle(pack)) };
}
