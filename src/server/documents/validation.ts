import { isRecord } from "../../shared/records.js";
import type { DocumentSpaceInput } from "../../shared/documents/contracts.js";
import { DocumentError } from "./errors.js";

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Closed command objects cannot select operational fields owned by application composition. */
export function documentInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new DocumentError("invalidInput");
  return value;
}

export function text(value: unknown, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new DocumentError("invalidInput");
  return value.trim();
}
export function documentPath(value: unknown): string {
  const path = text(value, 512);
  if (path.startsWith("/") || path.includes("\\") || path.includes(":")) throw new DocumentError("invalidInput");
  if (path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")))
    throw new DocumentError("invalidInput");
  if (!/\.(md|mdx|markdown)$/i.test(path)) throw new DocumentError("invalidInput");
  return path;
}
export function contentText(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new DocumentError("invalidInput");
  if (Buffer.byteLength(value) > MAX_DOCUMENT_BYTES) throw new DocumentError("tooLarge", 413);
  return value;
}
export function localeText(value: unknown): string {
  const locale = text(value, 35, "en");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) throw new DocumentError("invalidInput");
  return locale;
}
export function spaceInput(value: unknown): DocumentSpaceInput {
  if (!isRecord(value)) throw new DocumentError("invalidInput");
  const code = text(value.code, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(code)) throw new DocumentError("invalidInput");
  const engine = value.engine;
  const sourceMode = value.sourceMode;
  if (
    !["markdown", "hexo", "docusaurus"].includes(String(engine)) ||
    !["managed", "external"].includes(String(sourceMode))
  )
    throw new DocumentError("invalidInput");
  return {
    projectId: text(value.projectId, 128),
    name: text(value.name, 100),
    code,
    engine: engine as DocumentSpaceInput["engine"],
    sourceMode: sourceMode as DocumentSpaceInput["sourceMode"],
    sourceRoot: sourceMode === "external" ? text(value.sourceRoot, 4096) : undefined,
    locale: localeText(value.locale),
    theme: text(value.theme, 100, "default"),
  };
}
export function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DocumentError("invalidInput");
  return value as number;
}
