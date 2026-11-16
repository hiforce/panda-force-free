import { createHash } from "node:crypto";
import type { RichTextNode } from "../../../shared/documents/rich-body.js";
import type { RichTextEdit } from "../../../shared/editorial/contracts.js";
import { EDITORIAL_LIMITS } from "../../../shared/editorial/rich-edits.js";
import type { EditorialProcessor, EditorialSource } from "../ports.js";

/** A mechanical check, explicitly separate from model proofreading and substantive rewriting. */
export const richSpacingProcessor: EditorialProcessor = {
  prepare(source: EditorialSource) {
    const edits: RichTextEdit[] = [];
    let truncated = false;
    function visit(node: RichTextNode, path: number[], terminal = false) {
      if (
        ["codeBlock", "blockquote"].includes(node.type) ||
        node.marks?.some((mark) => ["code", "link"].includes(mark.type))
      )
        return;
      if (node.type === "text") {
        for (const match of (node.text || "").matchAll(/(?<=\p{L})[ ]{2,}(?=\p{L})|[ \t]+(?=\n|$)/gu)) {
          const trailing =
            match.index + match[0].length === node.text!.length || node.text![match.index + match[0].length] === "\n";
          if (trailing && !terminal && match.index + match[0].length === node.text!.length) continue;
          if (edits.length === EDITORIAL_LIMITS.edits || match[0].length > EDITORIAL_LIMITS.editBytes / 2) {
            truncated = true;
            continue;
          }
          const after = trailing ? "" : " ",
            rule = trailing ? "trailingWhitespace" : "repeatedSpaces";
          edits.push({
            id: createHash("sha256")
              .update(JSON.stringify([source.ref, path, match.index, match[0], after]))
              .digest("hex")
              .slice(0, 24),
            path,
            start: match.index,
            end: match.index + match[0].length,
            before: match[0],
            after,
            rule,
            contextBefore: Array.from(node.text!.slice(Math.max(0, match.index - 160), match.index))
              .slice(-80)
              .join(""),
            contextAfter: Array.from(
              node.text!.slice(match.index + match[0].length, match.index + match[0].length + 160),
            )
              .slice(0, 80)
              .join(""),
          });
        }
      } else
        node.content?.forEach((child, index, children) =>
          visit(child, [...path, index], ["paragraph", "heading"].includes(node.type) && index === children.length - 1),
        );
    }
    visit(source.body.document, []);
    return { producer: { kind: "rules", version: "rich-spacing-1" }, edits, truncated };
  },
};
