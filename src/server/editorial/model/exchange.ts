import { createHash } from "node:crypto";
import { normalizeRichBody, type RichTextNode } from "../../../shared/documents/rich-body.js";
import { applyRichTextEdits, EDITORIAL_LIMITS } from "../../../shared/editorial/rich-edits.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { EditorialSource } from "../ports.js";
import {
  EditorialModelOutputError,
  type EditorialModelInput,
  type EditorialModelProfile,
  type EditorialSegment,
  type ModelEditorialMode,
  type PreparedEditorial,
} from "./contracts.js";

export const MODEL_EDITORIAL_LIMITS = { inputBytes: 65536, segmentBytes: 8192, segments: 200, outputBytes: 524288 };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Send bounded editable text only. Protected scopes, image URLs, editor attributes and credentials are excluded. */
export function editorialModelInput(source: EditorialSource, mode: ModelEditorialMode): EditorialModelInput {
  const body = normalizeRichBody(source.body),
    segments: EditorialSegment[] = [],
    segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  let used = 0,
    truncated = false;
  const add = (text: string, path: number[], start: number) => {
    if (segments.length >= MODEL_EDITORIAL_LIMITS.segments || used + bytes(text) > MODEL_EDITORIAL_LIMITS.inputBytes) {
      truncated = true;
      return false;
    }
    segments.push({
      id: createHash("sha256")
        .update(stableJson([source.ref, path, start, text]))
        .digest("hex")
        .slice(0, 32),
      path,
      start,
      text,
    });
    used += bytes(text);
    return true;
  };
  const visit = (node: RichTextNode, path: number[]) => {
    if (["codeBlock", "blockquote"].includes(node.type) || node.marks?.some((m) => ["code", "link"].includes(m.type)))
      return;
    if (node.type !== "text") {
      node.content?.forEach((child, index) => visit(child, [...path, index]));
      return;
    }
    const text = node.text!;
    if (segments.length >= MODEL_EDITORIAL_LIMITS.segments || used >= MODEL_EDITORIAL_LIMITS.inputBytes) {
      truncated = true;
      return;
    }
    if (bytes(text) <= MODEL_EDITORIAL_LIMITS.segmentBytes) {
      add(text, path, 0);
      return;
    }
    let start = 0,
      length = 0;
    for (const part of segmenter.segment(text)) {
      const size = bytes(part.segment);
      if (size > MODEL_EDITORIAL_LIMITS.segmentBytes) {
        if (length && !add(text.slice(start, part.index), path, start)) return;
        truncated = true;
        start = part.index + part.segment.length;
        length = 0;
        continue;
      }
      if (length + size > MODEL_EDITORIAL_LIMITS.segmentBytes) {
        if (!add(text.slice(start, part.index), path, start)) return;
        start = part.index;
        length = 0;
      }
      length += size;
    }
    if (length) add(text.slice(start), path, start);
  };
  visit(body.document, []);
  return { schema: 1, mode, segments, truncated };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new EditorialModelOutputError("invalidOutput");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || bytes(value) > max || value.includes("\0"))
    throw new EditorialModelOutputError("invalidOutput");
  return value;
}
/** The model identifies known segments, never paths or arbitrary ranges. All returned edits are revalidated together. */
export function reviewedModelOutput(
  source: EditorialSource,
  input: EditorialModelInput,
  profile: EditorialModelProfile,
  output: unknown,
): PreparedEditorial {
  if (typeof output !== "string" || bytes(output) > MODEL_EDITORIAL_LIMITS.outputBytes)
    throw new EditorialModelOutputError("invalidOutput");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new EditorialModelOutputError("invalidOutput");
  }
  const payload = object(parsed, ["edits"]);
  if (!Array.isArray(payload.edits) || payload.edits.length > EDITORIAL_LIMITS.edits)
    throw new EditorialModelOutputError("invalidOutput");
  const known = new Map(input.segments.map((segment) => [segment.id, segment])),
    seen = new Set<string>();
  const edits = payload.edits.map((value) => {
    const item = object(value, ["segmentId", "before", "after", "reason"]),
      id = text(item.segmentId, 32),
      segment = known.get(id),
      before = text(item.before, MODEL_EDITORIAL_LIMITS.segmentBytes),
      after = text(item.after, EDITORIAL_LIMITS.editBytes - bytes(before)),
      reason = text(item.reason, 2000);
    if (!segment || seen.has(id) || before !== segment.text || before === after)
      throw new EditorialModelOutputError("invalidOutput");
    seen.add(id);
    return {
      id: createHash("sha256")
        .update(stableJson([id, after, profile]))
        .digest("hex")
        .slice(0, 32),
      path: segment.path,
      start: segment.start,
      end: segment.start + before.length,
      before,
      after,
      rule: input.mode === "rewrite" ? ("rewrite" as const) : ("grammar" as const),
      reason,
    };
  });
  if (edits.length) applyRichTextEdits(source.body, edits);
  return {
    producer: { kind: "model", engine: profile.engine, model: profile.model, version: profile.version },
    edits,
    truncated: input.truncated,
  };
}
