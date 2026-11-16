import { isRecord } from "../records.js";
import { KnowledgeError } from "./contracts.js";

export function knowledgeObject(value: unknown, keys: readonly string[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new KnowledgeError("invalidInput");
  return value;
}
export function knowledgeText(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > max || (!empty && !value.trim()))
    throw new KnowledgeError("invalidInput");
  return value;
}
export function knowledgeId(value: unknown): string {
  const id = knowledgeText(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new KnowledgeError("invalidInput");
  return id;
}
export function knowledgeDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new KnowledgeError("invalidInput");
  return value;
}
