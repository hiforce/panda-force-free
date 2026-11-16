import { createHash } from "node:crypto";
import type { ContentBlock, ContentIR, ProofreadingSuggestion } from "../../../shared/publishing/content.js";

/** Conservative mechanical suggestions never inspect code, quotations, links or unknown syntax. */
export function proofread(ir: ContentIR): ProofreadingSuggestion[] {
  if (ir.origin?.kind === "richtext") return [];
  const suggestions: ProofreadingSuggestion[] = [];
  const visit = (blocks: ContentBlock[]) => {
    for (const block of blocks) {
      if (block.kind === "container") {
        visit(block.children);
        continue;
      }
      if (block.kind !== "paragraph" || !block.span.exact || block.inline.some((item) => item.kind !== "text"))
        continue;
      for (const match of block.raw.matchAll(/[ \t]+(?=\n|$)|(?<=[\p{L}])[ ]{2,}(?=[\p{L}])/gu)) {
        const start = block.span.start + match.index,
          before = match[0];
        const trailing =
          match.index + before.length === block.raw.length || block.raw[match.index + before.length] === "\n";
        // Markdown's two-space line break is meaningful and must be kept.
        if (trailing && before.endsWith("  ")) continue;
        const after = trailing ? "" : " ";
        suggestions.push({
          id: createHash("sha256").update(`${ir.sourceHash}:${start}:${before}:${after}`).digest("hex").slice(0, 24),
          span: { start, end: start + before.length, exact: true },
          before,
          after,
          rule: trailing ? "trailingWhitespace" : "repeatedSpaces",
          blockId: block.id,
        });
      }
    }
  };
  visit(ir.blocks);
  return suggestions;
}
export function applySuggestions(ir: ContentIR, selected: string[]): string {
  if (ir.origin?.kind === "richtext") throw new Error("Rich sources require structured edit proposals");
  const allowed = proofread(ir),
    ids = new Set(selected);
  if (selected.length !== ids.size || selected.some((id) => !allowed.some((item) => item.id === id)))
    throw new Error("Invalid proofreading selection");
  let source = ir.source;
  for (const suggestion of allowed.filter((item) => ids.has(item.id)).sort((a, b) => b.span.start - a.span.start)) {
    if (source.slice(suggestion.span.start, suggestion.span.end) !== suggestion.before)
      throw new Error("Source differs from suggestion");
    source = source.slice(0, suggestion.span.start) + suggestion.after + source.slice(suggestion.span.end);
  }
  return source;
}
