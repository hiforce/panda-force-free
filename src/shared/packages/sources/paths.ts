import { SourceError, DEFAULT_SOURCE_LIMITS } from "./contracts.js";
const utf8 = new TextEncoder();

/** Logical source paths remain relative and unambiguous across supported filesystems. */
export function sourcePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\\:*?"<>|\p{Cc}\p{Cf}\p{Cs}]/u.test(value) ||
    /%(?:2e|2f|5c|00)/i.test(value)
  )
    throw new SourceError("invalidSourcePath");
  const parts = value.split("/");
  if (
    parts.length > 64 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        utf8.encode(part).byteLength > 255 ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new SourceError("invalidSourcePath");
  return value;
}

/** One spelling owns each logical node, including implicit parent directories. */
export class SourcePaths {
  private nodes = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
  constructor(private maximum = DEFAULT_SOURCE_LIMITS.entries) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new SourceError("invalidSource");
  }
  add(value: string, directory = false): string {
    const path = sourcePath(value),
      parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join("/"),
        key = spelling.normalize("NFC").toLowerCase(),
        isDirectory = index < parts.length || directory,
        explicit = index === parts.length,
        prior = this.nodes.get(key);
      if (
        prior &&
        (prior.path !== spelling ||
          prior.directory !== isDirectory ||
          (!isDirectory && explicit) ||
          (explicit && prior.explicit))
      )
        throw new SourceError("duplicateSourcePath");
      if (!prior && this.nodes.size >= this.maximum) throw new SourceError("sourceTooLarge");
      this.nodes.set(key, { path: spelling, directory: isDirectory, explicit: explicit || !!prior?.explicit });
    }
    return path;
  }
}
