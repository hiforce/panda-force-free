import { BuildError } from "./errors.js";
export function safeBuildPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !value ||
    /[\\?#:%]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    value
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.length > 100 || new TextEncoder().encode(part).length > 255)
  )
    throw new BuildError("invalidPath");
  return value;
}
export function buildBinaryFile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BuildError("invalidInput");
  const file = value as Record<string, unknown>,
    path = safeBuildPath(file.path);
  if (typeof file.data !== "string" || file.data.length > 64 * 1024 * 1024 * 1.4 || typeof file.sha256 !== "string")
    throw new BuildError("invalidInput");
  const data = file.data,
    sha256 = file.sha256,
    padding = data.indexOf("=");
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data) ||
    (padding >= 0 && (padding < data.length - 2 || !/^={1,2}$/.test(data.slice(padding))))
  )
    throw new BuildError("invalidInput");
  return { path, data, sha256 };
}
