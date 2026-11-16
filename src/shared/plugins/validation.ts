import { PluginPackageError } from "./contracts.js";

export function packageRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new PluginPackageError("invalidPackage");
  return value as Record<string, unknown>;
}
export function packageText(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim()) ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value.replace(/[\t\n\r]/g, ""))
  )
    throw new PluginPackageError("invalidPackage");
  return value;
}
export function packageId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) ||
    value.length < 3 ||
    value.length > 40 ||
    value === "panda" ||
    value.startsWith("panda.") ||
    value.startsWith("panda-")
  )
    throw new PluginPackageError("invalidPackage");
  return value;
}
export function packageVersion(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(value))
    throw new PluginPackageError("invalidPackage");
  return value;
}
export function packageExportId(value: unknown, prefix: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) ||
    `${prefix}.${value}`.length > 64
  )
    throw new PluginPackageError("invalidPackage");
  return value;
}
/** A single POSIX spelling prevents traversal, platform aliases and hidden credential/config files. */
export function packagePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !value.length ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part.length > 100 ||
          new TextEncoder().encode(part).length > 255 ||
          !/^[\p{L}\p{N}_@-][\p{L}\p{N}\p{M}_@. -]*$/u.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
          /^(?:node_modules|credentials?|auth\.json|id_rsa|id_ed25519)$/i.test(part),
      )
  )
    throw new PluginPackageError("invalidPackagePath");
  return value;
}
export { contentSha256 as packageSha256 } from "../packages/digest.js";
/** Digests do not depend on JSON property insertion order or host locale. */
export function canonicalPackageJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPackageJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPackageJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
