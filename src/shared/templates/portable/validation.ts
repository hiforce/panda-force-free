import { PortableTemplateError, templateAssert } from "./errors.js";

export function templateObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  templateAssert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === "string" &&
          fields.includes(key) &&
          !Object.getOwnPropertyDescriptor(value, key)?.get &&
          !Object.getOwnPropertyDescriptor(value, key)?.set,
      ),
  );
  return value as Record<string, unknown>;
}
export function templateText(value: unknown, max: number, empty = false): string {
  templateAssert(
    typeof value === "string" &&
      value.length <= max &&
      (empty || value.trim().length) &&
      !/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(value.replace(/[\t\r\n]/g, "")),
  );
  return value;
}
export function templateId(value: unknown) {
  const id = templateText(value, 80);
  templateAssert(id.length >= 3 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id));
  return id;
}
export function templateField(value: unknown) {
  const id = templateText(value, 64);
  templateAssert(/^[a-z][a-z0-9_-]*$/.test(id) && !["constructor", "prototype"].includes(id));
  return id;
}
export function templateVersion(value: unknown) {
  const version = templateText(value, 20);
  templateAssert(/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/.test(version));
  return version;
}
export function templateDigest(value: unknown) {
  const digest = templateText(value, 64);
  templateAssert(/^[a-f0-9]{64}$/.test(digest));
  return digest;
}
export function templateLocalized(value: unknown): Readonly<Record<string, string>> {
  templateAssert(value && typeof value === "object" && !Array.isArray(value));
  const row = templateObject(value, Object.keys(value)),
    result: Record<string, string> = {};
  templateAssert(Object.keys(row).length > 0 && Object.keys(row).length <= 32 && Object.hasOwn(row, "en"));
  for (const [locale, text] of Object.entries(row)) {
    templateAssert(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale));
    result[locale] = templateText(text, 2000);
  }
  return result;
}
export function templateList<T>(value: unknown, decode: (value: unknown) => T, max: number, min = 0): T[] {
  templateAssert(Array.isArray(value) && value.length >= min && value.length <= max);
  return value.map(decode);
}
export function templateUnique<T>(values: readonly T[], key: (value: T) => string) {
  templateAssert(new Set(values.map(key)).size === values.length);
}
export function templateInteger(value: unknown, min: number, max: number) {
  templateAssert(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max);
  return Number(value);
}
export function templateNumber(value: unknown) {
  templateAssert(typeof value === "number" && Number.isFinite(value));
  return value;
}
export function templateBoolean(value: unknown) {
  templateAssert(typeof value === "boolean");
  return value;
}
export function templateChoice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  templateAssert(typeof value === "string" && choices.includes(value));
  return value;
}
export function templatePath(value: unknown): string {
  const path = templateText(value, 240);
  templateAssert(
    path === path.normalize("NFC") &&
      !/[\p{Cc}\p{Cf}\\:?*"<>|#%]/u.test(path) &&
      path
        .split("/")
        .every(
          (part) =>
            part.length &&
            !/^[.\s]|[.\s]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
            !/^(?:node_modules|credentials?|auth\.json|id_rsa|id_ed25519)$/i.test(part),
        ),
    "invalidPath",
  );
  return path;
}
export function templateUtf8(value: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new PortableTemplateError("invalidBundle");
  }
}
export function templateJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(templateUtf8(value));
  } catch {
    throw new PortableTemplateError("invalidBundle");
  }
}
export function freezeTemplate<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTemplate(child);
    Object.freeze(value);
  }
  return value;
}
/** Checks component aliases as well as complete names, without ever extracting paths to disk. */
export function templatePathSet() {
  const files = new Set<string>(),
    directories = new Set<string>(),
    spellings = new Map<string, string>();
  return (value: unknown) => {
    const path = templatePath(value),
      key = path.toLowerCase(),
      parts = path.split("/");
    templateAssert(!files.has(key) && !directories.has(key), "invalidPath");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/"),
        folded = prefix.toLowerCase();
      templateAssert(!spellings.has(folded) || spellings.get(folded) === prefix, "invalidPath");
      spellings.set(folded, prefix);
      if (index < parts.length) {
        templateAssert(!files.has(folded), "invalidPath");
        directories.add(folded);
      }
    }
    files.add(key);
    return path;
  };
}
