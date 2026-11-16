import { createHash } from "node:crypto";
import type { DocumentTreeTarget } from "../../../shared/documents/navigation.js";
import { DocumentTreeError } from "../../../shared/documents/navigation.js";
import { stableJson } from "../../../shared/stable-json.js";
import { DocumentError } from "../errors.js";
import { text } from "../validation.js";
import { isRecord } from "../../../shared/records.js";

export function navigationGuard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DocumentTreeError)
      throw new DocumentError(
        error.code === "limit"
          ? "tooManyDocuments"
          : error.code === "depth"
            ? "treeDepth"
            : error.code === "missing"
              ? "notFound"
              : "invalidTreeMove",
        error.code === "missing" ? 404 : error.code === "limit" ? 409 : 400,
      );
    throw error;
  }
}
export function navigationVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new DocumentError("invalidInput");
  return Number(value);
}
export function navigationInput(value: unknown, keys: string[]) {
  if (
    !isRecord(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !["id", "projectId", "treeVersion", ...keys].includes(key))
  )
    throw new DocumentError("invalidInput");
  const id = text(value.id, 128);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new DocumentError("invalidInput");
  return {
    id: id.toLowerCase(),
    projectId: text(value.projectId, 128),
    version: navigationVersion(value.treeVersion),
    input: value,
  };
}
export function navigationTarget(value: unknown): DocumentTreeTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentError("invalidInput");
  const target = value as Record<string, unknown>;
  if (target.kind === "root" && Object.keys(target).length === 1) return { kind: "root" };
  if (
    !["before", "after", "inside"].includes(String(target.kind)) ||
    Object.keys(target).some((key) => !["kind", "documentId"].includes(key))
  )
    throw new DocumentError("invalidInput");
  return { kind: target.kind as "before" | "after" | "inside", documentId: text(target.documentId, 128) };
}
/** Large bodies participate in identity without being duplicated in the operation journal. */
export const navigationRequest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
