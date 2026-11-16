import type { ContentIR, ContentIssue, Inline, PublicationFormat } from "../../../shared/publishing/content.js";
import { walkBlocks } from "./walk.js";
import {
  PUBLICATION_FORMAT_CAPABILITIES,
  preservesPublicationInlineStyle,
} from "../../../shared/publishing/format-capabilities.js";

/** Capabilities describe our serializers. Unknown platform styling is reported rather than invented. */
export function richFormatLosses(ir: ContentIR, format: PublicationFormat): ContentIssue[] {
  if (!ir.origin) return [];
  const capabilities = PUBLICATION_FORMAT_CAPABILITIES[format].rich,
    issues: ContentIssue[] = [];
  if (
    capabilities.imageLayout &&
    capabilities.alignment &&
    capabilities.listStyle &&
    capabilities.grid &&
    Object.values(capabilities.inlineStyles).every(Boolean)
  )
    return [];
  const issue = (blockId: string, code: ContentIssue["code"] = "unsupportedStyle") => {
    if (!issues.some((item) => item.blockId === blockId && item.code === code))
      issues.push({ blockId, code, severity: "warning" });
  };
  function inline(items: Inline[], id: string) {
    for (const item of items) {
      if (!preservesPublicationInlineStyle(capabilities, item.kind)) issue(id);
      if (!capabilities.imageLayout && item.kind === "image" && (item.width || item.height || item.title)) issue(id);
      if ("children" in item) inline(item.children, id);
    }
  }
  walkBlocks(ir.blocks, (block) => {
    if ("inline" in block) inline(block.inline, block.id);
    if (!capabilities.alignment && "align" in block && block.align && block.align !== "left") issue(block.id);
    if (!capabilities.imageLayout && block.kind === "image" && (block.width || block.height || block.title))
      issue(block.id);
    if (!capabilities.listStyle && block.kind === "list" && block.style && block.style !== "1") issue(block.id);
    if (!capabilities.grid && block.kind === "grid") issue(block.id, "structuredTextFlattened");
  });
  return issues;
}
