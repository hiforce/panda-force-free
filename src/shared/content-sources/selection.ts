import type { SavedSourceKind } from "./contracts.js";

export const SAVED_SOURCE_KINDS = Object.freeze(["document", "slides", "web"] as const);

/** Explicit kinds are copied and canonicalized; missing intent retains the document-only default. */
export function selectedSourceKinds(value: unknown): SavedSourceKind[] | null {
  if (value === undefined) return ["document"];
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > SAVED_SOURCE_KINDS.length ||
    new Set(value).size !== value.length ||
    value.some((kind) => !SAVED_SOURCE_KINDS.includes(kind))
  )
    return null;
  return SAVED_SOURCE_KINDS.filter((kind) => value.includes(kind));
}
