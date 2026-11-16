import { createHash } from "node:crypto";
import type { KnowledgePrevious, KnowledgeTaskInput } from "../../../shared/knowledge/tasks.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import { knowledgeObject, knowledgeId, knowledgeDigest } from "../../../shared/knowledge/primitives.js";
import { KnowledgeTaskError, type KnowledgeTaskFiles } from "./contracts.js";
import { knowledgeRecord } from "./record.js";
import { knowledgeMarkdown } from "./markdown.js";
import { knowledgeValueDigest } from "../identity.js";

export const previousFileDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const recordFromJson = (json: string) =>
  knowledgeRecord(JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json));

/** Raw structured and readable bytes are preserved together; an edited readable copy is never silently normalized. */
export function knowledgePrevious(value: unknown): KnowledgePrevious {
  const p = knowledgeObject(value, ["schema", "id", "files", "json", "markdown"]),
    files = knowledgeObject(p.files, ["json", "markdown"]),
    id = knowledgeId(p.id);
  if (p.schema !== 1 || (p.json === null && p.markdown === null)) throw new KnowledgeTaskError("invalidInput");
  const text = (value: unknown, digest: unknown) => {
      if (value === null) {
        if (digest !== null) throw new KnowledgeTaskError("invalidInput");
        return null;
      }
      if (
        typeof value !== "string" ||
        Buffer.byteLength(value) > KNOWLEDGE_LIMITS.previousFileBytes ||
        previousFileDigest(value) !== knowledgeDigest(digest)
      )
        throw new KnowledgeTaskError("invalidInput");
      return value;
    },
    json = text(p.json, files.json),
    markdown = text(p.markdown, files.markdown);
  if (json !== null && recordFromJson(json).id !== id) throw new KnowledgeTaskError("invalidInput");
  return {
    schema: 1,
    id,
    files: {
      json: json === null ? null : previousFileDigest(json),
      markdown: markdown === null ? null : previousFileDigest(markdown),
    },
    json,
    markdown,
  };
}
export function previousRecord(value: KnowledgePrevious) {
  return value.json === null ? null : recordFromJson(value.json);
}
export function previousState(value: KnowledgePrevious) {
  return knowledgeValueDigest({ id: value.id, files: value.files });
}
export function previousRequiresReview(value: KnowledgePrevious) {
  const record = previousRecord(value);
  return (
    !record ||
    record.approval?.mode !== "automatic" ||
    record.sources.some((source) => source.kind === "user-input") ||
    value.markdown !== knowledgeMarkdown(record)
  );
}
export async function readTaskPrevious(files: Pick<KnowledgeTaskFiles, "previous">, input: KnowledgeTaskInput) {
  const ref = input.target.previous;
  if (!ref) return null;
  const value = await files.previous(ref.digest),
    record = previousRecord(value);
  if (
    value.id !== input.target.id ||
    previousState(value) !== ref.state ||
    (record?.version ?? null) !== input.target.expectedVersion ||
    previousRequiresReview(value) !== ref.reviewRequired
  )
    throw new KnowledgeTaskError("conflict");
  return value;
}
/** Comparison pages are bounded independently of model tool frames and preserve UTF-16 boundaries. */
export function previousTextChunk(markdown: string, start: number) {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > markdown.length ||
    (start > 0 && /[\uDC00-\uDFFF]/.test(markdown[start]!) && /[\uD800-\uDBFF]/.test(markdown[start - 1]!))
  )
    throw new KnowledgeTaskError("invalidInput");
  let end = Math.min(markdown.length, start + 65536);
  if (end < markdown.length && /[\uD800-\uDBFF]/.test(markdown[end - 1]!)) end--;
  return {
    markdown: markdown.slice(start, end),
    start,
    next: end < markdown.length ? end : null,
    total: markdown.length,
  };
}
