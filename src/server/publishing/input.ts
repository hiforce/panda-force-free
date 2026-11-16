import { PublicationError } from "./errors.js";

export function publicationField(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new PublicationError("invalidInput");
  return value.trim();
}
export function publicationProject(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const project = publicationField(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) throw new PublicationError("invalidInput");
  return project;
}
