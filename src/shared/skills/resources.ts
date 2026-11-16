import { contentSha256 } from "../packages/digest.js";
import { SKILL_LIMITS, type SkillResource, type SkillResourceStamp, type VerifiedSkillPack } from "./contracts.js";
import { SkillContractError, skillAssert } from "./errors.js";
import { validateSkillManifest } from "./manifest.js";
import { resourcePath } from "./manifest/identity.js";
import { text } from "./manifest/primitives.js";

export function skillUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillContractError("invalidResource");
  }
}
export function freezeSkillValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSkillValue(child);
    Object.freeze(value);
  }
  return value;
}
/** Source adapters own archive/transport checks; this verifier sees only explicitly declared inert resources. */
export async function verifySkillResources(
  manifestBytes: Uint8Array,
  source: Iterable<SkillResource>,
): Promise<VerifiedSkillPack> {
  skillAssert(
    manifestBytes instanceof Uint8Array && manifestBytes.byteLength <= SKILL_LIMITS.manifestBytes,
    "packageTooLarge",
    "manifest",
  );
  const raw = new Uint8Array(manifestBytes);
  let value: unknown;
  try {
    value = JSON.parse(skillUtf8(raw));
  } catch {
    throw new SkillContractError("invalidManifest");
  }
  const manifest = freezeSkillValue(validateSkillManifest(value)),
    declared = new Set(manifest.files),
    captured = new Map<string, Uint8Array>(),
    aliases = new Set<string>();
  let total = raw.length;
  // Capture all bytes before the first asynchronous hash; later caller mutations cannot alter verification.
  for (const item of source) {
    const path = resourcePath(item.path);
    skillAssert(!aliases.has(path.toLowerCase()), "invalidResourcePath", path);
    aliases.add(path.toLowerCase());
    skillAssert(declared.has(path), "invalidResourcePath", path);
    skillAssert(
      item.bytes instanceof Uint8Array && item.bytes.length <= SKILL_LIMITS.fileBytes,
      "packageTooLarge",
      path,
    );
    total += item.bytes.length;
    skillAssert(total <= SKILL_LIMITS.totalBytes && captured.size < SKILL_LIMITS.files, "packageTooLarge");
    skillAssert(
      /\.(?:md|txt|json|csv|png|jpe?g|webp)$/i.test(path) ||
        (path === manifest.license.file &&
          /^(?:licen[cs]e|copying|notice)(?:[-_][A-Za-z0-9_-]+)?$/i.test(path.split("/").at(-1)!)),
      "invalidResource",
      path,
    );
    captured.set(path, new Uint8Array(item.bytes));
  }
  skillAssert(captured.size === declared.size && manifest.files.every((path) => captured.has(path)), "missingResource");
  const read = (path: string) => {
    const data = captured.get(path);
    skillAssert(data, "missingResource", path);
    return new Uint8Array(data);
  };
  text(skillUtf8(read(manifest.license.file)), SKILL_LIMITS.fileBytes, "license", true);
  for (const skill of manifest.skills) {
    const instructions = read(skill.instructions);
    skillAssert(instructions.length <= SKILL_LIMITS.instructionBytes, "packageTooLarge", skill.instructions);
    text(skillUtf8(instructions), SKILL_LIMITS.instructionBytes, "instructions", true);
    if (skill.template) text(skillUtf8(read(skill.template)), SKILL_LIMITS.fileBytes, "template", true);
  }
  const manifestSha256 = await contentSha256(raw),
    resources: SkillResourceStamp[] = [];
  for (const path of [...manifest.files].sort())
    resources.push(
      Object.freeze({ path, byteLength: captured.get(path)!.length, sha256: await contentSha256(captured.get(path)!) }),
    );
  const digest = await contentSha256(
    "PandaForce-SkillPack-v1\n" +
      JSON.stringify([manifestSha256, resources.map((file) => [file.path, file.byteLength, file.sha256])]),
  );
  return Object.freeze({
    manifest,
    manifestSha256,
    digest,
    resources: Object.freeze(resources),
    byteLength: total,
    readManifest: () => new Uint8Array(raw),
    read,
    text: (path: string) => skillUtf8(read(path)),
  });
}
