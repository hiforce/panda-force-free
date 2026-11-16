import type { KnowledgeEvidenceSource } from "../../../shared/knowledge/contracts.js";
import { KnowledgeTaskError } from "./contracts.js";

/** Escaping is included in the native tool-frame budget; offsets always refer to the original UTF-16 text. */
export function knowledgeTextChunk(source: KnowledgeEvidenceSource, start: number) {
  if (!Number.isSafeInteger(start) || start < 0 || start > source.text.length)
    throw new KnowledgeTaskError("invalidInput");
  let end = Math.min(source.text.length, start + 8000);
  for (;;) {
    if (end < source.text.length && end > start && /[\uD800-\uDBFF]/.test(source.text[end - 1]!)) end--;
    const chunk = {
      id: source.id,
      version: source.version,
      kind: source.kind,
      start,
      text: source.text.slice(start, end),
      next: end < source.text.length ? end : null,
      sections: source.sections.filter((section) => section.start < end && section.end > start).slice(0, 32),
    };
    if (JSON.stringify(chunk).length <= 30000) return chunk;
    end = start + Math.max(1, Math.floor((end - start) / 2));
  }
}
