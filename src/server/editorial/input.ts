import { EditorialError } from "./errors.js";

export function editorialValue(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new EditorialError("invalidInput");
  return value.trim();
}
export function editorialProject(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw new EditorialError("invalidInput");
  return value;
}
export function editorialUuid(value: unknown): string {
  const id = editorialValue(value);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new EditorialError("invalidInput");
  return id;
}
