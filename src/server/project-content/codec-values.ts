import { ProjectContentError } from "./errors.js";

export function fileRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ProjectContentError("invalidFile");
  return value as Record<string, unknown>;
}
export function fileText(value: unknown, limit: number, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > limit
  )
    throw new ProjectContentError("invalidFile");
  return value;
}
export function fileInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ProjectContentError("invalidFile");
  return Number(value);
}
export function fileDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ProjectContentError("invalidFile");
  return value;
}
export function fileLocale(value: unknown): string {
  const locale = fileText(value, 35);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) throw new ProjectContentError("invalidFile");
  return locale;
}

export function fileChoice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new ProjectContentError("invalidFile");
  return value;
}
