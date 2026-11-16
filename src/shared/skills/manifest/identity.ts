import { skillAssert } from "../errors.js";
import { record, text } from "./primitives.js";
export function packageId(value: unknown): string {
  const id = text(value, 96, "id");
  skillAssert(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id), "invalidIdentity", "id");
  return id;
}
export function localId(value: unknown): string {
  const id = text(value, 64, "skill.id");
  skillAssert(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id), "invalidIdentity", "skill.id");
  return id;
}
export function version(value: unknown): string {
  const result = text(value, 20, "version");
  skillAssert(
    /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(result),
    "invalidIdentity",
    "version",
  );
  return result;
}
export function compareVersions(left: string, right: string): number {
  const a = version(left).split(".").map(Number),
    b = version(right).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
export function resourcePath(value: unknown): string {
  const path = text(value, 240, "files");
  skillAssert(
    path
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
          !/^(?:node_modules|credentials?|auth\.json|id_rsa|id_ed25519)$/i.test(part),
      ),
    "invalidResourcePath",
    "files",
  );
  return path;
}
/** Prefix spellings and file/directory collisions must agree on case-insensitive hosts too. */
export function validateResourcePaths(paths: readonly string[]): void {
  const files = new Set(paths),
    spellings = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/"),
        folded = prefix.toLowerCase(),
        prior = spellings.get(folded);
      skillAssert(prior === undefined || prior === prefix, "invalidResourcePath", "files");
      spellings.set(folded, prefix);
      skillAssert(index === parts.length || !files.has(prefix), "invalidResourcePath", "files");
    }
  }
}
export function locale(value: unknown): string {
  const tag = text(value, 32, "locale");
  skillAssert(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(tag), "invalidManifest", "locale");
  try {
    return Intl.getCanonicalLocales(tag)[0]!;
  } catch {
    skillAssert(false, "invalidManifest", "locale");
  }
}
export function localized(value: unknown, max: number, multiline = false): Readonly<Record<string, string>> {
  skillAssert(value && typeof value === "object" && !Array.isArray(value), "invalidManifest", "localized");
  const source = record(value, Object.keys(value)),
    result: Record<string, string> = {};
  skillAssert(Object.keys(source).length <= 30 && Object.hasOwn(source, "en"), "invalidManifest", "localized.en");
  for (const [key, item] of Object.entries(source)) {
    const canonical = locale(key);
    skillAssert(!Object.hasOwn(result, canonical), "invalidManifest", "localized");
    result[canonical] = text(item, max, "localized", multiline);
  }
  return result;
}
export function qualifiedSkill(value: unknown): string {
  const result = text(value, 161, "conflictsWith"),
    parts = result.split("/");
  skillAssert(parts.length === 2, "invalidIdentity", "conflictsWith");
  packageId(parts[0]);
  localId(parts[1]);
  return result;
}
