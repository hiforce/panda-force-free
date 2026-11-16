import { skillAssert, type SkillErrorCode } from "../errors.js";
export function record(
  value: unknown,
  fields: readonly string[],
  field = "",
  code: SkillErrorCode = "invalidManifest",
): Record<string, unknown> {
  skillAssert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === "string" &&
          fields.includes(key) &&
          Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
          Object.getOwnPropertyDescriptor(value, key)?.set === undefined,
      ),
    code,
    field,
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, field = "", multiline = false): string {
  skillAssert(
    typeof value === "string" &&
      value.length <= max &&
      value.trim().length > 0 &&
      !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(multiline ? value.replace(/[\t\n\r]/g, "") : value),
    "invalidManifest",
    field,
  );
  return value;
}
export function boolean(value: unknown, field: string): boolean {
  skillAssert(typeof value === "boolean", "invalidManifest", field);
  return value;
}
export function list<T>(value: unknown, decode: (value: unknown) => T, min: number, max: number, field: string): T[] {
  skillAssert(Array.isArray(value) && value.length >= min && value.length <= max, "invalidManifest", field);
  return value.map(decode);
}
export function unique<T>(values: readonly T[], key: (value: T) => string, field: string): void {
  skillAssert(new Set(values.map(key)).size === values.length, "invalidManifest", field);
}
export function oneOf<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  skillAssert(typeof value === "string" && values.includes(value), "invalidManifest", field);
  return value;
}
export function finite(value: unknown, field: string): number {
  skillAssert(typeof value === "number" && Number.isFinite(value), "invalidManifest", field);
  return value;
}
export function https(value: unknown, field: string): string {
  const result = text(value, 1000, field);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    skillAssert(false, "invalidManifest", field);
  }
  skillAssert(
    url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search && !/\s/.test(result),
    "invalidManifest",
    field,
  );
  return result;
}
