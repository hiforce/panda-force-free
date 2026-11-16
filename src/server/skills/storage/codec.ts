import { SKILL_LIMITS, SKILL_BUNDLE_BYTES, type VerifiedSkillPack } from "../../../shared/skills/contracts.js";
import { verifySkillResources, skillUtf8 } from "../../../shared/skills/resources.js";
import { SkillRegistryError } from "../errors.js";

export { SKILL_BUNDLE_BYTES } from "../../../shared/skills/contracts.js";
function data(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4) throw new SkillRegistryError("unavailable");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max || bytes.toString("base64") !== value) throw new SkillRegistryError("unavailable");
  return bytes;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new SkillRegistryError("unavailable");
  return value as Record<string, unknown>;
}
export function encodeSkillBundle(value: VerifiedSkillPack): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      manifest: Buffer.from(value.readManifest()).toString("base64"),
      files: value.resources.map((file) => ({
        path: file.path,
        data: Buffer.from(value.read(file.path)).toString("base64"),
      })),
    }),
  );
}
export async function decodeSkillBundle(bytes: Uint8Array): Promise<VerifiedSkillPack> {
  if (bytes.length > SKILL_BUNDLE_BYTES) throw new SkillRegistryError("unavailable");
  let raw: unknown;
  try {
    raw = JSON.parse(skillUtf8(bytes));
  } catch {
    throw new SkillRegistryError("unavailable");
  }
  const value = object(raw, ["schema", "manifest", "files"]);
  if (value.schema !== 1 || !Array.isArray(value.files) || value.files.length > SKILL_LIMITS.files)
    throw new SkillRegistryError("unavailable");
  let total = 0;
  const files = value.files.map((file) => {
    const row = object(file, ["path", "data"]);
    if (typeof row.path !== "string") throw new SkillRegistryError("unavailable");
    const bytes = data(row.data, SKILL_LIMITS.fileBytes);
    total += bytes.length;
    if (total > SKILL_LIMITS.totalBytes) throw new SkillRegistryError("unavailable");
    return { path: row.path, bytes };
  });
  return verifySkillResources(data(value.manifest, SKILL_LIMITS.manifestBytes), files);
}
