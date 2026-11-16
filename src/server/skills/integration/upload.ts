import { SKILL_BUNDLE_BYTES } from "../../../shared/skills/contracts.js";
import { skillOrigin } from "../../../shared/skills/registry-validation.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { decodeSkillBundle } from "../storage/codec.js";
import { SkillRegistryError } from "../errors.js";

/** Only source acquisition establishes origin; an upload cannot impersonate a repository or a built-in. */
export async function readSkillUpload(content: unknown, name: unknown) {
  if (typeof content !== "string" || content.length > SKILL_BUNDLE_BYTES) throw new SkillRegistryError("invalidInput");
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > SKILL_BUNDLE_BYTES) throw new SkillRegistryError("invalidInput");
  const origin = skillOrigin({ kind: "upload", name, sha256: await contentSha256(bytes) });
  try {
    return { pack: await decodeSkillBundle(bytes), origin };
  } catch (error) {
    if (error instanceof SkillRegistryError && error.code === "unavailable")
      throw new SkillRegistryError("invalidInput");
    throw error;
  }
}
